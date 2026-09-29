/**
 * dsh-feishu — talk to DeepSeek Harness from Feishu (飞书).
 *
 * Each Feishu chat is bound to one DSH session. A message in Feishu becomes a
 * user turn in that session; the assistant's answer is streamed back into the
 * chat. Because a desktop DSH listens on `127.0.0.1`, Feishu's servers cannot
 * call back into it, so events arrive over Feishu's *long connection* — an
 * outbound WebSocket this plugin opens itself (`./ws.mjs`).
 *
 * Everything is dependency-free: the protobuf framing is hand-rolled in
 * `./pbbp2.mjs`, HTTP is `fetch`, and the socket is Node 22+'s global
 * `WebSocket`. That is deliberate — the officially packaged IM plugin needs a
 * native build script that pnpm blocks, and it crashed the harness at boot on
 * this machine.
 *
 * @module dsh-feishu
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'

import * as settingsApi from '@deepseek-ai/dsh-settings'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { SANDBOX_MODES, setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import z from '@deepseek-ai/schemastery'

import { DEFAULT_DOMAIN, FeishuApi, messageText } from './api.mjs'
import {
	answeredApprovalCard,
	answeredQuestionCard,
	approvalCard,
	modeLabel,
	parseApprovalAction,
	parsePermissionAction,
	parseQuestionAction,
	permissionCard,
	permissionErrorToast,
	permissionResponse,
	questionCard,
	questionErrorToast,
	questionResponse,
} from './cards.mjs'
import { ConversationBook, LIST_COMMANDS, parseSessionAction, renderSessions, sessionCard } from './conversations.mjs'
import { chunkMarkdown, markdownCard, toPlainText } from './format.mjs'
import { decodeSessionId, sessionIdOf } from './generations.mjs'
import { describeAttachment, mergeForwardContainer, safeFileName } from './inbound.mjs'
import { isBareLink, parseFeishuLink } from './links.mjs'
import { createProgressThrottle } from './progress.mjs'
import { parseDriveFolderRef, walkDriveFolder } from './drive.mjs'
import { modelCard, normalizeCatalog, parseModelAction, readModelCatalog, renderModelCatalog } from './models.mjs'
import { FileLogger } from './log.mjs'
import { ChatPointerStore } from './state.mjs'
import { FeishuLongConnection } from './ws.mjs'

/** Plugin display name used by loader diagnostics. */
export const name = 'dsh-feishu'

/** Services this plugin needs; the row refuses to load without them. */
export const inject = ['agents', 'sessionQuery', 'tools', 'agentDefaultModel', 'agentPresets', 'sandboxPolicy', 'llm', 'webServer']

/** Settings namespace shown in the GUI. */
export const FEISHU_NAMESPACE = 'feishu'

/**
 * Producer-owned `source.kind` stamped on every message this plugin injects.
 *
 * ⚠️ Session format **v4** (DSH ≥ 0.1.7) refuses the retired wrapper
 * `{kind:'plugin', plugin:'dsh-feishu'}` outright — the turn dies before any
 * model call with
 * `format v4 message requires a producer-owned source kind`
 * (`dsh-session-format-v3-to-v4`: `source()` rejects `kind === 'plugin'`).
 * The v3→v4 migration maps a third-party plugin to **`plugin:<name>`**
 * (`producerKind()`), so that is exactly what new writes must stamp.
 */
export const PLUGIN_SOURCE_KIND = `plugin:${name}`

/** Fresh producer-owned source for one injected user message. */
function producerSource() {
	return { kind: PLUGIN_SOURCE_KIND }
}

/** Inbound message ids are remembered this long to absorb Feishu retries. */
const DEDUPE_TTL_MS = 10 * 60 * 1000

/**
 * How long `feishu_ask` waits for a card click before it gives up and hands the
 * model a "no answer" result. Ten minutes is deliberately long: a question card
 * is often read on a phone, and the cost of waiting is one idle turn.
 */
const ASK_TIMEOUT_MS = 10 * 60 * 1000

/** Bounds a model-supplied `timeout_seconds`, so a typo cannot park a turn for a day. */
const ASK_TIMEOUT_MIN_S = 30
const ASK_TIMEOUT_MAX_S = 3_600

/**
 * After `feishu_ask` gives up, the card stays live this much longer: a click in
 * that window is delivered as an ordinary chat message instead of being lost.
 */
const ASK_LATE_GRACE_MS = 10 * 60 * 1000

/** Same-origin route the GUI settings card reads for live bridge status. */
const STATUS_ROUTE = '/plugins/dsh-feishu/status'

/** Configuration schema — also the GUI settings section. */
export const Config = z.object({
	/** Whether the bridge runs at all. */
	enabled: z.boolean().default(false),
	/** Self-built app id (`cli_...`). */
	appId: z.string().default(''),
	/** Self-built app secret. */
	appSecret: z.string().role('secret').default(''),
	/** Open-platform origin; change only for Lark (international). */
	domain: z.string().default(DEFAULT_DOMAIN),
	/** Working directory new sessions use. Empty means the host's cwd. */
	cwd: z.string().default(''),
	/** Chat ids allowed to drive the agent. Empty means "any chat". */
	allowedChatIds: z.array(z.string()).default([]),
	/** React with an emoji as soon as a message is accepted. */
	ackReaction: z.boolean().default(true),
	/** Send the assistant's answer back to Feishu. */
	replyToChat: z.boolean().default(true),
	/**
	 * How an inbound Feishu message reaches a chat's agent **while a turn is
	 * already running**.
	 *
	 * `steer` (default) hands it to the active turn's nearest step boundary, so
	 * a running task sees it right away instead of finishing first — the message
	 * jumps the queue. `queue` is the old behavior: wait for the current turn to
	 * end, then open the next one.
	 *
	 * User 2026-09-29: 「正在运行任务的时候通过飞书发送消息默认插队，而不是排队」.
	 */
	sendMode: z.union([z.const('steer'), z.const('queue')]).default('steer'),
})

/**
 * Render a log line prefix.
 * @param {string} message - the message body.
 * @returns {string} the prefixed line.
 */
function tag(message) {
	return `[dsh-feishu] ${message}`
}

/**
 * Install the settings section across DSH settings generations.
 *
 * dsh 0.1.5 moved this onto the `settings` service and removed the module-level
 * helpers; probing at runtime keeps the bundle loadable on both generations
 * instead of taking the whole host down with a bad named import.
 *
 * @param {object} ctx - the plugin context.
 * @param {object} config - the row's config, i.e. the section's initial value.
 * @param {object} hooks - the section hooks (`setSource` / `onChange`).
 */
function installFeishuSettings(ctx, config, hooks) {
	try {
		if (typeof settingsApi.SettingsProvider?.prototype?.installSection === 'function') {
			ctx.inject(['settings'], (settingsCtx) => {
				settingsCtx.settings.installSection(ctx, FEISHU_NAMESPACE, Config, config, hooks)
			})
			return
		}
		if (typeof settingsApi.installSettingsSection === 'function' && typeof settingsApi.settingsNamespace === 'function') {
			settingsApi.installSettingsSection(ctx, settingsApi.settingsNamespace(FEISHU_NAMESPACE), Config, config, hooks)
			return
		}
		ctx.logger?.warn?.(tag('设置面板 API 不可用，飞书配置改为只读（用 patch 行配置）'))
	} catch (error) {
		ctx.logger?.warn?.(tag(`设置面板注册失败（不影响运行）: ${error instanceof Error ? error.message : String(error)}`))
	}
}

/**
 * Register the plugin.
 * @param {object} ctx - the plugin context.
 * @param {object} config - the row config.
 */
