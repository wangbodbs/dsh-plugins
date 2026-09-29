#!/usr/bin/env node
/**
 * dsh-mcp-flapi-setup — install (or repair) FilmLight's FLAPI MCP Assistant.
 *
 * Upstream publishes `flapi-dev-mcp` as a uv tool, not an npm package, so the
 * DSH bundle cannot pull it in as a dependency. This helper runs the exact
 * pinned sequence the bundle needs, then probes the result.
 *
 *   npx dsh-mcp-flapi-setup
 *
 * Why the pin: upstream declares `mcp>=1.2.0` with no upper bound, so a plain
 * install resolves the mcp 2.x SDK, where `mcp.server.fastmcp` no longer exists
 * (it became `mcp.server.mcpserver.MCPServer`). flapi-dev-mcp 0.2.2 still imports
 * the v1 path and dies on startup. `--with "mcp<2"` keeps it on the 1.x line.
 */
import { spawnSync } from 'node:child_process'

const PACKAGE = 'git+https://github.com/FilmLightAPI/flapi-dev-mcp'
const CONSTRAINT = 'mcp<2'
const TOOL = 'flapi-dev-mcp'

/** Run a command with inherited stdio, resolving `.cmd` shims on Windows. */
function run(command, args, { optional = false } = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error?.code === 'ENOENT' && optional) return 127
  if (result.error) {
    process.stderr.write(`dsh-mcp-flapi-setup: cannot run ${command}: ${result.error.message}\n`)
    return 127
  }
  return result.status ?? 1
}

process.stdout.write(`dsh-mcp-flapi-setup: installing ${TOOL} with the ${CONSTRAINT} pin\n`)

if (run('uv', ['--version'], { optional: true }) !== 0) {
  process.stderr.write(
    [
      '',
      'dsh-mcp-flapi-setup: uv is required and was not found.',
      '  macOS:  brew install uv',
      '  other:  curl -LsSf https://astral.sh/uv/install.sh | sh',
      '',
    ].join('\n'),
  )
  process.exit(1)
}

const installStatus = run('uv', ['tool', 'install', '--force', '--with', CONSTRAINT, PACKAGE])
if (installStatus !== 0) {
  process.stderr.write('dsh-mcp-flapi-setup: uv tool install failed; nothing was changed.\n')
  process.exit(installStatus)
}

// `init` discovers the local Baselight/Daylight builds and writes ~/.flapi-dev-mcp/config.json.
// It is safe to re-run; it is also the step that reports an unusable install.
if (run(TOOL, ['init']) !== 0) {
  process.stderr.write('dsh-mcp-flapi-setup: flapi-dev-mcp init failed (see output above).\n')
  process.exit(1)
}

process.stdout.write('\ndsh-mcp-flapi-setup: environment report\n')
run(TOOL, ['status'])

process.stdout.write(
  [
    '',
    'dsh-mcp-flapi-setup: done.',
    '  Restart or reload DSH, then check that the tools appear as mcp__flapi__*.',
    '  In a running DSH session, editing the profile patch hot-reloads this plugin.',
    '',
  ].join('\n'),
)
