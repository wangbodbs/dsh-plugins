/**
 * Feishu interactive-card payloads: the `/permission` switcher and the
 * `feishu_ask` question card.
 *
 * Card JSON here is the classic **card 1.0** shape (`config` / `header` /
 * `elements`), which every Feishu and Lark client renders. The button's
 * `value` object travels back verbatim in the `card.action.trigger`
 * callback, so it is the only state the handler needs — no server-side
 * bookkeeping and no message id lookup. Both families share one callback
 * handler and are distinguished by the `type` field inside `value`
 * ({@link PERMISSION_ACTION_TYPE} vs {@link QUESTION_ACTION_TYPE}).
 *
 * @module dsh-feishu/cards
 */

/** Marker inside a button's `value` that identifies our cards. */
export const PERMISSION_ACTION_TYPE = 'dsh_permission'

/** Marker inside an approval button's `value`. */
export const APPROVAL_ACTION_TYPE = 'dsh_approval'

/**
 * The approval prompt for a Feishu session.
 *
 * DSH asks permission through composed "answerers" (waterfall listeners). The
 * shipped one is the GUI dialog, which nobody can see while the conversation is
 * happening in Feishu — the turn just hangs. This card is the Feishu answerer's
 * question, so the decision can be made where the user actually is.
 *
 * @param {object} options - card contents.
 * @param {string} options.approvalId - opaque id echoed back by the buttons.
 * @param {string} options.toolName - the tool asking for permission.
 * @param {string} [options.reason] - the asker's explanation.
 * @returns {object} a card 2.0 JSON object.
 */
export function approvalCard({ approvalId, toolName, reason }) {
	const lines = [
		`**工具**：\`${String(toolName)}\``,
		'',
		`**原因**：${reason === undefined || reason === '' ? '（未说明）' : String(reason)}`,
		'',
		'> 这条请求来自飞书会话，本机的 GUI 弹窗你看不到，所以在这里问你。',
	]
	const button = (label, decision, type) => ({
		tag: 'button',
		size: 'small',
		type,
		text: { tag: 'plain_text', content: label },
		behaviors: [{ type: 'callback', value: { type: APPROVAL_ACTION_TYPE, approvalId, decision } }],
	})
	return {
		schema: '2.0',
		config: { update_multi: true },
		header: { template: 'orange', title: { tag: 'plain_text', content: '🔐 需要你授权' } },
		body: {
			elements: [
				{ tag: 'markdown', content: lines.join('\n') },
				{
					tag: 'column_set',
					flex_mode: 'flow',
					columns: [
						{ tag: 'column', width: 'auto', elements: [button('✅ 允许一次', 'allow', 'primary')] },
						{ tag: 'column', width: 'auto', elements: [button('⛔ 拒绝', 'deny', 'danger')] },
					],
				},
			],
		},
	}
}

/**
 * The card an approval prompt turns into once it was decided (or expired).
 *
 * @param {object} options - card contents.
 * @param {string} options.toolName - the tool that asked.
 * @param {'allow'|'deny'|'expired'} options.decision - what happened.
 * @returns {object} a card 2.0 JSON object.
 */
export function answeredApprovalCard({ toolName, decision }) {
	const meta = decision === 'allow'
		? { template: 'green', title: '✅ 已允许一次', body: '这次调用放行；**授权只对这一次生效**。' }
		: decision === 'deny'
			? { template: 'red', title: '⛔ 已拒绝', body: '这次调用被拒。' }
			: { template: 'grey', title: '⌛ 授权超时', body: '没人确认，按**拒绝**处理（fail closed）。' }
	return {
		schema: '2.0',
		config: { update_multi: true },
		header: { template: meta.template, title: { tag: 'plain_text', content: meta.title } },
		body: {
			elements: [
				{ tag: 'markdown', content: `**工具**：\`${String(toolName)}\`` },
				{ tag: 'hr' },
				{ tag: 'markdown', content: meta.body },
			],
		},
	}
}

/**
 * Extract the decision from an approval button click.
 * @param {unknown} value - the callback's `event.action.value`.
 * @returns {{approvalId: string, decision: 'allow'|'deny'} | null} the parsed action, or null when it is not ours.
 */
export function parseApprovalAction(value) {
	if (value === null || typeof value !== 'object') return null
	const record = /** @type {Record<string, unknown>} */ (value)
	if (record.type !== APPROVAL_ACTION_TYPE) return null
	const approvalId = typeof record.approvalId === 'string' ? record.approvalId : ''
	const decision = record.decision === 'allow' ? 'allow' : record.decision === 'deny' ? 'deny' : undefined
	if (approvalId === '' || decision === undefined) return null
	return { approvalId, decision }
}

