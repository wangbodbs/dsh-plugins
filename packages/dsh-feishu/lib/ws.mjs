/**
 * Minimal Feishu (Lark) long-connection client.
 *
 * Feishu's servers cannot reach a `127.0.0.1` host, so a self-built app on a
 * desktop machine receives events over Feishu's *long connection* channel: an
 * outbound WebSocket to `msg-frontier.feishu.cn` that the app opened itself.
 * That channel is protobuf-framed, so this module pairs with `./pbbp2.mjs`.
 *
 * The handshake and the framing rules below were transcribed from
 * `@larksuiteoapi/node-sdk@1.74.0` (`lib/index.js`, class `WSClient`). Going
 * dependency-free matters here: the official SDK pulls `protobufjs`, `ws` and
 * `axios` and needs a build script that pnpm blocks in this environment. Node
 * 22+ ships a global `WebSocket`, which is all this needs.
 *
 * @module dsh-feishu/ws
 */

import {
  FRAME_METHOD,
  HEADER_KEY,
  MESSAGE_TYPE,
  FragmentCache,
  decodeFrame,
  encodeFrame,
  headerMap,
} from './pbbp2.mjs'

/** Endpoint that trades app credentials for a WebSocket URL. */
const WS_ENDPOINT_PATH = '/callback/ws/endpoint'

/** HTTP status the server expects back inside an event acknowledgement. */
const ACK_OK = 200

/** How long endpoint discovery may take before it is abandoned. */
const DISCOVERY_TIMEOUT_MS = 15_000

/**
 * A no-op logger, used when the host passes none.
 * @type {{info: Function, warn: Function, error: Function, debug: Function}}
 */
const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
}

/**
 * Parse a query string into a plain object.
 * @param {string} url - a full URL.
 * @returns {Record<string, string>} decoded query parameters.
 */
function queryParams(url) {
  const parsed = new URL(url)
  /** @type {Record<string, string>} */
  const out = {}
  for (const [key, value] of parsed.searchParams) out[key] = value
  return out
}

/**
 * Normalize whatever a WebSocket delivered into bytes.
 * @param {unknown} data - the `message` event payload.
 * @returns {Promise<Uint8Array>} the frame bytes.
 */
async function toBytes(data) {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer())
  throw new TypeError(`unsupported WebSocket frame type: ${Object.prototype.toString.call(data)}`)
}

/**
 * A reconnecting Feishu long-connection client.
 *
 * Lifecycle: `start()` discovers the URL and connects; incoming
 * `im.message.receive_v1` (and any other subscribed) events are handed to
 * `onEvent`; `close()` stops the client permanently.
 */
export class FeishuLongConnection {
  /**
   * @param {object} options - client options.
   * @param {string} options.appId - self-built app id (`cli_...`).
   * @param {string} options.appSecret - the matching app secret.
   * @param {(event: object) => void | Promise<void>} options.onEvent - called with each event body (the `schema 2.0` envelope).
   * @param {(status: object) => void} [options.onStatus] - connection lifecycle notifications.
   * @param {string} [options.domain] - open-platform origin; defaults to Feishu's.
   * @param {object} [options.logger] - host logger (`ctx.logger`).
   */
  constructor({ appId, appSecret, onEvent, onStatus, domain = 'https://open.feishu.cn', logger }) {
    this.appId = appId
    this.appSecret = appSecret
    this.onEvent = onEvent
    this.onStatus = onStatus ?? (() => {})
    this.domain = domain.replace(/\/+$/, '')
    this.log = logger ?? silentLogger

    /** @type {WebSocket | null} */
    this.socket = null
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.pingTimer = null
    /** @type {ReturnType<typeof setTimeout> | null} */
    this.reconnectTimer = null
    this.fragments = new FragmentCache()
    this.closed = false
    this.started = false

    /** Server-supplied tuning, refreshed from each `pong`. */
    this.wsConfig = {
      connectUrl: '',
      serviceId: 0,
      pingIntervalMs: 90_000,
      reconnectCount: -1,
      reconnectIntervalMs: 90_000,
      reconnectNonceMs: 25_000,
    }
    this.attempts = 0
  }

