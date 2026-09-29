# dsh-feishu

在飞书里直接跟 DeepSeek Harness 对话。

每个飞书聊天绑定一串 DSH session：你在飞书发一条消息，它就变成**当前那一代** session 的一轮用户输入；
助手的回答被推回飞书。另外注册一个 `feishu_send` 工具，让 agent 在长任务里主动向你报进度。

> **回答是「卡片」不是「文本消息」** —— 因为飞书的纯文本消息**完全不渲染 Markdown**，
> `**粗体**`、`| 表格 |`、`` `代码` `` 会原样显示成字符。详见下面「消息怎么发出去（渲染）」。

发 **`/permission`** 会推一张**交互卡片**，点按钮就能切换这个会话的文件权限
（只读 / 工作区可写 / 完全访问）——不用回电脑上点界面。

**`feishu_ask` 工具**让 agent 反过来问你：它推一张带选项按钮的问题卡片，你点一下就作答
（卡片上还有输入框，可以顺手写补充说明；也可以直接回文字）。这是 `ask_user_question` 的飞书替代品——后者弹的是**本机 GUI 对话框**，
你在飞书里看不到，那一轮会一直空等到超时。见下面「问用户一个问题」。

发 **`/new`** 开一段**全新空白**的对话，旧的一段原样保留（历史、还能切回去、在 GUI 里也能翻到），
**`/sessions`** 推一张**卡片**：这个聊天的每一段一个按钮，**点一下就把对话切过去**（等价 `/open 2`）。见下面「会话代次」。

**零运行时依赖。** protobuf 帧协议（`pbbp2.Frame`）是按官方 SDK 的 schema 手写的
（`lib/pbbp2.mjs`），HTTP 用内置 `fetch`，WebSocket 用 Node 22+ 的内置全局 `WebSocket`。
不需要 `protobufjs` / `ws` / `axios`，也不需要任何 native 构建脚本。

## 为什么不用现成的 IM 插件

npm 上的 `dsh-im` / `dsh-im-feishu` 在本机会让 `dsh web` **启动整体失败**：
它的 `inject` 缺 `webServer`，boot 期 cordis loader 抛
`cannot get property "webServer" without inject`。另外它依赖 `protobufjs`，
pnpm 会拦掉构建脚本。这个插件两样都避开了。

## 为什么必须走长连接

桌面版 DSH 监听 `127.0.0.1`，飞书的服务器**打不进来**，所以收不到 webhook 回调。
飞书的「长连接」模式是 DSH 主动向 `msg-frontier.feishu.cn` 建一条 WebSocket，
事件从这条连接下来——这正是本插件做的事。

## 飞书侧的准备（一次）

