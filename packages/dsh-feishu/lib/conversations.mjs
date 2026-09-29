/**
 * Conversation generations of one Feishu chat: `/new`, `/sessions`, `/open`.
 *
 * A chat is not one DSH session but a series of them, so "start over" never has
 * to mean "lose the old thread":
 *
 * - `/new` opens the next **blank** generation. The previous one keeps its
 *   history, stays resumable, keeps answering a turn that was already running,
 *   and simply gains a title so it can be told apart in the GUI's session list.
 * - `/sessions` lists every generation the chat owns, newest state marked.
 * - `/open <n>` points the chat back at an earlier generation and resumes it —
 *   including one that was archived (归档) in the GUI, which is why this exists
 *   at all: the GUI hides archived sessions with no way back.
 *
 * Which generations exist is read from the session store, so nothing here can
 * drift from reality; only "which one is current" needs the durable pointer,
 * because `/open` can move it backwards.
 *
 * Every dependency arrives through the constructor: the commands are the one
 * part of the bridge with real branching, and they must be testable without a
 * live Feishu socket (see `tools/smoke.mjs`).
 *
 * @module dsh-feishu/conversations
 */

import { modeLabel } from './cards.mjs'
import { generationOf } from './generations.mjs'

/** Command spellings that open a brand-new blank conversation. */
export const NEW_COMMANDS = new Set(['/new', '/新会话', '/新对话', '/reset'])

/** Command spellings that list this chat's conversations. */
export const LIST_COMMANDS = new Set(['/sessions', '/session', '/会话', '/历史'])

/** Command spellings that switch this chat back to an earlier conversation. */
export const OPEN_COMMANDS = new Set(['/open', '/切换', '/打开'])

/** Marker inside a session button's `value` that identifies `/sessions` cards. */
export const SESSION_ACTION_TYPE = 'dsh_session'

/**
 * Render a local `MM-DD HH:mm` stamp.
 * @param {number} at - epoch milliseconds.
 * @returns {string} the stamp.
 */