/**
 * Display metadata for each sandbox mode. The keys are the values DSH's
 * `setSandboxMode` accepts.
 */
export const MODE_META = {
	'read-only': {
		label: '只读',
		emoji: '🔒',
		summary: '只能读取，任何写操作都会被拒',
		header: 'grey',
	},
	'workspace-write': {
		label: '工作区可写',
		emoji: '📁',
		summary: '只能改工作区内的文件（默认）',
		header: 'blue',
	},
	'danger-full-access': {
		label: '完全访问',
		emoji: '🔓',
		summary: '不限制，可以改这台机器上任何文件',
		header: 'red',
	},
}

/**
 * Describe one mode for display.
 * @param {string} mode - a sandbox mode.
 * @returns {{label: string, emoji: string, summary: string, header: string}} its display metadata.
 */
export function modeMeta(mode) {
	return MODE_META[mode] ?? { label: mode, emoji: '❔', summary: '', header: 'grey' }
}

/**
 * Render `mode` as `📁 工作区可写`.
 * @param {string} mode - a sandbox mode.
 * @returns {string} the human label.
 */
export function modeLabel(mode) {
	const meta = modeMeta(mode)
	return `${meta.emoji} ${meta.label}`
}

/**
 * Render the `sandbox/permission` card.
 *
 * @param {object} options - card contents.
 * @param {string} options.chatId - the Feishu chat this card belongs to.
 * @param {string} options.currentMode - the mode currently in effect.
 * @param {readonly string[]} options.modes - every selectable mode, in display order.
 * @returns {object} a card 1.0 JSON object.
 */
export function permissionCard({ chatId, currentMode, modes }) {
	const current = modeMeta(currentMode)

	const lines = modes.map((mode) => {
		const meta = modeMeta(mode)
		const marker = mode === currentMode ? ' ← **当前**' : ''
		return `${meta.emoji} **${meta.label}** —— ${meta.summary}${marker}`
	})

	const body = [
		`**当前：${modeLabel(currentMode)}**`,
		'',
		...lines,
		'',
		`> 这个设置只影响**本会话**（飞书会话 \`${chatId}\` 绑定的那个 DSH session）。`,
		'> 想直接指定也可以发文本：`/permission workspace-write`。',
	].join('\n')

	const buttons = modes.map((mode) => ({
		tag: 'button',
		text: { tag: 'plain_text', content: modeLabel(mode) },
		// The current mode is rendered as the emphasized button so the state
		// is readable at a glance without reading the body.
		type: mode === currentMode ? 'primary' : 'default',
		value: { type: PERMISSION_ACTION_TYPE, mode },
	}))

	return {
		config: { wide_screen_mode: true },
		header: {
			template: current.header,
			title: { tag: 'plain_text', content: '🔐 文件权限' },
		},
		elements: [
			{ tag: 'markdown', content: body },
			{ tag: 'hr' },
			{ tag: 'action', actions: buttons },
		],
	}
}

/**
 * Marker inside a question button's `value` that identifies `feishu_ask` cards.
 *
 * It lives in the same `value` channel as {@link PERMISSION_ACTION_TYPE}, so the
 * two card families share one `card.action.trigger` handler and are told apart
 * by this field alone.
 */
export const QUESTION_ACTION_TYPE = 'dsh_question'

/** Control `name` of the question card's free-text field. */
export const NOTE_FIELD = 'ask_note'

/**
 * Control name of one answer button.
 *
 * A form submit returns the clicked control's `name` in the submitted form
 * data, so the option — and the question it belongs to — survives even if
 * Feishu drops the button's own `value` on the way back.
 *
 * @param {number} index - the option's position.
 * @param {string} questionId - the question it answers.
 * @returns {string} the control name.
 */
export function buttonName(index, questionId) {
	return `opt${String(index)}-${questionId}`
}

