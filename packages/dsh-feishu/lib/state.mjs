/**
 * Durable "which generation is this chat on" pointer.
 *
 * Which generations *exist* is derived from the session store (see
 * `./generations.mjs`), but which one is *current* is a user decision that
 * cannot be derived: `/open 1` while generation 3 exists must survive a
 * restart of either the bridge or DSH itself. That single number per chat is
 * all this file holds.
 *
 * Losing it is never fatal — the bridge falls back to the newest generation —
 * so every read and write is best effort, and the two failure modes are
 * reported rather than thrown.
 *
 * @module dsh-feishu/state
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { dshHome } from './paths.mjs'

/** Bumped when the on-disk shape changes; an unknown version is ignored. */
const STATE_VERSION = 1

/**
 * Per-chat conversation pointers, persisted as one small JSON document.
 */
export class ChatPointerStore {
	/**
	 * @param {string} [file] - explicit state path; defaults to `<DSH_HOME>/dsh-feishu.state.json`.
	 */
	constructor(file = join(dshHome(), 'dsh-feishu.state.json')) {
		/** @type {string} */
		this.file = file
		/** @type {Map<string, number>} */
		this.values = new Map()
		/** @type {string|undefined} reason the stored file could not be read */
		this.readError = undefined
		/** @type {string|undefined} reason writes are not reaching the disk */
		this.writeError = undefined
		this.#load()
	}

	/** Read the stored document; a missing file is simply a first run. */
	#load() {
		let raw
		try {
			raw = readFileSync(this.file, 'utf8')
		} catch (error) {
			if (error?.code !== 'ENOENT') this.readError = describe(error)
			return
		}
		try {
			const parsed = JSON.parse(raw)
			if (parsed?.version !== STATE_VERSION) return
			const chats = parsed?.chats
			if (chats === null || typeof chats !== 'object') return
			for (const [chatId, generation] of Object.entries(chats)) {
				if (Number.isSafeInteger(generation) && generation >= 1) this.values.set(chatId, generation)
			}
		} catch (error) {
			this.readError = describe(error)
		}
	}

	/**
	 * The stored generation for one chat.
	 * @param {string} chatId - the Feishu chat id.
	 * @returns {number|undefined} the generation, or `undefined` when unknown.
	 */
	get(chatId) {
		return this.values.get(chatId)
	}

	/**
	 * Remember a generation for this process only.
	 *
	 * Used for the derived default (the newest existing generation), which is
	 * not a user decision and would otherwise cost a disk write per chat.
	 *
	 * @param {string} chatId - the Feishu chat id.
	 * @param {number} generation - the generation in effect.
	 */
	remember(chatId, generation) {
		this.values.set(chatId, generation)
	}

	/**
	 * Remember a generation and persist the whole document.
	 * @param {string} chatId - the Feishu chat id.
	 * @param {number} generation - the generation in effect.
	 * @returns {boolean} true when the document reached the disk.
	 */
	set(chatId, generation) {
		this.values.set(chatId, generation)
		return this.#save()
	}

	/**
	 * Write the document through a temporary file, so a crash mid-write cannot
	 * leave a truncated pointer behind.
	 * @returns {boolean} true on success.
	 */
	#save() {
		try {
			mkdirSync(dirname(this.file), { recursive: true })
			const document = JSON.stringify(
				{ version: STATE_VERSION, chats: Object.fromEntries(this.values) },
				null,
				'\t',
			)
			const temporary = `${this.file}.tmp`
			writeFileSync(temporary, `${document}\n`, { mode: 0o600 })
			renameSync(temporary, this.file)
			this.writeError = undefined
			return true
		} catch (error) {
			this.writeError = describe(error)
			return false
		}
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
