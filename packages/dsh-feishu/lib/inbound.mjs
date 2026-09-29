/**
 * What an inbound Feishu message actually is.
 *
 * The bridge used to drop every non-text message silently — the user sent a file
 * and got no reply at all, which reads as "the bot is broken". This module turns
 * `body.content` into one of three decisions so the caller can download it, or at
 * least say why it cannot.
 *
 * Pure on purpose (no API, no filesystem), so every message type is unit-tested
 * rather than discovered in production.
 *
 * @module dsh-feishu/inbound
 */

/**
 * Message types the message-resource API can serve, mapped to the `type` query
 * it wants. Feishu serves audio and video under `file`, and images under
 * `image`.
 */
const RESOURCE_TYPES = {
	file: 'file',
	audio: 'file',
	media: 'file',
	image: 'image',
}

/**
 * Pull a container chat id out of a `merge_forward` message body.
 *
 * A merged ("合并转发") message is a card holding other messages: the API serves
 * the sub-messages as the history of a hidden container chat. Finding that
 * container is the whole trick — and it is worth trying, because a folder that
 * arrives *inside* a merged card may be unpacked into ordinary `file` messages,
 * which this API does serve.
 *
 * @param {object} message - the raw Feishu message.
 * @returns {string | undefined} the container chat id, when one is present.
 */
export function mergeForwardContainer(message) {
	let content = {}
	try {
		content = JSON.parse(typeof message?.content === 'string' ? message.content : '{}')
	} catch {
		return undefined
	}
	// Documented shapes seen in the wild: `chat_id` at the top level, or nested
	// under a `thread`/`message_list` envelope; fall back to sniffing any string.
	for (const candidate of [content.chat_id, content.container_id, content.thread?.chat_id]) {
		if (typeof candidate === 'string' && candidate.startsWith('oc_')) return candidate
	}
	for (const value of Object.values(content)) {
		if (typeof value === 'string' && value.startsWith('oc_')) return value
	}
	return undefined
}

/** Types that carry a resource but that this API refuses to serve. */
const KNOWN_UNSUPPORTED = {
	folder: '飞书的「文件夹」消息不能通过 API 下载（实测连 Range 分片也返回 500 / code 40009）——把里面的文件单独发过来，或者放到 nas 上告诉我路径，我来取。',
	sticker: '表情包不支持下载。',
	share_chat: '群名片消息没有可下载的文件。',
	share_user: '个人名片消息没有可下载的文件。',
	location: '位置消息没有可下载的文件。',
}

/**
 * Human labels for the message types a user can actually send, so the reply
 * reads "你发的是一个**视频**" instead of "你发的是一个 media".
 */
const TYPE_LABELS = {
	text: '文字',
	post: '富文本',
	image: '图片',
	file: '文件',
	audio: '语音',
	media: '视频',
	sticker: '表情包',
	folder: '文件夹',
	share_chat: '群名片',
	share_user: '个人名片',
	location: '位置',
	system: '系统消息',
	interactive: '卡片',
}

/**
 * Make a filename safe to join onto a directory.
 *
 * Feishu gives us the sender's filename verbatim, so it can contain `/`, `..`,
 * NUL, or nothing at all.
 *
 * @param {unknown} name - the name Feishu reported.
 * @param {string} fallback - what to use when there is nothing usable.
 * @returns {string} a single path segment.
 */
export function safeFileName(name, fallback = 'feishu-attachment') {
	const raw = typeof name === 'string' ? name : ''
	const cleaned = raw
		// Path separators are what actually enable traversal, on POSIX and
		// Windows alike — blank them out and the result is one safe segment.
		.replace(/[/\\]/g, '_')
		.replace(/[\u0000-\u001f\u007f]/g, '')
		.trim()
	// Leading dots are kept on purpose: macOS sends real `._name` AppleDouble
	// sidecars, and renaming a user's file silently is its own kind of bug.
	// A name made only of dots is still useless, so that falls back.
	if (cleaned === '' || /^\.+$/.test(cleaned)) return fallback
	return cleaned.slice(0, 120)
}

/**
 * Decide what to do with one inbound message.
 *
 * @param {object} message - the raw `event.message`.
 * @returns {{kind: 'resource', downloadType: 'file'|'image', fileKey: string, name: string} | {kind: 'unsupported', label: string, reason: string}} the decision.
 */
export function describeAttachment(message) {
	const type = String(message?.message_type ?? '')
	let content = {}
	try {
		content = JSON.parse(typeof message?.content === 'string' ? message.content : '{}')
	} catch {
		content = {}
	}

	const downloadType = RESOURCE_TYPES[type]
	if (downloadType !== undefined) {
		const fileKey = content.file_key ?? content.image_key
		if (typeof fileKey !== 'string' || fileKey === '') {
			return { kind: 'unsupported', label: type, reason: `这条 ${type} 消息里没有可下载的资源 key。` }
		}
		const fallback = downloadType === 'image' ? 'feishu-image.png' : 'feishu-file'
		return {
			kind: 'resource',
			downloadType,
			fileKey,
			name: safeFileName(content.file_name, fallback),
		}
	}

	if (type in KNOWN_UNSUPPORTED) {
		return { kind: 'unsupported', label: TYPE_LABELS[type] ?? type, reason: KNOWN_UNSUPPORTED[type] }
	}
	const label = TYPE_LABELS[type] ?? (type === '' ? '未知类型' : type)
	return {
		kind: 'unsupported',
		label,
		reason: `暂不支持处理**${label}**类型的飞书消息（\`${type}\`）。发文件、图片或文字都可以。`,
	}
}
