# 提交插件市场 —— 运维手册 / Submission playbook

这个仓库面向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
目录（dsh-market 插件市场的插件来源）。手册记录**为什么这样写**，避免以后重新推一遍时踩同样的坑。

## 当前条目

| 包 | 分类 | 条目文件 |
|---|---|---|
| `packages/dsh-feishu` | `notify` | `submission/wangbodbs__dsh-plugins--packages-dsh-feishu.yml` |
| `packages/dsh-mcp-flapi` | `tools` | `submission/wangbodbs__dsh-plugins--packages-dsh-mcp-flapi.yml` |
| `packages/dsh-mcp-davinci-resolve` | `tools` | `submission/wangbodbs__dsh-plugins--packages-dsh-mcp-davinci-resolve.yml` |

## 提 PR 的步骤

已经脚本化 —— `scripts/open-catalog-pr.py`（用 Python 标准库，无需装东西；token 读
`$GITHUB_TOKEN` 或 `~/.dsh/.github-token`，**token 不进仓库**）：

```sh
python3 scripts/open-catalog-pr.py --status   # 看进度：仓库年龄、上游分支、有没有已开的 PR
python3 scripts/open-catalog-pr.py            # 准备：建 fork + 把三个条目推到一个分支（幂等）
python3 scripts/open-catalog-pr.py --pr       # 隔一天再跑：真正开 PR（会先查 24h 门槛，没到就拒）
```

它做的是手写步骤本来要做的事：fork 上游 → 在 fork 上建一个**只含这三个文件**的提交
（`data/plugins/<名>.yml`，用 Git Data API 一次性提交，不是三次）→ 开 PR。
**不会碰上游任何既有条目**（CI 的 gate 会列出 PR 修改的每一个既有条目，所以这条要守住）。

手工做法（脚本坏了时用）：fork `awesome-dsh-plugin/awesome-dsh-plugin`，把 `submission/` 里的
三个 yml 原样放进 fork 的 `data/plugins/`，提 PR。**只加文件，不要手工编辑生成出来的 README。**

### 当前状态（2026-09-29）

| 项 | 值 |
|---|---|
| 上游 | `awesome-dsh-plugin/awesome-dsh-plugin` |
| fork | `wangbodbs/awesome-dsh-plugin` |
| 分支 | `add-wangbodbs-dsh-plugins` @ `1a8e134d`（1 提交 / 只加 3 个文件） |
| 提交范围 | ✅ **三个一起发**（用户 2026-09-29 明确「一起」）。已知 `dsh-feishu` 与 `imetn/dsh-lark-bridge` 品类重合 —— 若维护者判定已被覆盖，按 PR 正文里的承诺**撤掉该条、保留两个 MCP** |
| PR | ⏳ 未开 —— **卡在仓库满 1 天门槛**：`wangbodbs/dsh-plugins` 创建于 2026-09-29T01:28:29Z，**2026-09-30 09:28（北京时间）之后**才能提 |

## ✅ 本地预演：把上游 CI 在自己机器上跑了一遍（2026-09-29）

等 24h 的时间里，把上游 `pr-check` 的每一步在本地复现了一遍（`data/plugins/` 放进三个条目并提交，
**必须提交** —— 见下面「收录日期」一条）。结论：**全绿**。

| 上游 CI 步骤 | 本地结果 |
|---|---|
| 每个条目文件以 `.yml` 结尾 | ✅ |
| 条目文件放在 `data/plugins/` | ✅ |
| stale-fork guard（删掉的条目 ≤ 2） | ✅ 删 0 个 |
| 「只改 README 不改条目」守卫 | ✅ 我们改了 `data/plugins/` |
| `generate-readme.mjs` | ✅ `4385 entries`，三条行在 `README.md` / `README.zh.md` 都渲染出来 |
| `awesome-lint` | ✅ **exit 0**，96 条警告全是既有条目，**我们三行零警告** |
| `added-dates` / `capabilities` / `adopt-discussions` 单测 | ✅ 三个都过 |
| `build-site.mjs`（`SKIP_PUBLISH_CHECKS=1`，与 workflow 同 env） | ✅ `site built: 4385 rows × 2 locales + sitemap + count badge` |

