/**
 * Conversation generations of one Feishu chat.
 *
 * A chat is not one DSH session but a series of them: generation 1 is the
 * session a chat has always had, and every `/new` opens the next one. A session
 * id is therefore a pure function of `(chatId, generation)`, which is what
 * makes `/sessions` and `/open` cheap and honest — the set of ids in the
 * session store *is* the history, so no index of our own can drift from it.
 *
 * @module dsh-feishu/generations
 */

/** Every session this plugin owns is named with this prefix. */
export const SESSION_PREFIX = 'feishu-'

/**
 * The session id of one chat's generation.
 *
 * Generation 1 keeps the historical `feishu-<chatId>` form, so a chat that
 * predates `/new` is already generation 1 and needs no migration.
 *
 * @param {string} chatId - the Feishu chat id.
 * @param {number} generation - a positive integer.
 * @returns {string} the session id.
 * @throws {Error} when the generation is not a positive integer.
 */
export function sessionIdOf(chatId, generation) {
	if (!Number.isInteger(generation) || generation < 1) {
		throw new Error(`generation must be a positive integer, got ${String(generation)}`)
	}
	return generation === 1 ? `${SESSION_PREFIX}${chatId}` : `${SESSION_PREFIX}${chatId}-${String(generation)}`
}

/**
 * The generation a session id encodes, when it belongs to that chat.
 *
 * Feishu chat ids contain no `-`, so the suffix after the chat id is
 * unambiguous: empty is generation 1, `-<digits>` is that generation, and
 * anything else is not one of ours.
 *
 * @param {string} sessionId - a candidate session id.
 * @param {string} chatId - the chat the id should belong to.
 * @returns {number|undefined} the generation, or `undefined` when it is not this chat's.
 */
export function generationOf(sessionId, chatId) {
	if (typeof sessionId !== 'string' || typeof chatId !== 'string' || chatId === '') return undefined
	const prefix = `${SESSION_PREFIX}${chatId}`
	if (!sessionId.startsWith(prefix)) return undefined
	const suffix = sessionId.slice(prefix.length)
	if (suffix === '') return 1
	const match = /^-(\d+)$/.exec(suffix)
	if (match === null) return undefined
	const generation = Number(match[1])
	return Number.isSafeInteger(generation) && generation >= 1 ? generation : undefined
}

/**
 * The chat (and generation) a session id encodes — the reverse of
 * {@link sessionIdOf}, needing no second argument.
 *
 * This exists because the live `sessionId ⇄ chatId` map is only ever filled by
 * an **inbound** Feishu message. Right after a restart, or when the user drives
 * a Feishu session from the DSH GUI instead of the chat, that map is empty and
 * a tool like `feishu_send` / `feishu_ask` would otherwise have no way to learn
 * which chat its own session belongs to. The id is deterministic, so decode it.
 *
 * @param {string} sessionId - a candidate session id.
 * @returns {{chatId: string, generation: number} | undefined} the decoded chat, or `undefined` when it is not one of ours.
 */
export function decodeSessionId(sessionId) {
	if (typeof sessionId !== 'string' || !sessionId.startsWith(SESSION_PREFIX)) return undefined
	const rest = sessionId.slice(SESSION_PREFIX.length)
	if (rest === '') return undefined
	// Chat ids contain no `-`, so a trailing `-<digits>` can only be the generation.
	const dash = rest.lastIndexOf('-')
	if (dash <= 0) return { chatId: rest, generation: 1 }
	const suffix = rest.slice(dash + 1)
	if (!/^\d+$/.test(suffix)) return { chatId: rest, generation: 1 }
	const generation = Number(suffix)
	if (!Number.isSafeInteger(generation) || generation < 1) return { chatId: rest, generation: 1 }
	return { chatId: rest.slice(0, dash), generation }
}
