# dsh-mcp-davinci-resolve

把 **DaVinci Resolve 内置的 MCP server** 接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）——命令行版和桌面版都适用。

装上之后，DSH 里会多出 14 个 `mcp__resolve__*` 工具：`run_script`（沙箱 Python）、`search_scripting_api`、`get_scripting_api`、`list_luts`、`update_dctl`、`generate_lut`、`launch_resolve`……

## 安装

「设置 → 插件市场」里搜 `dsh-mcp-davinci-resolve`，或者直接（这个包不在 npm 上，走仓库子目录）：

```bash
dsh plugin --profile web add \
  "git+https://github.com/wangbodbs/dsh-plugins.git#path:/packages/dsh-mcp-davinci-resolve"
```

`web` 换成你的 profile 名即可（桌面版通常也是 `web`）。装完重启或热重载 DSH。

## 前置条件

- **DaVinci Resolve 21.1 或更新**。MCP server 从 21.1 起随应用一起发布。
- 不需要 API key，不需要额外下载。Resolve 不必处于运行状态——没开时 `launch_resolve` 可以把它拉起来。

## 它到底连的是什么

Resolve 21.1 的应用包里带了两样东西：

| 路径 | 说明 |
|---|---|
| `Contents/Resources/DaVinciResolve.mcpb` | MCP Bundle（其实是 zip），Claude Desktop 的打包格式 |
| `Contents/Applications/ResolveMCP` | **原生二进制**，真正讲 MCP 的 server |

`.mcpb` 里的 Node 包装只是个转发层。本插件**直接连二进制**，跳过包装。

> 关于"只能 Claude / Codex 用"：那是误传。CG Channel 的原文是 "external AI tools **like** Claude and Codex"——是举例。`.mcpb` 只是分发容器，剥掉后就是标准 stdio MCP server，任何 MCP 客户端都能连。

## 各平台路径

| 平台 | 默认路径 |
|---|---|
| macOS | `/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Applications/ResolveMCP` |
| Windows | `%ProgramFiles%\Blackmagic Design\DaVinci Resolve\ResolveMCP.exe` |
| Linux | `/opt/resolve/bin/ResolveMCP` |

自定义路径：设环境变量 `RESOLVE_MCP_PATH`，或在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: mcp-resolve
  name: dsh-mcp-davinci-resolve
  config:
    command: /custom/path/to/ResolveMCP
    serverName: resolve        # 决定工具前缀 mcp__resolve__*
    toolCallTimeoutMs: 180000
```

## 卸载

```bash
dsh plugin --profile web remove dsh-mcp-davinci-resolve
```

## 说明

- 找不到二进制时插件**不会让 DSH 启动失败**，只打印一条带修复建议的提示，然后不带工具地正常加载。
- `run_script` 跑的是**沙箱化 Python 3.14**（屏蔽 `os`/`sys`/`pathlib`/`shutil`）；需要文件系统/网络/子进程时才用 `run_script_unsafe`。这是 Blackmagic 自己的安全设计。
- 该 MCP 的日志写在 `~/Library/Application Support/Blackmagic Design/DaVinci Resolve/logs/mcp.log`，是 DEBUG 级、会长，可定期清。

## License

MIT。DaVinci Resolve、Blackmagic Design 是 Blackmagic Design Pty. Ltd. 的商标；本项目与 Blackmagic 无关。
