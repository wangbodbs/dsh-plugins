/**
 * Feishu (Lark) OpenAPI client — the handful of endpoints this plugin needs,
 * on plain `fetch`. No SDK, no dependencies.
 *
 * @module dsh-feishu/api
 */

/** Origin of the Feishu open platform. */
export const DEFAULT_DOMAIN = 'https://open.feishu.cn'

/** Refresh the tenant token this long before it actually expires. */
const TOKEN_REFRESH_MARGIN_MS = 120_000

/** Longest a single API call may take. */
const REQUEST_TIMEOUT_MS = 20_000

/**
 * Feishu's cap for one `Range` chunk when downloading a resource of 100 MB or
 * more; the documented way to fetch something the plain download refuses.
 */
const CHUNK_BYTES = 32 * 1024 * 1024

/**
 * Largest image Feishu accepts on `/im/v1/images`. Anything bigger is refused
 * outright, and this client is dependency-free — it cannot resize a picture, so
 * the caller has to shrink it before handing it over.
 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/** Pushing a picture upstream is slower than a JSON call, so it gets its own budget. */
const UPLOAD_TIMEOUT_MS = 120_000

/**
 * An error carrying Feishu's own `code`/`msg` so callers can react to them.
 */
export class FeishuApiError extends Error {
  /**
   * @param {string} message - human-readable summary.
   * @param {object} [details] - structured context.
   * @param {number} [details.code] - Feishu error code.
   * @param {string} [details.path] - the endpoint that failed.
   * @param {number} [details.status] - HTTP status, when the call got that far.
   */
  constructor(message, { code, path, status } = {}) {
    super(message)
    this.name = 'FeishuApiError'
    this.code = code
    this.path = path
    this.status = status
  }
}

/**
 * Build the error a failed resource download throws.
 * @param {number} status - HTTP status.
 * @param {string} detail - the response body.
 * @param {string} path - the endpoint that failed.
 * @returns {FeishuApiError} the error, carrying Feishu's `code` when the body parsed.
 */
function resourceError(status, detail, path) {
	let code
	let message = detail
	try {
		const parsed = JSON.parse(detail)
		code = parsed?.code
		message = parsed?.msg ?? detail
	} catch {
		// Not JSON: keep the raw body as the message.
	}
	return new FeishuApiError(
		`resource download failed (HTTP ${String(status)}${code === undefined ? '' : `, code ${String(code)}`}): ${String(message).slice(0, 200)}`,
		{ code, path, status },
	)
}

/**
 * A thin client over the Feishu OpenAPI.
 */
