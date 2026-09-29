/**
 * dsh-mcp-davinci-resolve — register DaVinci Resolve's built-in MCP server with DSH.
 *
 * DaVinci Resolve 21.1+ ships its own MCP server inside the application bundle.
 * The bundled `DaVinciResolve.mcpb` is only Claude Desktop's packaging format;
 * the binary it wraps speaks plain MCP over stdio, so any MCP client can use it.
 * This module finds that binary for the host platform and hands it to the stock
 * `@deepseek-ai/dsh-mcp-client`, which publishes its tools as
 * `mcp__<serverName>__<tool>`.
 *
 * @module dsh-mcp-davinci-resolve
 */
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'mcp-davinci-resolve'
/** Services this plugin needs, re-exported from the MCP client it drives. */
export const inject = mcpClient.inject

/** Default tool-server namespace; tools surface as `mcp__resolve__<tool>`. */
const DEFAULT_SERVER_NAME = 'resolve'
/** FLAPI-style slow tools (render/script execution) need more than the 60 s default. */
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 180_000

/**
 * Where Resolve installs its MCP binary, per platform.
 *
 * macOS and Linux paths are taken from the thin wrapper shipped inside Resolve's
 * own `DaVinciResolve.mcpb`; the Windows path is the same wrapper's default for
 * a standard installation.
 * @param platform - a `process.platform` value.
 * @param env - environment used for the Windows Program Files lookup.
 * @returns the platform's default binary path, or `undefined` when unknown.
 */
export function defaultCommand(platform = process.platform, env = process.env) {
  if (platform === 'darwin') {
    return '/Applications/DaVinci Resolve/DaVinci Resolve.app/Contents/Applications/ResolveMCP'
  }
  if (platform === 'win32') {
    const programFiles = env.ProgramFiles ?? env.PROGRAMFILES ?? 'C:\\Program Files'
    return join(programFiles, 'Blackmagic Design', 'DaVinci Resolve', 'ResolveMCP.exe')
  }
  if (platform === 'linux') return '/opt/resolve/bin/ResolveMCP'
  return undefined
}

/**
 * Resolve the MCP binary this host should run.
 *
 * Precedence: an explicit `command` from the patch, then `$RESOLVE_MCP_PATH`,
 * then the platform default. A candidate that does not exist is skipped, so a
 * stale environment variable cannot mask a working default.
 * @param explicit - `command` supplied through the patch config, if any.
 * @param platform - a `process.platform` value.
 * @param env - environment supplying the override and the Windows lookup.
 * @returns the first existing candidate, or `undefined` when none exists.
 */
export function resolveCommand(explicit, platform = process.platform, env = process.env) {
  const candidates = [explicit, env.RESOLVE_MCP_PATH, defaultCommand(platform, env)]
  return candidates.find((candidate) => typeof candidate === 'string' && candidate !== '' && existsSync(candidate))
}

/**
 * The message a user sees when Resolve's MCP binary cannot be found.
 * @param platform - a `process.platform` value.
 * @param env - environment used for the Windows Program Files lookup.
 * @returns a multi-line, actionable diagnostic.
 */
function missingBinaryMessage(platform, env) {
  const expected = defaultCommand(platform, env)
  return [
    `[dsh-mcp-davinci-resolve] DaVinci Resolve's MCP server was not found on this host.`,
    `  expected: ${expected ?? `(unknown platform: ${platform})`}`,
    `  It ships inside Resolve 21.1 or newer (Studio or free), at Contents/Applications/ResolveMCP.`,
    `  Install or update DaVinci Resolve, or point this plugin at the binary:`,
    `    - id: mcp-resolve`,
    `      name: dsh-mcp-davinci-resolve`,
    `      config: { command: /full/path/to/ResolveMCP }`,
    `  (or export RESOLVE_MCP_PATH=/full/path/to/ResolveMCP)`,
    `  The plugin stays loaded without registering tools, so DSH keeps working.`,
    '',
  ].join('\n')
}

/**
 * Connect DSH to Resolve's MCP server.
 *
 * Resolves the host-appropriate binary, then delegates to the stock MCP client.
 * When the binary is absent this logs a remedy and returns cleanly rather than
 * throwing: a missing DaVinci Resolve must not take the whole harness down.
 * @param ctx - plugin context carrying the tool registry.
 * @param config - optional overrides from the patch (`serverName`, `command`, `args`, timings…).
 * @returns startup work once the MCP connection and initial tool sync settle.
 */
export async function apply(ctx, config = {}) {
  const { serverName, command: explicitCommand, ...rest } = config ?? {}
  const command = resolveCommand(explicitCommand)
  if (command === undefined) {
    process.stderr.write(missingBinaryMessage(process.platform, process.env))
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
