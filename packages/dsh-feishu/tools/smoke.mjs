/**
 * Load-and-apply smoke test for the dsh-feishu plugin.
 *
 * Runs the plugin module with a mock cordis context. It exists because a
 * module-level throw in a bundle takes the WHOLE harness down at boot, and
 * because `apply()` itself must not throw for a half-configured row.
 *
 *   node tools/smoke.mjs
 *
 * @module dsh-feishu/tools/smoke
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')

// A scratch copy of `lib/` with a `node_modules` link to the profile's, so the
// `@deepseek-ai/*` peer imports resolve exactly as they will once installed.
const scratch = mkdtempSync(join(tmpdir(), 'dsh-feishu-load-'))
mkdirSync(join(scratch, 'node_modules'), { recursive: true })
cpSync(join(pluginRoot, 'lib'), join(scratch, 'lib'), { recursive: true })
const profileModules = join(process.env.HOME ?? '', '.dsh', 'profiles', 'node_modules', '@deepseek-ai')
symlinkSync(profileModules, join(scratch, 'node_modules', '@deepseek-ai'), 'dir')
symlinkSync(
  join(process.env.HOME ?? '', '.dsh', 'profiles', 'node_modules', 'schemastery'),
  join(scratch, 'node_modules', 'schemastery'),
  'dir',
)

/** @type {string[]} */
const logs = []

