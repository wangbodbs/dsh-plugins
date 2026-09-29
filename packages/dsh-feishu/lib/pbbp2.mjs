/**
 * Hand-rolled protobuf wire codec for Feishu's `pbbp2.Frame` envelope.
 *
 * Feishu's long-connection (WebSocket) event channel frames every message in a
 * protobuf message called `pbbp2.Frame`. The official SDK gets this codec from
 * `protobufjs`, which drags a build-script dependency into the install and is
 * blocked by pnpm in this environment. The schema is tiny and fixed, so this
 * module implements exactly it — no dependencies.
 *
 * Schema, copied verbatim from the generated `protobufjs` static module inside
 * `@larksuiteoapi/node-sdk@1.74.0/lib/index.js`:
 *
 * ```proto
 * message Header {
 *   required string key   = 1;
 *   required string value = 2;
 * }
 * message Frame {
 *   required uint64 SeqID   = 1;
 *   required uint64 LogID   = 2;
 *   required int32  service = 3;
 *   required int32  method  = 4;
 *   repeated Header headers = 5;
 *   optional string payloadEncoding = 6;
 *   optional string payloadType     = 7;
 *   optional bytes  payload         = 8;
 *   optional string LogIDNew        = 9;
 * }
 * ```
 *
 * @module dsh-feishu/pbbp2
 */

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8')

/** Protobuf wire types. */
const WIRE_VARINT = 0
const WIRE_FIXED64 = 1
const WIRE_LENGTH = 2
const WIRE_FIXED32 = 5

/**
 * Encode a non-negative integer as protobuf base-128 varint bytes.
 * @param {number|bigint} value - a non-negative integer.
 * @returns {Uint8Array} the varint encoding.
 */
function varintBytes(value) {
  let rest = typeof value === 'bigint' ? value : BigInt(Math.trunc(Number(value)))
  if (rest < 0n) throw new RangeError(`varint cannot encode a negative value: ${String(value)}`)
  const out = []
  do {
    let byte = Number(rest & 0x7fn)
    rest >>= 7n
    if (rest > 0n) byte |= 0x80
    out.push(byte)
  } while (rest > 0n)
  return Uint8Array.from(out)
}

/**
 * Concatenate byte chunks into one buffer.
 * @param {Uint8Array[]} chunks - the pieces to join.
 * @returns {Uint8Array} the joined buffer.
 */