  /**
   * Discover the WebSocket URL and begin connecting. Safe to call once; later
   * calls are ignored until `close()`.
   */
  start() {
    if (this.started) return
    this.started = true
    this.closed = false
    void this.#connectLoop()
  }

  /** Stop permanently: no further reconnects, sockets and timers released. */
  close() {
    this.closed = true
    this.#clearTimers()
    const socket = this.socket
    this.socket = null
    if (socket !== null) {
      try {
        socket.close()
      } catch {
        // A socket already torn down by the peer throws on close; nothing to do.
      }
    }
    this.onStatus({ state: 'closed' })
  }

  /** @returns {{state: string, attempts: number, serviceId: number}} a status snapshot. */
  status() {
    return {
      state: this.socket?.readyState === 1 ? 'connected' : 'disconnected',
      attempts: this.attempts,
      serviceId: this.wsConfig.serviceId,
    }
  }

  /** Clear both timers. */
  #clearTimers() {
    if (this.pingTimer !== null) {
      clearTimeout(this.pingTimer)
      this.pingTimer = null
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  /**
   * Trade credentials for a connection URL.
   * @returns {Promise<boolean>} true when the client may connect.
   */
  async #discover() {
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, DISCOVERY_TIMEOUT_MS)
    try {
      const response = await fetch(`${this.domain}${WS_ENDPOINT_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8', locale: 'zh' },
        body: JSON.stringify({ AppID: this.appId, AppSecret: this.appSecret }),
        signal: controller.signal,
      })
      const payload = await response.json()
      if (payload?.code !== 0) {
        // A non-zero code here is a configuration problem (long connection not
        // enabled for the app, bad credentials), not a transient outage:
        // retrying forever would only hide it.
        this.log.warn?.(`[dsh-feishu] 长连接握手失败 code=${String(payload?.code)} msg=${String(payload?.msg)}`)
        this.onStatus({ state: 'discovery-failed', code: payload?.code, msg: payload?.msg })
        return false
      }
      const { URL: url, ClientConfig: config } = payload.data ?? {}
      if (typeof url !== 'string' || url === '') {
        this.log.warn?.('[dsh-feishu] 长连接握手返回了空 URL')
        this.onStatus({ state: 'discovery-failed', msg: 'empty URL' })
        return false
      }
      const params = queryParams(url)
      this.wsConfig.connectUrl = url
      this.wsConfig.serviceId = Number(params.service_id ?? 0)
      if (config != null) {
        this.wsConfig.pingIntervalMs = Number(config.PingInterval ?? 90) * 1000
        this.wsConfig.reconnectCount = Number(config.ReconnectCount ?? -1)
        this.wsConfig.reconnectIntervalMs = Number(config.ReconnectInterval ?? 90) * 1000
        this.wsConfig.reconnectNonceMs = Number(config.ReconnectNonce ?? 25) * 1000
      }
      return true
    } catch (error) {
      this.log.warn?.(`[dsh-feishu] 长连接握手请求异常: ${error instanceof Error ? error.message : String(error)}`)
      this.onStatus({ state: 'discovery-error', error })
      return true // Transient: a network blip should be retried.
    } finally {
      clearTimeout(timer)
    }
  }

  /** Discover, connect, and keep the connection alive until `close()`. */
  async #connectLoop() {
    while (!this.closed) {
      const usable = await this.#discover()
      if (this.closed) return
      if (usable) {
        const connected = await this.#connect()
        if (connected) {
          this.attempts = 0
          return // Event handlers own the lifecycle from here.
        }
      }
      if (this.closed) return
      this.attempts += 1
      const limit = this.wsConfig.reconnectCount
      if (limit >= 0 && this.attempts > limit) {
        this.log.error?.(`[dsh-feishu] 长连接重连 ${String(this.attempts)} 次后放弃`)
        this.onStatus({ state: 'failed', attempts: this.attempts })
        return
      }
      await this.#sleepBeforeReconnect()
    }
  }

  /** @returns {Promise<boolean>} whether the socket opened. */
  #connect() {
    return new Promise((resolve) => {
      let settled = false
      /** @type {WebSocket} */
      let socket
      try {
        socket = new WebSocket(this.wsConfig.connectUrl)
      } catch (error) {
        this.log.warn?.(`[dsh-feishu] 创建 WebSocket 失败: ${error instanceof Error ? error.message : String(error)}`)
        resolve(false)
        return
      }
      socket.binaryType = 'arraybuffer'
      this.socket = socket

      const settle = (ok) => {
        if (settled) return
        settled = true
        resolve(ok)
      }
      // A socket that never opens must not hang the loop forever.
      const openTimeout = setTimeout(() => {
        if (!settled) {
          try {
            socket.close()
          } catch {
            // Ignore: we are abandoning this socket anyway.
          }
          settle(false)
        }
      }, 20_000)

      socket.addEventListener('open', () => {
        clearTimeout(openTimeout)
        this.log.info?.(`[dsh-feishu] 长连接已建立 (service_id=${String(this.wsConfig.serviceId)})`)
        this.onStatus({ state: 'connected', serviceId: this.wsConfig.serviceId })
        this.#schedulePing()
        settle(true)
      })

      socket.addEventListener('message', (message) => {
        void this.#onFrame(message.data)
      })

      socket.addEventListener('close', () => {
        clearTimeout(openTimeout)
        if (this.socket === socket) this.socket = null
        this.#clearTimers()
        if (this.closed) return
        if (settled) {
          this.log.warn?.('[dsh-feishu] 长连接断开，准备重连')
          this.onStatus({ state: 'disconnected' })
          void this.#reconnect()
        } else {
          settle(false)
        }
      })

      socket.addEventListener('error', () => {
        // The close event that follows carries the actual retry decision; log
        // once here so a failed dial is not silent.
        this.log.debug?.('[dsh-feishu] 长连接 socket 报错')
      })
    })
  }

  /** Re-enter the connect loop after an established connection dropped. */
  async #reconnect() {
    if (this.closed) return
    await this.#sleepBeforeReconnect()
    if (this.closed) return
    void this.#connectLoop()
  }

  /** Wait the server-specified reconnect delay plus jitter. */
  async #sleepBeforeReconnect() {
    const base = this.wsConfig.reconnectIntervalMs
    const jitter = Math.random() * this.wsConfig.reconnectNonceMs
    const delay = Math.max(1_000, base + jitter)
    this.log.debug?.(`[dsh-feishu] ${String(Math.round(delay / 1000))}s 后重连`)
    await new Promise((resolve) => {
      this.reconnectTimer = setTimeout(resolve, delay)
    })
  }

  /**
   * Send a keep-alive control frame and re-arm itself. The first ping goes out
   * immediately on connect (matching the official SDK's `pingLoop`), which also
   * makes the server answer with a `pong` right away — a fast, decisive check
   * that the channel is bidirectional rather than merely open.
   */
  #schedulePing() {
    if (this.closed) return
    this.#send(encodeFrame({
      headers: [{ key: HEADER_KEY.type, value: MESSAGE_TYPE.ping }],
      service: this.wsConfig.serviceId,
      method: FRAME_METHOD.control,
      SeqID: 0,
      LogID: 0,
    }))
    this.pingTimer = setTimeout(() => { this.#schedulePing() }, this.wsConfig.pingIntervalMs)
  }

  /**
   * Write raw bytes to the socket when it is open.
   * @param {Uint8Array} bytes - the encoded frame.
   */
  #send(bytes) {
    const socket = this.socket
    if (socket === null || socket.readyState !== 1) return
    try {
      socket.send(bytes)
    } catch (error) {
      this.log.warn?.(`[dsh-feishu] 发送帧失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Route one inbound frame: control frames tune the connection, data frames
   * carry events.
   * @param {unknown} raw - the WebSocket message payload.
   */
  async #onFrame(raw) {
    let frame
    try {
      frame = decodeFrame(await toBytes(raw))
    } catch (error) {
      // A frame we cannot parse must never take the host down.
      this.log.warn?.(`[dsh-feishu] 无法解析入站帧: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    const headers = headerMap(frame.headers)

    // Frame-level trace. Diagnosing "no events arrive" needs to distinguish
    // "the socket is silent" from "the socket is busy but no event frames" from
    // "event frames arrive and we mishandle them" — this line separates them.
    this.log.debug?.(
      `[dsh-feishu] 入站帧 method=${String(frame.method)} type=${headers[HEADER_KEY.type] ?? '-'} ` +
      `headers=${JSON.stringify(headers)}`,
    )

    if (frame.method === FRAME_METHOD.control) {
      if (headers[HEADER_KEY.type] === MESSAGE_TYPE.pong && frame.payload != null) {
        this.#applyPong(frame.payload)
      }
      return
    }
    if (frame.method !== FRAME_METHOD.data) return
    if (headers[HEADER_KEY.type] !== MESSAGE_TYPE.event) return

    let merged
    try {
      merged = this.fragments.merge({
        messageId: headers[HEADER_KEY.messageId] ?? '',
        sum: Number(headers[HEADER_KEY.sum] ?? 1),
        seq: Number(headers[HEADER_KEY.seq] ?? 0),
        traceId: headers[HEADER_KEY.traceId],
        payload: frame.payload ?? new Uint8Array(0),
      })
    } catch (error) {
      this.log.warn?.(`[dsh-feishu] 事件分片合并失败: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    if (merged === null) return // More fragments still in flight.

    let result
    try {
      result = await this.onEvent(merged)
    } catch (error) {
      // Handled by the caller's own error path; swallow here so the socket's
      // message loop survives a bad event.
      this.log.error?.(`[dsh-feishu] 处理事件失败: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.#acknowledge(frame, result)
  }

  /**
   * Echo an event frame back — Feishu retries events that are not
   * acknowledged.
   *
   * The acknowledgement doubles as the **card-callback response**: when
   * `onEvent` returns a value, it is JSON-encoded and base64'd into `data`, and
   * Feishu uses it to show a toast and/or replace the card in place. That is
   * how the official SDK answers button clicks, and it is the only way an
   * interactive card gets its feedback.
   *
   * @param {object} frame - the fully merged inbound frame.
   * @param {unknown} [result] - the handler's card-callback response, if any.
   */
  #acknowledge(frame, result) {
    /** @type {{code: number, data?: string}} */
    const body = { code: ACK_OK }
    if (result !== undefined && result !== null) {
      // Node-only bundle: `Buffer` is always present on a supported runtime.
      body.data = Buffer.from(JSON.stringify(result), 'utf8').toString('base64')
    }
    this.#send(encodeFrame({
      ...frame,
      headers: [...(frame.headers ?? []), { key: HEADER_KEY.bizRt, value: '0' }],
      payload: new TextEncoder().encode(JSON.stringify(body)),
    }))
  }

  /**
   * Apply the connection tuning the server sends back in a pong.
   * @param {Uint8Array} payload - the pong's JSON body.
   */
  #applyPong(payload) {
    try {
      const pong = JSON.parse(new TextDecoder('utf-8').decode(payload))
      if (pong.PingInterval != null) this.wsConfig.pingIntervalMs = Number(pong.PingInterval) * 1000
      if (pong.ReconnectCount != null) this.wsConfig.reconnectCount = Number(pong.ReconnectCount)
      if (pong.ReconnectInterval != null) this.wsConfig.reconnectIntervalMs = Number(pong.ReconnectInterval) * 1000
      if (pong.ReconnectNonce != null) this.wsConfig.reconnectNonceMs = Number(pong.ReconnectNonce) * 1000
    } catch {
      this.log.debug?.('[dsh-feishu] pong 负载不是合法 JSON，忽略')
    }
  }
}