在 [open.feishu.cn](https://open.feishu.cn) → 开发者后台 → 你的自建应用：

1. **添加应用能力 → 机器人**。
2. **权限管理**，开通并发布：
   - `im:message`（读取消息）
   - `im:message:send_as_bot`（以机器人身份发消息）
   - `im:message.p2p_msg:readonly`（读单聊消息）——只做群聊则用 `im:message.group_at_msg:readonly`
3. **事件与回调 → 订阅方式 → 选择「使用长连接接收事件」**。
   ⚠️ 不要配置「请求地址」：一旦配了 URL，事件会走 HTTP 回调而不是长连接，本插件就收不到。
4. **添加事件**：`im.message.receive_v1`（接收消息）。
5. **添加事件**：**`card.action.trigger`**（卡片回传交互，即「卡片回调」）。
   ⚠️ 不加这个，`/permission` 的卡片按钮会**点了没反应**（飞书不会报错，只是回调没人收）。
6. **创建版本并发布**（企业自建应用还需要管理员审核，测试企业可跳过）。
7. 把机器人拉进群，或者直接跟它单聊。

拿到 **App ID**（`cli_` 开头）和 **App Secret**。App Secret 只在服务端使用，别写进前端或仓库。

## 安装

```bash
cd /path/to/this/repo/dsh-feishu
mkdir -p dist
npm pack --pack-destination dist   # 生成 dist/dsh-feishu-<版本>.tgz（版本号看 package.json，别写死）
#   ⚠️ npm 默认缓存目录在工作区外（~/.npm）会被沙箱拒；报错就补 --cache <工作区内目录>
# ⚠️ 安装时不要写死版本号 —— 取 dist 里最新的那个 tarball：
dsh plugin --profile web add "$(ls -1 dist/dsh-feishu-*.tgz | sort -V | tail -1)"
```

**必须用 tarball，不要用 `link:`**：pnpm 的符号链接目录会让 DSH loader 解析不到
`exports` 入口，表现为静默不加载（无任何报错）。

装完重启 DSH。

## 配置

两种方式，二选一：

**A. GUI 设置面板（推荐）** —— 「设置 → 插件 → 飞书」：

![面板字段见下表]

面板由插件的**浏览器端**提供（`lib/client.js`），包含：

- **实时状态**：长连接是否已建立（含 `service_id`）、App ID、会话数、最近一条事件类型与时间、
  最近一次推送时间、最后一次错误。每 5 秒刷新一次，读的是插件自己的
  `GET /plugins/dsh-feishu/status`。
- **全部配置项**：启用开关、App ID、App Secret、开放平台域名、会话工作目录、会话白名单、
  收到消息回执、回答回推、**任务运行中收到消息（插队 / 排队）**。
- **操作提示**：飞书后台要配的两处（长连接订阅方式、`im.message.receive_v1` 与
  `card.action.trigger` 两个事件）直接写在面板里。

保存即生效（写进 `~/.dsh/settings.yaml`，0600，**不用重启**）——桥接会按新配置重连。

> ⚠️ **只有服务端的 settings 段是不够的**：DSH 的设置页会枚举命名空间，但卡片必须由插件自己的
> 浏览器端注册到 `settings.plugin.item` 槽（key = 命名空间）。只装服务端那一半，设置页里
> 那一栏是**空的**。这就是 `lib/client.js` + `package.json` 的 `dsh.client` / `exports["./client"]`
> 存在的原因。

**B. patch 行** —— 在 profile 的 `~/.dsh/profiles/web/cordis.patch.yml` 末尾追加：

```yaml
- id: feishu
  config:
    enabled: true
    appId: cli_xxxxxxxxxxxxxxxx
    appSecret: xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
    cwd: /Users/you/project
    allowedChatIds: []
```

> ⚠️ 后一层 patch **替换**整份 config（不是合并），已配置的字段要全部重写一遍。

| 键 | 默认 | 作用 |
|---|---|---|
| `enabled` | `false` | 总开关。关着时插件照常加载、注册工具，但不建连接 |
| `appId` / `appSecret` | `''` | 自建应用凭据 |
| `domain` | `https://open.feishu.cn` | Lark 国际版改成 `https://open.larksuite.com` |
| `cwd` | 宿主 cwd | 新 session 的工作目录（必须是绝对路径） |
| `allowedChatIds` | `[]` | 允许驱动 agent 的会话白名单；空 = 不限制 |
| `ackReaction` | `true` | 收到消息先加一个表情回执 |
| `replyToChat` | `true` | 把助手回答推回飞书 |
| `sendMode` | `steer` | **任务运行中**收到消息怎么投递（见下） |

### `sendMode` —— 任务运行中收到消息：插队还是排队

核心的 agent inbox 有两条车道，插件把用户消息投到哪条就是这两种行为：

| 值 | 走的那条 | 效果 |
|---|---|---|
| **`steer`（默认）** | `agent.steer()` → `next-step` | **插队**：正在跑的这一轮**在下一个 step 边界就能看到**这条消息，不用等它跑完。会话空闲时等价于直接开一轮 |
| `queue` | `agent.followup()` → `next-turn` | **排队**：等当前这一轮彻底结束，这条消息作为**下一轮**开始 |

- 用 `steer` 时，消息不会打断正在执行的工具调用 —— 它插在「下一步」的边界上，所以 20 秒的多步任务
  通常下一步就会读到你的新指令；`queue` 则是等整个 turn 结束（有长任务时可能要等很久）。
- 四条入站路径都遵守这个开关：普通文字、飞书附件（文件/图片）、链接正文、迟到的卡片回答。
- 会话空闲时两者行为一致（都会立刻开一轮），只有「正在运行」时才有区别。
- 用户 2026-09-29 的要求就是默认插队：「正在运行任务的时候通过飞书发送消息默认插队，而不是排队」。
- 想改回排队：面板里切成「排队」，或 patch 里写 `sendMode: queue`。
- 插件日志里每次投递都会打一行 `投递方式=steer|queue`，用来确认真的走了插队。

## 权限审批：也在飞书里点

DSH 问权限走的是 `approval/request` **waterfall**（一串 "answerer"）。出厂只装了 GUI 那一个 ——
对话发生在飞书时没人看得见它，那一轮就干等到超时。本插件注册了自己的 answerer：

- **只拦截属于自己的会话**（从 session id 反推 chatId）；其它会话原样 `next()`，**GUI 行为一点没变**。
- 注册时带 **`{ prepend: true, global: true }`** —— 这两个选项是必需的，不是保险：
  answerer 链是**串行瀑布**，而 API 层通往浏览器 GUI 的桥在启动期就注册了，并且会把请求**停在那张弹窗上**。
  不 `prepend`，飞书会话的请求就会先落到浏览器、在那儿一直等 —— 正是「要权限时卡住」这个 bug 本身。
  `global` 则是因为该事件派发在 **agent 的 scoped 上下文**上（`ctx.waterfall(scopeTarget(agent), …)`），
  挂在插件上下文上的监听器必须显式跳过 scope 过滤。
- 发一张**橙色授权卡片**：工具名 + 原因 + `[✅ 允许一次]` `[⛔ 拒绝]`。
- 点按钮 → 卡片原地变成结果，`approval/request` 拿到 `allowed-once`（**只对这一次生效**）或 `rejected`。
- **5 分钟没人点** → 交回 `next()`（GUI 还有机会；都没人答就按 DSH 自己的 fail-closed 处理）。
- 请求被 abort（比如你按了停止）→ 返回 `cancelled`。
- 桥接停掉时 `failPendingApprovals` 放行所有等待，不会把一轮对话永久挂住。

> ⚠️ 前提是会话的 approval policy 是 `ask`。policy 为 `never` 时 DSH 直接拒掉，
> 根本不会问任何人，也就不会有卡片。用 **`/approval`** 看当前策略、`/approval ask` 打开询问。

## 收到附件（文件 / 图片）

飞书消息的 `body.content` 里只有一个 `file_key`，真正的字节要再调一次
[获取消息中的资源文件](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-resource/get.md)。
桥接现在会把它取下来落进工作区，**然后把本机路径作为一轮用户输入交给 agent**：

```
⏳ 收到文件 **报表.pdf**，正在取下来…
✅ 文件 **报表.pdf**（1.4 MB）已存到工作区：

/path/to/workspace/feishu-inbox/报表.pdf
```

| 消息类型 | 处理 |
|---|---|
| `file` / `audio` / `media` | 下载（`type=file`）→ `feishu-inbox/` |
| `image` | 下载（`type=image`）→ 用 `read_image` 直接看 |
| `folder`（聊天里的文件夹消息） | ❌ **飞书不提供下载**（不是 file/image；整包 `234037`、Range `500/40009`、token 也查不到云文档元数据 —— 都实测过）→ 会明确告诉你，并建议改用**云文档分享**或放到 nas |
| 其它（sticker / 名片 / 位置…） | 说明取不到内容，不再沉默 |

**大文件**：飞书对 `type=file` 的**整包下载限制 100 MB**（超了报 `234037`）。超过时桥接会改用
`Range: bytes=<start>-<end>`**分片下载**（单次 ≤ 32 MB）并本地拼接 —— 这是官方给的办法。
`type=image` 不支持分片，图片必须 < 100 MB。

**进度播报**：大文件走 `Range` 分片时，每块都会回调一次（32MB/块），但**按时间节流到 15 秒一条**
（`lib/progress.mjs`，用户的规矩是 10-20 秒一次）—— 所以 889MB 下载你会看到若干条
`⏳ xx.mov：320.0 MB / 889.0 MB（36%）`，而不是沉默 88 秒，也不是 29 条刷屏。
云盘文件夹递归拉取同理（按「已拉 N / M 个文件」播报）。

**文件名**：来自发送方，落盘前只做**必要**净化——把 `/`、`\` 换成 `_`、去掉控制字符、纯点号名字兜底；
**保留前导点**（macOS 会发真实的 `._name` AppleDouble 旁挂文件，静默改名也是 bug）。重名自动加 `-2`。

## 拉取飞书云文档（Drive）文件夹

聊天里直接发的**「文件夹」消息取不到**（见上），但**云文档的文件夹可以**：能列目录、能逐个下载、
能按原结构在本地重建。工具是 **`feishu_drive_pull`**：

```
feishu_drive_pull({ folder: "https://xxx.feishu.cn/drive/folder/fldcnXXXX" })
→ 云盘文件夹已拉到 <cwd>/feishu-inbox/fldcnXXXX：
  128 个文件 / 17 个目录 / 3.4 GB
```

- `folder` 支持**完整链接**、**裸 token**，也支持**夹在一句话里**的链接。
- 目标目录默认 `<会话 cwd>/feishu-inbox/<token>`，可用 `dest` 指定。
- 递归遍历有**循环保护**（`visited` 去重，自引用目录不会死循环）与深度上限（12 层）；
  每条路径的每一段都过 `safeFileName()`，所以文件夹里叫 `../evil` 的文件不会跑出目标目录。
- 单个文件下载失败会**继续下别的**，最后在结果里列出失败清单（最多 20 条）。

> ⚠️ 前提：**机器人 LUNA 得能看见这个文件夹** —— 在云文档里把文件夹/文档**分享给它**
> （添加协作者，或把文件夹发到这个会话）。`drive/v1/files` 我们这边已验证可用
> （`root_folder` 与列目录都返回 code 0）。

## 发链接给我：自动读内容

消息**只包含一条飞书链接**时，桥接会自己去取内容（不用等模型决定），取完再把结果作为一轮输入交给我：

| 链接 | 行为 |
|---|---|
| `/wiki/<node>` | `wiki/v2/spaces/get_node` 解析节点 → 若是 docx，读正文并落盘 |
| `/docx/<id>`、`/docs/<id>` | `docx/v1/documents/<id>/raw_content` → 正文落盘 → 我在聊天里回你摘要 |
| `/drive/folder/<token>` | 递归遍历 + 下载 + **按原结构重建**（与 `feishu_drive_pull` 同一套逻辑） |
| `/sheets/`、`/base/`、`/file/` | 明确回复「还没接这个类型」，不装死 |

- **只有链接**（`isBareLink`）才自动抓；链接夹在一句话里就交给模型，由我决定要不要取。
- 文档落盘为 `<cwd>/feishu-inbox/<标题>.md`，文件名走 `safeFileName()`。
- 已实测：一篇知识库文档（`/wiki/…` → docx）可以完整读到正文。

> ⚠️ **文档里的附件拿不到**：飞书「保存会话记录」生成的文档会把附件写成**纯文本** `[[文件]] 名字`,
> 块结构里没有 token（实测只有 3 个块：page/quote/text）。所以那种文档只能读到文字。
> 要附件仍然得走云盘分享或 nas。

## 消息怎么发出去（渲染）

**飞书的纯文本消息完全不渲染 Markdown。** 用 `msg_type: text` 把 `**粗体**` 发出去，
用户看到的就是四个星号；发表格就是一堆竖线。这不是"少用点 Markdown"能绕过的 ——
agent 的回答天然带格式，所以 bridge 推出去的东西**一律走卡片**（`lib/format.mjs`）：

| 载体 | 能渲染什么 |
|---|---|
| 纯文本消息（`text`） | ❌ 什么都不渲染，Markdown 原样显示 |
| 卡片 1.0 的 markdown 元素 | 粗体 / 斜体 / 删除线 / 行内代码 / 链接 / 有序无序列表 / 代码块 / 分割线 |
| **卡片 2.0 的 markdown 元素** | 上面全部 **＋ 标题 ＋ 引用 ＋ 表格** |

标题、引用、**表格**是 2.0 独有的语法
（[官方说明](https://open.feishu.cn/document/feishu-cards/card-components/content-components/rich-text?lang=zh-CN)），
所以 `markdownCard()` 用 **`schema: "2.0"`**。

- **默认不带标题栏** —— 看起来仍像一条普通消息，而不是告警框；需要当告警时才传 `header`。
- **长消息**按行切块（3800 字符），并且**代码块被切开时自动补 fence**，
  渲染器不会看到半个 ``` 块。
- **兜底**：卡片发不出去（网络 / 权限）时退回纯文本，并**先把 Markdown 洗掉**
  （`toPlainText()`：去星号、反引号、`#`、`>`，表格行降级成 `a · b`）——
  宁可不加粗，也不给你看语法。

## 命令

| 命令 | 作用 |
|---|---|
| `/permission`（或 `/perm`、`/权限`、`/p`） | 推一张交互卡片，点按钮切换本会话的文件权限 |
| `/permission read-only` | 直接切换，不发卡片。三个值：`read-only` / `workspace-write` / `danger-full-access` |
| `/new`（或 `/新会话`、`/新对话`、`/reset`） | 开一段全新空白对话；上一段原样保留 |
| `/sessions`（或 `/session`、`/会话`、`/历史`） | 推一张**会话切换卡片**：每段一个按钮，**点一下切过去**（当前段实心 + `✓`）；`/open <编号>` 仍可用 |
| `/open 2`（或 `/切换 2`、`/打开 2`） | 切回第 2 段并恢复它；`#2` 也认 |
| `/model`（或 `/models`、`/模型`） | 推一张**模型切换卡片**：每个模型一个按钮，点一下就把本会话切过去 |
| `/approval`（或 `/审批`） | 看本会话的审批策略；`/approval ask` / `/approval never` 切换（决定「要授权时会不会推卡片」）|

### `/model` 卡片长什么样

```
🧠 切换模型                                    ← 卡片标题
───────────────────────────────────────────────
当前：**deepseek-official / deepseek-flash**

点一下按钮就切过去（立刻生效，本会话下一轮就用新模型）。
───────────────────────────────────────────────
▸ DeepSeek 官方（`deepseek-official`）
[DeepSeek Flash ✓]  [deepseek-v4-pro]           ← 当前那个是实心按钮 + 打勾
▸ 智谱（`zai`）
[glm-4.5]  [glm-4.6]  [glm-5.3]  [glm-5.3-flash] …
```

点一下之后：飞书弹 toast（`已切到 glm-5.3`），**卡片原地刷新**，新模型变成实心 + 打勾。

**切换走的是 GUI 同一个入口**：`sessionController.selectModel({sessionId, provider, model})`
（`dsh-api-session-controller`）。它会先用 `ctx.llm.resolveCallConfig()` 校验这条路由，再往会话里
追加一条**持久化的 `model/selection` 事件**并更新内存里的待用选择 —— 所以：

- 效果**立刻生效**，本会话下一轮就用新模型；
- 和 GUI 里点模型选择器是同一个状态，不会出现两边打架；
- 它同时会把选择存成**默认**（`agentDefaultModel.saveSelection`），和 GUI 的行为一致 ——
  也就是说**之后新开的会话也用这个模型**。

> 卡片只列**能路由**的模型（`modelCatalog()` 的 `groups`）。某个 provider 读失败时，
> 卡片底部会写明「⚠️ xxx 读取失败：原因」，而不是让它看起来像"这个 provider 没有模型"。
> 文本清单（`/model` 在卡片发不出去时的兜底）也保留着。

### `/sessions` 卡片长什么样

```
📋 切换对话                                     ← 卡片标题
───────────────────────────────────────────────
当前：**#2**

点一下编号就切过去 —— 那一段记得之前所有对话，你的下一句话就发给它。
───────────────────────────────────────────────
[#1 · 09-24 21:16]  [#2 · 09-24 22:04 ✓]        ← 当前那段是实心按钮 + 打勾
───────────────────────────────────────────────
/new 开一段全新空白对话；/sessions 重新出这张卡片。
```

点一下之后：飞书弹 toast（`已切到 #1`），**卡片原地刷新**，实心按钮跟着移到那一段。

按钮走的是**和 `/open <n>` 完全相同**的那条路（`ConversationBook.open` → 写落盘段指针 + `resume` 那一段），
所以「点按钮」和「手打命令」不可能切到不同结果。卡片发不出去时退回原来的文本列表（`▶` 标当前段）。

### `/permission` 卡片长什么样

```
🔐 文件权限                                    ← 卡片标题（颜色随模式变：灰/蓝/红）

当前：📁 工作区可写

📁 工作区可写 —— 只能改工作区内的文件（默认） ← 当前
🔒 只读 —— 只能读取，任何写操作都会被拒
🔓 完全访问 —— 不限制，可以改这台机器上任何文件

> 这个设置只影响本会话（飞书会话 oc_xxx 绑定的那个 DSH session）。
> 想直接指定也可以发文本：/permission workspace-write
─────────────────────────────────────────
[📁 工作区可写]  [🔒 只读]  [🔓 完全访问]     ← 按钮，当前模式高亮
```

点按钮后：飞书弹一个 toast（`已切换到 🔓 完全访问`），**卡片原地刷新**成新状态。

底层调的是 DSH 自己的 `setSandboxMode(session, mode)`（`@deepseek-ai/dsh-sandbox-policy`），
往会话里追加一条 `sandbox/mode` 事件——跟你在 GUI 里点权限切换是同一个东西，
所以**只影响这个飞书会话对应的那个 DSH session**，下一次工具调用就生效。

> ⚠️ **按钮点了没反应？** 说明飞书那边没订阅 `card.action.trigger`。
> 去「事件与回调 → 添加事件」里加上，然后**创建版本并发布**。这是最容易漏的一步，
> 而且漏了不会有任何报错——飞书只是把回调丢掉。

## 问用户一个问题：`feishu_ask`

**在飞书会话里，agent 提问必须用 `feishu_ask`，不能用 `ask_user_question`。**

原因是后者弹的是 DSH **本机的 GUI 对话框**：你人在飞书，机器前没人，那一轮就卡在
「等你点确定」上，直到工具超时——你只会看到对话停住。`feishu_ask` 把同一件事搬到聊天里：

```
❓ 需要你选一个                                  ← 卡片标题
───────────────────────────────────────────────
要不要现在开始转 4K？

> 点按钮回答。想补充点什么，就写在下面的输入框里，会和选项一起回来。
┌─────────────────────────────────────────────┐
│ 补充说明（可留空）                            │  ← 多行输入框，可留空
└─────────────────────────────────────────────┘
[开始转]  [先看看]                                ← 第一个选项高亮
```

- **点按钮**：飞书弹 toast（`已选择：开始转`），卡片**原地刷新**成「✅ 已收到回答」，
  控件消失，等待中的那一轮立刻继续。
- **输入框里写的补充**会和选项一起回传，回答变成 `开始转 —— 补充：先备份一份`。
  也可以**只提交输入框**（不点按钮），那样整段文字就当答案。
- **直接回文字**：也算回答。问了问题之后，你在同一个聊天里发的普通文字会被当成答案交给
  等待中的工具调用，而不是另起一轮。
- **超时**（默认 600 秒，可用 `timeout_seconds` 调，钳在 30–3600）：工具返回
  `answered=false, reason="timeout"`，模型知道你没回答，可以自己决定继续或换问法。
  卡片在多留 10 分钟里仍然可点——那时候点下去会**当普通消息发出来**，不会白点。
- **非飞书会话**（比如你在 GUI 里聊）：工具直接返回 `reason="not-feishu"`，模型会改用
  `ask_user_question`。
- 会话权限、`/permission`、`/new` 这些命令在待答期间照常可用（命令优先于"当成回答"）。

| 参数 | 必填 | 说明 |
|---|---|---|
| `question` | ✅ | 问题正文，支持 markdown |
| `options` | ✅ | 2–6 个按钮文案；**第一个会被高亮**，所以把推荐的放最前 |
| `header` | | 卡片标题，默认 `❓ 需要你选一个` |
| `hint` | | 问题下方的小字，比如每个选项的代价 |
| `timeout_seconds` | | 等待上限，默认 600 |
| `chat_id` | | 目标会话，不给就回到当前这个飞书会话 |

### 为什么这张卡是 JSON 2.0，而 `/permission` 是 1.0

**输入框要和按钮一起提交，必须嵌在「表单容器」里，而表单容器只有卡片 JSON 2.0 才有**
（[输入框组件](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/interactive-components/input)）。
所以问题卡片升级成了 `schema: "2.0"` + `body.elements` + `tag: "form"`，按钮用
`name` + `form_action_type: "submit"`（[按钮组件](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/card-json-v2-components/interactive-components/button)）。
`/permission` 那张继续用 1.0——它没有输入框，没有必要动。

两张卡片的回调都走同一个 `card.action.trigger` 处理器，靠 `value.type`
（`dsh_question` vs `dsh_permission`）区分。

### 表单回传的兼容处理（踩过的坑）

飞书表单提交的回传形状文档没有完全钉死（`action.value` / `form_value` / `input_value`
都可能出现），所以解析是**防御式**的（`lib/cards.mjs` 的 `formValuesOf`）：

1. 优先用按钮自己的 `value`（`behaviors[].value`）；
2. 拿不到时，改用**控件名**兜底 —— 按钮的 `name` 是 `opt<下标>-<questionId>`，
   提交的表单数据里带着它，所以选项和问题都能还原；
3. 补充文字从 `ask_note` 这个控件名里取（输入框的 `name`）。

> 实现上，问题的身份（`questionId` 与选项下标）跟着按钮回来，所以不需要维护消息 id；
> 服务端只留一份「谁在等答案」的登记表（`lib/index.mjs` 的 `pendingQuestions`），
> 桥接停掉时会把等待中的调用全部放行，不会有工具调用被永久挂住。

### 桥接重启后还能发（`decodeSessionId`）

`sessionId ⇄ chatId` 的映射表**只在收到飞书消息时**才会填。所以刚重启完（或者你在
**GUI 里**往飞书会话里打字）时，`feishu_send` / `feishu_ask` 会找不到该发到哪个会话。

现在会从 session id 本身反推：`feishu-<chatId>[-<n>]` 是确定性的，`decodeSessionId()`
能把它解回 `chatId`（`lib/generations.mjs`）。**这就是「重启后第一轮就能发消息」的原因。**


## 会话代次（`/new` 为什么不会删掉旧对话）

一个飞书聊天可以拥有**多段** DSH 会话，段号就是身份：

```
feishu-oc_xxx        ← 第 1 段（历史遗留的聊天天然就是第 1 段，无需迁移）
feishu-oc_xxx-2      ← 第 2 段
feishu-oc_xxx-3      ← 第 3 段
```

- **哪些段存在**是从 session store 现算的（id 的集合就是历史），插件不维护自己的索引，
  所以不会出现"列表里有、实际打不开"的漂移。
- **哪一段是当前段**才需要落盘：`<DSH_HOME>/dsh-feishu.state.json` 里每个 chat 一个数字。
  没有它的话，`/open 1` 之后重启会悄悄跳回最新一段。文件损坏/不可写只会降级（回到最新一段），
  不会影响桥接。
- `/new` 的语义是**彻底空白**：新段不记得之前任何东西。旧段保持可恢复、还能在 DSH 界面里接着聊。
- `/sessions` 推的是**卡片**：每段一个按钮，点一下就等于 `/open <n>` —— 两处调用的是
  同一个 `ConversationBook.open()`，落盘指针也只有一份，所以「点按钮」和「手打命令」不可能切到
  不同结果。卡片发不出去时退回文本列表。
- 当前段**还有内容**时才开新段：在一个空段上反复 `/new` 不会堆出一串空会话。
- 文件权限**沿用**上一段——在飞书里 `/permission` 是"这个聊天"的决定，虽然它存在会话上。
- 旧段会被自动命名成 `飞书 #1 · 09-24 12:03`，这样在 GUI 的会话列表里能认出来
  （飞书消息是以 `source.kind === 'plugin'` 注入的，而标题服务只给 `'user'` 来源的消息自动起名，
  所以不命名的话每一段都是一行光秃秃的 `feishu-oc_…`）。你在 GUI 里手动改过的标题不会被覆盖。

### 旧段去哪调出来

1. **飞书里**：`/sessions` 看列表，`/open <编号>` 切回去。这条不依赖 GUI，**归档过的段也能打开**。
2. **DSH 界面里**：会话列表（左侧）。注意两件事：
   - 飞书会话没有登记进工作区成员表，所以它落在列表最后的 **「未分组」** 组里；
   - GUI 对**已归档**（会话行右键「归档会话」）的会话是**三处全隐藏**（分组树、平铺列表、搜索），
     而且**没有"取消归档"入口**。归档了就只能靠飞书侧的 `/open`，或者停掉 DSH 后手动把 id 从
     `~/.dsh/storages/workspace.json` 的 `archivedSessionIds` 里删掉再启动。

## ⭐ 会话能力来自 agent preset（最容易漏的一步）

**只用 `ctx.agents.create()` 建出来的会话是「裸」的。** 它只能看到**全局注册**的工具
（本插件自己注册的、以及 host 层的 MCP 与记忆工具），而
**shell、文件读写、搜索、skill、todo、subagent、web 全都没有** —— 因为那些是由
**agent preset 的 standing composition** 装进来的。

更隐蔽的是：裸会话也**没有 persona 和 instructions**，所以模型根本不知道自己是能动手的 coding agent，
会把手上那 50 个工具当摆设，表现得「只会聊天」。这正是 `/permission` 之前的症状。

所以插件建会话时必须走 GUI 那条路（`SessionController` 内部就是这么干的）：

```js
const preset = await ctx.agentPresets.resolve()          // 不传 = 配置里的默认（本机 standard）
const composition = {
  agentPreset: preset.id,
  setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, preset.id) },
}
await ctx.agents.create({ sessionId, meta: { cwd, agentPreset: composition.agentPreset }, setup: composition.setup })
await ctx.agents.resume({ resumeSessionId: sessionId, setup: composition.setup })   // 恢复也要给
```

实测对比（同一个 DSH、同一套插件）：

| 会话 | 工具数 | 差异 |
|---|---|---|
| 不带 preset | 50 | 只有 MCP + 记忆 + `feishu_send`；**没有 shell / 文件 / web / skill** |
| 带 preset | **77** | 多出 `bash`、`read`/`write`/`edit`/`glob`/`grep`、`read_image`、`web_fetch`/`web_search`、`skill`、`todo_write`、`subagent`/`workflow`、`ask_user_question`、`present`、`job_*`、goal 系列 |

> 旧版本建的裸会话**不用新开**：带 preset `resume` 一次就补上全部能力（已实测 77 个工具）。

## 行为

- **一个飞书聊天 = 一串 DSH session**，每段一个 id：`feishu-<chat_id>`（第 1 段）与
  `feishu-<chat_id>-<n>`（第 n 段）。确定性生成，所以重启/重载后会 `resume` 同一段对话，
  而不是新开一段；`/new` 是唯一换段的入口。
- 助手一轮结束时把最终文本推回会话；`turn/end` 的 reason 不是 `completed` 时会加前缀。
- 如果这一轮 agent 已经用 `feishu_send` 主动发过消息，就不再重复自动回推（避免刷屏）。
- 消息长度超过 3800 字符会按行拆成多条发送。
- 同一条飞书消息重复投递（ACK 慢时会发生）会被 message id 去重。
- 已识别的斜杠命令（`/permission`、`/new`、`/sessions`、`/open` 及各自别名）由插件自己处理，
  **不会**送给模型；其他 `/` 开头的文本照常当作消息发给模型。
- **任务运行中收到消息默认插队**（`sendMode: steer`）：消息投到正在跑那一轮的 next-step 车道，
  下一步就能被读到；切成 `queue` 则等这一轮跑完再开新一轮。详见「配置 → `sendMode`」。

## 工具

| 工具 | 参数 | 用途 |
|---|---|---|
| `feishu_send` | `text`（必填）、`chat_id`（可选） | 主动往飞书会话推消息；不给 `chat_id` 就回到最近跟这个 agent 说过话的会话 |
| `feishu_ask` | `question`、`options`（必填）、`header`、`hint`、`timeout_seconds`、`chat_id` | 推一张带选项按钮 + **补充输入框**的问题卡片，并**等你的回答**（点击 / 输入框 / 文字）；飞书会话里代替 `ask_user_question` |

## 自检

```bash
node tools/smoke.mjs    # 模块能否加载 + apply 能否干净干跑（不联网）
node tools/probe.mjs    # 只测长连接：连上后去飞书给机器人发条消息，看事件
```

`smoke.mjs` 存在的理由：bundle 里任何**模块级**抛错都会在 boot 期把整个 harness 带崩，
所以改完代码先跑它，再考虑往真 profile 里装。

## 文件

```
lib/pbbp2.mjs        pbbp2.Frame / Header 的 protobuf 编解码 + 事件分片合并
lib/ws.mjs           长连接：握手、心跳、重连、事件 ACK（ACK 同时承载卡片回调响应）
lib/api.mjs          OpenAPI 客户端：tenant_access_token、发文本/卡片、回复、加表情
lib/cards.mjs        `/permission` 与 `feishu_ask` 两类交互卡片的构造、按钮 value 解析、回调响应组装
lib/generations.mjs  会话代次与 session id 的纯映射（`feishu-<chat>[-<n>]` ⇄ n，含 `decodeSessionId` 反查）
lib/models.mjs       `/model` 的模型目录与切换卡片：归一化 catalog、渲染文本/卡片、解析按钮 value（可单测）
lib/progress.mjs     大文件进度播报的时间节流（假时钟可测）
lib/links.mjs        飞书链接识别：wiki/docx/sheets/drive-folder + 「是否只有一条链接」（可单测）
lib/drive.mjs        飞书云文档文件夹：链接解析 + 递归遍历（循环保护/路径净化，可单测）
lib/inbound.mjs      入站消息识别：附件类型 → 可下载/不支持 + 文件名净化（可单测）
lib/format.mjs       出站消息的渲染：markdown → 卡片 2.0、长消息切块（代码块补 fence）、纯文本兜底洗涤（可单测）
lib/conversations.mjs `/new` / `/sessions` / `/open` 的语义本体 + `/sessions` 切换卡片（`sessionCard` / `parseSessionAction`；依赖全部注入，可脱离飞书测）
lib/state.mjs        每个 chat 的「当前段」指针（<DSH_HOME>/dsh-feishu.state.json，损坏只降级）
lib/paths.mjs        <DSH_HOME> 的解析（日志与指针共用）
lib/log.mjs          插件独立诊断日志（<DSH_HOME>/dsh-feishu.log，2MB 轮转）
lib/index.mjs        服务端本体：设置段、preset 装配、会话映射、事件循环、命令分发、feishu_send、feishu_ask、状态路由
lib/client.js        浏览器端：设置面板卡片（`settings.plugin.item` 槽，key=feishu）
tools/smoke.mjs      服务端加载 + apply 干跑 + 卡片纯函数 + 会话命令（假宿主）+ 浏览器端模块加载（改完代码先跑这个）
tools/probe.mjs      只测长连接的独立探针
```

> `lib/client.js` 是**手写**的 DSH 客户端模块（`window.__ModuleLoader__.load` + `require("react")`），
> 不需要构建步骤。改完它要**重启 DSH**（客户端模块图在启动期组建）。
