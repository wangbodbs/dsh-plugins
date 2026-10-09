/**
 * dsh-feishu — browser half: the Feishu settings card.
 *
 * DSH's Plugins settings page enumerates every installed settings namespace and
 * renders whatever a plugin registers into the `settings.plugin.item` slot for
 * that namespace. A plugin that only installs a *server-side* section shows an
 * empty row — the card has to come from the plugin's own browser half, which is
 * this file.
 *
 * Written by hand in DSH's client-module format (`window.__ModuleLoader__.load`
 * + `require("react")`), so the plugin needs no build step.
 */
window.__ModuleLoader__.load({
	id: 'dsh-feishu',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const react = require('react')
		const h = react.createElement

		/** Settings namespace this card edits; must match the server-side section. */
		const NAMESPACE = 'feishu'
		/**
		 * Loader entry id of this bundle's row (`- id: feishu` in the bundle patch).
		 * DSH 0.1.7+ keys `configForms` by this id, not by the settings namespace.
		 */
		const ENTRY_ID = 'feishu'
		/** Same-origin route served by the plugin's host half. */
		const STATUS_ROUTE = '/plugins/dsh-feishu/status'
		/** How often the card refreshes the live bridge status. */
		const STATUS_POLL_MS = 5000

		/**
		 * Required browser services. The settings form reader is deliberately absent:
		 * DSH 0.1.7 serves it as `configForms` (keyed by the Loader entry id) while
		 * 0.1.5/0.1.6 expose `settingsScope` (keyed by the settings namespace), so it
		 * is probed at runtime in `apply` instead.
		 *
		 * ⚠️ Never put either name back in here. A static inject of a service the host
		 * does not provide parks this fiber forever, and the client module system
		 * awaits every module (`await loader.await()`) before the app renders — a
		 * parked fiber therefore hangs the whole GUI at open time. That is exactly how
		 * 0.6.6 froze DSH 0.1.7 (the card was the only visible symptom; the freeze was
		 * the real one).
		 */
		const inject = ['slots', 'connection', 'locale']

		/** Host with neither settings generation: reads empty, refuses writes, never throws. */
		function degradedScope() {
			return {
				getSnapshot: () => ({ value: undefined, writable: false }),
				subscribe: () => () => {},
				set: async () => false,
			}
		}

		/**
		 * Resolve this card's settings form across DSH generations.
		 * @param ctx - the client plugin context.
		 * @returns the form scope plus whether the card can persist edits.
		 */
		function resolveScope(ctx) {
			const read = (name) => {
				try {
					return typeof ctx.get === 'function' ? ctx.get(name) : undefined
				} catch (error) {
					console.warn(`[dsh-feishu] ctx.get(${name}) 失败：`, error)
					return undefined
				}
			}
			try {
				const configForms = read('configForms')
				if (configForms !== undefined && typeof configForms.get === 'function') {
					const form = configForms.get(ENTRY_ID)
					if (form !== undefined && typeof form.getSnapshot === 'function') return { scope: form, degraded: false }
				}
				const legacy = read('settingsScope')
				if (legacy !== undefined && typeof legacy.bind === 'function') {
					return { scope: legacy.bind({ namespace: NAMESPACE }), degraded: false }
				}
			} catch (error) {
				console.warn('[dsh-feishu] 设置表单服务解析失败，卡片降级为只读：', error)
			}
			return { scope: degradedScope(), degraded: true }
		}

		const STYLE = `
.dsh-fs-card{border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);border-radius:16px;list-style:none;transition:border-color .16s,background .16s;max-width:760px}
.dsh-fs-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.dsh-fs-card[data-open=true]{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.dsh-fs-header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;align-items:center;gap:12px;padding:14px 16px;display:flex}
.dsh-fs-header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.dsh-fs-headtext{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.dsh-fs-name{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.dsh-fs-desc{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.dsh-fs-pill{font-size:12px;padding:2px 8px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);white-space:nowrap;flex:none}
.dsh-fs-pill[data-state=on]{color:var(--dsw-alias-state-business-primary);border-color:currentColor}
.dsh-fs-pill[data-state=err]{color:var(--dsw-alias-state-error-primary,#d33);border-color:currentColor}
.dsh-fs-tag{font-size:12px;padding:2px 8px;border-radius:999px;background:var(--dsw-alias-bg-layer-1,rgba(127,127,127,.16));color:var(--dsw-alias-label-tertiary);white-space:nowrap;flex:none}
.dsh-fs-chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.dsh-fs-card[data-open=true] .dsh-fs-chevron{transform:rotate(180deg)}
.dsh-fs-body{border-top:.5px solid var(--dsw-alias-border-l2);margin:0 16px;padding:12px 0 4px}
.dsh-fs-grid{display:grid;grid-template-columns:132px 1fr;gap:8px 12px;align-items:center}
.dsh-fs-label{font-size:13px;color:var(--dsw-alias-label-secondary)}
.dsh-fs-input,.dsh-fs-area{font:inherit;font-size:13px;padding:5px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;width:100%;box-sizing:border-box}
.dsh-fs-area{min-height:52px;resize:vertical;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.dsh-fs-check{display:flex;align-items:center;gap:6px;font-size:13px}
.dsh-fs-actions{border-top:.5px solid var(--dsw-alias-border-l2);justify-content:flex-end;align-items:center;gap:8px;padding:12px 0 4px;display:flex}
.dsh-fs-btn{font:inherit;font-size:13px;padding:5px 14px;border-radius:8px;border:1px solid transparent;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);cursor:pointer}
.dsh-fs-btn[disabled]{opacity:.4;cursor:default}
.dsh-fs-msg{font-size:12px;color:var(--dsw-alias-label-tertiary);flex:1;margin:0}
.dsh-fs-msg[data-kind=err]{color:var(--dsw-alias-state-error-primary,#d33)}
.dsh-fs-status{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.7;margin-bottom:10px}
.dsh-fs-status code{font-size:11px}
.dsh-fs-hint{font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.7;border-left:2px solid var(--dsw-alias-border-l2);padding-left:10px;margin-top:12px}
.dsh-fs-hint b{color:var(--dsw-alias-label-secondary)}
`

		/**
		 * Render one timestamp as a short relative age.
		 * @param {number|null} at - epoch milliseconds, or null.
		 * @returns {string} e.g. `12s 前`, or `—`.
		 */
		function ago(at) {
			if (at === null || at === undefined) return '—'
			const seconds = Math.max(0, Math.round((Date.now() - at) / 1000))
			if (seconds < 60) return `${seconds}s 前`
			if (seconds < 3600) return `${Math.round(seconds / 60)}m 前`
			return `${Math.round(seconds / 3600)}h 前`
		}

		/**
		 * Summarize which conversation generation each chat is currently on.
		 *
		 * A chat owns one generation per `/new`, so this is how a user sees from
		 * the GUI that a chat has more than one conversation without opening the
		 * session list.
		 *
		 * @param {object} status - the status payload.
		 * @returns {string} e.g. `#2`, `#1 #3`, or `—`.
		 */
		function generationSummary(status) {
			const generations = Object.values(status.generations ?? {})
			if (generations.length === 0) return '—'
			return generations.map((generation) => `#${String(generation)}`).join(' ')
		}

		/**
		 * Split the allow-list textarea into ids.
		 * @param {string} text - raw textarea contents.
		 * @returns {string[]} trimmed, non-empty ids.
		 */
		function parseIds(text) {
			return String(text ?? '')
				.split(/[\s,;，、]+/)
				.map((entry) => entry.trim())
				.filter((entry) => entry !== '')
		}

		/** The Feishu settings card. */
		function FeishuSettingsCard(props) {
			const scope = props.scope
			/** True when neither `configForms` nor `settingsScope` exists on this host. */
			const degraded = props.degraded === true
			const [snapshot, setSnapshot] = react.useState(() => scope.getSnapshot())
			/**
			 * True when the host serves no form for this entry: the settings mirror is
			 * loaded, but this namespace is missing from it (`ConfigFormController.derive`
			 * marks that state `unavailable`). That is exactly what a core does when no
			 * `Config` field is marked `.volatile()` — the card has no value to render and
			 * every write would be refused, so it says that instead of showing empty
			 * fields as if they were the real configuration.
			 */
			const formMissing = !degraded && snapshot?.status === 'unavailable'
			const [status, setStatus] = react.useState(null)
			const [statusError, setStatusError] = react.useState('')
			const [saving, setSaving] = react.useState(false)
			const [message, setMessage] = react.useState('')
			const [messageKind, setMessageKind] = react.useState('info')

			// Draft fields — kept separate from the snapshot so an unsaved edit is
			// not clobbered by the next snapshot push.
			const [enabled, setEnabled] = react.useState(false)
			const [appId, setAppId] = react.useState('')
			const [appSecret, setAppSecret] = react.useState('')
			const [secretSet, setSecretSet] = react.useState(false)
			const [domain, setDomain] = react.useState('')
			const [cwd, setCwd] = react.useState('')
			const [allowedChatIds, setAllowedChatIds] = react.useState('')
			const [ackReaction, setAckReaction] = react.useState(true)
			const [replyToChat, setReplyToChat] = react.useState(true)
			// 'steer' (default) = a message sent while a task is running jumps the
			// queue and lands at the running turn's next step; 'queue' waits for the
			// current turn to finish. Server-side default and rationale: `sendMode`
			// in lib/index.mjs.
			const [sendMode, setSendMode] = react.useState('steer')
			// Disclosure is card-local reading state, exactly like DSH's built-in
			// plugin cards: collapsed by default, not persisted anywhere.
			const [open, setOpen] = react.useState(false)

			react.useEffect(() => scope.subscribe(() => setSnapshot(scope.getSnapshot())), [scope])

			const value = snapshot?.value ?? {}
			const valueKey = JSON.stringify([value.enabled, value.appId, value.domain, value.cwd, value.allowedChatIds, value.ackReaction, value.replyToChat, value.sendMode, value.appSecret])
			react.useEffect(() => {
				setEnabled(value.enabled === true)
				setAppId(value.appId ?? '')
				setSecretSet(typeof value.appSecret === 'string' && value.appSecret !== '')
				setAppSecret('')
				setDomain(value.domain ?? '')
				setCwd(value.cwd ?? '')
				setAllowedChatIds((value.allowedChatIds ?? []).join('\n'))
				setAckReaction(value.ackReaction !== false)
				setReplyToChat(value.replyToChat !== false)
				setSendMode(value.sendMode === 'queue' ? 'queue' : 'steer')
				// eslint-disable-next-line react-hooks/exhaustive-deps
			}, [valueKey])

			// Live status: read straight off the plugin's own route. A failure here
			// must not break the form, so it degrades to a note.
			react.useEffect(() => {
				let active = true
				const read = async () => {
					try {
						const response = await fetch(STATUS_ROUTE, { cache: 'no-store' })
						if (response.status === 401 || response.status === 403) {
							if (active) { setStatus(null); setStatusError('无法读取状态（需要登录会话）') }
							return
						}
						if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
						const next = await response.json()
						if (active) { setStatus(next); setStatusError('') }
					} catch (error) {
						if (active) { setStatus(null); setStatusError(error instanceof Error ? error.message : String(error)) }
					}
				}
				void read()
				const timer = setInterval(read, STATUS_POLL_MS)
				return () => { active = false; clearInterval(timer) }
			}, [])

			const save = async (event) => {
				event.preventDefault()
				setSaving(true)
				setMessage('')
				try {
					// `set` resolves false when the host refuses the write (revision
					// conflict, read-only scope). The degraded scope always refuses, so
					// this is also how a host with no settings-form service reports
					// itself instead of pretending the edit was stored.
					const refuse = () => {
						throw new Error(degraded
							? '这个 DSH 版本没有提供设置表单服务（configForms / settingsScope），卡片只能看桥接状态，改配置请直接编辑 profile 的 cordis.patch.yml'
							: formMissing
								? '宿主没有为「飞书」这一项提供可写表单（设置镜像里没有它，通常意味着 Config 字段没标 .volatile()）：改配置请直接编辑 profile 的 cordis.patch.yml'
								: '宿主拒绝了这次写入，请刷新后重试（若反复被拒，直接改 profile 的 cordis.patch.yml）')
					}
					if (await scope.set('enabled', enabled) === false) refuse()
					await scope.set('appId', appId.trim())
					// Leaving the field blank keeps the stored secret: the card never
					// echoes it back, so blank means "not edited".
					if (appSecret.trim() !== '') await scope.set('appSecret', appSecret.trim())
					await scope.set('domain', domain.trim())
					await scope.set('cwd', cwd.trim())
					await scope.set('allowedChatIds', parseIds(allowedChatIds))
					await scope.set('ackReaction', ackReaction)
					await scope.set('replyToChat', replyToChat)
					await scope.set('sendMode', sendMode)
					setAppSecret('')
					setMessageKind('info')
					setMessage('已保存 · 桥接会立即按新配置重连')
				} catch (error) {
					setMessageKind('err')
					setMessage(error instanceof Error ? error.message : String(error))
				} finally {
					setSaving(false)
				}
			}

			const state = status === null
				? 'off'
				: status.connected ? 'on' : status.enabled ? 'err' : 'off'
			const pillText = status === null
				? (statusError === '' ? '读取状态…' : '状态不可读')
				: status.connected
					? `长连接已建立 · service_id ${status.serviceId}`
					: status.enabled ? '已启用但未连接' : '未启用'

			// The save button lives inside the disclosure, so a collapsed card still
			// has to say that it holds edits the user has not written yet.
			const dirty =
				enabled !== (value.enabled === true) ||
				appId.trim() !== (value.appId ?? '') ||
				domain.trim() !== (value.domain ?? '') ||
				cwd.trim() !== (value.cwd ?? '') ||
				JSON.stringify(parseIds(allowedChatIds)) !== JSON.stringify(value.allowedChatIds ?? []) ||
				ackReaction !== (value.ackReaction !== false) ||
				replyToChat !== (value.replyToChat !== false) ||
				sendMode !== (value.sendMode === 'queue' ? 'queue' : 'steer') ||
				appSecret.trim() !== ''

			const row = (label, control) => [
				h('div', { className: 'dsh-fs-label', key: `${label}-l` }, label),
				h('div', { key: `${label}-c` }, control),
			]

			const header = h('button', {
				type: 'button',
				className: 'dsh-fs-header',
				'aria-expanded': open,
				'aria-label': `${open ? '收起设置' : '展开设置'}：飞书`,
				onClick: () => setOpen(!open),
				key: 'head',
			}, [
				h('span', { className: 'dsh-fs-headtext', key: 'ht' }, [
					h('span', { className: 'dsh-fs-name', key: 'n' }, '飞书'),
					h('span', { className: 'dsh-fs-desc', key: 'd' }, '在飞书里直接跟 DSH 对话；改完保存即生效，无需重启'),
				]),
				dirty ? h('span', { className: 'dsh-fs-tag', key: 'tag' }, '未保存') : null,
				h('span', { className: 'dsh-fs-pill', 'data-state': state, key: 'p' }, pillText),
				h('svg', {
					className: 'dsh-fs-chevron', width: 14, height: 14, viewBox: '0 0 16 16',
					fill: 'none', 'aria-hidden': 'true', key: 'ch',
				}, h('path', {
					d: 'M4 6.5 8 10.5 12 6.5', stroke: 'currentColor', strokeWidth: 1.5,
					strokeLinecap: 'round', strokeLinejoin: 'round',
				})),
			])

			const body = h('div', { className: 'dsh-fs-body', key: 'body' },
				h('form', { onSubmit: save }, [
					status === null ? null : h('div', { className: 'dsh-fs-status', key: 'st' }, [
						h('div', { key: 'a' }, [
							'App ID ', h('code', { key: 'a1' }, status.appId || '（未填）'),
							' · 会话数 ', h('code', { key: 'a2' }, String(status.chatCount ?? 0)),
							' · 当前段 ', h('code', { key: 'a3' }, generationSummary(status)),
						]),
						h('div', { key: 'b' }, [
							'最近事件 ', h('code', { key: 'b1' }, status.lastEventType || '—'),
							'（', ago(status.lastEventAt), '） · 最近推送 ', h('code', { key: 'b2' }, ago(status.lastPushAt)),
						]),
						status.lastError === null
							? null
							: h('div', { key: 'c', 'data-kind': 'err' }, `最后错误：${status.lastError}`),
					]),
					statusError === '' ? null : h('div', { className: 'dsh-fs-msg', 'data-kind': 'err', key: 'se' }, statusError),
					degraded
						? h('div', { className: 'dsh-fs-msg', 'data-kind': 'err', key: 'dg' },
							'这个 DSH 版本没有提供设置表单服务（configForms / settingsScope）：卡片仍显示桥接状态，但保存会被拒绝 —— 改配置请直接编辑 profile 的 cordis.patch.yml，或把插件升级到支持该版本的一版。')
						: null,
					formMissing
						? h('div', { className: 'dsh-fs-msg', 'data-kind': 'err', key: 'fm' },
							'宿主的设置镜像里没有「飞书」这一项：下面显示的空值不是真实配置（桥接状态才是真的），保存也会被拒。通常是插件 Config 的字段没标 .volatile() —— 改配置请编辑 profile 的 cordis.patch.yml，或把插件升级到 0.8.3+。')
						: null,

					h('div', { className: 'dsh-fs-grid', key: 'form' }, [
						...row('启用', h('label', { className: 'dsh-fs-check', key: 'en' }, [
							h('input', { type: 'checkbox', checked: enabled, onChange: (e) => setEnabled(e.target.checked), key: 'i' }),
							'打开后 DSH 会主动连接飞书（保存即生效，无需重启）',
						])),
						...row('App ID', h('input', {
							className: 'dsh-fs-input', type: 'text', value: appId, placeholder: 'cli_xxxxxxxxxxxxxxxx',
							onChange: (e) => setAppId(e.target.value), key: 'ai',
						})),
						...row('App Secret', h('input', {
							className: 'dsh-fs-input', type: 'password', value: appSecret,
							placeholder: secretSet ? '已配置（留空则不修改）' : '粘贴应用密钥',
							onChange: (e) => setAppSecret(e.target.value), key: 'as',
						})),
						...row('开放平台域名', h('input', {
							className: 'dsh-fs-input', type: 'text', value: domain, placeholder: 'https://open.feishu.cn',
							onChange: (e) => setDomain(e.target.value), key: 'dm',
						})),
						...row('会话工作目录', h('input', {
							className: 'dsh-fs-input', type: 'text', value: cwd, placeholder: '留空则用 DSH 进程的当前目录',
							onChange: (e) => setCwd(e.target.value), key: 'cw',
						})),
						...row('会话白名单', h('textarea', {
							className: 'dsh-fs-area', value: allowedChatIds,
							placeholder: '每行一个 oc_... ；留空 = 不限制',
							onChange: (e) => setAllowedChatIds(e.target.value), key: 'wl',
						})),
						...row('收到消息回执', h('label', { className: 'dsh-fs-check', key: 'ar' }, [
							h('input', { type: 'checkbox', checked: ackReaction, onChange: (e) => setAckReaction(e.target.checked), key: 'i' }),
							'加一个表情，表示已受理',
						])),
						...row('回答回推飞书', h('label', { className: 'dsh-fs-check', key: 'rt' }, [
							h('input', { type: 'checkbox', checked: replyToChat, onChange: (e) => setReplyToChat(e.target.checked), key: 'i' }),
							'一轮结束时把回答推到会话',
						])),
						...row('任务运行中收到消息', h('select', {
							className: 'dsh-fs-input', value: sendMode, key: 'sm',
							onChange: (e) => setSendMode(e.target.value === 'queue' ? 'queue' : 'steer'),
						}, [
							h('option', { value: 'steer', key: 'sm1' }, '插队 · 正在跑的任务下一步就能看到（默认）'),
							h('option', { value: 'queue', key: 'sm2' }, '排队 · 等当前任务跑完再开新一轮'),
						])),
					]),

					h('div', { className: 'dsh-fs-actions', key: 'act' }, [
						message === '' ? null : h('span', { className: 'dsh-fs-msg', 'data-kind': messageKind, key: 'm' }, message),
						h('button', { className: 'dsh-fs-btn', type: 'submit', disabled: saving, key: 's' }, saving ? '保存中…' : '保存'),
					]),

					h('div', { className: 'dsh-fs-hint', key: 'hint' }, [
						h('div', { key: '1' }, [h('b', { key: 'b1' }, '飞书后台要配两处：'), ' 事件订阅选「使用长连接接收事件」（不要配请求地址），并添加事件 ', h('code', { key: 'c1' }, 'im.message.receive_v1'), ' 与 ', h('code', { key: 'c2' }, 'card.action.trigger'), '。']),
						h('div', { key: '2' }, ['改完权限/事件要 ', h('b', { key: 'b2' }, '创建版本并发布'), '；漏配 ', h('code', { key: 'c3' }, 'card.action.trigger'), ' 时 /permission 的按钮会点了没反应。']),
						h('div', { key: '3' }, ['在飞书里发 ', h('code', { key: 'c4' }, '/permission'), ' 可以切换该会话的文件权限；发普通消息就是在跟 DSH 对话。']),
						h('div', { key: '4' }, [
							'一个聊天可以有好几段会话：', h('code', { key: 'c5' }, '/new'), ' 开一段全新空白对话（旧的一段仍然保留），',
							h('code', { key: 'c6' }, '/sessions'), ' 列出来，', h('code', { key: 'c7' }, '/open 2'), ' 切回去。',
						]),
					]),
				]))

			return h('li', { className: 'dsh-fs-card', 'data-open': open, key: 'card' }, [
				header,
				open ? body : null,
			])
		}

		function apply(ctx) {
			const { scope, degraded } = resolveScope(ctx)
			ctx.effect(() => {
				const style = document.createElement('style')
				style.dataset.plugin = 'dsh-feishu'
				style.textContent = STYLE
				document.head.appendChild(style)
				return () => { style.remove() }
			}, 'dsh-feishu: styles')

			const register = ctx.slots.register.bind(ctx.slots)
			// DSH 0.2.0-rc.2 moved plugin configuration from the flat
			// `settings.plugin.item` list to Settings *sections*: the settings shell
			// renders `settings.section` and builds the nav from its entries, while
			// `settings.plugin.item` no longer exists. Registering only the old slot
			// is exactly why this card disappeared from 设置 after the upgrade.
			// Register both — each host renders the slot it knows, the other stays
			// dormant (an injected slot that is never declared simply never fires).
			ctx.slots.inject('settings.section', () => register({
				name: 'settings.section',
				id: NAMESPACE,
				order: 60,
				label: () => '飞书',
				inject: () => ({ scope, degraded }),
			}, FeishuSettingsCard))
			ctx.slots.inject('settings.plugin.item', () => register({
				name: 'settings.plugin.item',
				key: NAMESPACE,
				inject: () => ({ scope, degraded }),
			}, FeishuSettingsCard))
		}

		exports.apply = apply
		exports.inject = inject
		exports.FeishuSettingsCard = FeishuSettingsCard
		return module.exports
	},
})
