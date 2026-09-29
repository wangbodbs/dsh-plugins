/**
 * dsh-mcp-flapi — register FilmLight's FLAPI MCP Assistant with DSH.
 *
 * FilmLight ships a local MCP server, `flapi-dev-mcp`, that turns an MCP-aware
 * coding agent into a FLAPI (Baselight / Daylight) developer: it discovers the
 * installed builds, matches the API wheel, scaffolds scripts and runs them.
 * It is distributed as a uv tool rather than an npm package, so this bundle
 * locates the executable and hands it to the stock
 * `@deepseek-ai/dsh-mcp-client`, which publishes its tools as
 * `mcp__<serverName>__<tool>`.
 *
 * @module dsh-mcp-flapi
 */
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-flapi'
/** Services this plugin needs, re-exported from the MCP client it drives. */
export const inject = mcpClient.inject

/** Default tool-server namespace; tools surface as `mcp__flapi__<tool>`. */
const DEFAULT_SERVER_NAME = 'flapi'
/** FLAPI scrubs are slow: readiness probes and renders outlive a 60 s default. */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 180_000
/** The uv tool the user must install before this bundle can do anything. */
const UV_TOOL_NAME = 'flapi-dev-mcp'

/** The executable's name on this platform. */
function binaryName(platform = process.platform) {
  return platform === 'win32' ? `${UV_TOOL_NAME}.exe` : UV_TOOL_NAME
}

/**
 * Every directory on `PATH`, in order.
 * @param env - environment supplying `PATH` (or `Path` on Windows).
 * @param platform - a `process.platform` value.
 * @returns the path entries, or an empty array when none are set.
 */
function pathEntries(env, platform) {
  const raw = platform === 'win32' ? (env.Path ?? env.PATH ?? '') : (env.PATH ?? '')
  return raw.split(delimiter).filter((entry) => entry !== '')
}

/**
 * Where `uv tool install` puts executables when the user has not overridden it.
 * @param env - environment supplying `UV_TOOL_BIN_DIR`.
 * @returns candidate directories, most specific first.
 */
function toolBinDirs(env) {
  const dirs = []
  if (env.UV_TOOL_BIN_DIR) dirs.push(env.UV_TOOL_BIN_DIR)
  if (env.XDG_BIN_HOME) dirs.push(env.XDG_BIN_HOME)
  dirs.push(join(homedir(), '.local', 'bin'))
  return dirs
}

/**
 * Resolve the `flapi-dev-mcp` executable this host should run.
 *
 * Precedence: an explicit `command` from the patch, then `$FLAPI_DEV_MCP_PATH`,
 * then uv's tool bin directories, then `PATH`. A candidate that does not exist
 * is skipped, so a stale variable cannot mask a working install.
 * @param explicit - `command` supplied through the patch config, if any.
 * @param platform - a `process.platform` value.
 * @param env - environment supplying overrides and lookup roots.
 * @returns the first existing candidate, or `undefined` when none exists.
 */
export function resolveCommand(explicit, platform = process.platform, env = process.env) {
  const bin = binaryName(platform)
  const candidates = [
    explicit,
    env.FLAPI_DEV_MCP_PATH,
    ...toolBinDirs(env).map((dir) => join(dir, bin)),
    ...pathEntries(env, platform).map((dir) => join(dir, bin)),
  ]
  return candidates.find((candidate) => typeof candidate === 'string' && candidate !== '' && existsSync(candidate))
}

/**
 * Best-effort read of the MCP Python SDK version inside the uv tool environment.
 *
 * `flapi-dev-mcp` 0.2.2 imports the v1 `mcp.server.fastmcp` module, which the
 * mcp 2.x SDK replaced with `mcp.server.mcpserver.MCPServer`; on 2.x the server
 * exits immediately with `ModuleNotFoundError`. Detecting it here turns an
 * opaque crash into an actionable message.
 * @param platform - a `process.platform` value.
 * @param env - environment supplying `UV_TOOL_DIR` and `XDG_DATA_HOME`.
 * @returns the installed major version, or `undefined` when it cannot be read.
 */
