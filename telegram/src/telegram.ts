const API = "https://api.telegram.org"
const DEFAULT_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 256 * 1024
const MAX_RETRY_AFTER_SECONDS = 10
const MAX_BUTTON_CHARS = 64

export interface Button {
  text: string
  data?: string
  url?: string
}

export interface SendOptions {
  threadId?: number
  buttons?: Button[][]
  forceReply?: { placeholder?: string }
  signal?: AbortSignal
}

export interface Update {
  update_id: number
  message?: Message
  callback_query?: {
    id: string
    from: { id: number }
    data?: string
    message?: Message
  }
}

export interface Message {
  message_id: number
  message_thread_id?: number
  date?: number
  chat: { id: number }
  from?: { id: number; is_bot?: boolean }
  text?: string
  reply_to_message?: { message_id: number }
}

export class TelegramError extends Error {
  constructor(
    message: string,
    readonly code: "timeout" | "network" | "response" | "rejected" | "rate_limited" | "conflict",
    readonly status?: number,
    readonly description?: string,
    readonly retryAfter?: number,
  ) {
    super(message)
    this.name = "TelegramError"
  }

  get threadMissing(): boolean {
    return /thread not found|topic.*(closed|deleted|not found)/i.test(this.description ?? "")
  }

  get notModified(): boolean {
    return /message is not modified/i.test(this.description ?? "")
  }

  get parseFailed(): boolean {
    return /can't parse entities|unsupported start tag|can't find end/i.test(this.description ?? "")
  }
}

