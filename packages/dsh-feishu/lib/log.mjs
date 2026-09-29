/**
 * Plugin-side diagnostic log.
 *
 * DSH routes `ctx.logger` output to the GUI, not to stdout, which makes a
 * bridge like this one very hard to debug from a terminal. This tee writes the
 * same lines to `<DSH_HOME>/dsh-feishu.log` so the connection lifecycle and
 * every inbound/outbound message can be inspected after the fact.
 *
 * The file is bounded by rotation: when it passes `maxBytes` it is renamed to
 * `<name>.1` and a fresh file is started, so a long-running bridge cannot fill
 * the disk.
 *
 * @module dsh-feishu/log
 */

import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { dshHome } from './paths.mjs'

/** Log file is rotated once it grows past this. */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

/**
 * A logger that mirrors `ctx.logger` into a rotating file.
 */
export class FileLogger {
  /**
   * @param {string} [file] - explicit log path; defaults to `<DSH_HOME>/dsh-feishu.log`.
   * @param {number} [maxBytes] - rotate threshold.
   */
  constructor(file, maxBytes = DEFAULT_MAX_BYTES) {
    this.file = file ?? join(dshHome(), 'dsh-feishu.log')
    this.maxBytes = maxBytes
    this.broken = false
    try {
      mkdirSync(dirname(this.file), { recursive: true })
    } catch {
      // An unwritable log directory must never stop the bridge.
      this.broken = true
    }
  }

  /**
   * Append one line, rotating first when the file is oversized.
   * @param {string} level - `INFO` / `WARN` / `ERROR` / `DEBUG`.
   * @param {string} message - the line body.
   */
  write(level, message) {
    if (this.broken) return
    try {
      this.#rotateIfNeeded()
      appendFileSync(this.file, `${new Date().toISOString()} ${level} ${String(message)}\n`)
    } catch {
      this.broken = true
    }
  }

  /** Rename the log aside once it exceeds the threshold. */
  #rotateIfNeeded() {
    try {
      if (statSync(this.file).size < this.maxBytes) return
      renameSync(this.file, `${this.file}.1`)
    } catch {
      // Missing file (first write) or a failed rename: either way, keep going.
    }
  }

  /**
   * Wrap a host logger so every call is mirrored to the file.
   * @param {object} [hostLogger] - `ctx.logger`, if the host provided one.
   * @returns {object} a logger usable anywhere the host logger was.
   */
  tee(hostLogger) {
    const emit = (level, args) => {
      const text = args.map((value) => (typeof value === 'string' ? value : String(value))).join(' ')
      this.write(level, text)
    }
    const logger = {
      info: (...args) => { emit('INFO', args); hostLogger?.info?.(...args) },
      warn: (...args) => { emit('WARN', args); hostLogger?.warn?.(...args) },
      error: (...args) => { emit('ERROR', args); hostLogger?.error?.(...args) },
      debug: (...args) => { emit('DEBUG', args); hostLogger?.debug?.(...args) },
    }
    // `ctx.logger` is callable as well as record-like; keep both shapes working.
    return Object.assign((name) => logger, logger)
  }
}
