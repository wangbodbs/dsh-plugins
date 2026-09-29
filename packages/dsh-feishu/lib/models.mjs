/**
 * The model catalog behind the `/model` command, and the card that switches it.
 *
 * Kept free of Feishu and of the plugin context so it can be tested directly:
 * the inputs are a catalog plus the current selection, the outputs are text or
 * card JSON going back to the chat.
 *
 * Two catalog sources exist and both are accepted:
 *
 * - `ctx.sessionController.modelCatalog()` — the authority. It is the same call
 *   the DSH GUI's model picker makes (it additionally resolves per-model
 *   metadata and reports per-provider failures), and the same service owns
 *   `selectModel()`, so "what is listed" and "what a click can select" cannot
 *   drift apart.
 * - `ctx.llm.listProviders()` + `listModels()` — the fallback when that service
 *   is not mounted. Membership is **advisory** (an adapter may accept an unlisted
 *   id), so the wording says "listed", never "allowed".
 *
 * @module dsh-feishu/models
 */

/** Marker inside a model button's `value` that identifies `/model` cards. */
export const MODEL_ACTION_TYPE = 'dsh_model'

/**
 * Convert a `sessionController.modelCatalog()` result into the internal shape.
 *
 * Provider failures become groups carrying `error`, so one broken provider still
 * renders in place instead of vanishing from the card.
 *
 * @param {object} catalog - the service's catalog.
 * @returns {{groups: Array<{id: string, name: string, models: object[], error?: string}>, current: {provider: string, model: string}}} the normalized catalog.
 */
export function normalizeCatalog(catalog) {
	const groups = (catalog?.groups ?? []).map((group) => ({
		id: group.id,
		name: group.name,
		models: [...(group.models ?? [])],
	}))
	for (const failure of catalog?.failures ?? []) {
		groups.push({ id: failure.id, name: failure.name, models: [], error: failure.message })
	}
	const picked = catalog?.default ?? {}
	return {
		groups,
		current: { provider: picked.provider ?? '', model: picked.model ?? '' },
	}
}

/**
 * The label for one model button.
 * @param {object} model - a catalog entry.
 * @param {boolean} isCurrent - whether this is the active selection.
 * @returns {string} the button text.
 */
function modelButtonLabel(model, isCurrent) {
	const base = typeof model.name === 'string' && model.name !== '' ? model.name : String(model.id)
	const short = base.length > 36 ? `${base.slice(0, 35)}…` : base
	return isCurrent ? `${short} ✓` : short
}


/**
 * Read every provider's advertised models.
 *
 * One slow or broken provider must not hide the others, so a failure is caught
 * per provider and carried in the result instead of thrown.
 *
 * @param {{listProviders: () => Array<{id: string, name: string}>, listModels: (provider: string) => Promise<object[]>}} llm - the LLM runtime.
 * @returns {Promise<Array<{id: string, name: string, models: object[], error?: string}>>} one group per provider, in runtime order.
 */
export async function readModelCatalog(llm) {
	/** @type {Array<{id: string, name: string, models: object[], error?: string}>} */
	const groups = []
	for (const provider of llm.listProviders()) {
		try {
			const models = await llm.listModels(provider.id)
			groups.push({ id: provider.id, name: provider.name, models: [...models] })
		} catch (error) {
			groups.push({
				id: provider.id,
				name: provider.name,
				models: [],
				error: error instanceof Error ? error.message : String(error),
			})
		}
	}
	return groups
}

/**
 * Render the catalog as chat text.
 *
 * @param {object} options - what to render.
 * @param {Array<{id: string, name: string, models: object[], error?: string}>} options.groups - provider groups from {@link readModelCatalog}.
 * @param {{provider: string, model: string}} [options.current] - the selection to mark.
 * @returns {string} the message body.
 */
