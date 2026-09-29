/**
 * Recognise Feishu links and say what they point at.
 *
 * Users paste links constantly, and each kind needs a different API:
 *
 * - `/wiki/<node>`      → `wiki/v2/spaces/get_node`, then the node's `obj_type`
 * - `/docx/<doc>`       → `docx/v1/documents/<id>/raw_content`
 * - `/docs/<doc>`       → the older doc format
 * - `/drive/folder/<t>` → the Drive folder walker
 * - `/file/<t>`, `/sheets/<t>`, `/base/<t>` → other Drive objects
 *
 * Pure: no network, no context — so every link shape is unit-tested.
 *
 * @module dsh-feishu/links
 */

/**
 * `https://<tenant>.feishu.cn/<kind>/<token>`, also matching larksuite.com.
 *
 * `/drive/folder/<token>` and `/drive/file/<token>` carry an extra segment; it
 * is captured separately so a bare `/drive/folder` token shorter than the token
 * length is not mistaken for the token itself.
 */
const LINK_PATTERN = /https?:\/\/[^\s/]*(?:feishu\.cn|larksuite\.com)\/(wiki|docx|docs|sheets|base|file|drive)\/(folder\/|file\/)?([A-Za-z0-9_-]{8,})/i

/**
 * Find one Feishu link in a message.
 *
 * @param {string} text - the message body.
 * @returns {{kind: string, token: string, url: string} | undefined} the link, when there is one.
 */
export function parseFeishuLink(text) {
	const match = String(text ?? '').match(LINK_PATTERN)
	if (match === null) return undefined
	let kind = match[1].toLowerCase()
	const sub = (match[2] ?? '').replace('/', '').toLowerCase()
	// `/drive/folder/<token>` is a folder, not a generic Drive object.
	if (kind === 'drive' && sub === 'folder') kind = 'folder'
	return { kind, token: match[3], url: match[0] }
}

/**
 * Whether a message is *just* a link (nothing else the user wanted to say).
 *
 * Used to decide between "fetch it quietly" and "let the model read the text".
 *
 * @param {string} text - the message body.
 * @returns {boolean} true when the message is one link plus whitespace.
 */
export function isBareLink(text) {
	const trimmed = String(text ?? '').trim()
	if (trimmed === '') return false
	const link = parseFeishuLink(trimmed)
	return link !== undefined && trimmed.replace(link.url, '').trim() === ''
}
