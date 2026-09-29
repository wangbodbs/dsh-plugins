/**
 * Where this plugin keeps its own files.
 *
 * Both the diagnostic log and the per-chat conversation pointer live under
 * DSH's state directory, so the resolution lives here once instead of being
 * copied into every module that writes something.
 *
 * @module dsh-feishu/paths
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The directory DSH keeps its state in: `$DSH_HOME` when the host set one,
 * otherwise `~/.dsh`.
 * @returns {string} an absolute directory path.
 */
export function dshHome() {
	const fromEnv = process.env.DSH_HOME
	if (typeof fromEnv === 'string' && fromEnv !== '') return fromEnv
	return join(homedir(), '.dsh')
}