两个坑记下来，免得以后重踩：

1. **`build-site.mjs` 要求条目的「收录日期」可从 git 历史推导**（`scripts/lib/added-dates.mjs`：
   `git log --diff-filter=A -- data/plugins/<文件>` 取**最老**的那次添加）。所以条目文件**必须是提交**——
   只 `cp` 进去不提交，日期推不出来，build 直接拒；浅克隆（`--depth 1`）同理。
2. 本地跑 `npm`/`npx` 要显式 `--cache`（本机 `~/.npm` 里有以前 sudo 留下的 root 属主文件，默认缓存 EPERM）。

## ⚠️ 去重尽调：`dsh-feishu` 落在拥挤分类里

`notify` 分类下**已有 3 个 Lark/飞书桥**：`PlutoKeating/dsh-lark-bot`、`imetn/dsh-lark-bridge`、
`shrekcg/dsh-im-channel`，另有 `CAI-MH/dsh-feishu-task-recorder`、`zhuiyueya/dsh-im-gateway`。
其中 **`imetn/dsh-lark-bridge`** 的描述（双向、卡片、审批、附件）与本包高度重合 ——
而上游评审规则第 4 条正是「**是否已被现有条目覆盖**」（先来者保留位置，但「规则不是先来后到，
规则是谁更好」，且「更好的分叉确实会被收录」）。

⇒ 处理方式：**PR 正文里主动摆出这个对比** —— 列出 `PlutoKeating/dsh-lark-bot` /
`imetn/dsh-lark-bridge` / `shrekcg/dsh-im-channel` 三个既有条目，并明确说明本包**不是**它们的分叉，
以及在最近的 `imetn/dsh-lark-bridge` 之外还多了什么（`/permission` 切沙盒模式、`/model` 切模型、
`/sessions` 切会话代次、带输入框的提问卡片、云盘文件夹递归拉取、大文件 Range 分片、零运行时依赖），
最后写明「如果判定为已覆盖，请直说，我就撤掉这一条、保留另外两条」。
**不要等评审来问** —— 这也是上游说的「夸大是让本来不错的插件被打回的主要原因」的反面用法。

另外两条 `dsh-mcp-*` 在目录里**没有同类条目**（`grep -i davinci|baselight|flapi|filmlight` 只命中我们自己加的），
是这两个应用的**首例**。


## ⚠️ 硬门槛：仓库创建满 1 天

CI 会检查被收录仓库的**年龄 ≥ 1 天**（`contributing.md` 里写明，用来挡住「PR 前几分钟才建仓」）。
所以**建仓当天提 PR 一定会红**。正确顺序是：先建仓推代码，**隔一天再提 PR**。

## ⚠️ 为什么写 `engines.dsh` 而不是只靠 peerDependencies

`contributing.md` 建议把官方 `@deepseek-ai/*` 声明为 peerDependencies，并提醒
「不带显式预发布分支的 peer 范围会静默排除 harness 的所有预发布构建」。

我们在核心 `0.1.7-rc.2` 上用 node-semver 实测（**contributing.md 给的写法也不行**）：

| 范围 | `0.1.0-rc.6` | `0.1.7-rc.2` |
|---|---|---|
| `>=0.1.0-rc.5 <0.2.0` | ✅ | ❌ |
| `>=0.1.0-rc.5 <0.2.0-0`（指南推荐写法） | ✅ | ❌ |
| `>=0.1.7-rc.0 <0.2.0-0` | ❌ | ✅ |

