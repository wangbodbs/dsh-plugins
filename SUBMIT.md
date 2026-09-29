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
| PR | ⏳ 未开 —— **卡在仓库满 1 天门槛**：`wangbodbs/dsh-plugins` 创建于 2026-09-29T01:28:29Z，**2026-09-30 09:28（北京时间）之后**才能提 |


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

## 收录要求速查（来自 contributing.md）

- `package.json` 声明 `dsh.bundle`（**只声明 `dsh.client` 会被 CI 拒**）
- 仓库有真实可用代码，不是占位
- 仓库创建满 1 天
- 仓库加 `dsh-plugin` topic
- 描述只说功能、不带营销词，且**必须与代码相符**
- 选贴合实际功能的分类
- 一个 PR 最多 3 条
