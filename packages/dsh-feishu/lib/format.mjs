/**
 * How outgoing text reaches a Feishu chat.
 *
 * **Feishu plain-text messages do not render Markdown at all** — a `text`
 * message shows `**bold**`, `| a | b |` and backticks literally, which reads as
 * noise. Cards do render Markdown, and a **card JSON 2.0** markdown element
 * additionally understands headings, quotes and **tables** (those three are
 * 2.0-only; card 1.0 silently drops them). So every message the bridge pushes
 * goes out as a 2.0 card, and only falls back to plain text — with the markup
 * stripped — when the card cannot be delivered.
 *
 * See https://open.feishu.cn/document/feishu-cards/card-components/content-components/rich-text
 *
 * @module dsh-feishu/format
 */

/** Feishu renders very long messages poorly; split above this. */
export const MAX_CHUNK_CHARS = 3_800

/** Fence markers a chunker has to keep balanced across a split. */
const FENCE_PATTERN = /^\s*(```|~~~)/

/**
 * Build a card that shows `content` as rendered Markdown.
 *
 * No header by default: without one the card looks like an ordinary message
 * instead of an alert, which is right for answers and progress reports.
 *
 * @param {string} content - Markdown body.
 * @param {object} [options] - card options.
 * @param {string} [options.header] - title, when the card should look like an alert.
 * @param {string} [options.template] - header colour.
 * @returns {object} a card 2.0 JSON object.
 */
export function markdownCard(content, { header, template = 'blue' } = {}) {
	return {
		schema: '2.0',
		config: { update_multi: true },
		...(header === undefined || header === ''
			? {}
			: { header: { template, title: { tag: 'plain_text', content: header } } }),
		body: { elements: [{ tag: 'markdown', content: String(content) }] },
	}
}

/**
 * Reduce Markdown to something that still reads well as a plain-text message.
 *
 * Only used when the card path failed, so it is deliberately crude: the goal is
 * "no stray asterisks", not fidelity.
 *
 * @param {string} text - Markdown source.
 * @returns {string} text with the markup removed.
 */
export function toPlainText(text) {
	return String(text)
		.replace(/^\s{0,3}#{1,6}\s+/gm, '')
		.replace(/^\s{0,3}>\s?/gm, '')
		.replace(/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/gm, '————')
		.replace(/\*\*(.+?)\*\*/g, '$1')
		.replace(/__(.+?)__/g, '$1')
		.replace(/~~(.+?)~~/g, '$1')
		.replace(/`([^`]+)`/g, '$1')
		.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
		// A Markdown row is unreadable without a table renderer; keep the cells.
		.replace(/^\s*\|(.+)\|\s*$/gm, (_line, cells) =>
			cells.split('|').map((cell) => cell.trim()).filter((cell) => cell !== '').join(' · '))
		.replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, '')
}

/**
 * Split a long Markdown body into chat-sized chunks.
 *
 * Splits on line boundaries and keeps **code fences balanced**: a chunk that
 * begins inside a fenced block is re-opened with the same fence and closed at
 * the end, so the renderer never sees an unterminated block.
 *
 * @param {string} text - the full body.
 * @param {number} [limit] - maximum characters per chunk.
 * @returns {string[]} the chunks, in order.
 */
export function chunkMarkdown(text, limit = MAX_CHUNK_CHARS) {
	const source = String(text)
	if (source.length <= limit) return [source]

	/** @type {string[]} */
	const chunks = []
	/** @type {string[]} */
	let current = []
	let size = 0
	/** The fence marker currently open, or null. */
	let openFence = null

	const flush = () => {
		if (current.length === 0) return
		if (openFence === null) {
			chunks.push(current.join('\n'))
			current = []
			size = 0
			return
		}
		// Close the block here and re-open it in the next chunk.
		chunks.push([...current, openFence].join('\n'))
		current = [openFence]
		size = openFence.length + 1
	}

	for (const line of source.split('\n')) {
		if (size > 0 && size + line.length + 1 > limit) flush()
		current.push(line)
		size += line.length + 1
		if (FENCE_PATTERN.test(line)) {
			if (openFence === null) openFence = line.trim().startsWith('~~~') ? '~~~' : '```'
			else openFence = null
		}
	}
	if (current.length > 0) chunks.push(current.join('\n'))
	return chunks.filter((chunk) => chunk !== '')
}