/**
 * Render the `feishu_ask` question card.
 *
 * This exists because the harness's own `ask_user_question` opens a **GUI**
 * dialog: when the conversation is happening in Feishu there is no GUI in front
 * of the user, and the turn stalls until the question times out. A card puts the
 * question, its options and an optional note **where the user actually is**.
 *
 * Deliberately **card JSON 2.0 with a form container**: an input and the buttons
 * can only be submitted together from inside a form, and form containers do not
 * exist in card 1.0 (the permission card still uses 1.0, which every client
 * renders — the two coexist per message).
 *
 * @param {object} options - card contents.
 * @param {string} options.questionId - opaque id echoed back by the controls.
 * @param {string} options.question - the question body (markdown).
 * @param {readonly string[]} options.options - answer buttons, in display order.
 * @param {string} [options.header] - card title.
 * @param {string} [options.hint] - small print under the question.
 * @param {string} [options.notePlaceholder] - placeholder of the free-text field.
 * @returns {object} a card 2.0 JSON object.
 */
export function questionCard({
	questionId,
	question,
	options,
	header = '❓ 需要你选一个',
	hint,
	notePlaceholder = '补充说明（可留空）',
}) {
	const buttons = options.map((label, index) => ({
		tag: 'button',
		// Every control inside a form needs a unique `name`; the name of the
		// clicked button also travels back inside the submitted form data.
		name: buttonName(index, questionId),
		text: { tag: 'plain_text', content: label },
		// The first option is the emphasized one: the model lists its
		// recommendation first, so the likely answer should be the easy click.
		type: index === 0 ? 'primary' : 'default',
		form_action_type: 'submit',
		behaviors: [{ type: 'callback', value: { type: QUESTION_ACTION_TYPE, questionId, index } }],
	}))

	const body = [
		String(question),
		'',
		hint ?? '> 点按钮回答。想补充点什么，就写在下面的输入框里，会和选项一起回来。',
	].join('\n')

	return {
		schema: '2.0',
		// Lets the answered card replace this one in place on the click.
		config: { update_multi: true },
		header: { template: 'turquoise', title: { tag: 'plain_text', content: header } },
		body: {
			elements: [
				{ tag: 'markdown', content: body },
				{
					tag: 'form',
					name: 'ask_form',
					elements: [
						{
							tag: 'input',
							name: NOTE_FIELD,
							input_type: 'multiline_text',
							rows: 2,
							auto_resize: true,
							max_length: 500,
							placeholder: { tag: 'plain_text', content: notePlaceholder },
							// Carried so that the input's *own* submit icon can still
							// be routed to this question.
							behaviors: [{ type: 'callback', value: { type: QUESTION_ACTION_TYPE, questionId } }],
						},
						{
							tag: 'column_set',
							flex_mode: 'flow',
							columns: buttons.map((button) => ({
								tag: 'column',
								width: 'auto',
								elements: [button],
							})),
						},
					],
				},
			],
		},
	}
}

/**
 * The card a question turns into once it has been answered (or timed out).
 *
 * Controls are dropped rather than disabled: removing them is what actually
 * prevents a second answer from looking clickable.
 *
 * @param {object} options - card contents.
 * @param {string} options.question - the original question body.
 * @param {string} [options.label] - the chosen option, when there is one.
 * @param {string} [options.note] - the free-text note, when there is one.
 * @param {boolean} [options.timedOut] - render the "gave up waiting" state.
 * @returns {object} a card 2.0 JSON object.
 */
export function answeredQuestionCard({ question, label, note, timedOut = false }) {
	const lines = timedOut
		? ['_没等到回答，这个问题已经作废了。_']
		: [`**你的选择：${String(label ?? '')}**`]
	if (!timedOut && typeof note === 'string' && note.trim() !== '') {
		lines.push('', `**补充：**${note.trim()}`)
	}
	return {
		schema: '2.0',
		config: { update_multi: true },
		header: {
			template: timedOut ? 'grey' : 'green',
			title: { tag: 'plain_text', content: timedOut ? '⌛ 问题已作废' : '✅ 已收到回答' },
		},
		body: {
			elements: [
				{ tag: 'markdown', content: String(question) },
				{ tag: 'hr' },
				{ tag: 'markdown', content: lines.join('\n') },
			],
		},
	}
}

/**
 * Flatten every form value a card callback may carry into one map.
 *
 * The shape of a form submission is not fully pinned down by the docs (`value`
 * vs `form_value` vs `input_value` have all been seen in the wild), so accept
 * them all instead of guessing one.
 *
 * @param {object} action - the callback's `event.action`.
 * @returns {Record<string, string>} field name -> text.
 */