try {
  console.log('1) 模块加载 …')
  const mod = await import(join(scratch, 'lib', 'index.mjs'))
  console.log(`   ✓ 加载成功 name=${String(mod.name)}`)
  console.log(`   ✓ inject=${JSON.stringify(mod.inject)}`)
  console.log(`   ✓ Config 校验: ${JSON.stringify(mod.Config({}))}`)
  console.log(`   ✓ apply 是函数: ${typeof mod.apply === 'function'}`)

  console.log('2) apply() 干跑（未启用，不应联网）…')
  /** @type {Array<() => unknown>} */
  const disposers = []
  /** @type {any[]} */
  const registeredTools = []
  /** @type {Array<{event: string, listener: Function, options: unknown}>} */
  const listeners = []
  const ctx = {
    logger: Object.assign(
      (name) => ctx.logger,
      {
        info: (message) => logs.push(`INFO ${String(message)}`),
        warn: (message) => logs.push(`WARN ${String(message)}`),
        error: (message) => logs.push(`ERROR ${String(message)}`),
        debug: (message) => logs.push(`DEBUG ${String(message)}`),
      },
    ),
    on: (event, listener, options) => { listeners.push({ event, listener, options }); return () => {} },
    inject: () => {},
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return () => {}
    },
    tools: { register: (definition) => { registeredTools.push(definition); return () => {} } },
    webServer: { register: () => () => {} },
    agents: { get: () => undefined, create: async () => ({ agent: {} }), resume: async () => ({ agent: {} }) },
    sessionQuery: { observeSession: async () => ({}), listSessions: async () => [] },
    /** Optional services are read through `ctx.get`; absent here on purpose. */
    get: () => undefined,
    agentDefaultModel: { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) },
    // Read-only stand-in: the plugin must survive the policy service being
    // absent, because `/permission` is usable before any session exists.
    sandboxPolicy: {
      defaultMode: 'workspace-write',
      overrideOf: () => undefined,
    },
    // Preset composition: this is what gives a session its real capabilities
    // (shell, filesystem, MCP, memory). The dry run only checks that apply()
    // tolerates its presence.
    agentPresets: {
      defaultId: 'standard',
      resolve: async (id) => ({ id: id ?? 'standard' }),
      mount: async () => ({ id: 'standard' }),
    },
  }

  mod.apply(ctx, mod.Config({}))
  console.log('   ✓ 未启用时 apply 未抛错')
  console.log(`   ✓ effect 注册数=${String(disposers.length)}`)

  const expected = ['agents', 'sessionQuery', 'tools', 'agentDefaultModel', 'sandboxPolicy', 'agentPresets', 'llm']
  const missing = expected.filter((service) => !mod.inject.includes(service))
  console.log(missing.length === 0
    ? '   ✓ inject 覆盖全部依赖（含 sandboxPolicy / agentPresets / llm）'
    : `   ✗ inject 缺: ${missing.join(', ')}`)

  console.log('3) `/permission` 卡片与回调（纯函数，不联网）…')
  const cards = await import(join(scratch, 'lib', 'cards.mjs'))
  const modes = ['read-only', 'workspace-write', 'danger-full-access']
  const card = cards.permissionCard({ chatId: 'oc_smoke', currentMode: 'workspace-write', modes })
  const buttons = card.elements.find((element) => element.tag === 'action')?.actions ?? []
  console.log(`   ✓ 卡片标题=${card.header.title.content} 按钮=${String(buttons.length)} 个`)
  const parsed = cards.parsePermissionAction(buttons[2]?.value, modes)
  console.log(`   ✓ 第三个按钮解析 → ${JSON.stringify(parsed)}`)
  console.log(`   ✓ 借用他人 value 解析 → ${JSON.stringify(cards.parsePermissionAction({ type: 'nope' }, modes))}`)
  const response = cards.permissionResponse('danger-full-access', card)
  console.log(`   ✓ 回调响应 toast=${response.toast.content} card.type=${response.card.type}`)

  console.log('3b) `feishu_ask` 问题卡片与回调（纯函数，不联网）…')
  const generations = await import(join(scratch, 'lib', 'generations.mjs'))
  const askCard = cards.questionCard({
    questionId: 'q_smoke',
    question: '要转 4K 吗？',
    options: ['要', '不要'],
    hint: '> 也可以直接回文字',
  })
  // Card 2.0: the question and the form live under `body.elements`.
  const form = askCard.body.elements.find((element) => element.tag === 'form')
  const askInput = form.elements.find((element) => element.tag === 'input')
  const columnSet = form.elements.find((element) => element.tag === 'column_set')
  const askButtons = columnSet.columns.map((column) => column.elements[0])
  console.log(`   ✓ 卡片版本=${askCard.schema} 标题=${askCard.header.title.content} 按钮=${String(askButtons.length)} 个`)
  console.log(askInput !== undefined && askInput.name === cards.NOTE_FIELD
    ? `   ✓ 表单里有补充输入框 name=${askInput.name}（${String(askInput.input_type)}）`
    : `   ✗ 表单里没有补充输入框: ${JSON.stringify(form.elements.map((e) => e.tag))}`)
  console.log(askButtons.every((button) => button.form_action_type === 'submit' && typeof button.name === 'string' && button.name.includes('q_smoke'))
    ? `   ✓ 按钮都绑定表单提交，name 带 questionId（${askButtons.map((b) => b.name).join(' / ')}）`
    : '   ✗ 按钮没绑定表单提交或 name 缺 questionId')

  const buttonValue = (button) => button.behaviors.find((behavior) => behavior.type === 'callback')?.value
  const secondAction = { tag: 'button', value: buttonValue(askButtons[1]) }
  console.log(`   ✓ 第二个按钮（带 value）解析 → ${JSON.stringify(cards.parseQuestionAction(secondAction))}`)
  console.log(`   ✓ 借用权限卡 value → ${JSON.stringify(cards.parseQuestionAction({ tag: 'button', value: buttons[2]?.value }))}`)
  console.log(`   ✓ 别人的卡片/普通消息 → ${JSON.stringify(cards.parseQuestionAction({ tag: 'button', value: { foo: 'bar' } }))}`)

  // A form submit may drop the button's own `value`; the control name still
  // carries both the option and the question.
  const nameOnly = { tag: 'button', form_value: { [cards.buttonName(1, 'q_smoke')]: '' } }
  console.log(JSON.stringify(cards.parseQuestionAction(nameOnly)) === JSON.stringify({ questionId: 'q_smoke', index: 1, note: '' })
    ? '   ✓ 只靠控件 name 也能还原 选项+questionId（value 丢了不怕）'
    : `   ✗ name 兜底失败: ${JSON.stringify(cards.parseQuestionAction(nameOnly))}`)

  const withNote = { tag: 'button', value: buttonValue(askButtons[0]), form_value: { [cards.NOTE_FIELD]: ' 先把 nas 上的素材同步过来 ' } }
  console.log(cards.parseQuestionAction(withNote)?.note === '先把 nas 上的素材同步过来'
    ? `   ✓ 补充文字被取出并 trim: ${JSON.stringify(cards.parseQuestionAction(withNote))}`
    : `   ✗ 补充文字没取到: ${JSON.stringify(cards.parseQuestionAction(withNote))}`)

  const noteOnly = { tag: 'input', input_value: '只有文字，没点按钮', value: { type: 'dsh_question', questionId: 'q_smoke' } }
  console.log(cards.parseQuestionAction(noteOnly)?.index === -1 && cards.parseQuestionAction(noteOnly)?.note !== ''
    ? '   ✓ 只提交输入框（没点按钮）也能识别'
    : `   ✗ 只提交输入框识别失败: ${JSON.stringify(cards.parseQuestionAction(noteOnly))}`)

  const badIndexes = [-1, 1.5, 'x', undefined]
  const accepted = badIndexes.filter((index) => cards.parseQuestionAction({ value: { type: 'dsh_question', questionId: 'q', index } })?.index >= 0)
  console.log(accepted.length === 0 ? '   ✓ 非法 index 一律不认' : `   ✗ 误认 index: ${accepted.join(', ')}`)
  console.log(cards.parsePermissionAction(buttonValue(askButtons[1]), modes) === null
    ? '   ✓ 问题按钮不会被权限处理器误认'
    : '   ✗ 问题按钮被权限处理器误认')

  const askAnswered = cards.answeredQuestionCard({ question: '要转 4K 吗？', label: '要', note: '记得先备份' })
  const residual = askAnswered.body.elements.filter((element) => element.tag === 'form' || element.tag === 'button').length
  const footer = askAnswered.body.elements.at(-1)?.content ?? ''
  console.log(`   ✓ 已答卡片标题=${askAnswered.header.title.content} 残留控件=${String(residual)} 个`)
  console.log(footer.includes('要') && footer.includes('记得先备份')
    ? '   ✓ 已答卡片同时回显选项与补充'
    : `   ✗ 已答卡片回显不全: ${footer}`)
  const timedOut = cards.answeredQuestionCard({ question: '要转 4K 吗？', timedOut: true })
  console.log(`   ✓ 超时卡片标题=${timedOut.header.title.content}`)
  const askResponse = cards.questionResponse('要', askAnswered)
  console.log(`   ✓ 回调响应 toast=${askResponse.toast.content} card.type=${askResponse.card.type}`)

  const decoded = generations.decodeSessionId('feishu-oc_cli_test-3')
  const decodedFirst = generations.decodeSessionId('feishu-oc_cli_test')
  const notOurs = generations.decodeSessionId('session-abc')
  console.log(decoded?.chatId === 'oc_cli_test' && decoded.generation === 3
    && decodedFirst?.generation === 1 && notOurs === undefined
    ? '   ✓ decodeSessionId: 第 3 段 → oc_cli_test#3，无后缀 → #1，别人的 id → undefined'
    : `   ✗ decodeSessionId 不对: ${JSON.stringify([decoded, decodedFirst, notOurs])}`)

  const toolNames = registeredTools.map((tool) => tool.name)
  console.log(toolNames.includes('feishu_send') && toolNames.includes('feishu_ask')
    ? `   ✓ 注册的工具: ${toolNames.join(', ')}`
    : `   ✗ 工具注册不对: ${toolNames.join(', ')}`)
  const askTool = registeredTools.find((tool) => tool.name === 'feishu_ask')
  const askProps = askTool?.parameters?.properties ?? {}
  const askParams = Object.keys(askProps)
  console.log(askTool !== undefined && typeof askTool.execute === 'function'
    ? `   ✓ feishu_ask 可执行，参数: ${askParams.join(', ')}`
    : '   ✗ feishu_ask 不可执行')
  const required = askTool?.parameters?.required ?? []
  console.log(askProps.options?.type === 'array' && required.includes('question') && required.includes('options')
    ? '   ✓ feishu_ask 参数表完整（question/options 必填，options 是数组）'
    : `   ✗ feishu_ask 参数表不对: ${JSON.stringify(askTool?.parameters ?? {})}`)

  // Non-Feishu sessions must be told to use ask_user_question instead of
  // parking a turn on a card nobody can see.
  const stranger = await askTool.execute(
    { question: 'q', options: ['a'] },
    { signal: new AbortController().signal, agent: { session: { id: 'session-not-feishu' } } },
  )
  // A Feishu session must be recognized from its **id alone**: right after a
  // restart (or when the user types in the GUI) no inbound message has filled
  // the chat map yet. `api` is null in this dry run, so the answer proves the
  // session was recognized: it says "bridge offline", not "not feishu".
  const revived = await askTool.execute(
    { question: 'q', options: ['a'] },
    { signal: new AbortController().signal, agent: { session: { id: 'feishu-oc_gui_typed' } } },
  )
  console.log(revived.reason === 'bridge-offline' && revived.chatId === 'oc_gui_typed'
    ? `   ✓ 飞书会话靠 session id 就能认出来（重启后第一轮也行）：${JSON.stringify(revived)}`
    : `   ✗ 没能靠 session id 认出飞书会话: ${JSON.stringify(revived)}`)
  console.log(stranger.reason === 'not-feishu' && stranger.answered === false
    ? `   ✓ 非飞书会话直接返回 ${JSON.stringify(stranger)}`
    : `   ✗ 非飞书会话应拒绝: ${JSON.stringify(stranger)}`)

  console.log('3c) `/model` 模型清单（假 LLM，不联网）…')
  const models = await import(join(scratch, 'lib', 'models.mjs'))
  const fakeLlm = {
    listProviders: () => [
      { id: 'deepseek-official', name: 'DeepSeek 官方' },
      { id: 'broken', name: '坏掉的 provider' },
      { id: 'empty', name: '空的 provider' },
    ],
    listModels: async (provider) => {
      if (provider === 'broken') throw new Error('connection refused')
      if (provider === 'empty') return []
      return [
        { provider, id: 'deepseek-flash', name: 'DeepSeek Flash' },
        { provider, id: 'deepseek-chat', name: 'deepseek-chat', description: '长上下文' },
      ]
    },
  }
  const modelGroups = await models.readModelCatalog(fakeLlm)
  console.log(modelGroups.length === 3 && modelGroups[0].models.length === 2 && modelGroups[1].error === 'connection refused'
    ? '   ✓ 一个 provider 报错不影响另外两个（错误就地记下）'
    : `   ✗ readModelCatalog 结构不对: ${JSON.stringify(modelGroups)}`)
  const listText = models.renderModelCatalog({
    groups: modelGroups,
    current: { provider: 'deepseek-official', model: 'deepseek-flash' },
  })
  console.log(listText.includes('共 2 个') && listText.includes('▸ DeepSeek 官方（`deepseek-official`）')
    ? '   ✓ 清单有数量与分组标题'
    : `   ✗ 清单头不对:\n${listText}`)
  console.log(listText.includes('DeepSeek Flash（`deepseek-flash`）')
    && listText.includes('`deepseek-chat` — 长上下文')
    ? '   ✓ 名字与 id 不同才并列显示；描述渲染出来了'
    : `   ✗ 模型行不对:\n${listText}`)
  console.log(listText.split('\n').filter((line) => line.includes('← 当前')).length === 1
    && listText.includes('← 当前')
    ? '   ✓ 只标出一个「← 当前」'
    : `   ✗ 当前标记不对:\n${listText}`)
  console.log(listText.includes('⚠️ 读取失败：connection refused') && listText.includes('（没有可列出的模型）')
    ? '   ✓ 坏 provider 与空 provider 各自有交代'
    : `   ✗ 异常分组没交代:\n${listText}`)
  const noProviders = models.renderModelCatalog({ groups: [] })
  const allBroken = models.renderModelCatalog({ groups: [{ id: 'x', name: 'X', models: [], error: 'boom' }] })
  console.log(noProviders.includes('没有注册任何 LLM provider') && allBroken.includes('boom')
    ? '   ✓ 空清单 / 全失败都有专门文案'
    : `   ✗ 兜底文案不对: ${noProviders} / ${allBroken}`)

  // The `sessionController.modelCatalog()` shape (what the GUI picker consumes)
  // must normalize into the same internal shape the text renderer and the card
  // both use.
  const serviceCatalog = {
    default: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    routableProviders: ['deepseek-official', 'zai', 'broken'],
    groups: [
      {
        id: 'deepseek-official',
        name: 'DeepSeek 官方',
        models: [
          { id: 'deepseek-flash', name: 'DeepSeek Flash' },
          { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro' },
        ],
      },
      { id: 'zai', name: '智谱', models: [{ id: 'glm-5.3', name: 'glm-5.3' }] },
    ],
    failures: [{ id: 'broken', name: '坏 provider', message: 'boom' }],
  }
  const normalized = models.normalizeCatalog(serviceCatalog)
  console.log(normalized.groups.length === 3 && normalized.groups[2].error === 'boom'
    && normalized.current.model === 'deepseek-v4-pro'
    ? '   ✓ sessionController 形态 → 归一化（失败分组也保留）'
    : `   ✗ normalizeCatalog 不对: ${JSON.stringify(normalized)}`)

  const switcher = models.modelCard(normalized)
  const modelButtons = switcher.body.elements
    .filter((element) => element.tag === 'column_set')
    .flatMap((set) => set.columns.map((column) => column.elements[0]))
  console.log(switcher.schema === '2.0' && modelButtons.length === 3
    ? `   ✓ 切换卡片：${String(modelButtons.length)} 个模型按钮`
    : `   ✗ 模型按钮数不对: ${String(modelButtons.length)}`)
  const currentButton = modelButtons.find((button) => button.text.content.endsWith('✓'))
  console.log(currentButton !== undefined && currentButton.type === 'primary_filled'
    && currentButton.behaviors[0].value.model === 'deepseek-v4-pro'
    ? '   ✓ 当前模型高亮 + 打勾，按钮 value 带 provider 与 model'
    : `   ✗ 当前按钮不对: ${JSON.stringify(currentButton)}`)
  const modelValue = modelButtons[0].behaviors[0].value
  console.log(JSON.stringify(models.parseModelAction(modelValue)) === JSON.stringify({ provider: 'deepseek-official', model: 'deepseek-flash' })
    ? `   ✓ 点击 value 解析出 provider+model: ${JSON.stringify(models.parseModelAction(modelValue))}`
    : `   ✗ parseModelAction 不对: ${JSON.stringify(models.parseModelAction(modelValue))}`)
  console.log(models.parseModelAction(buttonValue(askButtons[0])) === null
    && cards.parseQuestionAction(modelValue) === null
    && cards.parsePermissionAction(modelValue, modes) === null
    ? '   ✓ 模型 / 问题 / 权限 三种卡片 value 互不误认'
    : '   ✗ 三种卡片的 value 有误认')
  console.log(models.parseModelAction({ type: 'dsh_model', provider: '', model: 'x' }) === null
    && models.parseModelAction({ type: 'dsh_model', provider: 'p', model: '' }) === null
    ? '   ✓ 缺 provider 或 model 的 value 一律拒绝'
    : '   ✗ 残缺的模型 value 被放行')
  console.log(switcher.body.elements.some((element) => element.tag === 'markdown' && element.content.includes('读取失败'))
    ? '   ✓ 卡片底部交代了读不出来的 provider'
    : '   ✗ 卡片没交代失败 provider')

  console.log('3d) 飞书渲染：消息卡片化 + markdown 归一（纯函数，不联网）…')
  const format = await import(join(scratch, 'lib', 'format.mjs'))
  const plainCard = format.markdownCard('**粗体**\n\n| a | b |\n|---|---|\n| 1 | 2 |')
  console.log(plainCard.schema === '2.0' && plainCard.header === undefined
    && plainCard.body.elements[0].tag === 'markdown'
    ? '   ✓ 普通消息用 2.0 卡片、无标题栏（看起来仍像一条普通消息）'
    : `   ✗ markdownCard 不对: ${JSON.stringify(plainCard)}`)
  const titledCard = format.markdownCard('x', { header: '汇报', template: 'turquoise' })
  console.log(titledCard.header?.title?.content === '汇报' && titledCard.header.template === 'turquoise'
    ? '   ✓ 需要时能带标题栏'
    : `   ✗ 带标题卡片不对: ${JSON.stringify(titledCard.header)}`)

  // Plain text is only the fallback, but it must not leak raw markup.
  const messy = '# 标题\n**粗体** 与 `代码` 与 ~~删除~~\n> 引用\n\n| 命令 | 作用 |\n|---|---|\n| `/model` | 切模型 |\n'
  const cleaned = format.toPlainText(messy)
  console.log(!cleaned.includes('**') && !cleaned.includes('`') && !cleaned.includes('>') && !cleaned.includes('|---')
    ? '   ✓ 纯文本兜底：星号 / 反引号 / 引用 / 表格线都清掉了'
    : `   ✗ 兜底没清干净:\n${cleaned}`)
  console.log(cleaned.includes('命令 · 作用') && cleaned.includes('/model · 切模型')
    ? '   ✓ 表格行降级成「a · b」，不是留一堆竖线'
    : `   ✗ 表格降级不对:\n${cleaned}`)

  const shortChunks = format.chunkMarkdown('短消息')
  console.log(shortChunks.length === 1 && shortChunks[0] === '短消息'
    ? '   ✓ 短消息不切块'
    : `   ✗ 短消息被切: ${JSON.stringify(shortChunks)}`)
  const longBody = Array.from({ length: 400 }, (_, i) => `第 ${String(i)} 行内容`).join('\n')
  const pieces = format.chunkMarkdown(longBody, 500)
  console.log(pieces.length > 1 && pieces.every((piece) => piece.length <= 500)
    ? `   ✓ 长消息切成 ${String(pieces.length)} 块，每块 ≤ 500 字符`
    : `   ✗ 切块超限: ${String(pieces.length)} 块`)
  console.log(pieces.join('\n').replace(/\n/g, '') === longBody.replace(/\n/g, '')
    ? '   ✓ 切块不丢内容'
    : '   ✗ 切块丢内容了')
  const fenced = ['开头', '```js', ...Array.from({ length: 60 }, (_, i) => `const v${String(i)} = ${String(i)}`), '```', '结尾'].join('\n')
  const fencedChunks = format.chunkMarkdown(fenced, 200)
  const balanced = fencedChunks.length > 1
    && fencedChunks.every((piece) => (piece.match(/^```/gm) ?? []).length % 2 === 0)
  console.log(balanced
    ? `   ✓ 代码块被切开时自动补 fence（${String(fencedChunks.length)} 块，每块 fence 成对）`
    : `   ✗ fence 没配平: ${fencedChunks.map((piece) => String((piece.match(/^```/gm) ?? []).length)).join(',')}`)

  console.log('3e) 审批 answerer：飞书会话就地发卡片（假宿主，不联网）…')
  const approvalListener = listeners.find((entry) => entry.event === 'approval/request')?.listener
  console.log(typeof approvalListener === 'function'
    ? '   ✓ apply() 注册了 approval/request 监听器（即一个 answerer）'
    : '   ✗ 没有注册 approval/request 监听器')
  // 回归护栏：审批链是**串行瀑布**，GUI 那条（浏览器桥）在启动期就注册了并会把请求
  // 停在弹窗上。不 prepend 就永远轮不到飞书，症状正是「要权限时卡住」。
  const approvalRegistration = listeners.find((entry) => entry.event === 'approval/request')
  const approvalOptions = approvalRegistration?.options ?? {}
  console.log(approvalOptions.prepend === true && approvalOptions.global === true
    ? '   ✓ 用 { prepend: true, global: true } 注册 —— 抢在 GUI 弹窗之前，且不受 scope 过滤'
    : `   ✗ 注册选项不对（会被 GUI 抢先）: ${JSON.stringify(approvalOptions)}`)
  const approvalBuilt = cards.approvalCard({ approvalId: 'a_smoke', toolName: 'bash', reason: '要写工作区外的文件' })
  const approvalButtons = approvalBuilt.body.elements
    .filter((element) => element.tag === 'column_set')
    .flatMap((set) => set.columns.map((column) => column.elements[0]))
  console.log(approvalButtons.length === 2 && approvalBuilt.header.template === 'orange'
    ? '   ✓ 授权卡片：橙色告警头 + 允许/拒绝两个按钮'
    : `   ✗ 授权卡片不对: ${JSON.stringify(approvalBuilt.header)}`)
  console.log(JSON.stringify(cards.parseApprovalAction(approvalButtons[0].behaviors[0].value)) === JSON.stringify({ approvalId: 'a_smoke', decision: 'allow' })
    ? '   ✓ 允许按钮的 value 解析正确'
    : `   ✗ 允许按钮解析不对: ${JSON.stringify(cards.parseApprovalAction(approvalButtons[0].behaviors[0].value))}`)
  console.log(cards.parseApprovalAction({ type: 'dsh_approval', approvalId: 'a', decision: 'maybe' }) === null
    ? '   ✓ 非法的决定值被拒'
    : '   ✗ 非法决定被放行')
  console.log(cards.parseApprovalAction({ type: 'dsh_model', provider: 'p', model: 'm' }) === null
    && models.parseModelAction(approvalButtons[1].behaviors[0].value) === null
    && cards.parseQuestionAction(approvalButtons[1].behaviors[0].value) === null
    && cards.parsePermissionAction(approvalButtons[1].behaviors[0].value, modes) === null
    ? '   ✓ 审批 / 模型 / 问题 / 权限 四种卡片 value 互不误认'
    : '   ✗ 四种卡片的 value 有误认')

  // The answerer must be invisible to every session that is not ours, and must
  // hand the request back when the bridge is down (an `api === null` dry run).
  let downstreamCalls = 0
  const downstream = () => { downstreamCalls += 1; return Promise.resolve('rejected') }
  const strangersApproval = await approvalListener({ agent: { session: { id: 'session-not-feishu' } }, toolName: 'bash' }, downstream)
  const offlineApproval = await approvalListener({ agent: { session: { id: 'feishu-oc_offline' } }, toolName: 'bash' }, downstream)
  console.log(downstreamCalls === 2 && strangersApproval === 'rejected' && offlineApproval === 'rejected'
    ? '   ✓ 非飞书会话、以及桥接未连接时都原样交回下一个 answerer（GUI 行为不变）'
    : `   ✗ 交回逻辑不对: calls=${String(downstreamCalls)} / ${String(strangersApproval)} / ${String(offlineApproval)}`)

  console.log('3f) 入站附件识别（纯函数，不联网）…')
  const inbound = await import(join(scratch, 'lib', 'inbound.mjs'))
  const asMessage = (messageType, content) => ({ message_type: messageType, content: JSON.stringify(content) })
  const fileDecision = inbound.describeAttachment(asMessage('file', { file_key: 'fk_1', file_name: '报表.pdf' }))
  const imageDecision = inbound.describeAttachment(asMessage('image', { image_key: 'ik_1' }))
  const audioDecision = inbound.describeAttachment(asMessage('audio', { file_key: 'fk_2', file_name: '录音.mp3' }))
  const folderDecision = inbound.describeAttachment(asMessage('folder', { file_key: 'fk_3', file_name: '一个文件夹' }))
  const brokenDecision = inbound.describeAttachment({ message_type: 'file', content: '不是 JSON' })
  const noKeyDecision = inbound.describeAttachment(asMessage('file', { file_name: 'x' }))
  const weirdDecision = inbound.describeAttachment(asMessage('media', { file_key: 'fk_9', file_name: '片子.mp4' }))
  const unknownDecision = inbound.describeAttachment(asMessage('merge_forward', {}))
  console.log(fileDecision.kind === 'resource' && fileDecision.downloadType === 'file'
    && fileDecision.name === '报表.pdf' && fileDecision.fileKey === 'fk_1'
    ? '   ✓ 文件消息 → 可下载（type=file，原名保留）'
    : `   ✗ 文件识别不对: ${JSON.stringify(fileDecision)}`)
  console.log(imageDecision.kind === 'resource' && imageDecision.downloadType === 'image'
    && imageDecision.name === 'feishu-image.png'
    ? '   ✓ 图片消息 → type=image，没名字时给默认名'
    : `   ✗ 图片识别不对: ${JSON.stringify(imageDecision)}`)
  console.log(audioDecision.kind === 'resource' && audioDecision.downloadType === 'file'
    ? '   ✓ 音频/视频也走 type=file（飞书的规则）'
    : `   ✗ 音频识别不对: ${JSON.stringify(audioDecision)}`)
  console.log(folderDecision.kind === 'unsupported' && folderDecision.label === '文件夹'
    ? '   ✓ 文件夹消息 → 明确不支持，并给出可行替代（单独发 / 放 nas）'
    : `   ✗ 文件夹识别不对: ${JSON.stringify(folderDecision)}`)
  console.log(weirdDecision.kind === 'resource' && weirdDecision.downloadType === 'file'
    ? '   ✓ 视频(media) 走 type=file'
    : `   ✗ 视频识别不对: ${JSON.stringify(weirdDecision)}`)
  console.log(brokenDecision.kind === 'unsupported' && noKeyDecision.kind === 'unsupported'
    && unknownDecision.kind === 'unsupported' && unknownDecision.label === 'merge_forward'
    ? '   ✓ 坏 JSON / 缺 key / 未知类型 一律降级成「不支持」，不崩'
    : `   ✗ 降级不对: ${JSON.stringify([brokenDecision, noKeyDecision, unknownDecision])}`)

  const mergeTop = inbound.mergeForwardContainer({ content: JSON.stringify({ chat_id: 'oc_merged1' }) })
  const mergeNested = inbound.mergeForwardContainer({ content: JSON.stringify({ thread: { chat_id: 'oc_merged2' } }) })
  const mergeNone = inbound.mergeForwardContainer({ content: '不是 JSON' })
  console.log(mergeTop === 'oc_merged1' && mergeNested === 'oc_merged2' && mergeNone === undefined
    ? '   ✓ 合并转发的容器 chat_id 能认出来（顶层 + 嵌套），坏 JSON 返回 undefined'
    : `   ✗ 合并转发识别不对: ${JSON.stringify([mergeTop, mergeNested, mergeNone])}`)

  const evil = inbound.safeFileName('../../etc/passwd')
  const windows = inbound.safeFileName('a\\b/c.txt')
  const appleDouble = inbound.safeFileName('._20260923_x.mov')
  const dots = inbound.safeFileName('..', 'fallback.bin')
  const empty = inbound.safeFileName('   ', 'fallback.bin')
  const long = inbound.safeFileName('x'.repeat(500))
  console.log(!evil.includes('/') && !windows.includes('\\') && !windows.includes('/')
    ? `   ✓ 路径分隔符被换成下划线，无法越界：${JSON.stringify(evil)} / ${JSON.stringify(windows)}`
    : `   ✗ 文件名没净化: ${JSON.stringify([evil, windows])}`)
  console.log(appleDouble === '._20260923_x.mov' && dots === 'fallback.bin'
    ? '   ✓ 保留 macOS 的 ._ 旁挂名（不改写用户文件名）；纯点号才兜底'
    : `   ✗ 保真度不对: ${JSON.stringify([appleDouble, dots])}`)
  console.log(empty === 'fallback.bin' && long.length === 120
    ? '   ✓ 空名字给默认值；超长截断到 120'
    : `   ✗ 兜底不对: ${JSON.stringify([empty, long.length])}`)

  console.log('3g) 云盘文件夹遍历（纯函数 + 假 list，不联网）…')
  const drive = await import(join(scratch, 'lib', 'drive.mjs'))
  const fromUrl = drive.parseDriveFolderRef('https://xxx.feishu.cn/drive/folder/fldcnAbC123xyz?from=chat')
  const bare = drive.parseDriveFolderRef('fldcnAbC123xyz')
  const noisy = drive.parseDriveFolderRef('看看这个 https://xxx.feishu.cn/drive/folder/fldcnZZZ999aaa 里面的东西')
  const garbage = drive.parseDriveFolderRef('这不是链接')
  console.log(fromUrl === 'fldcnAbC123xyz' && bare === 'fldcnAbC123xyz' && noisy === 'fldcnZZZ999aaa' && garbage === undefined
    ? '   ✓ 链接里 / 裸 token / 夹在文字里 都能认出来；非链接返回 undefined'
    : `   ✗ 解析不对: ${JSON.stringify([fromUrl, bare, noisy, garbage])}`)

  const fakeTree = {
    root: [
      { type: 'folder', name: '素材', token: 'f_material' },
      { type: 'file', name: 'readme.txt', token: 't_readme' },
    ],
    f_material: [
      { type: 'file', name: 'a.mov', token: 't_a' },
      { type: 'folder', name: '子目录', token: 'f_sub' },
    ],
    f_sub: [{ type: 'file', name: '../evil.txt', token: 't_evil' }],
  }
  const walk = await drive.walkDriveFolder({
    folderToken: 'root',
    list: async (token) => ({ files: fakeTree[token] ?? [] }),
  })
  const paths = walk.files.map((file) => file.path).sort()
  console.log(walk.folders === 3 && walk.files.length === 3
    ? `   ✓ 递归遍历 3 个目录 / 3 个文件：${paths.join(', ')}`
    : `   ✗ 遍历结果不对: folders=${String(walk.folders)} files=${JSON.stringify(paths)}`)
  console.log(paths.includes('素材/a.mov') && paths.includes('素材/子目录/.._evil.txt')
    ? '   ✓ 按原目录结构拼路径；每段都过净化，../ 变成单个安全段（无法越界）'
    : `   ✗ 路径不对: ${JSON.stringify(paths)}`)
  const cycle = await drive.walkDriveFolder({
    folderToken: 'loop',
    list: async () => ({ files: [{ type: 'folder', name: '自己', token: 'loop' }] }),
  })
  console.log(cycle.folders === 1 && cycle.files.length === 0
    ? '   ✓ 自引用目录不会死循环（visited 去重）'
    : `   ✗ 循环保护失效: folders=${String(cycle.folders)}`)

  console.log('3h) 飞书链接识别（纯函数，不联网）…')
  const links = await import(join(scratch, 'lib', 'links.mjs'))
  const wikiLink = links.parseFeishuLink('https://my.feishu.cn/wiki/PvxYwuWp0iW1zjkgdrPcg1efnqc')
  const docxLink = links.parseFeishuLink('https://xxx.feishu.cn/docx/D2E0dLiGPoesxBxOqlEcSTFynXg')
  const folderLink = links.parseFeishuLink('https://xxx.feishu.cn/drive/folder/fldcnAbC123xyz')
  const sheetLink = links.parseFeishuLink('https://xxx.larksuite.com/sheets/ShtAbC123xyz')
  console.log(wikiLink?.kind === 'wiki' && wikiLink.token === 'PvxYwuWp0iW1zjkgdrPcg1efnqc'
    && docxLink?.kind === 'docx' && folderLink?.kind === 'folder' && sheetLink?.kind === 'sheets'
    ? '   ✓ wiki / docx / drive-folder / larksuite-sheets 都认得出（folder 与普通 drive 区分开）'
    : `   ✗ 链接识别不对: ${JSON.stringify([wikiLink, docxLink, folderLink, sheetLink])}`)
  console.log(links.parseFeishuLink('这不是链接') === undefined && links.parseFeishuLink('https://example.com/wiki/abc') === undefined
    ? '   ✓ 非飞书链接一律返回 undefined'
    : '   ✗ 误认了非飞书链接')
  console.log(links.isBareLink('https://my.feishu.cn/wiki/PvxYwuWp0iW1zjkgdrPcg1efnqc') === true
    && links.isBareLink('看看这个 https://my.feishu.cn/wiki/PvxYwuWp0iW1zjkgdrPcg1efnqc 谢谢') === false
    ? '   ✓ 「只有一条链接」才会被自动抓取；夹着别的话就交给模型'
    : '   ✗ isBareLink 判断不对')

  console.log('3i) 进度播报节流（假时钟，不联网）…')
  const progress = await import(join(scratch, 'lib', 'progress.mjs'))
  let clock = 0
  const sent = []
  const report = progress.createProgressThrottle({ intervalMs: 15_000, now: () => clock, report: (line) => sent.push(line) })
  report(() => 'A')                       // 0s：开场已被调用方说过，吞掉
  clock = 5_000; report(() => 'B')        // 5s：太快
  clock = 10_000; report(() => 'C')       // 10s：还是快
  clock = 16_000; report(() => 'D')       // 16s：该报了
  clock = 20_000; report(() => 'E')       // 20s：刚报过 4s，吞
  clock = 32_000; report(() => 'F')       // 32s：又到点
  console.log(sent.join(',') === 'D,F'
    ? `   ✓ 15 秒节流生效：0/5/10/20 秒被吞，16/32 秒放行（实发 ${String(sent.length)} 条）`
    : `   ✗ 节流不对: ${sent.join(',')}`)
  console.log(!sent.includes('A') && !sent.includes('E')
    ? '   ✓ 开场不刷「0%」噪音，密集回调也不会连发'
    : '   ✗ 不该发的发了')
  const started = sent.length
  clock = 1_000_000; report(() => 'G')
  console.log(sent.length === started + 1 && sent.at(-1) === 'G'
    ? '   ✓ 长时间无回调后仍能继续报（状态不回退）'
    : '   ✗ 长间隔后失效')

  console.log('4) 会话代次：/new + /sessions + /open（假宿主，不联网）…')
  // `generations` was imported in section 3b.
  const { ChatPointerStore } = await import(join(scratch, 'lib', 'state.mjs'))
  const conversations = await import(join(scratch, 'lib', 'conversations.mjs'))
  const { ConversationBook } = conversations

  const chat = 'oc_cli_test'
  console.log(`   ✓ sessionIdOf #1 → ${generations.sessionIdOf(chat, 1)}`)
  console.log(`   ✓ sessionIdOf #3 → ${generations.sessionIdOf(chat, 3)}`)
  const roundTrips = [
    [generations.sessionIdOf(chat, 1), 1],
    [generations.sessionIdOf(chat, 7), 7],
  ].every(([id, expected]) => generations.generationOf(id, chat) === expected)
  console.log(roundTrips ? '   ✓ generationOf 往返一致（含旧的无后缀 id = #1）' : '   ✗ generationOf 往返不一致')
  const rejected = [
    'feishu-oc_other',
    'feishu-oc_cli_test-0',
    'feishu-oc_cli_test-x',
    'feishu-oc_cli_test-1-2',
    'session-abc',
  ].filter((id) => generations.generationOf(id, chat) !== undefined)
  console.log(rejected.length === 0
    ? '   ✓ 别人的 id / 非法后缀一律不认'
    : `   ✗ 误认: ${rejected.join(', ')}`)

  // A fake host: sessions are real objects with `append`/`snapshotEvents`, so
  // `setSandboxMode` and the blank check exercise their real code paths.
  const liveSessions = new Map()
  const createdIds = []
  const ensureAgent = async (chatId, generation) => {
    const sessionId = generations.sessionIdOf(chatId, generation)
    let session = liveSessions.get(sessionId)
    if (session === undefined) {
      session = {
        id: sessionId,
        events: [],
        snapshotEvents() { return [...this.events] },
        append(type, data) { this.events.push({ type, data }) },
        turn() { this.events.push({ type: 'turn/start', data: {} }) },
      }
      liveSessions.set(sessionId, session)
      createdIds.push(sessionId)
    }
    return { session }
  }
  const bookDeps = {
    sessionQuery: {
      listSessions: async () => [...liveSessions.values()].map((session) => ({ header: { id: session.id, createdAt: 1_700_000_000_000 } })),
    },
    ensureAgent,
    modeOf: (session) => session.events.filter((event) => event.type === 'sandbox/mode').at(-1)?.data.mode ?? 'workspace-write',
    applyMode: (session, mode) => session.append('sandbox/mode', { mode }),
    titles: () => titleService,
    pointers: new ChatPointerStore(join(scratch, 'state.json')),
    warn: (message) => logs.push(`WARN ${message}`),
  }
  const learnedTitles = new Map()
  const titleService = {
    get: (session) => learnedTitles.get(session.id),
    rename: (session, title) => { learnedTitles.set(session.id, title); return { title } },
  }
  const book = new ConversationBook(bookDeps)

  console.log(`   ✓ 命令识别: /new=${book.matches('/new')} /sessions=${book.matches('/sessions')} /session=${book.matches('/session')} /open=${book.matches('/open')} /foo=${book.matches('/foo')}`)

  const fresh = await book.start(chat)
  console.log(fresh.includes('还是空的')
    ? `   ✓ 空会话上 /new 不叠空段：${fresh.slice(0, 24)}…`
    : `   ✗ 空会话上 /new 应拒绝：${fresh}`)
  console.log(createdIds.length === 1 ? '   ✓ 只建了 #1 一段' : `   ✗ 建了 ${createdIds.join(', ')}`)

  liveSessions.get(generations.sessionIdOf(chat, 1)).turn()
  const second = await book.start(chat)
  const newId = generations.sessionIdOf(chat, 2)
  console.log(createdIds.includes(newId) ? `   ✓ /new 开了 ${newId}` : `   ✗ 没开新段: ${createdIds.join(', ')}`)
  console.log(bookDeps.pointers.get(chat) === 2 ? '   ✓ 指针指向 #2' : `   ✗ 指针 = ${String(bookDeps.pointers.get(chat))}`)
  console.log(learnedTitles.get(generations.sessionIdOf(chat, 1))?.startsWith('飞书 #1 · ')
    ? `   ✓ 旧段被命名「${learnedTitles.get(generations.sessionIdOf(chat, 1))}」`
    : `   ✗ 旧段没有标题: ${String(learnedTitles.get(generations.sessionIdOf(chat, 1)))}`)
  console.log(liveSessions.get(newId).events.some((event) => event.type === 'sandbox/mode')
    ? '   ✓ 文件权限被带进新段'
    : '   ✗ 文件权限没有带过去')
  console.log(second.includes('#2') && second.includes('/open') ? '   ✓ 回执说明新段与如何切回' : `   ✗ 回执不对: ${second}`)

  const again = await book.start(chat)
  console.log(again.includes('还是空的') && createdIds.length === 2 ? '   ✓ 再按 /new 不叠空段' : '   ✗ 又叠了一段')

  const listed = await book.report(chat)
  console.log(listed.includes('▶ #2') && listed.includes('#1') ? '   ✓ /sessions 列出两段并标出当前' : `   ✗ 列表不对:\n${listed}`)

  // The listing is also a card with one button per conversation: the user asked
  // for the switch to be a click, not a number they retype as `/open <n>`.
  const switchCard = conversations.sessionCard(await book.overview(chat))
  const cardButtons = switchCard.body.elements
    .find((element) => element.tag === 'column_set')?.columns.map((column) => column.elements[0]) ?? []
  const cardValue = (button) => button.behaviors.find((behavior) => behavior.type === 'callback')?.value
  console.log(switchCard.schema === '2.0' && cardButtons.length === 2 && switchCard.header.title.content.includes('切换对话')
    ? `   ✓ /sessions 卡片：schema ${switchCard.schema}，两段各一个按钮`
    : `   ✗ 会话卡片结构不对: ${JSON.stringify({ schema: switchCard.schema, buttons: cardButtons.length })}`)
  const marked = cardButtons.map((button) => ({ value: cardValue(button), filled: button.type === 'primary_filled', check: button.text.content.endsWith('✓') }))
  console.log(JSON.stringify(marked) === JSON.stringify([
    { value: { type: 'dsh_session', generation: 1 }, filled: false, check: false },
    { value: { type: 'dsh_session', generation: 2 }, filled: true, check: true },
  ])
    ? '   ✓ 按钮编号齐全，只有当前段是实心 + 打勾'
    : `   ✗ 按钮标记不对: ${JSON.stringify(marked)}`)

  const click = conversations.parseSessionAction(cardValue(cardButtons[0]))
  console.log(click?.generation === 1 ? `   ✓ 点按钮解析 → ${JSON.stringify(click)}` : `   ✗ 按钮 value 解析: ${JSON.stringify(click)}`)
  await book.open(chat, String(click.generation))
  console.log(bookDeps.pointers.get(chat) === 1
    ? '   ✓ 点 #1 按钮后指针真的落到 #1（与 /open 1 同一条路）'
    : `   ✗ 点按钮没换过去：指针=${String(bookDeps.pointers.get(chat))}`)
  await book.open(chat, '2')

  const sessionValue = cardValue(cardButtons[1])
  const rejectedSession = [
    conversations.parseSessionAction({ type: 'dsh_model', provider: 'p', model: 'm' }),
    conversations.parseSessionAction({ type: 'dsh_session', generation: 0 }),
    conversations.parseSessionAction({ type: 'dsh_session', generation: 'abc' }),
    conversations.parseSessionAction({ type: 'dsh_session' }),
    conversations.parseSessionAction(null),
  ].every((item) => item === null)
  console.log(rejectedSession
    ? '   ✓ 别人的卡片 / 缺编号 / 非数字编号 / 非对象 都不认'
    : '   ✗ 会话按钮 value 被误认')
  console.log(models.parseModelAction(sessionValue) === null
    && cards.parseApprovalAction(sessionValue) === null
    && cards.parsePermissionAction(sessionValue, modes) === null
    && cards.parseQuestionAction({ tag: 'button', value: sessionValue }) === null
    ? '   ✓ 会话 / 模型 / 审批 / 权限 / 问题 五种卡片 value 互不误认'
    : '   ✗ 五种卡片的 value 有误认')

  const opened = await book.open(chat, '1')
  console.log(bookDeps.pointers.get(chat) === 1 && opened.includes('#1') ? '   ✓ /open 1 切回第一段' : `   ✗ /open 结果: ${opened}`)
  await book.open(chat, '#2')
  console.log(bookDeps.pointers.get(chat) === 2 ? '   ✓ /open #2 接受 # 前缀' : '   ✗ # 前缀没解析')

  const failures = []
  for (const bad of ['9', 'abc', '']) {
    try { await book.open(chat, bad) } catch (error) { failures.push(error instanceof Error ? error.message : String(error)) }
  }
  console.log(failures.length === 3 ? `   ✓ 非法 /open 都报错：${failures.join(' / ')}` : `   ✗ 只有 ${failures.length}/3 报错`)

  // The pointer must outlive the process: `/open 1` then a restart must not
  // silently jump back to the newest generation.
  await book.open(chat, '1')
  const restarted = new ConversationBook({ ...bookDeps, pointers: new ChatPointerStore(join(scratch, 'state.json')) })
  const afterRestart = await restarted.current(chat)
  console.log(afterRestart === 1 ? '   ✓ 重启后仍停在 /open 选的 #1' : `   ✗ 重启后跑到 #${afterRestart}`)

  const broken = join(scratch, 'broken-state.json')
  const { writeFileSync: writeScratch } = await import('node:fs')
  writeScratch(broken, '{ not json')
  const brokenStore = new ChatPointerStore(broken)
  console.log(brokenStore.get(chat) === undefined && brokenStore.readError !== undefined
    ? '   ✓ 指针文件损坏时降级为空（不抛错）'
    : '   ✗ 损坏的指针文件没被安全降级')

  // 回归护栏：卡片造得出来 ≠ 按钮接得上。按钮必须真的接到 handleCardAction 里那条与
  // `/open` 完全相同的路径，`/sessions` 也必须真的改走卡片（否则用户还是只能手打编号）。
  const indexSource = readFileSync(join(scratch, 'lib', 'index.mjs'), 'utf8')
  const missingWiring = [
    'parseSessionAction(value)',
    'conversations.open(chatId, String(wantedSession.generation))',
    'sendSessionsCard(chatId)',
    'LIST_COMMANDS.has(command)',
  ].filter((needle) => !indexSource.includes(needle))
  console.log(missingWiring.length === 0
    ? '   ✓ index.mjs 把按钮接到了 open()，且 /sessions 改走卡片'
    : `   ✗ index.mjs 缺接线: ${missingWiring.join(' / ')}`)

  // ⚠️ 回归护栏（2026-09-29 飞书全线「这一轮出错了」）：会话格式 v4 硬拒退役写法
  // `{kind:'plugin', plugin}`，注入消息必须盖**生产者自己的** kind —— 第三方插件即
  // `plugin:<包名>`（核心 v3→v4 迁移的 producerKind() 就是这么映射的）。写错的表现是
  // 开轮即死：`format v4 message requires a producer-owned source kind`，且**不产生任何事件**。
  const retiredSource = /source:\s*\{\s*kind:\s*'plugin'\s*,/.test(indexSource)
  const producerKindWired = indexSource.includes('plugin:${name}') && indexSource.includes('producerSource()')
  console.log(!retiredSource && producerKindWired
    ? '   ✓ 注入消息盖 producer-owned source（plugin:${name}），没有退役的 {kind:\'plugin\'} 写法'
    : `   ✗ 注入消息的 source 写法不对（退役写法=${String(retiredSource)}, producer kind 接线=${String(producerKindWired)}）——会话格式 v4 会开轮即报 "requires a producer-owned source kind"`)

  // ⚠️ 回归护栏（用户 2026-09-29）：**任务运行中从飞书发来的消息默认「插队」而不是「排队」**。
  // 语义来自核心的 inbox 两条车道：`agent.followup()` = next-turn（等这一轮跑完），
  // `agent.steer()` = next-step（正在跑的这一轮下一步就能看到）。四条入站路径
  // （普通文字 / 附件 / 链接正文 / 迟到的卡片回答）必须**都**走 `deliverUserMessage`，
  // 否则哪天改着改着又静默回到「等这一轮跑完再理我」。
  const commentless = indexSource.split('\n').filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line)).join('\n')
  const rawFollowup = (commentless.match(/agent\.followup\(/g) ?? []).length
  const deliverCalls = (commentless.match(/= deliverUserMessage\(agent,/g) ?? []).length
  const steerWired = commentless.includes("typeof agent.steer === 'function'") && commentless.includes('agent.steer(message)')
  const defaultSteer = /sendMode:\s*z\.union\(\[z\.const\('steer'\),\s*z\.const\('queue'\)\]\)\.default\('steer'\)/.test(commentless)
  console.log(rawFollowup === 1 && deliverCalls === 4 && steerWired && defaultSteer
    ? '   ✓ 入站消息默认插队：4 条路径走 deliverUserMessage，steer 优先、sendMode 默认 steer（裸 followup 只剩兜底那 1 处）'
    : `   ✗ 插队接线不对（裸 followup=${String(rawFollowup)} 应为 1；deliverUserMessage 调用=${String(deliverCalls)} 应为 4；steer 接线=${String(steerWired)}；默认 steer=${String(defaultSteer)}）——用户要求任务运行中发来的飞书消息默认插队`)

  console.log('5) 浏览器端（settings 卡片）…')
  const pkg = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'))
  const declared = pkg.dsh?.client
  console.log(`   ✓ package.json 声明 dsh.client: platform=${String(declared?.platform)} inject=${String((declared?.inject ?? []).length)} 项`)
  console.log(`   ✓ exports["./client"] → ${String(pkg.exports?.['./client'])}`)

  // Load lib/client.js the way the browser does: it registers itself on
  // `window.__ModuleLoader__` and pulls React from `require`.
  let captured
  globalThis.window = { __ModuleLoader__: { load: (spec) => { captured = spec } } }
  globalThis.document = {
    createElement: () => ({ dataset: {}, textContent: '', remove: () => {} }),
    head: { appendChild: () => {} },
  }
  const reactShim = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    Fragment: 'Fragment',
  }
  await import(join(scratch, 'lib', 'client.js'))
  const clientExports = captured.factory((name) => {
    if (name === 'react') return reactShim
    throw new Error(`client module required unknown specifier: ${name}`)
  })
  console.log(`   ✓ 客户端模块 id=${captured.id} apply=${typeof clientExports.apply} inject=${JSON.stringify(clientExports.inject)}`)

  // ⚠️ 回归护栏（2026-09-29，DSH 0.1.7 卡死事故）：静态 inject 一个宿主不提供的服务会让
  // fiber 永远 pending，而客户端模块系统在渲染前 `await loader.await()` 等全部模块 ——
  // 一个 park 住的 fiber 就把整个 GUI 卡在启动（0.6.6 在 0.1.7 上就是这样卡死的）。
  // 所以这两个名字**必须**留在 inject 外面，改成 apply 里运行时探测。
  const forbidden = ['settingsScope', 'configForms'].filter((name) => (clientExports.inject ?? []).includes(name))
  console.log(forbidden.length === 0
    ? `   ✓ inject 不含 settingsScope/configForms（静态声明会 park fiber → GUI 卡死）`
    : `   ✗ inject 里仍有 ${forbidden.join(' / ')}：宿主不提供时会把 fiber 永久 park，整个 GUI 卡在启动`)

  // 回归护栏（用户 2026-09-29）：卡片上必须有「任务运行中收到消息」= 插队/排队 的开关，
  // 且要真的写回 `sendMode`（否则面板存一次就可能把服务端默认盖掉，或者开关点了没用）。
  const clientSource = readFileSync(join(scratch, 'lib', 'client.js'), 'utf8')
  const modeControls = [
    "useState('steer')",
    "value.sendMode",
    "scope.set('sendMode', sendMode)",
    "value: 'steer'",
    "value: 'queue'",
  ].filter((needle) => !clientSource.includes(needle))
  console.log(modeControls.length === 0
    ? '   ✓ 卡片带「任务运行中收到消息」开关（插队/排队），并写回 sendMode'
    : `   ✗ 卡片缺 sendMode 控件接线: ${modeControls.join(' / ')}`)

  /** Build a minimal client ctx with the given services, capturing the slot descriptor. */
  const makeHost = (services) => {
    let registration
    const ctx = {
      ...services,
      slots: {
        register: (descriptor) => { registration = descriptor; return () => {} },
        inject: (_name, factory) => { factory() },
      },
      effect: (fn) => { const d = fn(); return () => d?.() },
      get: (name) => services[name],
    }
    return { ctx, registration: () => registration }
  }

  // ① DSH 0.1.7+：configForms，按 Loader entry id 键控
  const configForm = { id: 'feishu', getSnapshot: () => ({ value: {} }), subscribe: () => () => {}, set: async () => true }
  const newHost = makeHost({ configForms: { get: (id) => (id === 'feishu' ? configForm : undefined) } })
  clientExports.apply(newHost.ctx)
  const newRegistration = newHost.registration()
  const newPayload = newRegistration?.inject?.() ?? {}
  console.log(newPayload.scope === configForm && newPayload.degraded === false
    ? '   ✓ 0.1.7 宿主：走 configForms.get("feishu")（按 entry id，不是命名空间）'
    : '   ✗ 0.1.7 宿主：没有走 configForms')

  // ② DSH 0.1.5/0.1.6：settingsScope，按命名空间 bind
  const oldHost = makeHost({ settingsScope: { bind: (options) => ({ namespace: options.namespace }) } })
  clientExports.apply(oldHost.ctx)
  const oldPayload = oldHost.registration()?.inject?.() ?? {}
  console.log(oldPayload.scope?.namespace === 'feishu' && oldPayload.degraded === false
    ? '   ✓ 旧宿主：回落到 settingsScope.bind({ namespace: "feishu" })'
    : '   ✗ 旧宿主：回落 settingsScope 失败')

  // ③ 两代都没有：降级只读，apply 绝不能抛（抛了就等于把模块搞挂）
  const bareHost = makeHost({})
  let applyError = null
  try { clientExports.apply(bareHost.ctx) } catch (error) { applyError = error }
  const barePayload = bareHost.registration()?.inject?.() ?? {}
  const bareSnapshot = barePayload.scope?.getSnapshot?.()
  console.log(applyError === null && barePayload.degraded === true && bareSnapshot?.writable === false
    ? '   ✓ 两代都没有：降级为只读（不抛错，writable:false）'
    : `   ✗ 降级路径不对（threw=${applyError === null ? 'null' : applyError.message}, degraded=${String(barePayload.degraded)}）`)
  const refused = await barePayload.scope?.set?.('enabled', true)
  console.log(refused === false
    ? '   ✓ 降级 scope 的写返回 false（卡片据此报错，不会假装保存成功）'
    : '   ✗ 降级 scope 竟然接受了写入')

  const slotRegistration = newRegistration
  console.log(`   ✓ 注册到 slot=${String(slotRegistration?.name)} key=${String(slotRegistration?.key)}`)
  console.log(slotRegistration?.key === 'feishu'
    ? '   ✓ 卡片 key 与 settings 命名空间一致（否则设置页那一栏是空的）'
    : '   ✗ 卡片 key 与命名空间不一致')

  console.log('6) 拆解 disposer …')
  for (const dispose of disposers) await dispose()
  console.log('   ✓ teardown 未抛错')

  console.log('\n--- 插件日志 ---')
  for (const line of logs) console.log(`   ${line}`)
  console.log('\n✅ 全部通过：服务端可加载干跑、权限卡片可构造、浏览器端可注册设置卡片、可干净卸载')
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