function concat(chunks) {
  let total = 0
  for (const chunk of chunks) total += chunk.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/**
 * Encode one `pbbp2.Header`.
 * @param {{key: string, value: string}} header - the header to encode.
 * @returns {Uint8Array} the encoded header.
 */
function encodeHeader(header) {
  return concat([
    varintBytes((1 << 3) | WIRE_LENGTH), varintBytes(encoder.encode(header.key).length), encoder.encode(header.key),
    varintBytes((2 << 3) | WIRE_LENGTH), varintBytes(encoder.encode(header.value).length), encoder.encode(header.value),
  ])
}

/**
 * Encode one `pbbp2.Frame` exactly as the official SDK does: all four required
 * scalar fields are always written, optional fields only when non-null.
 * @param {object} frame - the frame to encode.
 * @param {number|bigint} [frame.SeqID] - sequence id.
 * @param {number|bigint} [frame.LogID] - log id.
 * @param {number} [frame.service] - service id, taken from the connect URL.
 * @param {number} [frame.method] - `0` control, `1` data.
 * @param {{key: string, value: string}[]} [frame.headers] - frame headers.
 * @param {string} [frame.payloadEncoding] - payload encoding marker.
 * @param {string} [frame.payloadType] - payload type marker.
 * @param {Uint8Array} [frame.payload] - opaque payload bytes.
 * @param {string} [frame.LogIDNew] - newer log id field.
 * @returns {Uint8Array} the encoded frame, ready to send over the socket.
 */
export function encodeFrame(frame) {
  const chunks = []
  const scalar = (field, value) => {
    chunks.push(varintBytes((field << 3) | WIRE_VARINT), varintBytes(value))
  }
  const lengthDelimited = (field, bytes) => {
    chunks.push(varintBytes((field << 3) | WIRE_LENGTH), varintBytes(bytes.length), bytes)
  }

  scalar(1, frame.SeqID ?? 0)
  scalar(2, frame.LogID ?? 0)
  scalar(3, frame.service ?? 0)
  scalar(4, frame.method ?? 0)
  for (const header of frame.headers ?? []) lengthDelimited(5, encodeHeader(header))
  if (frame.payloadEncoding != null) lengthDelimited(6, encoder.encode(frame.payloadEncoding))
  if (frame.payloadType != null) lengthDelimited(7, encoder.encode(frame.payloadType))
  if (frame.payload != null) lengthDelimited(8, frame.payload)
  if (frame.LogIDNew != null) lengthDelimited(9, encoder.encode(frame.LogIDNew))
  return concat(chunks)
}

/** Cursor over a byte buffer for protobuf reading. */
class Reader {
  /** @param {Uint8Array} buf - the buffer to read. */
  constructor(buf) {
    this.buf = buf
    this.pos = 0
  }

  /** @returns {number} the number of unread bytes. */
  get remaining() {
    return this.buf.length - this.pos
  }

  /**
   * Read one base-128 varint.
   * @returns {bigint} the decoded value.
   */
  varint() {
    let result = 0n
    let shift = 0n
    for (;;) {
      if (this.pos >= this.buf.length) throw new RangeError('truncated varint')
      const byte = this.buf[this.pos++]
      result |= BigInt(byte & 0x7f) << shift
      if ((byte & 0x80) === 0) return result
      shift += 7n
      if (shift > 70n) throw new RangeError('varint overflows 64 bits')
    }
  }

  /**
   * Read a length-delimited field.
   * @returns {Uint8Array} a view over the field bytes.
   */
  bytes() {
    const length = Number(this.varint())
    const end = this.pos + length
    if (end > this.buf.length) throw new RangeError('truncated length-delimited field')
    const view = this.buf.subarray(this.pos, end)
    this.pos = end
    return view
  }

  /**
   * Skip a field of known wire type.
   * @param {number} wire - the field's wire type.
   */
  skip(wire) {
    switch (wire) {
      case WIRE_VARINT: this.varint(); break
      case WIRE_FIXED64: this.pos += 8; break
      case WIRE_LENGTH: this.bytes(); break
      case WIRE_FIXED32: this.pos += 4; break
      default: throw new RangeError(`unsupported protobuf wire type ${String(wire)}`)
    }
  }
}

/**
 * Decode one `pbbp2.Header`.
 * @param {Uint8Array} bytes - the encoded header.
 * @returns {{key: string, value: string}} the decoded header.
 */
function decodeHeader(bytes) {
  const reader = new Reader(bytes)
  const header = { key: '', value: '' }
  while (reader.remaining > 0) {
    const tag = Number(reader.varint())
    const field = tag >>> 3
    const wire = tag & 7
    if (field === 1 && wire === WIRE_LENGTH) header.key = decoder.decode(reader.bytes())
    else if (field === 2 && wire === WIRE_LENGTH) header.value = decoder.decode(reader.bytes())
    else reader.skip(wire)
  }
  return header
}

/**
 * Decode one `pbbp2.Frame`. `SeqID` and `LogID` are returned as `bigint` so a
 * 64-bit value survives a decode/re-encode round trip (an ACK echoes both).
 * @param {Uint8Array} bytes - the frame received from the socket.
 * @returns {object} the decoded frame.
 */
export function decodeFrame(bytes) {
  const reader = new Reader(bytes)
  /** @type {any} */
  const frame = { headers: [] }
  while (reader.remaining > 0) {
    const tag = Number(reader.varint())
    const field = tag >>> 3
    const wire = tag & 7
    switch (field) {
      case 1: frame.SeqID = reader.varint(); break
      case 2: frame.LogID = reader.varint(); break
      case 3: frame.service = Number(reader.varint()); break
      case 4: frame.method = Number(reader.varint()); break
      case 5: frame.headers.push(decodeHeader(reader.bytes())); break
      case 6: frame.payloadEncoding = decoder.decode(reader.bytes()); break
      case 7: frame.payloadType = decoder.decode(reader.bytes()); break
      case 8: frame.payload = reader.bytes(); break
      case 9: frame.LogIDNew = decoder.decode(reader.bytes()); break
      default: reader.skip(wire)
    }
  }
  return frame
}

/** Frame `method` values. */
export const FRAME_METHOD = { control: 0, data: 1 }

/** Well-known frame header keys. */
export const HEADER_KEY = {
  type: 'type',
  messageId: 'message_id',
  sum: 'sum',
  seq: 'seq',
  traceId: 'trace_id',
  bizRt: 'biz_rt',
}

/** Well-known frame `type` header values. */
export const MESSAGE_TYPE = { event: 'event', card: 'card', ping: 'ping', pong: 'pong' }

/**
 * Assemble a frame's headers into a plain lookup object.
 * @param {{key: string, value: string}[]} headers - frame headers.
 * @returns {Record<string, string>} header values keyed by name.
 */
export function headerMap(headers) {
  /** @type {Record<string, string>} */
  const map = {}
  for (const header of headers ?? []) map[header.key] = header.value
  return map
}

/**
 * Reassemble fragmented event payloads. Feishu splits a large event into
 * `sum` fragments sharing one `message_id`; they must all arrive before the
 * JSON payload can be parsed. Mirrors the SDK's `DataCache`, including its
 * validation of `sum`/`seq` (malformed metadata must not corrupt the buffer).
 */
export class FragmentCache {
  /** @param {number} [ttlMs] - how long an incomplete event may linger. */
  constructor(ttlMs = 10_000) {
    /** @type {Map<string, {parts: (Uint8Array|undefined)[], traceId: string, createdAt: number}>} */
    this.entries = new Map()
    this.ttlMs = ttlMs
  }

  /**
   * Add one fragment and return the parsed event once every fragment landed.
   * @param {object} fragment - one inbound data frame's metadata.
   * @param {string} fragment.messageId - id shared by all fragments of one event.
   * @param {number} fragment.sum - total fragment count.
   * @param {number} fragment.seq - this fragment's zero-based index.
   * @param {string} [fragment.traceId] - trace id, for diagnostics.
   * @param {Uint8Array} fragment.payload - this fragment's bytes.
   * @returns {object|null} the parsed event, or null while fragments are missing.
   */
  merge({ messageId, sum, seq, traceId, payload }) {
    if (!Number.isInteger(sum) || sum <= 0 || !Number.isInteger(seq) || seq < 0 || seq >= sum) {
      throw new RangeError(`invalid event fragment metadata (sum: ${String(sum)}, seq: ${String(seq)})`)
    }
    this.evictExpired()
    let entry = this.entries.get(messageId)
    if (entry === undefined) {
      entry = { parts: new Array(sum).fill(undefined), traceId: traceId ?? '', createdAt: Date.now() }
      this.entries.set(messageId, entry)
    } else if (sum !== entry.parts.length) {
      throw new RangeError(`fragment sum ${String(sum)} differs from first fragment's ${String(entry.parts.length)}`)
    }
    entry.parts[seq] = payload
    if (!entry.parts.every((part) => part !== undefined)) return null
    this.entries.delete(messageId)
    const merged = concat(/** @type {Uint8Array[]} */ (entry.parts))
    return JSON.parse(decoder.decode(merged))
  }

  /** Drop fragments that never completed, so a lost frame cannot leak memory. */
  evictExpired() {
    const now = Date.now()
    for (const [key, entry] of this.entries) {
      if (now - entry.createdAt > this.ttlMs) this.entries.delete(key)
    }
  }
}
