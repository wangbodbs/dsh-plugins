/**
 * Pull a Feishu **Drive** folder (飞书云文档) down into the workspace, recreating
 * its directory structure.
 *
 * This is deliberately *not* the `folder` chat message: that one is an opaque
 * blob resource which Feishu refuses to serve at all (plain download → `234037`,
 * `Range` → HTTP 500 / `40009`, and the token is not a Drive token — verified).
 * A Drive folder, by contrast, can be listed and walked.
 *
 * The walking logic is pure: it talks to an injected asynchronous lister, so the
 * tree/flattening behaviour is unit-tested instead of discovered in production.
 *
 * @module dsh-feishu/drive
 */

import { safeFileName } from './inbound.mjs'

/** How deep a Drive folder tree is walked before we call it a loop. */
const MAX_DEPTH = 12

/** Guard against a pathological tree turning into an endless crawl. */
const MAX_ENTRIES = 20_000

/** A Feishu Drive folder token, as it appears in a URL or on its own. */
const FOLDER_TOKEN = /(?:folder|fldcn)[A-Za-z0-9]{6,}/i

/**
 * Pull a folder token out of a pasted link (or accept a bare token).
 *
 * Feishu folder links look like
 * `https://xxx.feishu.cn/drive/folder/<token>` and often carry query noise.
 *
 * @param {string} text - the pasted link or token.
 * @returns {string | undefined} the token, when one was found.
 */
export function parseDriveFolderRef(text) {
	const raw = String(text ?? '').trim()
	if (raw === '') return undefined
	const fromUrl = raw.match(FOLDER_TOKEN)
	if (fromUrl !== null) return fromUrl[0]
	try {
		const url = new URL(raw)
		for (const [, value] of url.searchParams) {
			if (FOLDER_TOKEN.test(value)) return value.match(FOLDER_TOKEN)?.[0]
		}
	} catch {
		// Not a URL; fall through to the bare-token check.
	}
	return /^[A-Za-z0-9_-]{10,}$/.test(raw) ? raw : undefined
}

/**
 * Walk one Drive folder tree.
 *
 * @param {object} options - the walk.
 * @param {string} options.folderToken - where to start.
 * @param {(folderToken: string, pageToken?: string) => Promise<{files: object[], nextPageToken?: string}>} options.list - one page of a folder's children.
 * @param {(event: {seen: number, path: string}) => void} [options.onProgress] - called for every folder visited.
 * @returns {Promise<{files: Array<{token: string, name: string, path: string}>, folders: number, truncated: boolean}>} the flattened tree, paths relative to the root.
 */
export async function walkDriveFolder({ folderToken, list, onProgress }) {
	/** @type {Array<{token: string, name: string, path: string}>} */
	const files = []
	let folders = 0
	let truncated = false
	const visited = new Set()

	/**
	 * @param {string} token - folder being listed.
	 * @param {string} prefix - path of that folder's children.
	 * @param {number} depth - current depth.
	 */
	async function visit(token, prefix, depth) {
		if (visited.has(token)) return
		visited.add(token)
		folders += 1
		onProgress?.({ seen: files.length, path: prefix === '' ? '/' : prefix })

		let pageToken
		do {
			const page = await list(token, pageToken)
			for (const entry of page.files ?? []) {
				const name = safeFileName(entry.name, entry.type === 'folder' ? '未命名文件夹' : '未命名文件')
				if (entry.type === 'folder') {
					if (depth >= MAX_DEPTH) continue
					await visit(String(entry.token), prefix === '' ? name : `${prefix}/${name}`, depth + 1)
					continue
				}
				if (files.length >= MAX_ENTRIES) {
					truncated = true
					return
				}
				files.push({ token: String(entry.token), name, path: prefix === '' ? name : `${prefix}/${name}` })
			}
			pageToken = page.nextPageToken
		} while (pageToken !== undefined && pageToken !== '')
	}

	await visit(folderToken, '', 0)
	return { files, folders, truncated }
}
