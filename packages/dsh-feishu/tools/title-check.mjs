/**
 * `/sessions` titles: the derivation that turns a Feishu prompt into a label.
 *
 *   node tools/title-check.mjs
 *
 * Feishu prompts are injected with a producer source kind, which the host's own
 * session-title service ignores (`source.kind === 'user'` only), so this plugin
 * derives the label itself. These cases pin what that derivation must and must
 * not produce: no control codes, no URLs, no bare acknowledgements, and never a
 * title that grows past the byte cap the host bundle uses (40 bytes / 5 words).
 *
 * @module dsh-feishu/tools/title-check
 */

import { renderSessions, titleFromPrompt, titleFromPrompts } from '../lib/conversations.mjs'

let failed = 0

/**
 * Assert one derived title.
 * @param {string} label - what is being checked.
 * @param {unknown} actual - the produced value.
 * @param {string} expected - the required value.
 * @returns {void}
 */
function same(label, actual, expected) {
	const ok = actual === expected
	if (!ok) failed += 1
	console.log(`${ok ? '✓' : '✗'} ${label} → ${JSON.stringify(actual)}${ok ? '' : `（期望 ${JSON.stringify(expected)}）`}`)
}

console.log('1) 单条消息 → 标题 …')
same('普通中文', titleFromPrompt('你的修改没成功啊'), '你的修改没成功啊')
same('裸链接被丢掉', titleFromPrompt('看这个 https://example.com/a?b=1 行不行'), '看这个 行不行')
same('控制序列被清掉', titleFromPrompt('\u001b[31m红色\u001b[0m 标题'), '红色 标题')
same('折行归一为一行', titleFromPrompt('第一行\n第二行'), '第一行 第二行')
same('太短的应答不配标题', titleFromPrompt('2'), '')
same('单个字不配标题', titleFromPrompt('w'), '')
same('纯标点不配标题', titleFromPrompt('？？？'), '')
same('超长按 40 字节截断', titleFromPrompt('通过网盘分享的文件：1008大众扩4k'), '通过网盘分享的文件：1008大众')
same('超过 5 个词只留前 5 个', titleFromPrompt('a b c d e f g'), 'a b c d e')

console.log('\n2) 一段会话的多条消息 → 标题 …')
same('跳过开场白，用下一条', titleFromPrompts(['怎么样了', '看一下上传到怎么样了']), '看一下上传到怎么样了')
same('全是噪声则没有标题', titleFromPrompts(['2', 'w', '？']), '')
same('只有一条短而具体的消息', titleFromPrompts(['转4K']), '转4K')
same('没有消息则没有标题', titleFromPrompts([]), '')

console.log('\n3) 列表渲染 …')
const overview = {
	current: 2,
	items: [
		{ generation: 1, sessionId: 'feishu-oc_x', createdAt: 0, title: '转4K批量' },
		{ generation: 2, sessionId: 'feishu-oc_x-2', createdAt: 0 },
	],
	hiddenCount: 3,
	currentArchived: false,
}
const text = renderSessions(overview)
same('编号后面有标题', text.includes('　 #1  转4K批量  ·  时间未知'), true)
same('写入归档条数', text.includes('已省略 3 个归档会话'), true)

console.log(failed === 0 ? '\n✅ 全部通过' : `\n❌ ${String(failed)} 项失败`)
process.exit(failed === 0 ? 0 : 1)