export function renderModelCatalog({ groups, current = { provider: '', model: '' } }) {
	const total = groups.reduce((sum, group) => sum + group.models.length, 0)
	if (total === 0) {
		const failed = groups.filter((group) => group.error !== undefined)
		if (groups.length === 0) return '⚠️ 这台 DSH 没有注册任何 LLM provider。'
		return failed.length === 0
			? '⚠️ 没有任何注册的 provider 报了模型清单。'
			: `⚠️ 模型清单读不出来：\n${failed.map((group) => `• ${group.id}：${String(group.error)}`).join('\n')}`
	}

	const lines = [
		`🧠 可用模型（共 ${String(total)} 个，来自 ${String(groups.length)} 个 provider）`,
		`当前默认：${current.provider === '' ? '(未知)' : `${current.provider} / ${current.model}`}`,
		'',
	]
	for (const group of groups) {
		lines.push(`▸ ${group.name}（\`${group.id}\`）`)
		if (group.error !== undefined) {
			lines.push(`  ⚠️ 读取失败：${group.error}`)
			continue
		}
		if (group.models.length === 0) {
			lines.push('  （没有可列出的模型）')
			continue
		}
		for (const model of group.models) {
			const mark = group.id === current.provider && model.id === current.model ? ' ← 当前' : ''
			// The display name is often just a prettier id; only show it when it
			// actually adds information.
			const label = typeof model.name === 'string' && model.name !== '' && model.name !== model.id
				? `${model.name}（\`${model.id}\`）`
				: `\`${model.id}\``
			const why = typeof model.description === 'string' && model.description !== '' ? ` — ${model.description}` : ''
			lines.push(`  • ${label}${why}${mark}`)
		}
	}
	lines.push('', '> 清单由各 provider 的适配器自报，仅供参考；实际能不能调，要看对应凭据。')
	return lines.join('\n')
}

/**
 * Build the `/model` switcher card.
 *
 * One button per model, grouped by provider, with the active selection rendered
 * as the filled button and marked with a check. Card 2.0 because `column_set`
 * is what wraps the buttons into rows instead of one long vertical list.
 *
 * @param {object} options - card contents.
 * @param {Array<{id: string, name: string, models: object[], error?: string}>} options.groups - provider groups.
 * @param {{provider: string, model: string}} [options.current] - the active selection.
 * @returns {object} a card 2.0 JSON object.
 */
export function modelCard({ groups, current = { provider: '', model: '' } }) {
	const elements = [
		{
			tag: 'markdown',
			content: [
				`当前：**${current.provider === '' ? '(未知)' : `${current.provider} / ${current.model}`}**`,
				'',
				'点一下按钮就切过去（立刻生效，本会话下一轮就用新模型）。',
			].join('\n'),
		},
		{ tag: 'hr' },
	]

	const selectable = groups.filter((group) => group.error === undefined && group.models.length > 0)
	if (selectable.length === 0) {
		elements.push({ tag: 'markdown', content: '_没有可切换的模型。_' })
	}
	for (const group of selectable) {
		elements.push({ tag: 'markdown', content: `▸ ${group.name}（\`${group.id}\`）` })
		elements.push({
			tag: 'column_set',
			flex_mode: 'flow',
			columns: group.models.map((model) => {
				const isCurrent = group.id === current.provider && model.id === current.model
				return {
					tag: 'column',
					width: 'auto',
					elements: [{
						tag: 'button',
						text: { tag: 'plain_text', content: modelButtonLabel(model, isCurrent) },
						type: isCurrent ? 'primary_filled' : 'default',
						size: 'small',
						behaviors: [{
							type: 'callback',
							value: { type: MODEL_ACTION_TYPE, provider: group.id, model: String(model.id) },
						}],
					}],
				}
			}),
		})
	}

	// Naming the failures keeps "a provider is missing" from looking like "it has
	// no models", which is a different and much more confusing state.
	const broken = groups.filter((group) => group.error !== undefined)
	if (broken.length > 0) {
		elements.push({
			tag: 'markdown',
			content: broken.map((group) => `⚠️ ${group.name}（\`${group.id}\`）读取失败：${String(group.error)}`).join('\n'),
		})
	}

	return {
		schema: '2.0',
		config: { update_multi: true },
		header: { template: 'blue', title: { tag: 'plain_text', content: '🧠 切换模型' } },
		body: { elements },
	}
}

/**
 * Extract the requested selection from a model button click.
 * @param {unknown} value - the callback's `event.action.value`.
 * @returns {{provider: string, model: string} | null} the request, or null when it is not ours.
 */
export function parseModelAction(value) {
	if (value === null || typeof value !== 'object') return null
	const record = /** @type {Record<string, unknown>} */ (value)
	if (record.type !== MODEL_ACTION_TYPE) return null
	const provider = typeof record.provider === 'string' ? record.provider : ''
	const model = typeof record.model === 'string' ? record.model : ''
	if (provider === '' || model === '') return null
	return { provider, model }
}