export function stamp(at = Date.now()) {
	const date = new Date(at)
	const pad = (value) => String(value).padStart(2, '0')
	return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * The label for one conversation button.
 * @param {{generation: number, createdAt: number}} item - one generation.
 * @param {boolean} isCurrent - whether the chat is pointed at it right now.
 * @returns {string} the button text.
 */
function sessionButtonLabel(item, isCurrent) {
	const when = item.createdAt > 0 ? stamp(item.createdAt) : ''
	const base = when === '' ? `#${String(item.generation)}` : `#${String(item.generation)} · ${when}`
	return isCurrent ? `${base} ✓` : base
}

/**
 * Render the conversation list as chat text.
 *
 * The card is the normal way in; this stays as the fallback for when a card
 * cannot be delivered, and as the body of `/open` errors.
 *
 * @param {{current: number, items: Array<{generation: number, sessionId: string, createdAt: number}>}} overview - what {@link ConversationBook#overview} returns.
 * @returns {string} the reply body.
 */
export function renderSessions({ current, items }) {
	const lines = [`📋 本聊天的会话（当前 ▶ #${String(current)}）`]
	if (items.length === 0) {
		lines.push('（还没有落盘的会话；直接发消息就是第 1 段）')
	}
	for (const item of items) {
		const mark = item.generation === current ? '▶' : '　'
		const when = item.createdAt > 0 ? stamp(item.createdAt) : '时间未知'
		lines.push(`${mark} #${String(item.generation)}  ${when}  ${item.sessionId}`)
	}
	lines.push('', '/new 开一段全新空白对话，/open <编号> 切回旧的一段。')
	return lines.join('\n')
}

/**
 * Build the `/sessions` switcher card: one button per conversation.
 *
 * Same idea as the `/model` card — the list is clickable instead of being
 * something the user has to copy a number out of. Card 2.0 because
 * `column_set` is what wraps the buttons into rows.
 *
 * @param {{current: number, items: Array<{generation: number, sessionId: string, createdAt: number}>}} overview - the chat's generations and its current one.
 * @returns {object} a card 2.0 JSON object.
 */
export function sessionCard({ current, items }) {
	const elements = []
	if (items.length === 0) {
		elements.push({ tag: 'markdown', content: '（还没有落盘的会话；直接发消息就是第 1 段）' })
	} else {
		elements.push({
			tag: 'markdown',
			content: [
				`当前：**#${String(current)}**`,
				'',
				'点一下编号就切过去 —— 那一段记得之前所有对话，你的下一句话就发给它。',
			].join('\n'),
		})
		elements.push({ tag: 'hr' })
		elements.push({
			tag: 'column_set',
			flex_mode: 'flow',
			columns: items.map((item) => {
				const isCurrent = item.generation === current
				return {
					tag: 'column',
					width: 'auto',
					elements: [{
						tag: 'button',
						text: { tag: 'plain_text', content: sessionButtonLabel(item, isCurrent) },
						type: isCurrent ? 'primary_filled' : 'default',
						size: 'small',
						behaviors: [{
							type: 'callback',
							value: { type: SESSION_ACTION_TYPE, generation: item.generation },
						}],
					}],
				}
			}),
		})
		elements.push({ tag: 'hr' })
		elements.push({ tag: 'markdown', content: '_`/new` 开一段全新空白对话；`/sessions` 重新出这张卡片。_' })
	}
	return {
		schema: '2.0',
		config: { update_multi: true },
		header: { template: 'blue', title: { tag: 'plain_text', content: '📋 切换对话' } },
		body: { elements },
	}
}

/**
 * Extract the requested generation from a session button click.
 * @param {unknown} value - the callback's `event.action.value`.
 * @returns {{generation: number} | null} the request, or null when it is not ours.
 */
export function parseSessionAction(value) {
	if (value === null || typeof value !== 'object') return null
	const record = /** @type {Record<string, unknown>} */ (value)
	if (record.type !== SESSION_ACTION_TYPE) return null
	const generation = Number(record.generation)
	if (!Number.isSafeInteger(generation) || generation < 1) return null
	return { generation }
}

/**
 * The conversation commands of a single chat.
 */
export class ConversationBook {
	/**
	 * @param {object} deps - everything the commands touch.
	 * @param {object} deps.sessionQuery - the host session-query service (for listing).
	 * @param {(chatId: string, generation: number) => Promise<object>} deps.ensureAgent - resume-or-create one generation.
	 * @param {(session: object) => string} deps.modeOf - the session's effective file policy.
	 * @param {(session: object, mode: string) => void} deps.applyMode - write a file policy onto a session.
	 * @param {() => object|undefined} deps.titles - the session-title service, when the host mounts one.
	 * @param {object} deps.pointers - the durable per-chat generation pointer.
	 * @param {(message: string) => void} [deps.warn] - diagnostic sink for degraded paths.
	 */
	constructor({ sessionQuery, ensureAgent, modeOf, applyMode, titles, pointers, warn }) {
		this.sessionQuery = sessionQuery
		this.ensureAgent = ensureAgent
		this.modeOf = modeOf
		this.applyMode = applyMode
		this.titles = titles
		this.pointers = pointers
		this.warn = warn ?? (() => {})
	}

	/**
	 * Whether one command word belongs to this book.
	 * @param {string} command - the lower-cased command word.
	 * @returns {boolean} true when {@link ConversationBook#run} handles it.
	 */
	matches(command) {
		return NEW_COMMANDS.has(command) || LIST_COMMANDS.has(command) || OPEN_COMMANDS.has(command)
	}

	/**
	 * Run one conversation command.
	 * @param {string} chatId - the Feishu chat id.
	 * @param {string} command - the lower-cased command word.
	 * @param {string} argument - everything after the command word.
	 * @returns {Promise<string>} the reply body sent back to the chat.
	 * @throws {Error} with a user-readable message when the command cannot run.
	 */
	async run(chatId, command, argument) {
		if (NEW_COMMANDS.has(command)) return this.start(chatId)
		if (LIST_COMMANDS.has(command)) return this.report(chatId)
		return this.open(chatId, argument)
	}

	/**
	 * Every generation this chat owns, oldest first.
	 *
	 * The session store is the source of truth: a generation exists exactly when
	 * its session id does, so this also picks up generations created before the
	 * plugin was last restarted, and generations whose pointer was lost.
	 *
	 * @param {string} chatId - the Feishu chat id.
	 * @returns {Promise<Array<{generation: number, sessionId: string, createdAt: number}>>} the generations.
	 */
	async generations(chatId) {
		const listSessions = this.sessionQuery?.listSessions
		if (typeof listSessions !== 'function') return []
		let records
		try {
			records = await listSessions.call(this.sessionQuery)
		} catch (error) {
			// A broken listing must not break the chat: the caller falls back to
			// generation 1, which is what a chat without `/new` history needs.
			this.warn(`读取会话列表失败: ${describe(error)}`)
			return []
		}
		const found = []
		for (const record of records ?? []) {
			const sessionId = String(record?.header?.id ?? '')
			const generation = generationOf(sessionId, chatId)
			if (generation === undefined) continue
			found.push({ generation, sessionId, createdAt: Number(record?.header?.createdAt ?? 0) })
		}
		return found.sort((left, right) => left.generation - right.generation)
	}

	/**
	 * The generation this chat talks to right now.
	 *
	 * The persisted pointer wins, because `/open` can deliberately sit on an
	 * older generation. Without one, the newest generation is the answer — which
	 * is also right for a chat created before `/new` existed.
	 *
	 * @param {string} chatId - the Feishu chat id.
	 * @returns {Promise<number>} the current generation.
	 */
	async current(chatId) {
		const remembered = this.pointers.get(chatId)
		if (remembered !== undefined) return remembered
		const known = await this.generations(chatId)
		const generation = known.length === 0 ? 1 : known[known.length - 1].generation
		// Derived, not chosen: cache it for this process only.
		this.pointers.remember(chatId, generation)
		return generation
	}

	/**
	 * Open the next blank generation and point the chat at it.
	 *
	 * The file policy carries over, because in Feishu `/permission` is a per-chat
	 * decision even though it is stored per session.
	 *
	 * @param {string} chatId - the Feishu chat id.
	 * @returns {Promise<string>} the reply body.
	 */
	async start(chatId) {
		const previous = await this.current(chatId)
		const previousAgent = await this.ensureAgent(chatId, previous)
		if (isBlank(previousAgent.session)) {
			return `ℹ️ 当前 #${previous} 还是空的，已经在最新一段了，直接说话就行。`
		}
		const known = await this.generations(chatId)
		const used = new Set(known.map((item) => item.generation))
		used.add(previous)
		let next = Math.max(...used) + 1
		// The listing above should already guarantee a free id; never reuse one.
		while (used.has(next)) next += 1
		const mode = this.modeOf(previousAgent.session)
		const title = this.name(previousAgent, previous)
		const agent = await this.ensureAgent(chatId, next)
		this.applyMode(agent.session, mode)
		this.pointers.set(chatId, next)
		const named = title === undefined ? '' : `，上一段已命名「${title}」`
		return [
			`✅ 已开一段全新空白对话：#${next}（${agent.session.id}）${named}`,
			'这段不记得之前的对话。旧的一段仍然保留：/sessions 看列表，/open <编号> 切回去；在 DSH 界面里也能翻到。',
			`文件权限沿用：${modeLabel(mode)}`,
		].join('\n')
	}

	/**
	 * Point the chat back at an earlier generation and resume it.
	 * @param {string} chatId - the Feishu chat id.
	 * @param {string} argument - the `/open` argument (`2` or `#2`).
	 * @returns {Promise<string>} the reply body.
	 * @throws {Error} when the argument is not an existing generation of this chat.
	 */
	async open(chatId, argument) {
		const requested = Number(String(argument ?? '').trim().replace(/^#/, ''))
		if (!Number.isSafeInteger(requested) || requested < 1) {
			throw new Error('用法：/open 2（编号见 /sessions）')
		}
		const known = await this.generations(chatId)
		if (known.length === 0) throw new Error('这个聊天还没有会话')
		if (!known.some((item) => item.generation === requested)) {
			throw new Error(`没有 #${requested} 这一段（现有 ${known.map((item) => `#${item.generation}`).join(' ')}）`)
		}
		const agent = await this.ensureAgent(chatId, requested)
		this.pointers.set(chatId, requested)
		return `✅ 已切回 #${requested}（${agent.session.id}），下一条消息就发给它。\n文件权限：${modeLabel(this.modeOf(agent.session))}`
	}

	/**
	 * The chat's conversations plus the one it is pointed at.
	 * @param {string} chatId - the Feishu chat id.
	 * @returns {Promise<{current: number, items: Array<{generation: number, sessionId: string, createdAt: number}>}>} everything a listing needs.
	 */
	async overview(chatId) {
		return { current: await this.current(chatId), items: await this.generations(chatId) }
	}

	/**
	 * Render the `/sessions` listing as text (the card is the normal way in).
	 * @param {string} chatId - the Feishu chat id.
	 * @returns {Promise<string>} the reply body.
	 */
	async report(chatId) {
		return renderSessions(await this.overview(chatId))
	}

	/**
	 * Give one generation a findable name in the GUI session list.
	 *
	 * Feishu prompts are injected with `source.kind === 'plugin'`, and the
	 * session-title service only derives titles from `'user'` prompts — so
	 * without this every Feishu session is a bare `feishu-oc_…` row. A title the
	 * user set in the GUI is never overwritten.
	 *
	 * @param {object} agent - the live agent of that generation.
	 * @param {number} generation - its generation number.
	 * @returns {string|undefined} the accepted title, when one was written.
	 */
	name(agent, generation) {
		const titles = this.titles()
		if (titles === undefined) return undefined
		try {
			if (titles.get(agent.session) !== undefined) return undefined
			const label = `飞书 #${generation} · ${stamp()}`
			const accepted = titles.rename(agent.session, label)
			return typeof accepted?.title === 'string' ? accepted.title : label
		} catch (error) {
			this.warn(`写入会话标题失败: ${describe(error)}`)
			return undefined
		}
	}
}

/**
 * Whether a session has never started a turn.
 * @param {object} session - a live DSH session.
 * @returns {boolean} true when nothing has been asked in it yet.
 */
function isBlank(session) {
	try {
		const events = session?.snapshotEvents?.() ?? []
		return !events.some((event) => event.type === 'turn/start')
	} catch {
		// Unknown shape: assume it has content, so `/new` still does its job.
		return false
	}
}

/**
 * Render an unknown thrown value as a message.
 * @param {unknown} error - the thrown value.
 * @returns {string} a human-readable message.
 */
function describe(error) {
	return error instanceof Error ? error.message : String(error)
}
