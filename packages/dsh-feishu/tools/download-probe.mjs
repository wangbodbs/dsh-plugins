/**
 * Diagnose why one Feishu **message resource** will or will not download.
 *
 *   node tools/download-probe.mjs <message_id> <file_key> [--type file|image]
 *
 * The message-resource API is the only way to fetch a chat attachment, and its
 * rules are easy to get wrong:
 *
 * - a plain download is refused for a resource of >= 100 MB (`234037`), and the
 *   documented workaround is `Range` chunks of at most 32 MB;
 * - `type=image` does not support `Range` at all.
 *
 * This walks every header/type combination that matters and prints the raw
 * Feishu code for each, so a failure can be attributed instead of guessed. It is
 * deliberately dependency-free and prints **no file contents** (sizes and codes
 * only).
 *
 * Credentials come from `~/.dsh/settings.yaml` (the same place the bridge reads
 * them) and are never printed.
 *
 * @module dsh-feishu/tools/download-probe
 */

import { readFileSync } from 'node:fs'

const [messageId, fileKey] = process.argv.slice(2)
if (messageId === undefined || fileKey === undefined) {
	console.error('用法: node tools/download-probe.mjs <message_id> <file_key> [--type file|image]')
	process.exit(2)
}
const typeFlag = process.argv.indexOf('--type')
const resourceType = typeFlag === -1 ? 'file' : String(process.argv[typeFlag + 1])

const yaml = readFileSync(`${process.env.HOME}/.dsh/settings.yaml`, 'utf8')
const block = yaml.split(/^(?=\S)/m).find((chunk) => chunk.startsWith('feishu:')) ?? ''
const pick = (key) => {
	const found = block.match(new RegExp(`^[ \\t]*${key}:[ \\t]*(.+)$`, 'm'))
	return (found?.[1] ?? '').trim().replace(/^['"]|['"]$/g, '')
}
const domain = (pick('domain') || 'https://open.feishu.cn').replace(/\/+$/, '')

const tokenPayload = await (await fetch(`${domain}/open-apis/auth/v3/tenant_access_token/internal`, {
	method: 'POST',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify({ app_id: pick('appId'), app_secret: pick('appSecret') }),
})).json()
const token = tokenPayload?.tenant_access_token
if (typeof token !== 'string') {
	console.error('拿不到 tenant_access_token')
	process.exit(3)
}
const auth = { Authorization: `Bearer ${token}` }
const base = `${domain}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}`

/**
 * Run one attempt and describe it.
 * @param {string} label - what is being tried.
 * @param {string} url - request URL.
 * @param {Record<string,string>} headers - extra headers.
 * @returns {Promise<void>} prints one line.
 */
async function attempt(label, url, headers) {
	const started = Date.now()
	let response
	try {
		response = await fetch(url, { headers: { ...auth, ...headers } })
	} catch (error) {
		console.log(`  ${label.padEnd(34)} → 请求失败 ${error instanceof Error ? error.message : String(error)}`)
		return
	}
	const elapsed = `${String(Date.now() - started)}ms`
	if (response.ok) {
		const bytes = Buffer.from(await response.arrayBuffer())
		console.log(`  ${label.padEnd(34)} → ✅ HTTP ${String(response.status)} ${String(bytes.length)} 字节 (${elapsed}) content-range=${String(response.headers.get('content-range'))}`)
		return
	}
	const body = await response.text().catch(() => '')
	let code
	let message = body
	try {
		const parsed = JSON.parse(body)
		code = parsed?.code
		message = parsed?.msg
	} catch { /* not JSON */ }
	console.log(`  ${label.padEnd(34)} → ❌ HTTP ${String(response.status)} code=${String(code)} ${String(message)} (${elapsed})`)
}

console.log(`资源: message=${messageId}`)
console.log(`      fileKey=${fileKey}`)
console.log(`      声明类型=${resourceType}\n`)

console.log('A) 类型维度（不带 Range）')
await attempt('type=file', `${base}?type=file`, {})
await attempt('type=image', `${base}?type=image`, {})
await attempt('不带 type 参数', base, {})

console.log('\nB) Range 维度（type=file）')
await attempt('bytes=0-1048575 (1MB)', `${base}?type=file`, { Range: 'bytes=0-1048575' })
await attempt('bytes=0-9999999 (10MB)', `${base}?type=file`, { Range: 'bytes=0-9999999' })
await attempt('bytes=0-33554431 (32MiB)', `${base}?type=file`, { Range: 'bytes=0-33554431' })
await attempt('bytes=0- (开放式)', `${base}?type=file`, { Range: 'bytes=0-' })
await attempt('bytes=1000000-2000000 (中段)', `${base}?type=file`, { Range: 'bytes=1000000-2000000' })

console.log('\nC) 头维度')
await attempt('Range + Content-Type: application/json', `${base}?type=file`, { Range: 'bytes=0-1048575', 'Content-Type': 'application/json' })
await attempt('Range + Accept-Encoding: identity', `${base}?type=file`, { Range: 'bytes=0-1048575', 'Accept-Encoding': 'identity' })
await attempt('If-Range 伪装', `${base}?type=file`, { Range: 'bytes=0-1048575', 'If-Range': '"0"' })

console.log('\nD) 元数据（不含字节）')
{
	const response = await fetch(`${domain}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, { headers: auth })
	const payload = await response.json().catch(() => ({}))
	const body = payload?.data?.items?.[0]?.body?.content
	console.log(`  消息体: ${String(body)}`)
}

console.log('\n结论速查：234037=超过 100MB 需 Range；234046=Range 窗口非法（>32MB 或越界）；40009=飞书服务端内部错误')