export function detectMcpSdkMajor(platform = process.platform, env = process.env) {
  const roots = [env.UV_TOOL_DIR, env.XDG_DATA_HOME && join(env.XDG_DATA_HOME, 'uv', 'tools'), join(homedir(), '.local', 'share', 'uv', 'tools')].filter(
    (root) => typeof root === 'string' && root !== '',
  )
  for (const root of roots) {
    let libDirs
    try {
      libDirs = readdirSync(join(root, UV_TOOL_NAME, 'lib'), { withFileTypes: true }).filter((entry) => entry.isDirectory())
    } catch {
      continue
    }
    for (const libDir of libDirs) {
      const sitePackages = join(root, UV_TOOL_NAME, 'lib', libDir.name, 'site-packages')
      let entries
      try {
        entries = readdirSync(sitePackages)
      } catch {
        continue
      }
      const match = entries.map((entry) => /^mcp-(\d+)\./.exec(entry)).find((found) => found !== null)
      if (match) return Number(match[1])
    }
  }
  return undefined
}

/**
 * The message a user sees when `flapi-dev-mcp` is missing or unusable.
 * @param options - the failure being reported.
 * @returns a multi-line, actionable diagnostic.
 */
function remedyMessage({ installed, sdkMajor }) {
  const lines = [`[dsh-mcp-flapi] FilmLight's FLAPI MCP Assistant is not usable from this DSH process.`]
  if (!installed) {
    lines.push(
      `  ${UV_TOOL_NAME} was not found on PATH or in uv's tool bin directory.`,
      `  Install it once (note the required mcp<2 pin):`,
      `    uv tool install --with "mcp<2" git+https://github.com/FilmLightAPI/flapi-dev-mcp`,
      `    flapi-dev-mcp init`,
      `  Or run the helper shipped with this bundle: npx dsh-mcp-flapi-setup`,
    )
  } else if (sdkMajor !== undefined && sdkMajor >= 2) {
    lines.push(
      `  ${UV_TOOL_NAME} is installed, but its environment has the mcp ${sdkMajor}.x SDK.`,
      `  Upstream imports the v1 API (mcp.server.fastmcp), which mcp 2.x removed, so the`,
      `  server exits on startup with ModuleNotFoundError. Reinstall with the pin:`,
      `    uv tool install --force --with "mcp<2" git+https://github.com/FilmLightAPI/flapi-dev-mcp`,
    )
  }
  lines.push(
    `  This plugin stays loaded without registering tools, so DSH keeps working.`,
    `  Verify the environment any time with: flapi-dev-mcp status`,
    '',
  )
  return lines.join('\n')
}

/**
 * Connect DSH to FilmLight's FLAPI MCP Assistant.
 *
 * Resolves the executable, warns when a known-broken mcp 2.x environment is
 * detected, then delegates to the stock MCP client. Failures are reported and
 * swallowed: a missing or broken FLAPI tool must not take the harness down.
 * @param ctx - plugin context carrying the tool registry.
 * @param config - optional overrides from the patch (`serverName`, `command`, `args`, timings…).
 * @returns startup work once the MCP connection and initial tool sync settle.
 */
export async function apply(ctx, config = {}) {
  const { serverName, command: explicitCommand, ...rest } = config ?? {}
  const command = resolveCommand(explicitCommand)
  const sdkMajor = command === undefined ? undefined : detectMcpSdkMajor()
  if (command === undefined || (sdkMajor !== undefined && sdkMajor >= 2)) {
    process.stderr.write(remedyMessage({ installed: command !== undefined, sdkMajor }))
    return
  }
  await mcpClient.apply(ctx, {
    transport: 'stdio',
    args: [],
    toolCallTimeoutMs: DEFAULT_TOOL_CALL_TIMEOUT_MS,
    ...rest,
    serverName: serverName ?? DEFAULT_SERVER_NAME,
    command,
  })
}
