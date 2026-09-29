# dsh-mcp-flapi

把 **FilmLight 官方的 FLAPI MCP Assistant**（`flapi-dev-mcp`）接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）——命令行版和桌面版都适用。

装上之后，DSH 里会多出 18 个 `mcp__flapi__*` 工具：`flapi_check_environment`、`search_examples`、`get_class_docs`、`check_standalone_readiness`、`setup_standalone_env`、`flapi_connection`、`check_flapid`、`get_app_script_log`……

这样 DSH 就能直接写并运行 Baselight / Daylight 的 FLAPI 脚本——探测已安装的版本、匹配 API wheel、生成脚手架、跑起来、读日志自纠错。

## 安装

**两步。** 第一步装插件，第二步装 FilmLight 那个 uv 工具（它不是 npm 包，插件拉不进来）。

```bash
# 1) 插件
dsh plugin --profile web add dsh-mcp-flapi

# 2) FilmLight 的 MCP（注意 mcp<2 这个 pin，原因见下）
npx dsh-mcp-flapi-setup
```

`dsh-mcp-flapi-setup` 就是替你跑这串命令：

```bash
uv tool install --with "mcp<2" git+https://github.com/FilmLightAPI/flapi-dev-mcp
flapi-dev-mcp init
```

没装 uv 的话：`brew install uv`（macOS）或 `curl -LsSf https://astral.sh/uv/install.sh | sh`。

## ⚠️ 为什么必须 `mcp<2`

官方 `pyproject.toml` 把依赖写成 `mcp>=1.2.0`，**没有上界**。而 mcp SDK 2.x 把 `FastMCP` 改名成了 `MCPServer`、API 也变了，`flapi-dev-mcp 0.2.2` 还在 import 旧的 `mcp.server.fastmcp`——于是启动即崩：

```
ModuleNotFoundError: No module named 'mcp.server.fastmcp'
```

`--with "mcp<2"` 把它钉在 1.x（例如 1.30.0）。这个约束会写进 uv 的 tool receipt，所以之后 `uv tool upgrade` 也不会再踩坑。

> 顺带一提：就算升到 mcp 2.x 也**拿不到更新的协议版本**——实测请求 `2026-07-28` 仍会协商回 `2025-11-25`。花力气升级没有收益。

本插件会在启动时检测这个情况，发现 mcp 2.x 就直接打印修复命令，而不是让你对着一个晦涩的 traceback 发愁。

## 前置条件

- **Baselight 或 Daylight 7.0.0.24232 或更新**（wheel 化的 FLAPI 发行版）
- Python 3.12+（uv 会自己装）
- 能连到 flapid 守护进程（`1984`），或运行中的应用（`1985`，live 会话用）

`flapi-dev-mcp status` 随时可以看它眼中的环境。

## 自定义

```yaml
- id: mcp-flapi
  name: dsh-mcp-flapi
  config:
    command: /custom/path/to/flapi-dev-mcp   # 或用 $FLAPI_DEV_MCP_PATH
    serverName: flapi                         # 决定工具前缀 mcp__flapi__*
    toolCallTimeoutMs: 180000
```

搜索顺序：patch 里的 `command` → `$FLAPI_DEV_MCP_PATH` → `$UV_TOOL_BIN_DIR` → `~/.local/bin` → `PATH`。

## 卸载

```bash
dsh plugin --profile web remove dsh-mcp-flapi
uv tool uninstall flapi-dev-mcp
```

## 说明

- 找不到或检测到损坏的安装时，插件**不会让 DSH 启动失败**，只打印带修复命令的提示，然后不带工具地正常加载。
- MCP 本身免费；你的编码 agent（如果另需订阅）不在此列。
- `flapi-dev-mcp init` 会克隆示例仓库到 `~/.flapi-dev-mcp/repo`，配置写在 `~/.flapi-dev-mcp/config.json`。

## License

MIT。Baselight、Daylight、FLAPI 是 FilmLight Ltd. 的商标；本项目与 FilmLight 无关。