export class TelegramClient {
  constructor(
    private readonly token: string,
    readonly chatId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Bot ID is the token prefix; safe to persist and survives token rotation. */
  get botId(): string {
    return this.token.split(":")[0] ?? ""
  }

  async send(html: string, options: SendOptions = {}): Promise<number> {
    const body: Record<string, unknown> = {
      chat_id: this.chatId,
      text: html,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    }
    if (options.threadId !== undefined) body.message_thread_id = options.threadId
    if (options.buttons?.length) body.reply_markup = { inline_keyboard: keyboard(options.buttons) }
    else if (options.forceReply) {
      body.reply_markup = {
        force_reply: true,
        ...(options.forceReply.placeholder ? { input_field_placeholder: clip(options.forceReply.placeholder, 64) } : {}),
      }
    }
    const result = await this.callWithFallback("sendMessage", body, options.signal)
    if (typeof result?.message_id !== "number") throw new TelegramError("Telegram did not return a message ID.", "response")
    return result.message_id
  }

  async edit(messageId: number, html: string, buttons?: Button[][]): Promise<void> {
    try {
      await this.callWithFallback("editMessageText", {
        chat_id: this.chatId,
        message_id: messageId,
        text: html,
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
        reply_markup: { inline_keyboard: buttons ? keyboard(buttons) : [] },
      })
    } catch (error) {
      if (error instanceof TelegramError && error.notModified) return
      throw error
    }
  }

  async answerCallback(id: string, text?: string): Promise<void> {
    await this.call("answerCallbackQuery", { callback_query_id: id, ...(text ? { text: clip(text, 200) } : {}) })
  }

  async getUpdates(offset: number | undefined, timeoutSeconds: number, signal: AbortSignal): Promise<Update[]> {
    const result = await this.call(
      "getUpdates",
      { offset, timeout: timeoutSeconds, allowed_updates: ["message", "callback_query"] },
      signal,
      (timeoutSeconds + 10) * 1_000,
    )
    return Array.isArray(result) ? result : []
  }

  async getMe(signal?: AbortSignal): Promise<{ id: number; username?: string; has_topics_enabled?: boolean }> {
    return this.call("getMe", {}, signal)
  }

  async getChat(signal?: AbortSignal): Promise<{ id: number; type: string; is_forum?: boolean }> {
    return this.call("getChat", { chat_id: this.chatId }, signal)
  }

  async getWebhookUrl(signal?: AbortSignal): Promise<string> {
    const info = await this.call("getWebhookInfo", {}, signal)
    return typeof info?.url === "string" ? info.url : ""
  }

  async createTopic(name: string): Promise<number> {
    const result = await this.call("createForumTopic", { chat_id: this.chatId, name: clip(name, 128) })
    const id = result?.message_thread_id
    if (!Number.isSafeInteger(id) || id <= 0) throw new TelegramError("Telegram did not confirm the topic.", "response")
    return id
  }

  async renameTopic(threadId: number, name: string): Promise<void> {
    try {
      await this.call("editForumTopic", { chat_id: this.chatId, message_thread_id: threadId, name: clip(name, 128) })
    } catch (error) {
      if (error instanceof TelegramError && /TOPIC_NOT_MODIFIED/i.test(error.description ?? "")) return
      throw error
    }
  }

  /** HTML that Telegram cannot parse is retried once as plain text rather than dropped. */
  private async callWithFallback(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    try {
      return await this.call(method, body, signal)
    } catch (error) {
      if (!(error instanceof TelegramError) || !error.parseFailed) throw error
      const { parse_mode: _, ...plain } = body
      return this.call(method, { ...plain, text: stripHtml(String(body.text)) }, signal)
    }
  }

  async call(method: string, body: Record<string, unknown>, signal?: AbortSignal, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.request(method, body, signal, timeoutMs)
      } catch (error) {
        const retryable =
          error instanceof TelegramError &&
          error.code === "rate_limited" &&
          attempt === 0 &&
          (error.retryAfter ?? Infinity) <= MAX_RETRY_AFTER_SECONDS
        if (!retryable) throw error
        await sleep((error as TelegramError).retryAfter! * 1_000, signal)
      }
    }
  }

  private async request(method: string, body: Record<string, unknown>, signal: AbortSignal | undefined, timeoutMs: number): Promise<any> {
    signal?.throwIfAborted()
    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    let response: Response
    try {
      response = await this.fetchImpl(`${API}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: combined,
      })
    } catch {
      signal?.throwIfAborted()
      if (timeout.aborted) throw new TelegramError(`Telegram ${method} timed out.`, "timeout")
      throw new TelegramError(`Telegram ${method} could not reach the service.`, "network")
    }
    const text = await readBounded(response)
    let payload: any
    try {
      payload = text ? JSON.parse(text) : undefined
    } catch {
      throw new TelegramError(`Telegram ${method} returned invalid JSON.`, "response", response.status)
    }
    if (payload?.ok === true) return payload.result
    // Descriptions come from Telegram, never contain the token, and are useful for diagnosis.
    const description = typeof payload?.description === "string" ? payload.description : undefined
    const suffix = description ? `: ${description}` : ` (HTTP ${response.status})`
    if (response.status === 429) {
      throw new TelegramError(`Telegram rate-limited ${method}${suffix}`, "rate_limited", 429, description, payload?.parameters?.retry_after)
    }
    if (response.status === 409) throw new TelegramError(`Telegram ${method} conflict${suffix}`, "conflict", 409, description)
    throw new TelegramError(`Telegram rejected ${method}${suffix}`, "rejected", response.status, description)
  }
}

function keyboard(rows: Button[][]): unknown[][] {
  return rows
    .filter((row) => row.length > 0)
    .map((row) =>
      row.map((button) => ({
        text: clip(button.text.replace(/\s+/g, " ").trim() || "·", MAX_BUTTON_CHARS),
        ...(button.url ? { url: button.url } : { callback_data: button.data ?? "noop" }),
      })),
    )
}

async function readBounded(response: Response): Promise<string> {
  if (!response.body) return ""
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ""
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    size += chunk.value.byteLength
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel()
      throw new TelegramError("Telegram returned an oversized response.", "response", response.status)
    }
    text += decoder.decode(chunk.value, { stream: true })
  }
  return text + decoder.decode()
}

export function clip(value: string, limit: number): string {
  const characters = [...value]
  return characters.length <= limit ? value : `${characters.slice(0, Math.max(0, limit - 1)).join("")}…`
}

export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}