export function apply(ctx, config = {}) {
	/** Live config: the settings section replaces this source once mounted. */
	let current = () => config

	// DSH routes plugin logs to the GUI, not to stdout, so a socket-level bridge
	// is undebuggable from a terminal. Tee everything into a file as well.
	const log = new FileLogger().tee(ctx.logger)

	/**
	 * Live bridge status, served to the GUI settings card.
	 *
	 * The settings card is the only place a user can see whether the bridge is
	 * actually up without tailing a log file, so this is deliberately a small
	 * snapshot of facts rather than a copy of the config.
	 */
	const status = {
		/** @type {number | null} */ startedAt: null,
		/** @type {boolean} */ connected: false,
		/** @type {number} */ serviceId: 0,
		/** @type {number | null} */ lastEventAt: null,
		/** @type {number | null} */ lastPushAt: null,
		/** @type {string | null} */ lastError: null,
		/** @type {Set<string>} */ chats: new Set(),
		/** @type {string | null} */ lastEventType: null,
	}

	// ---- per-fiber state; all of it dies with the plugin fiber ----
	/** @type {Map<string, string>} chat id -> session id */
	const sessionByChat = new Map()
	/** @type {Map<string, string>} session id -> chat id */
	const chatBySession = new Map()
	/** @type {Map<string, string>} session id -> assistant text of the open turn */
	const pendingReply = new Map()
	/** @type {Set<string>} session ids whose turn used the feishu_send tool */
	const repliedViaTool = new Set()
	/** @type {Map<string, number>} message id -> first-seen timestamp */
	const seenMessages = new Map()
	/**
	 * Questions waiting for a card click, keyed by the opaque `questionId` that
	 * travels inside the button's `value`.
	 *
	 * In-memory on purpose: a question is meaningless once the process that
	 * asked it is gone, and the tool call awaiting the answer dies with it.
	 *
	 * @type {Map<string, {
	 *   questionId: string, chatId: string, question: string,
	 *   options: readonly string[], settled: boolean, expired: boolean,
	 *   timer: ReturnType<typeof setTimeout> | null,
	 *   graceTimer: ReturnType<typeof setTimeout> | null,
	 *   resolve: (label: string | null) => void,
	 * }>}
	 */
	const pendingQuestions = new Map()
	/** Disambiguates two questions asked inside the same millisecond. */
	let questionSeq = 0
	/**
	 * Which generation each chat talks to. Survives bridge restarts because it
	 * is not part of `stopBridge()` state: a settings change must not silently
	 * drag a chat back to its newest conversation.
	 */
	const pointers = new ChatPointerStore()
	/** @type {FeishuApi | null} */
	let api = null
	/** @type {FeishuLongConnection | null} */
	let connection = null

	if (pointers.writeError !== undefined) {
		log.warn?.(tag(`会话指针写不进 ${pointers.file}（${pointers.writeError}）：/open 的选择重启后会丢`))
	}

	/**
	 * Remember an inbound message id, and report whether it is a repeat.
	 * @param {string} messageId - Feishu's message id.
	 * @returns {boolean} true when this message was already handled.
	 */
	function isDuplicate(messageId) {
		const now = Date.now()
		for (const [key, at] of seenMessages) {
			if (now - at > DEDUPE_TTL_MS) seenMessages.delete(key)
		}
		if (seenMessages.has(messageId)) return true
		seenMessages.set(messageId, now)
		return false
	}

	/**
	 * Look up the live agent of one exact generation, resuming the persisted
	 * session if that id exists and creating it only when it does not.
	 *
	 * Both id and generation are deterministic (`feishu-<chatId>[-<n>]`), so a
	 * restarted plugin lands on the same conversation instead of starting a new
	 * one.
	 *
	 * @param {string} chatId - the Feishu chat id.
	 * @param {number} generation - which generation to bind.
	 * @returns {Promise<object>} the live agent.
	 */
	async function agentForGeneration(chatId, generation) {
		const sessionId = SessionId(sessionIdOf(chatId, generation))
		sessionByChat.set(chatId, sessionId)
		// Kept for older generations too: a turn that was already running when
		// `/new` fired still reports its answer into this chat.
		chatBySession.set(sessionId, chatId)

		const live = ctx.agents.get(sessionId)
		if (live !== undefined) return live

		const agentOptions = currentAgentOptions()
		const composition = await composePreset()
		// A stored session must be resumed, never re-created: create() would
		// collide with the persisted artifacts of the same id.
		try {
			await ctx.sessionQuery.observeSession(sessionId)
			const { agent } = await ctx.agents.resume({
				resumeSessionId: sessionId,
				agentOptions,
				setup: composition.setup,
			})
			log.info?.(tag(`已恢复飞书会话 ${sessionId} (chat ${chatId}, preset ${composition.agentPreset ?? '无'})`))
			return agent
		} catch (error) {
			if (error?.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
		}

		const cwd = String(current().cwd ?? '') || process.cwd()
		const { agent } = await ctx.agents.create({
			sessionId,
			agentOptions,
			// Without the preset the session is bare: `agents.create` alone gives
			// it only globally registered tools — no shell, filesystem, MCP or
			// memory. `setup` is what mounts the preset's composition.
			meta: {
				cwd,
				...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
			},
			setup: composition.setup,
		})
		log.info?.(tag(`已新建飞书会话 ${sessionId} (chat ${chatId}, gen ${generation}, cwd ${cwd}, preset ${composition.agentPreset ?? '无'})`))
		return agent
	}

	/**
	 * The live agent for a chat's *current* generation.
	 * @param {string} chatId - the Feishu chat id.
	 * @returns {Promise<object>} the live agent.
	 */
	async function agentFor(chatId) {
		return agentForGeneration(chatId, await conversations.current(chatId))
	}

	/**
	 * Hand one user-authored message to a chat's agent.
	 *
	 * The default (`sendMode: 'steer'`) is **插队**: `agent.steer()` parks the
	 * message in the nearest-step lane, so a turn that is already running picks
	 * it up at its next step boundary instead of finishing first. On an idle
	 * agent steering opens the turn immediately, so there is no idle-side
	 * regression. `sendMode: 'queue'` restores the old `agent.followup()`
	 * (next-turn) behavior; cores whose Agent has no `steer` fall back to it too.
	 *
	 * @param {object} agent - the live agent from {@link agentFor}.
	 * @param {object} message - the `createUserMessage(...)` payload.
	 * @returns {'steer' | 'queue'} the mode actually used, for logging.
	 */
	function deliverUserMessage(agent, message) {
		const wanted = current().sendMode === 'queue' ? 'queue' : 'steer'
		if (wanted === 'steer' && typeof agent.steer === 'function') {
			agent.steer(message)
			return 'steer'
		}
		agent.followup(message)
		return 'queue'
	}

	/**
	 * Resolve the agent-preset composition a new Feishu session should run on.
	 *
	 * This is the difference between a session that can only talk and one that
	 * can actually work. `ctx.agents.create()` on its own produces a **bare**
	 * agent: it sees only tools registered globally on the host context — which
	 * is why a Feishu session used to have `feishu_send` and nothing else. The
	 * shell, filesystem, MCP servers, memory and skills all arrive through the
	 * preset's *standing composition*, which the GUI mounts from
	 * `SessionController` via `presets.mount(agentCtx, presetId)`.
	 *
	 * `mount` binds the agent's scope to that composition, so it must run inside
	 * the `setup` callback (the factory rolls the agent back if setup rejects).
	 *
	 * @returns {Promise<{agentPreset?: string, setup?: Function}>} the preset id and its setup callback.
	 */
	async function composePreset() {
		const presets = ctx.agentPresets
		if (presets === undefined) {
			log.warn?.(tag('没有 agentPresets 服务，会话将是「裸」的（只有全局工具）'))
			return {}
		}
		try {
			// No id ⇒ the configured default preset (本机是 `standard`).
			const preset = await presets.resolve()
			return {
				agentPreset: preset.id,
				setup: async (agentCtx) => {
					await presets.mount(agentCtx, preset.id)
				},
			}
		} catch (error) {
			// A broken preset must not take the whole bridge down; degrade to a
			// bare session and say so loudly.
			const message = error instanceof Error ? error.message : String(error)
			log.error?.(tag(`装配 agent preset 失败（会话将只有全局工具）: ${message}`))
			return {}
		}
	}

	/**
	 * The model selection new sessions should use.
	 * @returns {object|undefined} `{provider, model}` when the service is present.
	 */
	function currentAgentOptions() {
		try {
			const selection = ctx.agentDefaultModel?.currentSelection?.()
			if (selection?.provider !== undefined && selection?.model !== undefined) {
				return { provider: selection.provider, model: selection.model }
			}
		} catch {
			// The service is optional; a session without an explicit selection
			// simply falls back to whatever the host defaults are.
		}
		return undefined
	}

	/**
	 * One-line, user-facing summary of a turn failure.
	 *
	 * DSH records the cause of a failed turn as `turn/end` → `reason.error`,
	 * which is either an `LlmError` failure or `{ message, code }` (see
	 * `dsh-agent-loop`: `errorChain(error)`). Surfacing it is the difference
	 * between a diagnosable report and "something went wrong".
	 * @param {unknown} failure - the reason's `error` field (or any thrown value).
	 * @returns {string} a short human-readable cause.
	 */
	function describeTurnError(failure) {
		if (failure === undefined || failure === null) return '未知（DSH 没给出原因）'
		if (typeof failure === 'string') return failure.slice(0, 600)
		if (failure instanceof Error) return (failure.stack ?? failure.message ?? String(failure)).slice(0, 600)
		if (typeof failure === 'object') {
			const record = /** @type {Record<string, unknown>} */ (failure)
			const parts = []
			for (const key of ['code', 'name', 'type', 'status']) {
				const value = record[key]
				if (typeof value === 'string' && value !== '') parts.push(`[${value}]`)
				else if (typeof value === 'number') parts.push(`[${String(value)}]`)
			}
			const message = record.message
			if (typeof message === 'string' && message !== '') parts.push(message)
			else if (typeof record.reason === 'string' && record.reason !== '') parts.push(record.reason)
			if (parts.length > 0) return parts.join(' ').slice(0, 600)
			try {
				return JSON.stringify(failure).slice(0, 600)
			} catch {
				return '无法序列化的错误对象'
			}
		}
		return String(failure).slice(0, 600)
	}

	/**
	 * Send text to a chat, split across messages when long.
	 * @param {string} chatId - the destination chat.
	 * @param {string} text - the body.
	 * @returns {Promise<void>} resolves once every chunk was accepted.
	 */
	async function sendToChat(chatId, text) {
		if (api === null) {
			log.warn?.(tag('桥接未连接，消息未发出'))
			return
		}
		// Cards, not text messages: Feishu renders Markdown in cards only. A text
		// message would show every `**` and `|` literally, which is what made the
		// bridge's answers look like noise.
		for (const chunk of chunkMarkdown(text)) {
			try {
				await api.sendCard({ receiveIdType: 'chat_id', receiveId: chatId, card: markdownCard(chunk) })
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error)
				log.warn?.(tag(`卡片发送失败，退回纯文本：${detail}`))
				await api.sendText({ receiveIdType: 'chat_id', receiveId: chatId, text: toPlainText(chunk) })
			}
		}
		log.info?.(tag(`已推送到飞书 chat=${chatId} chars=${String(text.length)}`))
		status.lastPushAt = Date.now()
	}

	/**
	 * The chat a session belongs to.
	 *
	 * `chatBySession` only ever learns a mapping from an **inbound** message, so
	 * right after a restart — or when the user drives a Feishu session from the
	 * DSH GUI instead of the chat — the map is empty and a tool could not tell
	 * which chat its own session belongs to. The session id is deterministic
	 * (`feishu-<chatId>[-<n>]`), so decode it as the fallback and remember it.
	 *
	 * @param {string | undefined} sessionId - the calling session's id.
	 * @returns {string | undefined} the Feishu chat id, when this is one of ours.
	 */
	function chatOfSession(sessionId) {
		if (typeof sessionId !== 'string' || sessionId === '') return undefined
		const mapped = chatBySession.get(sessionId)
		if (mapped !== undefined) return mapped
		const decoded = decodeSessionId(sessionId)
		if (decoded === undefined) return undefined
		chatBySession.set(sessionId, decoded.chatId)
		status.chats.add(decoded.chatId)
		log.info?.(tag(`按 session id 反推出会话 ${decoded.chatId}（gen ${String(decoded.generation)}）：桥接重启后还没收到过飞书消息`))
		return decoded.chatId
	}

	// ---- 入站附件：把飞书发来的文件/图片落到工作区 --------------------------
	// 飞书消息的 `body.content` 里只有一个 file_key；真正的字节要再调一次
	// 「获取消息中的资源文件」。这里下载、落盘，然后把**本机路径**作为一轮用户
	// 输入交给 agent —— agent 用 read / read_image 就能直接处理它。

	/**
	 * Where inbound attachments land.
	 * @returns {string} an absolute directory inside the session's cwd.
	 */
	function inboxDir() {
		const cwd = String(current().cwd ?? '') || process.cwd()
		return join(cwd, 'feishu-inbox')
	}

	/**
	 * A path in `dir` that nothing occupies yet.
	 * @param {string} dir - the directory.
	 * @param {string} name - the desired filename.
	 * @returns {string} the absolute path to write.
	 */
	function uniquePath(dir, name) {
		const extension = extname(name)
		const stem = extension === '' ? name : name.slice(0, -extension.length)
		let candidate = join(dir, name)
		for (let index = 2; existsSync(candidate); index += 1) {
			candidate = join(dir, `${stem}-${String(index)}${extension}`)
		}
		return candidate
	}

	/**
	 * Render a byte count for humans.
	 * @param {number} bytes - the size.
	 * @returns {string} e.g. `1.4 MB`.
	 */
	function formatBytes(bytes) {
		if (bytes < 1024) return `${String(bytes)} B`
		const units = ['KB', 'MB', 'GB']
		let value = bytes / 1024
		let unit = 0
		while (value >= 1024 && unit < units.length - 1) {
			value /= 1024
			unit += 1
		}
		return `${value.toFixed(1)} ${units[unit]}`
	}

	/**
	 * Fetch one inbound attachment into the workspace, or explain why not.
	 *
	 * @param {string} chatId - the chat it arrived in.
	 * @param {object} message - the raw Feishu message.
	 * @returns {Promise<void>} resolves once the chat has been answered.
	 */
	async function handleAttachment(chatId, message, depth = 0) {
		// 「合并转发」不是附件，是一个装着别的消息的卡片。它的子消息可能是普通的
		// file 消息 —— 而那种是能下载的。所以先展开，再逐个走同一条路。
		if (String(message?.message_type) === 'merge_forward') {
			await expandMergeForward(chatId, message, depth)
			return
		}
		const described = describeAttachment(message)
		if (described.kind === 'unsupported') {
			log.info?.(tag(`收到不支持的消息类型 ${described.label}，已回执 chat=${chatId}`))
			// 规则：取不到内容也要**明确告诉用户发的是什么类型**，绝不沉默。
			await sendToChat(chatId, [
				`⚠️ 你发的是一个 **${described.label}** 类型的消息，我取不到里面的文件。`,
				'',
				described.reason,
			].join('\n'))
			return
		}
		if (api === null) {
			await sendToChat(chatId, '⚠️ 桥接未连接，附件取不下来。')
			return
		}

		const messageId = String(message.message_id ?? '')
		const kind = described.downloadType === 'image' ? '图片' : '文件'
		log.info?.(tag(`收到附件 ${described.name}（${described.downloadType}），开始下载 chat=${chatId}`))
		await sendToChat(chatId, `⏳ 收到${kind} **${described.name}**，正在取下来…`)

		// 大文件会走 Range 分片，一块一回调；按时间节流，别每块都发消息。
		const reportProgress = createProgressThrottle({
			intervalMs: PROGRESS_INTERVAL_MS,
			report: (line) => { void sendToChat(chatId, line).catch(() => {}) },
		})
		const { bytes, chunked } = await api.downloadResource({
			messageId,
			fileKey: described.fileKey,
			type: described.downloadType,
			onProgress: (received, total) => {
				reportProgress(() => total === undefined
					? `⏳ **${described.name}**：已下 ${formatBytes(received)}…`
					: `⏳ **${described.name}**：${formatBytes(received)} / ${formatBytes(total)}（${String(Math.round((received / total) * 100))}%）`)
			},
		})
		const inbox = inboxDir()
		mkdirSync(inbox, { recursive: true })
		const target = uniquePath(inbox, described.name)
		writeFileSync(target, bytes)
		log.info?.(tag(`附件已保存 ${target}（${String(bytes.length)} 字节${chunked ? '，Range 分片' : ''}）`))
		status.lastPushAt = Date.now()

		await sendToChat(chatId, `✅ ${kind} **${described.name}**（${formatBytes(bytes.length)}）已存到工作区：\n\n\`${target}\``)
		const agent = await agentFor(chatId)
		const attachDelivery = deliverUserMessage(agent, createUserMessage({
			content: [{
				type: 'text',
				text: [
					`（用户在飞书发来一个${kind}，桥接已下载到本机：${target}`,
					`文件名：${described.name}`,
					`大小：${String(bytes.length)} 字节）`,
					'',
					'按用户这次消息的意图处理（他只发了附件、没配文字时按下面默认）：',
					described.downloadType === 'image'
						? '· 图片 → 先用 read_image 看它，再按用户要求分析/处理；没有额外要求就简要说明画面内容'
						: '· 其他文件 → 按用户要求处理（读取、转换、上传…）；没有额外要求就先说明它是什么、需不需要你做什么',
				].join('\n'),
			}],
			source: producerSource(),
		}))
		log.info?.(tag(`附件已交给会话（投递方式=${attachDelivery}）`))
	}


	/**
	 * Hand a parsed Feishu link's content to the agent.
	 * @param {string} chatId - the chat.
	 * @param {string} text - the pasted message.
	 * @returns {Promise<boolean>} true when the link was recognised and handled.
	 */
	async function handleFeishuLink(chatId, text) {
		const link = parseFeishuLink(text)
		if (link === undefined || api === null) return false

		if (link.kind === 'folder') {
			await sendToChat(chatId, '⏳ 这是云盘文件夹链接，我递归拉取中…（文件多会慢一点）')
			const reportDrive = createProgressThrottle({
				intervalMs: PROGRESS_INTERVAL_MS,
				report: (line) => { void sendToChat(chatId, line).catch(() => {}) },
			})
			const result = await pullDriveFolder({
				folderToken: link.token,
				onProgress: (done, totalFiles, bytes) => {
					reportDrive(() => `⏳ 云盘文件夹：已拉 ${String(done)} / ${String(totalFiles)} 个文件（${formatBytes(bytes)}）`)
				},
			})
			if (!result.ok) {
				await sendToChat(chatId, `⚠️ 拉取失败（${result.reason}）——多半是机器人还没有这个文件夹的访问权，把它分享给 LUNA 再试。`)
				return true
			}
			const failedNote = result.failed.length === 0 ? '' : `\n\n⚠️ ${String(result.failed.length)} 个失败：\n${result.failed.slice(0, 5).map((line) => `· ${line}`).join('\n')}`
			await sendToChat(chatId, `✅ 拉完了：${String(result.downloaded)} 个文件 / ${String(result.folders)} 个目录 / ${formatBytes(result.bytes)}\n\n\`${result.dest}\`${failedNote}`)
			await injectUserText(chatId, `（用户在飞书发来一个云盘文件夹链接，已递归下载到本机：${result.dest}\n${String(result.downloaded)} 个文件，按原目录结构重建。要处理就直接读这些文件。）`)
			return true
		}

		if (link.kind === 'wiki') {
			const node = await api.resolveWikiNode(link.token)
			if (node.objType !== 'docx' && node.objType !== 'docs') {
				await sendToChat(chatId, `ℹ️ 这个知识库节点是 **${node.objType}**：「${node.title}」——我目前只能读 docx 文档。`)
				return true
			}
			return await readDocIntoChat(chatId, node.objToken, node.title, link.url)
		}

		if (link.kind === 'docx' || link.kind === 'docs') {
			return await readDocIntoChat(chatId, link.token, '', link.url)
		}

		await sendToChat(chatId, `ℹ️ 这是一条 **${link.kind}** 链接，我还没接它的读取接口（现在支持：docx 文档、知识库 docx 节点、云盘文件夹）。`)
		return true
	}

	/**
	 * Read a docx and hand its text to the agent.
	 * @param {string} chatId - the chat.
	 * @param {string} documentId - the docx id.
	 * @param {string} title - a known title, when we have one.
	 * @param {string} url - the original link, for the log.
	 * @returns {Promise<boolean>} always true (the link was recognised).
	 */
	async function readDocIntoChat(chatId, documentId, title, url) {
		const content = await api.readDocxText(documentId)
		const inbox = inboxDir()
		mkdirSync(inbox, { recursive: true })
		const name = safeFileName(`${title === '' ? documentId : title}.md`, `${documentId}.md`)
		const target = uniquePath(inbox, name)
		writeFileSync(target, content)
		log.info?.(tag(`已读飞书文档 ${url} → ${target}（${String(content.length)} 字符）`))
		status.lastPushAt = Date.now()
		await sendToChat(chatId, `✅ 已读这篇文档（${String(content.length)} 字符）${title === '' ? '' : `：「${title}」`}\n\n\`${target}\`\n\n---\n\n${content.slice(0, 1200)}${content.length > 1200 ? '\n\n…（完整内容已存到上面的文件）' : ''}`)
		await injectUserText(chatId, `（用户在飞书发来一篇文档链接，已存到本机：${target}\n字符数：${String(content.length)}。要分析就直接读它。）`)
		return true
	}

	/**
	 * Deliver one bridge-authored user turn (link content, attachment note…).
	 * @param {string} chatId - the chat.
	 * @param {string} text - the text to inject.
	 * @returns {Promise<void>} resolves once the message was handed over.
	 */
	async function injectUserText(chatId, text) {
		const agent = await agentFor(chatId)
		const mode = deliverUserMessage(agent, createUserMessage({
			content: [{ type: 'text', text }],
			source: producerSource(),
		}))
		log.info?.(tag(`桥接文本已交给会话（投递方式=${mode}）`))
	}


	/**
	 * Unpack a 「合并转发」 message and handle every sub-message.
	 *
	 * The sub-messages live in a hidden container chat, so this reads the
	 * message record (the event body often omits the container), then replays
	 * each sub-message through {@link handleAttachment}. That is what makes a
	 * forwarded folder worth trying: inside a merged card its contents may be
	 * ordinary `file` messages, which Feishu *does* serve.
	 *
	 * @param {string} chatId - the chat it arrived in.
	 * @param {object} message - the raw merged message.
	 * @param {number} depth - nesting guard.
	 * @returns {Promise<void>} resolves once every sub-message was handled.
	 */
	async function expandMergeForward(chatId, message, depth) {
		if (api === null) {
			await sendToChat(chatId, '⚠️ 桥接未连接，合并消息取不到。')
			return
		}
		if (depth > 2) {
			await sendToChat(chatId, '⚠️ 合并消息嵌套太深，先不展开了。')
			return
		}
		const messageId = String(message?.message_id ?? '')
		log.info?.(tag(`收到合并转发消息 ${messageId}，尝试展开 chat=${chatId}`))

		let container = mergeForwardContainer(message)
		if (container === undefined) {
			// The event body is often abridged; the message record carries it.
			const record = await api.getMessage(messageId).catch(() => undefined)
			if (record !== undefined) {
				container = mergeForwardContainer({
					content: typeof record.body?.content === 'string'
						? record.body.content
						: JSON.stringify(record.body?.content ?? {}),
				})
			}
		}
		if (container === undefined) {
			await sendToChat(chatId, '⚠️ 这是一条**合并转发**消息，但我读不到里面的子消息容器，取不到内容。')
			return
		}

		const items = await api.listChatMessages({ chatId: container })
		log.info?.(tag(`合并转发 ${messageId} 展开出 ${String(items.length)} 条子消息`))
		if (items.length === 0) {
			await sendToChat(chatId, '⚠️ 合并转发里没有读到子消息。')
			return
		}
		await sendToChat(chatId, `📦 合并转发里有 **${String(items.length)}** 条子消息，我逐个处理…`)
		for (const item of items) {
			const synthetic = {
				message_id: item.message_id,
				message_type: item.msg_type,
				content: typeof item.body?.content === 'string' ? item.body.content : JSON.stringify(item.body?.content ?? {}),
			}
			await handleAttachment(chatId, synthetic, depth + 1).catch((error) => {
				log.warn?.(tag(`子消息处理失败: ${error instanceof Error ? error.message : String(error)}`))
			})
		}
	}

	// ---- 审批：把 GUI 的权限弹窗搬到飞书卡片 ------------------------------
	// DSH 通过一组 "answerer"（`approval/request` waterfall 监听器）问权限。
	// 出厂只装了 GUI 那一个；对话发生在飞书时没人在那台机器前，请求就干等到
	// 超时或被 abort。这里注册一个飞书 answerer：**属于飞书会话的请求就地发卡片
	// 问**，其它会话原样交回 next()（GUI），所以非飞书会话的行为一点没变。

	/** 大文件下载/拉取时，进度播报的最小间隔（用户规矩：10-20 秒一次）。 */
	const PROGRESS_INTERVAL_MS = 15_000

	/** 等授权的时间上限；超时按 fail closed 处理（交回 next()）。 */
	const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000

	/** Command spellings that read or switch the session's approval policy. */
	const APPROVAL_COMMANDS = new Set(['/approval', '/审批'])

	/**
	 * Approvals waiting for a button, keyed by the opaque id in the card.
	 * @type {Map<string, {
	 *   approvalId: string, chatId: string, toolName: string,
	 *   settled: boolean, cancelled: boolean,
	 *   timer: ReturnType<typeof setTimeout> | null,
	 *   resolve: (decision: 'allow' | 'deny' | null) => void,
	 * }>}
	 */
	const pendingApprovals = new Map()
	/** Disambiguates two approvals raised in the same millisecond. */
	let approvalSeq = 0

	/**
	 * Register one pending approval.
	 * @param {object} options - the request.
	 * @param {string} options.approvalId - the id embedded in the card.
	 * @param {string} options.chatId - the Feishu chat that was asked.
	 * @param {string} options.toolName - the tool asking.
	 * @returns {object} the registry entry, carrying `answered`.
	 */
	function registerApproval({ approvalId, chatId, toolName }) {
		/** @type {any} */
		const entry = {
			approvalId,
			chatId,
			toolName,
			settled: false,
			cancelled: false,
			timer: null,
			resolve: () => {},
		}
		entry.answered = new Promise((resolve) => { entry.resolve = resolve })
		pendingApprovals.set(approvalId, entry)
		entry.timer = setTimeout(() => {
			if (entry.settled) return
			entry.settled = true
			pendingApprovals.delete(approvalId)
			log.warn?.(tag(`授权超时未答（${String(APPROVAL_TIMEOUT_MS / 1000)}s）：${toolName}`))
			entry.resolve(null)
		}, APPROVAL_TIMEOUT_MS)
		entry.timer.unref?.()
		return entry
	}

	/**
	 * Resolve one pending approval.
	 * @param {object} entry - the registry entry.
	 * @param {'allow' | 'deny' | null} decision - the decision, or null to just unblock.
	 * @returns {boolean} false when it had already settled.
	 */
	function settleApproval(entry, decision) {
		if (entry.settled) return false
		entry.settled = true
		if (entry.timer !== null) clearTimeout(entry.timer)
		pendingApprovals.delete(entry.approvalId)
		entry.resolve(decision)
		return true
	}

	/**
	 * Unblock everyone still waiting, e.g. when the bridge is torn down.
	 * @param {string} reason - what happened, for the log.
	 */
	function failPendingApprovals(reason) {
		for (const entry of pendingApprovals.values()) {
			if (entry.timer !== null) clearTimeout(entry.timer)
			entry.settled = true
			log.warn?.(tag(`放弃等待授权（${reason}）：${entry.toolName}`))
			entry.resolve(null)
		}
		pendingApprovals.clear()
	}

	/**
	 * Ask a Feishu chat to allow or deny one request.
	 *
	 * `'allowed-once'` is the only grant the approval service accepts, and it
	 * applies to this one call — so the card is deliberately not a blanket "yes".
	 *
	 * @param {string} chatId - the chat to ask in.
	 * @param {object} request - the `approval/request` payload.
	 * @param {Function} next - the rest of the answerer chain (the GUI dialog).
	 * @returns {Promise<string>} the ApprovalOutcome.
	 */
	async function askApprovalByCard(chatId, request, next) {
		const approvalId = `a${Date.now().toString(36)}-${(approvalSeq++).toString(36)}`
		const toolName = String(request?.toolName ?? '未知工具')
		const entry = registerApproval({ approvalId, chatId, toolName })
		const onAbort = () => {
			entry.cancelled = true
			settleApproval(entry, null)
		}
		request?.signal?.addEventListener?.('abort', onAbort, { once: true })

		try {
			await api.sendCard({
				receiveIdType: 'chat_id',
				receiveId: chatId,
				card: approvalCard({
					approvalId,
					toolName,
					...(typeof request?.reason === 'string' && request.reason !== '' ? { reason: request.reason } : {}),
				}),
			})
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error)
			log.warn?.(tag(`授权卡片发送失败，交回其它 answerer：${detail}`))
			settleApproval(entry, null)
			request?.signal?.removeEventListener?.('abort', onAbort)
			return next()
		}
		log.info?.(tag(`已发送授权卡片 chat=${chatId} 工具=${toolName}`))
		status.lastPushAt = Date.now()

		let decision = null
		try {
			decision = await entry.answered
		} finally {
			request?.signal?.removeEventListener?.('abort', onAbort)
		}
		if (entry.cancelled) return 'cancelled'
		if (decision === null) {
			// Nobody answered in time: hand it to the remaining answerers, which
			// fail closed when there are none — same outcome as before this
			// plugin existed, just later.
			try {
				return await next()
			} catch {
				return 'unavailable'
			}
		}
		return decision === 'allow' ? 'allowed-once' : 'rejected'
	}

	// Only our own sessions are intercepted; everything else reaches the GUI
	// answerer exactly as before.
	//
	// `prepend` is load-bearing: the answerer chain is a **sequential waterfall**,
	// and the API layer's bridge to the browser GUI registers its own listener
	// early (at boot) and parks the request on a dialog. Without `prepend`, a
	// Feishu session's request would reach the browser first and wait there
	// forever — the exact hang this answerer exists to remove.
	//
	// `global` is required for the same reason the event travels: it is dispatched
	// on the *agent's* scoped context (`ctx.waterfall(scopeTarget(agent), …)`), so
	// a listener on this plugin's context must opt out of scope filtering. Routing
	// is done by session id here, which is stricter than the scope filter anyway.
	ctx.on('approval/request', (request, next) => {
		const chatId = chatOfSession(request?.agent?.session?.id)
		if (chatId === undefined || api === null) return next()
		return askApprovalByCard(chatId, request, next)
	}, { prepend: true, global: true })

	// ---- /model: what can this harness actually talk to -------------------
	// The catalog and the card live in `./models.mjs` (no Feishu, no plugin
	// context) so both are unit-tested instead of only tried live.

	/** Command spellings that open the model switcher. */
	const MODEL_COMMANDS = new Set(['/model', '/models', '/模型'])

	/**
	 * The session controller service, when it is mounted.
	 *
	 * It owns BOTH halves of this feature — `modelCatalog()` (the same call the
	 * GUI's picker makes) and `selectModel()` — so using it keeps "what is
	 * listed" and "what a click can select" from drifting apart. Read lazily and
	 * tolerantly: a deployment without the API layer must not fail to load.
	 *
	 * @returns {object | undefined} the service.
	 */
	function sessionController() {
		try {
			return ctx.get?.('sessionController') ?? ctx.sessionController
		} catch {
			return undefined
		}
	}

	/**
	 * The deployment's default model selection.
	 * @returns {{provider: string, model: string}} the selection, empty when unknown.
	 */
	function currentSelection() {
		try {
			const selection = ctx.agentDefaultModel?.currentSelection?.()
			if (selection !== undefined) return { provider: selection.provider, model: selection.model }
		} catch {
			// Optional to read; the card is still useful without it.
		}
		return { provider: '', model: '' }
	}

	/**
	 * Read the catalog from whichever source this deployment has.
	 * @returns {Promise<{groups: Array<object>, current: {provider: string, model: string}} | undefined>} the normalized catalog.
	 */
	async function catalogForCard() {
		const controller = sessionController()
		if (typeof controller?.modelCatalog === 'function') {
			return normalizeCatalog(await controller.modelCatalog())
		}
		if (ctx.llm !== undefined) {
			return { groups: await readModelCatalog(ctx.llm), current: currentSelection() }
		}
		return undefined
	}

	/**
	 * Send the model switcher into a chat, falling back to plain text when the
	 * card cannot be delivered or the catalog cannot be read.
	 * @param {string} chatId - the Feishu chat.
	 * @returns {Promise<void>} resolves once the chat has its reply.
	 */
	async function sendModelCard(chatId) {
		const catalog = await catalogForCard()
		if (catalog === undefined) {
			await sendToChat(chatId, '⚠️ 读不到模型清单：这台 DSH 既没有 `sessionController` 也没有 `llm` 服务。')
			return
		}
		if (api !== null) {
			try {
				await api.sendCard({
					receiveIdType: 'chat_id',
					receiveId: chatId,
					card: modelCard(catalog),
				})
				status.lastPushAt = Date.now()
				log.info?.(tag(`已发送模型卡片 chat=${chatId} 分组=${String(catalog.groups.length)} 当前=${catalog.current.provider}/${catalog.current.model}`))
				return
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error)
				log.warn?.(tag(`模型卡片发送失败，退回文本: ${detail}`))
			}
		}
		await sendToChat(chatId, renderModelCatalog(catalog))
	}

	// ---- observe assistant output for our own sessions -------------------
	// Registered on the plugin ctx, which is untagged, so this listener sees
	// EVERY session in the host: filtering by our session ids is mandatory.
	ctx.on('session/event', (session, event) => {
		const sessionId = session.id
		const chatId = chatBySession.get(sessionId)
		if (chatId === undefined) return

		switch (event.type) {
			case 'assistant/message': {
				const text = (event.data?.message?.content ?? [])
					.filter((block) => block?.type === 'text' && typeof block.text === 'string')
					.map((block) => block.text)
					.join('')
				if (text.trim() !== '') pendingReply.set(sessionId, text)
				break
			}
			case 'turn/start': {
				pendingReply.delete(sessionId)
				repliedViaTool.delete(sessionId)
				break
			}
			case 'turn/end': {
				const text = pendingReply.get(sessionId)
				pendingReply.delete(sessionId)
				const usedTool = repliedViaTool.delete(sessionId)
				const reason = event.data?.reason?.kind ?? 'completed'
				if (!current().replyToChat || usedTool) break
				if (text === undefined || text.trim() === '') {
					if (reason === 'error') {
						// ⚠️ Don't just say "see the DSH UI": nobody at the Feishu end can
						// see that UI, and the real cause is right here in the event
						// (`reason.error` = { message, code }). Report it — 2026-09-29 the
						// opaque one-liner cost a whole diagnosis round trip.
						const detail = describeTurnError(event.data?.reason?.error)
						log.warn?.(tag(`这一轮出错且未产出任何文本：${detail}（session=${sessionId}）`))
						void sendToChat(chatId, `⚠️ 这一轮出错了，DSH 没有产出任何回答。\n\n**原因**：${detail}`).catch(() => {})
					}
					break
				}
				const prefix = reason === 'completed' ? '' : `⚠️ (${reason})\n`
				void sendToChat(chatId, prefix + text.trim()).catch((error) => {
					log.warn?.(tag(`回推飞书失败: ${error instanceof Error ? error.message : String(error)}`))
				})
				break
			}
			default:
				break
		}
	})

	// ---- /permission: an interactive card that switches the file policy ----
	/** Command spellings that open the permission switcher. */
	const PERMISSION_COMMANDS = new Set(['/permission', '/perm', '/权限', '/p'])

	/**
	 * The sandbox mode currently in effect for one session.
	 * @param {object} session - a DSH session.
	 * @returns {string} the effective mode.
	 */
	function currentModeOf(session) {
		try {
			return ctx.sandboxPolicy?.overrideOf?.(session)
				?? ctx.sandboxPolicy?.defaultMode
				?? 'workspace-write'
		} catch {
			// The policy service is optional to *read*; fall back to the safest
			// useful default rather than failing the card.
			return 'workspace-write'
		}
	}

	/**
	 * Apply a sandbox mode to a chat's session and rebuild the card.
	 *
	 * `setSandboxMode` appends a `sandbox/mode` event to the session — the same
	 * thing the GUI's permission switch does — so the change takes effect on
	 * the next tool call and is recorded in the session log.
	 *
	 * @param {string} chatId - the Feishu chat.
	 * @param {string} mode - the mode to apply.
	 * @returns {Promise<object>} the card reflecting the new state.
	 */
	async function applyPermissionMode(chatId, mode) {
		const agent = await agentFor(chatId)
		setSandboxMode(agent.session, mode)
		log.info?.(tag(`文件权限切换 → ${mode}（session ${agent.session.id}）`))
		return permissionCard({ chatId, currentMode: mode, modes: SANDBOX_MODES })
	}

	/**
	 * Send the permission card into a chat.
	 * @param {string} chatId - the Feishu chat.
	 * @returns {Promise<void>} resolves once the card was accepted.
	 */
	async function sendPermissionCard(chatId) {
		if (api === null) return
		// Ensure the session exists: the card shows *its* mode, and a button
		// needs a session to write the mode event to.
		const agent = await agentFor(chatId)
		await api.sendCard({
			receiveIdType: 'chat_id',
			receiveId: chatId,
			card: permissionCard({ chatId, currentMode: currentModeOf(agent.session), modes: SANDBOX_MODES }),
		})
		log.info?.(tag(`已发送权限卡片 chat=${chatId}`))
	}

	// ---- feishu_ask: a question card that lives where the user actually is --
	// `ask_user_question` opens a GUI dialog on the machine running DSH. When the
	// conversation is happening in Feishu there is nobody in front of that GUI,
	// so the question just stalls the turn. A card carries the same question and
	// options into the chat, and the click resolves this promise.

	/**
	 * Register a question and return the promise its button click resolves.
	 *
	 * @param {object} options - the question.
	 * @param {string} options.chatId - the chat to ask in.
	 * @param {string} options.question - the question body.
	 * @param {readonly string[]} options.options - the answer buttons.
	 * @param {number} options.waitMs - how long before the asker gives up.
	 * @returns {{questionId: string, answered: Promise<string | null>}} the id to put in the card and the answer promise.
	 */
	function registerQuestion({ chatId, question, options, waitMs }) {
		const questionId = `q${Date.now().toString(36)}-${(questionSeq++).toString(36)}`
		const entry = {
			questionId,
			chatId,
			question,
			options,
			settled: false,
			expired: false,
			/** @type {ReturnType<typeof setTimeout> | null} */ timer: null,
			/** @type {ReturnType<typeof setTimeout> | null} */ graceTimer: null,
			/** @type {(label: string | null) => void} */ resolve: () => {},
		}
		const answered = new Promise((resolve) => { entry.resolve = resolve })
		pendingQuestions.set(questionId, entry)

		const giveUp = () => {
			entry.timer = null
			entry.expired = true
			entry.settled = true
			log.warn?.(tag(`问题超时未答（${String(Math.round(waitMs / 1000))}s），本轮按"没回答"继续`))
			entry.resolve(null)
			// Keep the card answerable for a while longer; a late click becomes an
			// ordinary message instead of vanishing.
			entry.graceTimer = setTimeout(() => { pendingQuestions.delete(questionId) }, ASK_LATE_GRACE_MS)
			entry.graceTimer.unref?.()
		}
		entry.timer = setTimeout(giveUp, waitMs)
		// A timer must never hold the host process open.
		entry.timer.unref?.()
		return { questionId, answered }
	}

	/**
	 * Resolve a pending question with the clicked option.
	 * @param {object} entry - the registry entry.
	 * @param {string} label - the chosen option.
	 * @returns {boolean} false when the question had already settled.
	 */
	function settleQuestion(entry, label) {
		if (entry.settled) return false
		entry.settled = true
		if (entry.timer !== null) clearTimeout(entry.timer)
		if (entry.graceTimer !== null) clearTimeout(entry.graceTimer)
		pendingQuestions.delete(entry.questionId)
		entry.resolve(label)
		return true
	}

	/**
	 * The unanswered question for a chat, if any.
	 * @param {string} chatId - the Feishu chat.
	 * @returns {object | undefined} the live entry.
	 */
	function pendingQuestionFor(chatId) {
		for (const entry of pendingQuestions.values()) {
			if (entry.chatId === chatId && !entry.settled) return entry
		}
		return undefined
	}

	/**
	 * Unblock everyone still waiting, e.g. when the bridge is torn down.
	 * @param {string} reason - what happened, for the log.
	 */
	function failPendingQuestions(reason) {
		for (const entry of pendingQuestions.values()) {
			if (entry.timer !== null) clearTimeout(entry.timer)
			if (entry.graceTimer !== null) clearTimeout(entry.graceTimer)
			entry.settled = true
			log.warn?.(tag(`放弃等待回答（${reason}）`))
			entry.resolve(null)
		}
		pendingQuestions.clear()
	}

	/**
	 * Deliver a click that arrived after the asker stopped waiting.
	 *
	 * Losing it would be the worst outcome — the user made a choice and nothing
	 * happened — so it is re-injected as a plain chat message and becomes a new
	 * turn.
	 *
	 * @param {object} entry - the expired registry entry.
	 * @param {string} label - the chosen option.
	 * @returns {Promise<void>} resolves once the message was handed over.
	 */
	async function deliverLateAnswer(entry, label) {
		pendingQuestions.delete(entry.questionId)
		if (entry.graceTimer !== null) clearTimeout(entry.graceTimer)
		log.info?.(tag(`卡片回答迟到，按普通消息投递: ${label}`))
		const agent = await agentFor(entry.chatId)
		const mode = deliverUserMessage(agent, createUserMessage({
			content: [{ type: 'text', text: label }],
			source: producerSource(),
		}))
		log.info?.(tag(`迟到的卡片回答已交给会话（投递方式=${mode}）`))
	}

	/**
	 * Handle a card button click.
	 *
	 * Whatever this returns becomes the card-callback response: Feishu shows the
	 * toast and swaps the card for `card.data` in place.
	 *
	 * @param {object} envelope - the `card.action.trigger` envelope.
	 * @returns {Promise<object|undefined>} the callback response.
	 */
	async function handleCardAction(envelope) {
		const event = envelope?.event ?? {}
		const chatId = String(event.context?.open_chat_id ?? event.open_chat_id ?? '')
		const value = event.action?.value

		// ---- feishu_ask form: resolve the waiting tool call ----
		const asked = parseQuestionAction(event.action)
		if (asked !== null) {
			// Kept in the log on purpose: the exact shape of a form submission is
			// worth being able to see when a card misbehaves.
			log.debug?.(tag(`卡片回传 tag=${String(event.action?.tag)} actionKeys=${Object.keys(event.action ?? {}).join(',')}`))
			if (chatId === '') return undefined
			status.chats.add(chatId)
			// A bare input submission (the field's own submit icon) carries no
			// question id; with exactly one question outstanding in this chat the
			// note can only be meant for it.
			const entry = asked.questionId !== ''
				? pendingQuestions.get(asked.questionId)
				: pendingQuestionFor(chatId)
			if (entry === undefined) return { toast: questionErrorToast('这个问题已经结束了') }
			if (entry.chatId !== chatId) return { toast: questionErrorToast('这个问题不是发给这个会话的') }

			const label = entry.options[asked.index]
			const note = asked.note
			const card = answeredQuestionCard({ question: entry.question, label: label ?? '', note })

			if (label === undefined) {
				// Note without a choice: treat it as the free-text answer, exactly
				// like replying in the chat.
				const text = note !== '' ? note : ''
				if (text === '') return { toast: questionErrorToast('没看懂这次提交，请点一个按钮') }
				if (entry.expired) {
					await deliverLateAnswer(entry, text).catch(() => {})
				} else {
					settleQuestion(entry, text)
				}
				log.info?.(tag(`卡片文字回答 chat=${chatId}: ${text.slice(0, 60)}`))
				return questionResponse(text, answeredQuestionCard({ question: entry.question, label: '', note }))
			}

			const answer = note === '' ? label : `${label} —— 补充：${note}`
			if (entry.expired) {
				await deliverLateAnswer(entry, answer).catch((error) => {
					log.warn?.(tag(`迟到回答投递失败: ${error instanceof Error ? error.message : String(error)}`))
				})
				return { toast: questionErrorToast('这条回答到得有点晚，已当作新消息发出'), card: { type: 'raw', data: card } }
			}
			settleQuestion(entry, answer)
			log.info?.(tag(`卡片回答 chat=${chatId}: ${answer}`))
			return questionResponse(label, card)
		}

		// ---- 审批卡片：把决定交回等待中的 approval/request ----
		const approval = parseApprovalAction(value)
		if (approval !== null) {
			if (chatId === '') return undefined
			status.chats.add(chatId)
			const entry = pendingApprovals.get(approval.approvalId)
			if (entry === undefined) return { toast: { type: 'error', content: '这条授权请求已经结束了' } }
			if (entry.chatId !== chatId) return { toast: { type: 'error', content: '这条授权不是发给这个会话的' } }
			const applied = settleApproval(entry, approval.decision)
			log.info?.(tag(`授权决定 chat=${chatId} 工具=${entry.toolName} → ${approval.decision}${applied ? '' : '（已超时）'}`))
			return {
				toast: {
					type: applied ? 'success' : 'warning',
					content: applied
						? (approval.decision === 'allow' ? '已允许一次' : '已拒绝')
						: '这条授权已经超时了',
				},
				card: { type: 'raw', data: answeredApprovalCard({ toolName: entry.toolName, decision: approval.decision }) },
			}
		}

		// ---- /model buttons: switch this session's model ----
		const wanted = parseModelAction(value)
		if (wanted !== null) {
			if (chatId === '') return undefined
			status.chats.add(chatId)
			const controller = sessionController()
			if (typeof controller?.selectModel !== 'function') {
				return { toast: { type: 'error', content: '这台 DSH 没挂载 sessionController，切不了模型' } }
			}
			try {
				const agent = await agentFor(chatId)
				// The service validates the route and records a durable
				// `model/selection` event on this session — the exact path the
				// GUI's picker takes, so nothing here can disagree with the GUI.
				const result = await controller.selectModel({
					sessionId: agent.session.id,
					provider: wanted.provider,
					model: wanted.model,
				})
				const selected = result?.selected ?? wanted
				log.info?.(tag(`模型切换 chat=${chatId} → ${String(selected.provider)}/${String(selected.model)}`))
				const catalog = await catalogForCard()
				return {
					toast: { type: 'success', content: `已切到 ${String(selected.model)}` },
					...(catalog === undefined
						? {}
						: { card: { type: 'raw', data: modelCard(catalog) } }),
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				log.warn?.(tag(`模型切换失败 chat=${chatId}: ${message}`))
				return { toast: { type: 'error', content: `切换失败：${message}` } }
			}
		}

		// ---- /sessions buttons: point this chat at another conversation ----
		const wantedSession = parseSessionAction(value)
		if (wantedSession !== null) {
			if (chatId === '') return undefined
			status.chats.add(chatId)
			try {
				// The button is only a shorter way to type `/open <n>`: the same
				// call moves the durable pointer and resumes that generation.
				await conversations.open(chatId, String(wantedSession.generation))
				log.info?.(tag(`卡片切换会话 chat=${chatId} → #${String(wantedSession.generation)}`))
				const overview = await conversations.overview(chatId)
				return {
					toast: { type: 'success', content: `已切到 #${String(wantedSession.generation)}` },
					card: { type: 'raw', data: sessionCard(overview) },
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				log.warn?.(tag(`卡片切换会话失败 chat=${chatId}: ${message}`))
				return { toast: { type: 'error', content: message } }
			}
		}

		const parsed = parsePermissionAction(value, SANDBOX_MODES)
		if (parsed === null) return undefined
		if (chatId === '') return undefined
		status.chats.add(chatId)

		const allowed = current().allowedChatIds ?? []
		if (allowed.length > 0 && !allowed.includes(chatId)) {
			log.warn?.(tag(`拒绝未授权会话的权限切换 ${chatId}`))
			return { toast: permissionErrorToast('这个会话不在允许列表里') }
		}

		try {
			return permissionResponse(parsed.mode, await applyPermissionMode(chatId, parsed.mode))
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			log.warn?.(tag(`权限切换失败: ${message}`))
			return { toast: permissionErrorToast(`切换失败：${message}`) }
		}
	}

	// ---- /new, /sessions, /open: the chat's conversation generations -----
	// The semantics live in `./conversations.mjs`, wired to the two things only
	// this file owns: the session factory and the session-title service.
	const conversations = new ConversationBook({
		sessionQuery: ctx.sessionQuery,
		ensureAgent: (chatId, generation) => agentForGeneration(chatId, generation),
		modeOf: (session) => currentModeOf(session),
		applyMode: (session, mode) => { setSandboxMode(session, mode) },
		// Resolved per call: the title service may mount after this plugin.
		titles: () => ctx.get?.('sessionTitle'),
		pointers,
		warn: (message) => { log.warn?.(tag(message)) },
	})

	/**
	 * Send the conversation switcher into a chat, falling back to plain text when
	 * the card cannot be delivered.
	 *
	 * `/sessions` used to answer with a list the user had to read a number out of
	 * and retype as `/open <n>`; now the listing itself is the switcher.
	 *
	 * @param {string} chatId - the Feishu chat.
	 * @returns {Promise<void>} resolves once the chat has its reply.
	 */
	async function sendSessionsCard(chatId) {
		const overview = await conversations.overview(chatId)
		if (api !== null) {
			try {
				await api.sendCard({
					receiveIdType: 'chat_id',
					receiveId: chatId,
					card: sessionCard(overview),
				})
				status.lastPushAt = Date.now()
				log.info?.(tag(`已发送会话卡片 chat=${chatId} 共 ${String(overview.items.length)} 段，当前 #${String(overview.current)}`))
				return
			} catch (error) {
				const detail = error instanceof Error ? error.message : String(error)
				log.warn?.(tag(`会话卡片发送失败，退回文本: ${detail}`))
			}
		}
		await sendToChat(chatId, renderSessions(overview))
	}

	// ---- inbound: one Feishu message becomes one DSH turn ----------------
	/**
	 * Handle one inbound event envelope.
	 * @param {object} envelope - the `schema 2.0` event body.
	 * @returns {Promise<object|void>} a card-callback response, when one is due.
	 */
	async function onEvent(envelope) {
		const type = envelope?.header?.event_type
		status.lastEventAt = Date.now()
		status.lastEventType = type ?? null
		if (type === 'card.action.trigger') return handleCardAction(envelope)
		if (type !== 'im.message.receive_v1') return
		const message = envelope?.event?.message ?? {}
		const sender = envelope?.event?.sender ?? {}

		// Never react to the bot's own posts.
		if (sender.sender_type !== undefined && sender.sender_type !== 'user') return

		const messageId = String(message.message_id ?? '')
		if (messageId === '' || isDuplicate(messageId)) return

		const chatId = String(message.chat_id ?? '')
		if (chatId === '') return
		status.chats.add(chatId)

		const allowed = current().allowedChatIds ?? []
		if (allowed.length > 0 && !allowed.includes(chatId)) {
			log.debug?.(tag(`忽略未授权会话 ${chatId}`))
			return
		}

		const text = messageText(message)
		if (text === '') {
			// Not text: an attachment, or something we cannot read. Silence here is
			// what made "I sent you a file and nothing happened" feel broken, so
			// either fetch it into the workspace or say why not.
			if (current().ackReaction && api !== null) {
				void api.addReaction({ messageId }).catch(() => {})
			}
			await handleAttachment(chatId, message).catch((error) => {
				const detail = error instanceof Error ? error.message : String(error)
				log.warn?.(tag(`附件处理失败: ${detail}`))
				void sendToChat(chatId, `⚠️ 收到你的附件，但处理失败：${detail}`).catch(() => {})
			})
			return
		}

		if (current().ackReaction && api !== null) {
			// Best-effort "seen it"; a failure here must not drop the message.
			void api.addReaction({ messageId }).catch(() => {})
		}

		// A slash command is handled here instead of being sent to the model:
		// `/permission` opens the switcher, `/permission <mode>` applies one,
		// and `/new` / `/sessions` / `/open` manage conversation generations.
		const [head = '', argument = ''] = text.trim().split(/\s+/)
		const command = head.toLowerCase()
		if (PERMISSION_COMMANDS.has(command)) {
			log.info?.(tag(`收到权限命令 chat=${chatId} arg=${argument || '(无)'}`))
			try {
				if (SANDBOX_MODES.includes(argument)) {
					await applyPermissionMode(chatId, argument)
					await sendToChat(chatId, `✅ 文件权限已切换到 ${modeLabel(argument)}`)
				} else {
					await sendPermissionCard(chatId)
				}
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error)
				log.warn?.(tag(`权限命令处理失败: ${reason}`))
				void sendToChat(chatId, `⚠️ 权限操作失败：${reason}`).catch(() => {})
			}
			return
		}

		// `/model` opens the switcher card.
		if (MODEL_COMMANDS.has(command)) {
			log.info?.(tag(`收到模型命令 chat=${chatId}`))
			try {
				await sendModelCard(chatId)
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error)
				log.warn?.(tag(`模型清单读取失败: ${reason}`))
				void sendToChat(chatId, `⚠️ 模型清单读取失败：${reason}`).catch(() => {})
			}
			return
		}

		// `/approval` reads or switches this session's approval policy — the switch
		// that decides whether the authorization card is ever asked for.
		if (APPROVAL_COMMANDS.has(command)) {
			log.info?.(tag(`收到审批策略命令 chat=${chatId} arg=${argument || '(无)'}`))
			try {
				const service = ctx.approval
				if (service === undefined) {
					await sendToChat(chatId, '⚠️ 这台 DSH 没有挂载 `approval` 服务。')
					return
				}
				const agent = await agentFor(chatId)
				const override = service.overrideOf?.(agent.session)
				const fallback = service.config?.policy ?? 'ask'
				const effective = override ?? fallback
				if (argument === 'ask' || argument === 'never') {
					service.setPolicy(agent, argument)
					await sendToChat(chatId, argument === 'ask'
						? '✅ 审批策略 → **ask**\n\n之后需要授权的操作会**推卡片**给你，点一下才放行。'
						: '✅ 审批策略 → **never**\n\n之后需要授权的操作会**直接拒绝**，不会再问你（也就不会有卡片）。')
				} else if (argument !== '') {
					await sendToChat(chatId, '用法：`/approval` 看当前策略，`/approval ask` 或 `/approval never` 切换。')
				} else {
					await sendToChat(chatId, [
						`🔐 审批策略：**${String(effective)}**`,
						'',
						`· 本会话覆盖：${override === undefined ? '（无）' : `\`${String(override)}\``}`,
						`· 部署默认：\`${String(fallback)}\``,
						'',
						effective === 'never'
							? '⚠️ 现在是 `never`：需要授权的操作会被**直接拒绝**，不会有卡片。要卡片就 `/approval ask`。'
							: '需要授权的操作会推卡片给你。',
					].join('\n'))
				}
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error)
				log.warn?.(tag(`审批策略命令失败: ${reason}`))
				void sendToChat(chatId, `⚠️ 审批策略操作失败：${reason}`).catch(() => {})
			}
			return
		}

		if (conversations.matches(command)) {
			log.info?.(tag(`收到会话命令 chat=${chatId} cmd=${command} arg=${argument || '(无)'}`))
			try {
				// The listing is a card with one button per conversation; `/new`
				// and `/open` still answer with text.
				if (LIST_COMMANDS.has(command)) {
					await sendSessionsCard(chatId)
				} else {
					await sendToChat(chatId, await conversations.run(chatId, command, argument))
				}
			} catch (error) {
				const reason = error instanceof Error ? error.message : String(error)
				log.warn?.(tag(`会话命令 ${command} 失败: ${reason}`))
				void sendToChat(chatId, `⚠️ 会话命令失败：${reason}`).catch(() => {})
			}
			return
		}

		// A plain reply while a question card is waiting *is* the answer: the user
		// typed instead of clicking. Hand it to the tool call that is waiting
		// rather than starting a second, competing turn. Slash commands were
		// already handled above, so `/permission` still works mid-question.
		const waiting = pendingQuestionFor(chatId)
		if (waiting !== undefined) {
			log.info?.(tag(`以文字回答待答问题 chat=${chatId}: ${text.slice(0, 40)}`))
			settleQuestion(waiting, text)
			return
		}

		// A message that is nothing but a Feishu link is a request to fetch it.
		if (isBareLink(text)) {
			const handled = await handleFeishuLink(chatId, text).catch((error) => {
				const detail = error instanceof Error ? error.message : String(error)
				log.warn?.(tag(`链接处理失败: ${detail}`))
				void sendToChat(chatId, `⚠️ 这条链接我没能处理：${detail}`).catch(() => {})
				return false
			})
			if (handled) return
		}

		log.info?.(tag(`收到飞书消息 chat=${chatId} len=${String(text.length)}`))
		const agent = await agentFor(chatId)
		try {
			// Default is `steer` (插队): a turn that is already running picks this
			// up at its next step boundary instead of finishing first. See
			// `sendMode` in Config and `deliverUserMessage`.
			const running = agent.status === 'running'
			const mode = deliverUserMessage(agent, createUserMessage({
				content: [{ type: 'text', text }],
				source: producerSource(),
			}))
			log.info?.(tag(`消息已交给会话（投递方式=${mode}${running ? '，当时有任务在跑' : '，会话空闲'}）`))
		} catch (error) {
			// A synchronous throw here means no turn ever started, so the
			// `turn/end` handler can never report it — say it out loud instead of
			// dropping the message on the floor.
			const detail = describeTurnError(error)
			log.warn?.(tag(`投递这一轮失败（followup/steer 抛错）: ${detail}`))
			void sendToChat(chatId, `⚠️ 没能把这条消息交给 DSH：${detail}`).catch(() => {})
		}
	}

	// ---- a tool so the agent can push to Feishu on its own ---------------
	ctx.tools.register(defineTool({
		name: 'feishu_send',
		description: 'Send a message to a Feishu chat through the running dsh-feishu bridge. Use it to proactively report progress on long-running work, or to answer when you were asked to push something to Feishu. Markdown is welcome (the bridge renders it in a card; plain Feishu text would show the markup literally). Omit chat_id to reply to the chat that most recently messaged this agent.',
		parameters: {
			text: { type: 'string', required: true, description: 'Message body to send.' },
			chat_id: { type: 'string', description: 'Target Feishu chat id (oc_...). Defaults to the most recent chat that talked to this agent.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					chatId: { type: 'string', required: true },
					sent: { type: 'boolean', required: true },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.sent
					? `Sent to Feishu chat ${value.chatId}. Do not repeat the message in your reply.`
					: 'Feishu bridge is not connected; nothing was sent.',
			}],
		},
		async execute(args, exec) {
			const explicit = typeof args.chat_id === 'string' && args.chat_id !== '' ? args.chat_id : undefined
			const sessionId = exec.agent?.session?.id
			const chatId = explicit ?? chatOfSession(sessionId)
			if (chatId === undefined || api === null) return { chatId: '', sent: false }
			if (sessionId !== undefined) repliedViaTool.add(sessionId)
			await sendToChat(chatId, String(args.text))
			return { chatId, sent: true }
		},
	}))

	// ---- 云盘文件夹：递归下载 + 按原结构重建 ------------------------------
	// 聊天里直接发的「文件夹」消息（`msg_type=folder`）是**不透明资源**：整包下载报
	// 234037、Range 分片报 500/40009、token 也查不到云文档元数据（都实测过），所以
	// 那种消息取不到内容。**云文档（Drive）的文件夹**则可以列目录、逐个下载 ——
	// 这个工具就是干这个的。
	ctx.tools.register(defineTool({
		name: 'feishu_drive_pull',
		description: 'Recursively download a Feishu Drive (云文档) folder into the workspace, recreating its directory structure. Use this when the user gives a Feishu folder LINK. Not applicable to a "folder" chat message (msg_type=folder): that one is an opaque resource Feishu refuses to serve — for that, tell the user to share the folder from Drive instead, or send the files individually.',
		parameters: {
			folder: { type: 'string', required: true, description: '飞书文件夹链接（https://xxx.feishu.cn/drive/folder/<token>）或裸 folder_token。' },
			dest: { type: 'string', description: '目标目录；默认 <会话 cwd>/feishu-inbox/<token>。' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					ok: { type: 'boolean', required: true },
					reason: { type: 'string', required: true },
					dest: { type: 'string', required: true },
					folders: { type: 'integer', required: true },
					downloaded: { type: 'integer', required: true },
					bytes: { type: 'integer', required: true },
					failed: { type: 'array', required: true, items: { type: 'string' } },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.ok === true
					? `云盘文件夹已拉到 ${value.dest}：${String(value.downloaded)} 个文件 / ${String(value.folders)} 个目录 / ${formatBytes(value.bytes)}${value.failed.length === 0 ? '' : `（${String(value.failed.length)} 个失败）`}`
					: `拉取失败（${value.reason}）`,
			}],
		},
		async execute(args) {
			const token = parseDriveFolderRef(args.folder)
			if (token === undefined) {
				return { ok: false, reason: 'bad-folder', dest: '', folders: 0, downloaded: 0, bytes: 0, failed: [] }
			}
			if (api === null) {
				return { ok: false, reason: 'bridge-offline', dest: '', folders: 0, downloaded: 0, bytes: 0, failed: [] }
			}
			const explicit = typeof args.dest === 'string' && args.dest !== '' ? args.dest : undefined
			return pullDriveFolder({ folderToken: token, ...(explicit === undefined ? {} : { dest: explicit }) })
		},
	}))

	/**
	 * Walk a Drive folder into the workspace, recreating its structure.
	 *
	 * Shared by the tool and by the bare-link handler, so a pasted folder link
	 * behaves exactly like an explicit tool call.
	 *
	 * @param {object} options - what to pull.
	 * @param {string} options.folderToken - the Drive folder token.
	 * @param {string} [options.dest] - destination root; defaults under the inbox.
	 * @returns {Promise<{ok: boolean, reason: string, dest: string, folders: number, downloaded: number, bytes: number, failed: string[]}>} the summary.
	 */
	async function pullDriveFolder({ folderToken, dest, onProgress }) {
		if (api === null) return { ok: false, reason: 'bridge-offline', dest: '', folders: 0, downloaded: 0, bytes: 0, failed: [] }
		const root = dest ?? join(inboxDir(), folderToken)
		const tree = await walkDriveFolder({
			folderToken,
			list: (token, pageToken) => api.listDriveFiles({ folderToken: token, pageToken }),
		})
		log.info?.(tag(`云盘文件夹 ${folderToken}：${String(tree.folders)} 个目录 / ${String(tree.files.length)} 个文件`))

		/** @type {string[]} */
		const failed = []
		let downloaded = 0
		let bytes = 0
		for (const file of tree.files) {
			try {
				const content = await api.downloadDriveFile({ fileToken: file.token })
				const target = join(root, file.path)
				mkdirSync(dirname(target), { recursive: true })
				writeFileSync(target, content)
				downloaded += 1
				bytes += content.length
				onProgress?.(downloaded, tree.files.length, bytes)
			} catch (error) {
				failed.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`)
			}
		}
		log.info?.(tag(`云盘文件夹已落地 ${root}：${String(downloaded)} 个文件，${String(failed.length)} 个失败`))
		return { ok: true, reason: 'ok', dest: root, folders: tree.folders, downloaded, bytes, failed: failed.slice(0, 20) }
	}

	// ---- ask the user a question with real buttons -----------------------
	// The GUI's `ask_user_question` cannot reach a Feishu user, so this is its
	// counterpart for this channel: same intent, but the options are buttons in
	// the chat and the call blocks until one is clicked (or the text reply
	// arrives, or the deadline passes).
	ctx.tools.register(defineTool({
		name: 'feishu_ask',
		description: 'Ask the user a question through Feishu and wait for the answer. Use this INSTEAD of ask_user_question whenever the conversation is happening in Feishu: ask_user_question pops a dialog on the DSH machine that the Feishu user cannot see, so the turn stalls. This sends an interactive card with one button per option — plus a free-text field the user can fill in to add detail — and returns the chosen option; when a note was typed it comes back appended as "选项 —— 补充：…". The user may also reply with plain text (which counts as the answer) or submit only the note. Returns answered=false with a reason when nobody answers in time. If the current session is not a Feishu conversation, it returns answered=false / reason="not-feishu" and you should fall back to ask_user_question.',
		parameters: {
			question: { type: 'string', required: true, description: 'The question to ask. Markdown is allowed.' },
			options: {
				type: 'array',
				required: true,
				items: { type: 'string' },
				description: 'Two to six short answer buttons. Put the recommended option first: it is rendered as the emphasized button.',
			},
			header: { type: 'string', description: 'Card title. Defaults to "❓ 需要你选一个".' },
			hint: { type: 'string', description: 'Small print under the question, e.g. what each option costs.' },
			timeout_seconds: { type: 'integer', description: `How long to wait before giving up. Default 600, clamped to ${String(ASK_TIMEOUT_MIN_S)}-${String(ASK_TIMEOUT_MAX_S)}.` },
			chat_id: { type: 'string', description: 'Target Feishu chat id (oc_...). Defaults to the chat this agent is talking to.' },
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					answered: { type: 'boolean', required: true },
					choice: { type: 'string', required: true },
					reason: { type: 'string', required: true },
					chatId: { type: 'string', required: true },
				},
			},
			render: (_args, value) => [{
				type: 'text',
				text: value.answered === true
					? `Feishu 回答：${value.choice}`
					: `Feishu 未收到回答（${value.reason}）`,
			}],
		},
		async execute(args, exec) {
			const explicit = typeof args.chat_id === 'string' && args.chat_id !== '' ? args.chat_id : undefined
			const sessionId = exec.agent?.session?.id
			const chatId = explicit ?? chatOfSession(sessionId)
			if (chatId === undefined) {
				// A GUI (or any non-Feishu) session: say so plainly so the model
				// switches to the tool that works there.
				return { answered: false, choice: '', reason: 'not-feishu', chatId: '' }
			}
			if (api === null) return { answered: false, choice: '', reason: 'bridge-offline', chatId }

			const options = (Array.isArray(args.options) ? args.options : [])
				.map((option) => String(option).trim())
				.filter((option) => option !== '')
			if (options.length === 0) return { answered: false, choice: '', reason: 'no-options', chatId }
			if (options.length > 6) options.length = 6

			const seconds = Number.isFinite(args.timeout_seconds) ? Number(args.timeout_seconds) : ASK_TIMEOUT_MS / 1000
			const waitMs = Math.min(Math.max(seconds, ASK_TIMEOUT_MIN_S), ASK_TIMEOUT_MAX_S) * 1000
			const question = String(args.question ?? '')

			const { questionId, answered } = registerQuestion({ chatId, question, options, waitMs })

			// Drop the question if the caller aborts (user hit stop, turn was
			// cancelled): otherwise the entry would outlive its tool call.
			const onAbort = () => { failQuestion(questionId, '调用被取消') }
			exec.signal?.addEventListener?.('abort', onAbort, { once: true })

			try {
				await api.sendCard({
					receiveIdType: 'chat_id',
					receiveId: chatId,
					card: questionCard({
						questionId,
						question,
						options,
						...(typeof args.header === 'string' && args.header !== '' ? { header: args.header } : {}),
						...(typeof args.hint === 'string' && args.hint !== '' ? { hint: args.hint } : {}),
					}),
				})
			} catch (error) {
				failQuestion(questionId, '卡片发送失败')
				const detail = error instanceof Error ? error.message : String(error)
				log.warn?.(tag(`问题卡片发送失败 chat=${chatId}: ${detail}`))
				return { answered: false, choice: '', reason: 'send-failed', chatId }
			}
			log.info?.(tag(`已发送问题卡片 chat=${chatId} 选项=${String(options.length)} 等待=${String(Math.round(waitMs / 1000))}s`))
			status.lastPushAt = Date.now()

			let choice = null
			try {
				choice = await answered
			} finally {
				exec.signal?.removeEventListener?.('abort', onAbort)
			}

			if (choice === null) {
				return { answered: false, choice: '', reason: exec.signal?.aborted === true ? 'aborted' : 'timeout', chatId }
			}
			return { answered: true, choice, reason: 'answered', chatId }
		},
	}))

	/**
	 * Remove one waiting question without answering it.
	 * @param {string} questionId - the question to drop.
	 * @param {string} why - reason for the log.
	 */
	function failQuestion(questionId, why) {
		const entry = pendingQuestions.get(questionId)
		if (entry === undefined) return
		if (entry.timer !== null) clearTimeout(entry.timer)
		if (entry.graceTimer !== null) clearTimeout(entry.graceTimer)
		entry.settled = true
		pendingQuestions.delete(questionId)
		log.warn?.(tag(`放弃问题（${why}）`))
		entry.resolve(null)
	}

	// ---- lifecycle: connect the long connection, and tear it down cleanly --
	/** Closes whatever the currently running bridge started. */
	let stopBridge = () => {}
	/** Set once the fiber unloads, so a late settings change cannot revive it. */
	let disposed = false
	/** Signature of the config the running bridge was built from, for idempotence. */
	let runningSignature = null

	/**
	 * (Re)configure the bridge from the current settings. Runs once at load and
	 * again on every settings change, so flipping the switch in the GUI takes
	 * effect without restarting DSH. Restarting is skipped when nothing that
	 * matters changed — mounting the settings section re-emits `onChange` once,
	 * and that must not cost a second handshake.
	 */
	function startBridge() {
		const { enabled, appId, appSecret, domain } = current()
		const signature = JSON.stringify([enabled, appId, appSecret, domain])
		if (signature === runningSignature) return

		stopBridge()
		runningSignature = signature
		if (disposed) return

		if (enabled !== true) {
			log.info?.(tag('未启用：在「设置 → 飞书」里打开开关并填好 App ID / App Secret'))
			return
		}
		if (typeof appId !== 'string' || appId === '' || typeof appSecret !== 'string' || appSecret === '') {
			log.warn?.(tag('已启用但缺少 App ID / App Secret，暂不连接'))
			return
		}

		const nextApi = new FeishuApi({ appId, appSecret, domain, logger: log })
		const nextConnection = new FeishuLongConnection({
			appId,
			appSecret,
			domain,
			logger: log,
			onEvent,
			onStatus: (next) => {
				log.debug?.(tag(`长连接状态: ${JSON.stringify(next)}`))
				status.connected = next.state === 'connected'
				if (next.state === 'connected') status.serviceId = Number(next.serviceId ?? 0)
				if (next.state === 'failed' || next.state === 'discovery-failed') {
					status.lastError = String(next.msg ?? next.state)
				}
			},
		})
		api = nextApi
		connection = nextConnection
		status.startedAt = Date.now()
		status.connected = false
		status.serviceId = 0
		status.lastError = null
		status.lastEventAt = null
		status.lastEventType = null
		status.lastPushAt = null
		log.info?.(tag(`桥接启动 appId=${appId} domain=${domain}`))
		nextConnection.start()

		stopBridge = () => {
			nextConnection.close()
			status.connected = false
			if (connection === nextConnection) connection = null
			if (api === nextApi) api = null
			sessionByChat.clear()
			chatBySession.clear()
			pendingReply.clear()
			repliedViaTool.clear()
			seenMessages.clear()
			// Nobody can click a button once the socket is gone, so no tool call
			// may stay parked on one.
			failPendingQuestions('桥接停止')
			failPendingApprovals('桥接停止')
		}
	}

	ctx.effect(() => {
		startBridge()
		return () => {
			disposed = true
			stopBridge()
		}
	}, 'dsh-feishu.bridge()')

	// ---- status route for the GUI settings card --------------------------
	// The card shows configuration; this is the part it cannot derive from the
	// config: whether the long connection is actually up right now.
	ctx.effect(() => ctx.webServer.register({
		kind: 'exact',
		path: STATUS_ROUTE,
		handler: (req, res) => {
			try {
				const cfg = current()
				res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
				res.end(JSON.stringify({
					enabled: cfg.enabled === true,
					configured: typeof cfg.appId === 'string' && cfg.appId !== ''
						&& typeof cfg.appSecret === 'string' && cfg.appSecret !== '',
					connected: status.connected,
					serviceId: status.serviceId,
					appId: typeof cfg.appId === 'string' ? cfg.appId : '',
					startedAt: status.startedAt,
					lastEventAt: status.lastEventAt,
					lastEventType: status.lastEventType,
					lastPushAt: status.lastPushAt,
					lastError: status.lastError,
					chatCount: status.chats.size,
					chats: [...status.chats].slice(-10),
					// Which conversation generation each chat is on; the settings
					// card reads this to show that a chat can own several.
					generations: Object.fromEntries(
						[...status.chats].slice(-10).map((chatId) => [chatId, pointers.get(chatId) ?? 1]),
					),
				}))
			} catch (error) {
				res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
				res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
			}
		},
	}), 'dsh-feishu: status route')

	// Mounted last so the bridge already exists when the stored settings arrive
	// and trigger their first onChange.
	installFeishuSettings(ctx, config, {
		setSource: (source) => { current = source },
		onChange: () => { startBridge() },
	})
}
