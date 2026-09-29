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

1. Fork `awesome-dsh-plugin/awesome-dsh-plugin`。
2. 把 `submission/` 里的三个 yml 原样放进 fork 的 `data/plugins/`。
   **只加这一个目录里的文件，不要手工编辑生成出来的 README。**
3. 提 PR。一个 PR 最多 3 条，这三条正好用满。

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
