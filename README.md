# dsh-plugins

DeepSeek Harness (DSH) plugins, by [wangbodbs](https://github.com/wangbodbs).

A monorepo: each directory under `packages/` is a standalone, separately installable
DSH bundle. There is no bundle at the root — the root is only a container.

| Package | What it does | Requires |
|---|---|---|
| [`dsh-feishu`](packages/dsh-feishu) | Talk to DSH from Feishu / Lark: a chat maps to a DSH session, messages become turns, answers are pushed back as interactive cards | DSH ≥ 0.1.0-rc.5, Node ≥ 22 |
| [`dsh-mcp-flapi`](packages/dsh-mcp-flapi) | Registers FilmLight's official FLAPI MCP assistant (`flapi-dev-mcp`) as an MCP server in DSH | DSH ≥ 0.1.0-rc.5, Node ≥ 20, a FilmLight FLAPI install |
| [`dsh-mcp-davinci-resolve`](packages/dsh-mcp-davinci-resolve) | Registers the MCP server built into DaVinci Resolve 21.1+ as an MCP server in DSH | DSH ≥ 0.1.0-rc.5, Node ≥ 20, DaVinci Resolve 21.1+ |

## Install

Each package installs on its own. From the plugin market (Settings → Plugin Market),
or straight from this repository with the subdirectory selector:

```sh
dsh plugin --profile web add "git+https://github.com/wangbodbs/dsh-plugins.git#path:/packages/dsh-feishu"
dsh plugin --profile web add "git+https://github.com/wangbodbs/dsh-plugins.git#path:/packages/dsh-mcp-flapi"
dsh plugin --profile web add "git+https://github.com/wangbodbs/dsh-plugins.git#path:/packages/dsh-mcp-davinci-resolve"
```

Installing one package does **not** pull in the others.

## What the packages are not

- `dsh-mcp-flapi` and `dsh-mcp-davinci-resolve` are *registration* bundles: they start
  the MCP server that ships with the host application and expose its tools to DSH. The
  tools themselves belong to FilmLight and Blackmagic; this repository only wires them up.
- `dsh-feishu` talks to the Feishu open platform with a self-built app that the user
  creates. No credentials are shipped, and none are read from anywhere but the plugin's
  own settings.

## Layout

```
packages/<name>/package.json     declares dsh.bundle → cordis.patch.yml
packages/<name>/cordis.patch.yml inserts the bundle into a profile's layer stack
packages/<name>/lib/             the plugin code
submission/                      the entries this repository publishes to
                                 github.com/awesome-dsh-plugin/awesome-dsh-plugin
```

## License

MIT — see [LICENSE](LICENSE). Each package carries its own copy.