原因就是指南自己讲的那条语义：预发布版本只有**元组完全相同的比较符**也带预发布标签才放行。
`0.1.0-rc.x` 的比较符救不了 `0.1.7-rc.2`；要覆盖任意 `0.1.x` 只能逐个小版本枚举，而枚举会在下一个
小版本线上再次失效。连 dsh-market 自己（`^0.1.0-rc.7 || ^0.1.1-rc.2 || ^0.1.2-alpha.2 || ^0.2.0-rc.1`）
也匹配不到 `0.1.7-rc.2` —— 这个坑在生态里是普遍的，而且 **DSH 核心根本不读 `engines`，pnpm 默认也不强制 peer**，
所以它平时不发作，只在 npm 侧变成 `ERESOLVE`。

因此本仓库的声明方式：

- **`engines.dsh`** —— 承担「宿主版本要求」的表达。市场读它，并且是**带 `includePrerelease: true`**
  求值的（`dshmarket/lib/discovery-compatibility.js:74`），所以 `>=0.1.0-rc.5 <0.2.0-0` 在市场和卡片上
  判定正确。DSH 核心不读 `engines`，加了不会影响加载。
- **peerDependencies** 只声明版本线稳定的宿主包（`@deepseek-ai/cordis` 4.x、`@deepseek-ai/schemastery` 3.x）；
  `dsh-feishu` 里针对 `@deepseek-ai/dsh-*` 的几条保持原样，属于**提示性**声明，不作为准入判断。

## 从工作区同步源码

本仓库是**发布副本**；日常开发仍在工作区的 `dsh-feishu/` 与 `dsh-mcp-bundles/dsh-mcp-*/`（默认 `~/Downloads/DSH`）。
推送前重新同步：

```sh
bash scripts/sync-from-workspace.sh          # 默认源头是 ~/Downloads/DSH
bash scripts/sync-from-workspace.sh /别的/路径
```

脚本只覆盖 `packages/*/lib`、`tools`、`README.md`、`cordis.patch.yml`，**不会**覆盖各包的
`package.json`（发布元数据是这里手工维护的）与 `LICENSE`。

### ⚠️ 单向：**要改内容，改工作区的权威源**

`README.md` 在同步范围内，所以**任何针对公开仓库的内容修改（隐私清洗、安装命令、错别字）
都必须改在工作区的 `dsh-feishu/README.md` / `dsh-mcp-bundles/*/README.md`，再跑同步**。
2026-09-29 踩过一次：把 `/Users/wangbo/...` 的私人路径只在本仓库里洗成占位符，随后一跑同步
就被工作区版本覆盖回来了（`README.md` 是同步项，`SUBMIT.md` 和 `package.json` 不是 —— 后者可以直接在这里改）。

工作区源改完，记得把备份副本也刷一遍（否则灾难恢复还原出来的又是旧文本）：

```sh
# dsh-feishu 的备份副本
cp ~/Downloads/DSH/dsh-feishu/README.md ~/Downloads/DSH/mnemon/infra/tools/dsh-feishu/README.md
# 两个 MCP 包的备份副本
for p in dsh-mcp-flapi dsh-mcp-davinci-resolve; do
  cp ~/Downloads/DSH/dsh-mcp-bundles/$p/README.md \
     ~/Downloads/DSH/mnemon/infra/tools/dsh-mcp-sources/$p/README.md
done
```

### 安装命令必须是访客能跑的

`packages/*/README.md` 是市场详情页链过去的那份文档，里面的安装命令**必须在公开仓库里成立**。
2026-09-29 修掉的三处：`dist/dsh-feishu-*.tgz`（`dist/` 根本不在仓库里）与两个裸包名
`dsh plugin add dsh-mcp-flapi` / `dsh-mcp-davinci-resolve`（这两个包**从未发布到 npm**，会 404）。
正确形态统一是上面那条 `#path:` 子目录选择器。

## 收录要求速查（来自 contributing.md）

- `package.json` 声明 `dsh.bundle`（**只声明 `dsh.client` 会被 CI 拒**）
- 仓库有真实可用代码，不是占位
- 仓库创建满 1 天
- 仓库加 `dsh-plugin` topic
- 描述只说功能、不带营销词，且**必须与代码相符**
- 选贴合实际功能的分类
- 一个 PR 最多 3 条
