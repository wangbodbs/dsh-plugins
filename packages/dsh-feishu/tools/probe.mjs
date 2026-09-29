/**
 * Standalone probe for the Feishu long connection.
 *
 * Run it, send a message to the bot in Feishu, and watch the event arrive. It
 * proves the framing (`pbbp2.Frame`) and the credential/setup path before any
 * of it is wired into the DSH plugin — the plugin can then reuse the exact
 * same modules.
 *
 *   node tools/probe.mjs
 *
 * Credentials are read from `<workspace>/.feishu-secrets/` (0600) and never
 * printed.
 *
 * @module dsh-feishu/tools/probe
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { FeishuApi, messageText } from '../lib/api.mjs'
import { FeishuLongConnection } from '../lib/ws.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const secretsDir = join(here, '..', '..', '.feishu-secrets')

const appId = readFileSync(join(secretsDir, 'app-id'), 'utf8').trim()
const appSecret = readFileSync(join(secretsDir, 'app-secret'), 'utf8').trim()

const logger = {
  info: (message) => console.log(`${new Date().toISOString()} INFO  ${message}`),
  warn: (message) => console.log(`${new Date().toISOString()} WARN  ${message}`),
  error: (message) => console.log(`${new Date().toISOString()} ERROR ${message}`),
  debug: (message) => console.log(`${new Date().toISOString()} DEBUG ${message}`),
}

const api = new FeishuApi({ appId, appSecret, logger })

console.log('正在做一次 REST 自检 …')
const bot = await (async () => {
  const token = await api.tenantToken()
  const response = await fetch('https://open.feishu.cn/open-apis/bot/v3/info', {
    headers: { Authorization: `Bearer ${token}` },
  })
  return response.json()
})()
console.log(`REST 自检: code=${String(bot.code)} 机器人=${String(bot.bot?.app_name)}`)

const connection = new FeishuLongConnection({
  appId,
  appSecret,
  logger,
  onStatus: (status) => console.log(`[状态] ${JSON.stringify(status)}`),
  onEvent: async (envelope) => {
    const type = envelope?.header?.event_type ?? '(未知)'
    console.log(`\n===== 收到事件: ${type} =====`)
    console.log(JSON.stringify(envelope, null, 2))

    if (type !== 'im.message.receive_v1') return
    const message = envelope.event?.message ?? {}
    const chatId = message.chat_id
    const text = messageText(message)
    console.log(`→ chat_id=${String(chatId)} chat_type=${String(message.chat_type)} text=${JSON.stringify(text)}`)
    if (typeof chatId !== 'string' || chatId === '') return

    try {
      const sent = await api.sendText({
        receiveIdType: 'chat_id',
        receiveId: chatId,
        text: `✅ 链路已通（DSH 飞书插件探针）\n收到你的消息: ${text || '(空)'}`,
      })
      console.log(`← 已回复, message_id=${sent.messageId}`)
    } catch (error) {
      console.log(`← 回复失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  },
})

connection.start()
console.log('长连接启动中 … 请现在到飞书里给「LUNA」发一条消息。')

process.on('SIGINT', () => {
  console.log('\n收到 SIGINT，断开长连接。')
  connection.close()
  process.exit(0)
})