function formValuesOf(action) {
	const out = {}
	const absorb = (candidate) => {
		if (candidate === null || typeof candidate !== 'object') return
		for (const [key, value] of Object.entries(candidate)) {
			if (typeof value === 'string') out[key] = value
			else if (typeof value === 'number' || typeof value === 'boolean') out[key] = String(value)
		}
	}
	absorb(action.form_value)
	absorb(action.formValue)
	absorb(action.form_data)
	absorb(action.input_value)
	if (typeof action.input_value === 'string') out[NOTE_FIELD] = action.input_value
	const value = action.value
	if (value !== null && typeof value === 'object' && value.type !== QUESTION_ACTION_TYPE) absorb(value)
	return out
}

/**
 * Extract our payload from a question card's `card.action.trigger` action.
 *
 * @param {unknown} action - the callback's `event.action`.
 * @returns {{questionId: string, index: number, note: string} | null} the parsed action, or null when it is not ours.
 */
export function parseQuestionAction(action) {
	if (action === null || typeof action !== 'object') return null
	const record = /** @type {Record<string, unknown>} */ (action)
	const form = formValuesOf(record)
	const value = record.value
	const ours = value !== null && typeof value === 'object'
		&& /** @type {Record<string, unknown>} */ (value).type === QUESTION_ACTION_TYPE

	let questionId = ''
	let index = -1
	if (ours) {
		const payload = /** @type {Record<string, unknown>} */ (value)
		if (typeof payload.questionId === 'string') questionId = payload.questionId
		if (typeof payload.index === 'number' && Number.isInteger(payload.index) && payload.index >= 0) {
			index = payload.index
		}
	}
	// Fall back to the control names, which survive a form submit even when the
	// button's own `value` does not.
	for (const key of Object.keys(form)) {
		const match = /^opt(\d+)-(.*)$/.exec(key)
		if (match === null) continue
		if (index < 0) index = Number(match[1])
		if (questionId === '' && match[2] !== '') questionId = match[2]
	}

	const note = typeof form[NOTE_FIELD] === 'string' ? form[NOTE_FIELD].trim() : ''
	const identifiable = ours || questionId !== '' || index >= 0 || NOTE_FIELD in form
	if (!identifiable) return null
	return { questionId, index, note }
}

/**
 * The toast Feishu shows after a question button is clicked.
 * @param {string} label - the chosen option.
 * @returns {{type: string, content: string}} a card-callback toast.
 */
export function questionToast(label) {
	return { type: 'success', content: `已选择：${label}` }
}

/**
 * The toast shown when a question click cannot be applied.
 * @param {string} message - why it failed.
 * @returns {{type: string, content: string}} a card-callback toast.
 */
export function questionErrorToast(message) {
	return { type: 'error', content: message }
}

/**
 * Build the `card.action.trigger` response for an answered question.
 * @param {string} label - the chosen option.
 * @param {object} card - the updated card to render in place.
 * @returns {{toast: object, card: {type: string, data: object}}} the callback response.
 */
export function questionResponse(label, card) {
	return { toast: questionToast(label), card: { type: 'raw', data: card } }
}

/**
 * Extract our payload from a `card.action.trigger` button value.
 * @param {unknown} value - the callback's `event.action.value`.
 * @param {readonly string[]} modes - the modes this build accepts.
 * @returns {{mode: string} | null} the parsed action, or null when it is not ours.
 */
export function parsePermissionAction(value, modes) {
	if (value === null || typeof value !== 'object') return null
	const record = /** @type {Record<string, unknown>} */ (value)
	if (record.type !== PERMISSION_ACTION_TYPE) return null
	const mode = typeof record.mode === 'string' ? record.mode : ''
	if (!modes.includes(mode)) return null
	return { mode }
}

/**
 * The toast Feishu shows after a button click.
 * @param {string} mode - the mode that was applied.
 * @returns {{type: string, content: string}} a card-callback toast.
 */
export function permissionToast(mode) {
	return { type: 'success', content: `已切换到 ${modeLabel(mode)}` }
}

/**
 * The toast shown when the requested change was rejected.
 * @param {string} message - why it failed.
 * @returns {{type: string, content: string}} a card-callback toast.
 */
export function permissionErrorToast(message) {
	return { type: 'error', content: message }
}

/**
 * Build the whole `card.action.trigger` response body.
 *
 * Feishu replaces the card in place with `card.data` and shows `toast`
 * as a transient popup. Returning this from the long-connection handler
 * is what makes the buttons feel instant.
 *
 * @param {string} mode - the mode now in effect.
 * @param {object} card - the updated card to render in place.
 * @returns {{toast: object, card: {type: string, data: object}}} the callback response.
 */
export function permissionResponse(mode, card) {
	return { toast: permissionToast(mode), card: { type: 'raw', data: card } }
}