export class FeishuApi {
  /**
   * @param {object} options - client options.
   * @param {string} options.appId - self-built app id (`cli_...`).
   * @param {string} options.appSecret - the matching app secret.
   * @param {string} [options.domain] - open-platform origin.
   * @param {object} [options.logger] - host logger.
   */
  constructor({ appId, appSecret, domain = DEFAULT_DOMAIN, logger }) {
    this.appId = appId
    this.appSecret = appSecret
    this.domain = domain.replace(/\/+$/, '')
    this.log = logger ?? { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
    /** @type {{token: string, expiresAt: number} | null} */
    this.cached = null
    /** @type {Promise<string> | null} */
    this.inflight = null
  }

  /**
   * A valid `tenant_access_token`, reusing a cached one while it is fresh.
   * Concurrent callers share one in-flight request.
   * @returns {Promise<string>} the bearer token.
   */
  async tenantToken() {
    const now = Date.now()
    if (this.cached !== null && this.cached.expiresAt > now) return this.cached.token
    if (this.inflight !== null) return this.inflight
    this.inflight = this.#fetchToken().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  /**
   * Exchange app credentials for a tenant access token.
   * @returns {Promise<string>} the bearer token.
   */
  async #fetchToken() {
    const payload = await this.#request('POST', '/open-apis/auth/v3/tenant_access_token/internal', {
      body: { app_id: this.appId, app_secret: this.appSecret },
      authenticated: false,
    })
    const token = payload?.tenant_access_token
    if (typeof token !== 'string' || token === '') {
      throw new FeishuApiError('飞书未返回 tenant_access_token', { code: payload?.code, path: 'tenant_access_token' })
    }
    const expiresIn = Number(payload?.expire ?? 7200) * 1000
    this.cached = { token, expiresAt: Date.now() + Math.max(60_000, expiresIn - TOKEN_REFRESH_MARGIN_MS) }
    return token
  }

  /** Forget the cached token (used after an auth failure). */
  invalidateToken() {
    this.cached = null
  }

  /**
   * Send a text message to a chat or a user.
   * @param {object} options - the message to send.
   * @param {'chat_id'|'open_id'|'user_id'|'union_id'|'email'} options.receiveIdType - how to interpret `receiveId`.
   * @param {string} options.receiveId - the destination id.
   * @param {string} options.text - the message body.
   * @returns {Promise<{messageId: string, chatId: string}>} the created message.
   */
  async sendText({ receiveIdType, receiveId, text }) {
    return this.#sendMessage({ receiveIdType, receiveId, msgType: 'text', content: { text } })
  }

  /**
   * Send an interactive card (`msg_type: interactive`).
   *
   * The card's buttons carry a `value` object that Feishu hands back verbatim
   * in the `card.action.trigger` callback, which is what makes a card a
   * self-contained control surface.
   *
   * @param {object} options - the card to send.
   * @param {'chat_id'|'open_id'|'user_id'|'union_id'|'email'} options.receiveIdType - how to interpret `receiveId`.
   * @param {string} options.receiveId - the destination id.
   * @param {object} options.card - the card 1.0 JSON object.
   * @returns {Promise<{messageId: string, chatId: string}>} the created message.
   */
  async sendCard({ receiveIdType, receiveId, card }) {
    return this.#sendMessage({ receiveIdType, receiveId, msgType: 'interactive', content: card })
  }

  /**
   * Send an image message (`msg_type: image`).
   *
   * @param {object} options - the image message.
   * @param {'chat_id'|'open_id'|'user_id'|'union_id'|'email'} options.receiveIdType - how to interpret `receiveId`.
   * @param {string} options.receiveId - the destination id.
   * @param {string} options.imageKey - an `image_key` from {@link FeishuApi#uploadImage}.
   * @returns {Promise<{messageId: string, chatId: string}>} the created message.
   */
  async sendImage({ receiveIdType, receiveId, imageKey }) {
    return this.#sendMessage({ receiveIdType, receiveId, msgType: 'image', content: { image_key: imageKey } })
  }

  /**
   * Upload one image and get back its `image_key`.
   *
   * Feishu wants `multipart/form-data` here, not the JSON envelope `#request`
   * speaks, so this is a hand-rolled call like the resource download. The
   * picture has to be under {@link MAX_IMAGE_BYTES}.
   *
   * @param {object} options - the upload.
   * @param {Buffer} options.bytes - the encoded image.
   * @param {string} options.fileName - name handed to Feishu; its extension picks the decoder.
   * @param {'message'|'avatar'} [options.imageType] - what the image is for.
   * @returns {Promise<string>} the `image_key` to send with.
   */
  async uploadImage({ bytes, fileName, imageType = 'message' }) {
    const path = '/open-apis/im/v1/images'
    const form = new FormData()
    form.append('image_type', imageType)
    form.append('image', new Blob([bytes]), fileName)

    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, UPLOAD_TIMEOUT_MS)
    let response
    try {
      response = await fetch(`${this.domain}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await this.tenantToken()}` },
        body: form,
        signal: controller.signal,
      })
    } catch (error) {
      throw new FeishuApiError(
        `图片上传失败: ${error instanceof Error ? error.message : String(error)}`,
        { path },
      )
    } finally {
      clearTimeout(timer)
    }

    let payload
    try {
      payload = await response.json()
    } catch {
      throw new FeishuApiError(`图片上传返回了非 JSON 响应 (HTTP ${String(response.status)})`, { path, status: response.status })
    }
    if (payload?.code !== 0) {
      throw new FeishuApiError(
        `图片上传失败: code=${String(payload?.code)} msg=${String(payload?.msg)}`,
        { code: payload?.code, path, status: response.status },
      )
    }
    const key = payload?.data?.image_key
    if (typeof key !== 'string' || key === '') {
      throw new FeishuApiError('飞书未返回 image_key', { code: payload?.code, path })
    }
    return key
  }

  /**
   * Resolve a Feishu **wiki** node to the object behind it.
   *
   * A wiki link names a *node*; the useful thing is its `obj_type`/`obj_token`
   * (a docx, a sheet, a file…). Wiki nodes are not Drive tokens — asking Drive
   * about them fails — so this hop is mandatory.
   *
   * @param {string} nodeToken - the token from a `/wiki/<token>` link.
   * @returns {Promise<{title: string, objType: string, objToken: string, spaceId: string, hasChild: boolean, nodeToken: string}>} the node.
   */
  async resolveWikiNode(nodeToken) {
    const payload = await this.#request('GET', '/open-apis/wiki/v2/spaces/get_node', {
      query: { token: nodeToken, obj_type: 'wiki' },
    })
    const node = payload?.data?.node ?? {}
    return {
      title: String(node.title ?? ''),
      objType: String(node.obj_type ?? ''),
      objToken: String(node.obj_token ?? ''),
      spaceId: String(node.space_id ?? ''),
      hasChild: node.has_child === true,
      nodeToken: String(node.node_token ?? nodeToken),
    }
  }

  /**
   * List the direct children of a wiki node (a wiki "folder").
   *
   * @param {object} options - the page.
   * @param {string} options.spaceId - the wiki space.
   * @param {string} options.parentNodeToken - the parent node.
   * @param {string} [options.pageToken] - continuation token.
   * @returns {Promise<{items: object[], nextPageToken?: string}>} one page of child nodes.
   */
  async listWikiNodes({ spaceId, parentNodeToken, pageToken }) {
    const payload = await this.#request('GET', `/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes`, {
      query: {
        parent_node_token: parentNodeToken,
        page_size: 50,
        ...(pageToken === undefined || pageToken === '' ? {} : { page_token: pageToken }),
      },
    })
    const next = payload?.data?.next_page_token
    return {
      items: payload?.data?.items ?? [],
      ...(typeof next === 'string' && next !== '' ? { nextPageToken: next } : {}),
    }
  }

  /**
   * Read a docx document as plain text.
   *
   * `raw_content` flattens the document to text, which is what a model needs.
   * Note it does **not** carry attachment bytes: a "save chat records" doc stores
   * an attachment as the literal text `[[文件]] name`.
   *
   * @param {string} documentId - the docx document id.
   * @returns {Promise<string>} the document's text.
   */
  async readDocxText(documentId) {
    const payload = await this.#request('GET', `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`)
    return String(payload?.data?.content ?? '')
  }

  /**
   * Read one message's own record (its body carries the resource keys).
   *
   * @param {string} messageId - the message.
   * @returns {Promise<object | undefined>} the message item, when it is visible.
   */
  async getMessage(messageId) {
    const payload = await this.#request('GET', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`)
    return payload?.data?.items?.[0]
  }

  /**
   * List a chat's (or a merged-message container's) messages, newest first.
   *
   * @param {object} options - the query.
   * @param {string} options.chatId - `oc_…` container.
   * @param {number} [options.pageSize] - how many to ask for.
   * @returns {Promise<object[]>} the message items.
   */
  async listChatMessages({ chatId, pageSize = 50 }) {
    const payload = await this.#request('GET', '/open-apis/im/v1/messages', {
      query: { container_id_type: 'chat', container_id: chatId, sort_type: 'ByCreateTimeDesc', page_size: pageSize },
    })
    return payload?.data?.items ?? []
  }

  /**
   * List one page of a Feishu Drive folder's children.
   *
   * @param {object} options - the page.
   * @param {string} options.folderToken - the folder (`fldcn…`, or the root token).
   * @param {string} [options.pageToken] - continuation token from a previous page.
   * @returns {Promise<{files: object[], nextPageToken?: string}>} one page.
   */
  async listDriveFiles({ folderToken, pageToken }) {
    const payload = await this.#request('GET', '/open-apis/drive/v1/files', {
      query: {
        folder_token: folderToken,
        page_size: 200,
        ...(pageToken === undefined || pageToken === '' ? {} : { page_token: pageToken }),
      },
    })
    const next = payload?.data?.next_page_token
    return {
      files: payload?.data?.files ?? [],
      ...(typeof next === 'string' && next !== '' ? { nextPageToken: next } : {}),
    }
  }

  /**
   * Download one Feishu Drive file.
   *
   * @param {object} options - the file.
   * @param {string} options.fileToken - the Drive file token.
   * @returns {Promise<Buffer>} its bytes.
   */
  async downloadDriveFile({ fileToken }) {
    const path = `/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}/download`
    const response = await fetch(`${this.domain}${path}`, {
      headers: { Authorization: `Bearer ${await this.tenantToken()}` },
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw resourceError(response.status, detail, path)
    }
    return Buffer.from(await response.arrayBuffer())
  }

  /**
   * Download one attachment out of a message.
   *
   * A plain download is refused for a resource of 100 MB or more (`234037`), and
   * the documented way through that is `Range` chunks of at most 32 MB, appended
   * in order. `type=image` does not support Range at all, so images must be under
   * the limit.
   *
   * @param {object} options - the resource.
   * @param {string} options.messageId - the message owning the resource.
   * @param {string} options.fileKey - `file_key` / `image_key` from its content.
   * @param {'file'|'image'} options.type - which resource namespace to read.
   * @param {(received: number, total: number|undefined) => void} [options.onProgress] - called after every chunk.
   * @returns {Promise<{bytes: Buffer, chunked: boolean}>} the whole resource.
   * @throws {Error} with the Feishu `code` attached, so callers can explain the failure.
   */
  async downloadResource({ messageId, fileKey, type, onProgress }) {
    const path = `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/resources/${encodeURIComponent(fileKey)}?type=${type}`
    const token = await this.tenantToken()

    const probe = await fetch(`${this.domain}${path}`, { headers: { Authorization: `Bearer ${token}` } })
    if (probe.ok) return { bytes: Buffer.from(await probe.arrayBuffer()), chunked: false }

    const detail = await probe.text().catch(() => '')
    let code
    try { code = JSON.parse(detail)?.code } catch { /* not JSON */ }
    if (code !== 234037) throw resourceError(probe.status, detail, path)

    /** @type {Buffer[]} */
    const chunks = []
    let start = 0
    let total
    for (;;) {
      const end = start + CHUNK_BYTES - 1
      const response = await fetch(`${this.domain}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Range: `bytes=${start}-${end}` },
      })
      if (!response.ok && response.status !== 206) {
        const text = await response.text().catch(() => '')
        throw resourceError(response.status, text, path)
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length === 0) break
      chunks.push(bytes)
      start += bytes.length
      const range = response.headers.get('content-range')
      if (range !== null) {
        const parsed = Number(range.split('/')[1])
        if (Number.isFinite(parsed)) total = parsed
      }
      onProgress?.(start, total)
      if (total !== undefined && start >= total) break
      if (bytes.length < CHUNK_BYTES) break
    }
    return { bytes: Buffer.concat(chunks), chunked: true }
  }

  /**
   * Create one message of any type.
   * @param {object} options - the message.
   * @param {'chat_id'|'open_id'|'user_id'|'union_id'|'email'} options.receiveIdType - how to interpret `receiveId`.
   * @param {string} options.receiveId - the destination id.
   * @param {string} options.msgType - Feishu message type (`text`, `interactive`, ...).
   * @param {object} options.content - the message content object, serialized for Feishu.
   * @returns {Promise<{messageId: string, chatId: string}>} the created message.
   */
  async #sendMessage({ receiveIdType, receiveId, msgType, content }) {
    const payload = await this.#request('POST', '/open-apis/im/v1/messages', {
      query: { receive_id_type: receiveIdType },
      body: { receive_id: receiveId, msg_type: msgType, content: JSON.stringify(content) },
    })
    return {
      messageId: String(payload?.data?.message_id ?? ''),
      chatId: String(payload?.data?.chat_id ?? ''),
    }
  }

  /**
   * Reply inside the thread of an existing message.
   * @param {object} options - the reply.
   * @param {string} options.messageId - the message being replied to.
   * @param {string} options.text - the reply body.
   * @returns {Promise<{messageId: string}>} the created reply.
   */
  async replyText({ messageId, text }) {
    const payload = await this.#request('POST', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reply`, {
      body: { msg_type: 'text', content: JSON.stringify({ text }) },
    })
    return { messageId: String(payload?.data?.message_id ?? '') }
  }

  /**
   * Add a `reaction` emoji to a message — the cheapest possible "seen it" ack.
   * @param {object} options - the reaction.
   * @param {string} options.messageId - the target message.
   * @param {string} [options.emojiType] - Feishu emoji key; defaults to a thumbs-up.
   * @returns {Promise<void>} resolves once Feishu accepted it.
   */
  async addReaction({ messageId, emojiType = 'OnIt' }) {
    await this.#request('POST', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}/reactions`, {
      body: { reaction_type: { emoji_type: emojiType } },
    })
  }

  /**
   * List the group chats this app's bot belongs to. Used to discover a
   * `chat_id` without asking the user to copy one out of the console.
   * @returns {Promise<{chatId: string, name: string}[]>} the visible chats.
   */
  async listChats() {
    const payload = await this.#request('GET', '/open-apis/im/v1/chats', { query: { page_size: 100 } })
    const items = payload?.data?.items ?? []
    return items.map((item) => ({ chatId: String(item.chat_id ?? ''), name: String(item.name ?? '') }))
  }

  /**
   * Look up a single message by id — used to resolve a P2P chat id when all we
   * have is a message the user sent.
   * @param {string} messageId - the message id.
   * @returns {Promise<object>} Feishu's message record.
   */
  async getMessage(messageId) {
    const payload = await this.#request('GET', `/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`)
    return payload?.data?.items?.[0] ?? {}
  }

  /**
   * Call one OpenAPI endpoint and unwrap Feishu's `{code, msg, data}` envelope.
   * @param {'GET'|'POST'} method - HTTP method.
   * @param {string} path - endpoint path, starting with `/open-apis`.
   * @param {object} [options] - request options.
   * @param {Record<string, string|number>} [options.query] - query parameters.
   * @param {object} [options.body] - JSON request body.
   * @param {boolean} [options.authenticated] - whether to attach a tenant token.
   * @returns {Promise<any>} the response envelope.
   */
  async #request(method, path, { query, body, authenticated = true } = {}) {
    const url = new URL(`${this.domain}${path}`)
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value))

    /** @type {Record<string, string>} */
    const headers = { 'Content-Type': 'application/json; charset=utf-8' }
    if (authenticated) headers.Authorization = `Bearer ${await this.tenantToken()}`

    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, REQUEST_TIMEOUT_MS)
    let response
    try {
      response = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (error) {
      throw new FeishuApiError(`飞书接口不可达: ${error instanceof Error ? error.message : String(error)}`, { path })
    } finally {
      clearTimeout(timer)
    }

    let payload
    try {
      payload = await response.json()
    } catch {
      throw new FeishuApiError(`飞书接口返回了非 JSON 响应 (HTTP ${String(response.status)})`, { path, status: response.status })
    }

    if (payload?.code !== 0) {
      // 99991663/99991664 are "token invalid/expired": drop the cache so the
      // next call re-authenticates instead of failing forever.
      if (payload?.code === 99991663 || payload?.code === 99991664) this.invalidateToken()
      throw new FeishuApiError(
        `飞书接口 ${path} 失败: code=${String(payload?.code)} msg=${String(payload?.msg)}`,
        { code: payload?.code, path, status: response.status },
      )
    }
    return payload
  }
}

/**
 * Pull the plain text out of a Feishu message record.
 * @param {object} message - `event.message` from an inbound event.
 * @returns {string} the text, with mention placeholders removed.
 */
export function messageText(message) {
  if (typeof message?.content !== 'string') return ''
  try {
    const content = JSON.parse(message.content)
    if (typeof content?.text === 'string') return stripMentions(content.text)
    // Rich text / post messages nest their text under a title and paragraphs.
    if (typeof content?.title === 'string' || Array.isArray(content?.content)) return stripMentions(flattenPost(content))
    return ''
  } catch {
    return ''
  }
}

/**
 * Render a Feishu "post" (rich text) body as plain text.
 * @param {object} content - the parsed post content.
 * @returns {string} the flattened text.
 */
function flattenPost(content) {
  const lines = []
  if (typeof content.title === 'string' && content.title !== '') lines.push(content.title)
  for (const paragraph of content.content ?? []) {
    if (!Array.isArray(paragraph)) continue
    lines.push(paragraph.map((node) => (typeof node?.text === 'string' ? node.text : '')).join(''))
  }
  return lines.join('\n')
}

/**
 * Drop `@_user_1` style mention placeholders and collapse the spacing they leave.
 * @param {string} text - raw message text.
 * @returns {string} the cleaned text.
 */
function stripMentions(text) {
  return text.replace(/@_user_\d+/g, '').replace(/[ \t]{2,}/g, ' ').trim()
}
