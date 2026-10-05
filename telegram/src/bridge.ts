import { readFile } from "node:fs/promises"
import { basename } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { loadConfig, statePath, updateConfigFile, writePrivateJson, type TelegramConfig } from "./config.ts"
import { FormWalker, type FormInfo } from "./forms.ts"
import { clean, escapeHtml, markdownExcerpt } from "./markdown.ts"
import { ServerApi, ServerApiError } from "./server-api.ts"
import { TelegramClient, TelegramError, clip, type Button, type Message, type Update } from "./telegram.ts"

type Context = Plugin.Context
type Decision = "once" | "always" | "reject"

interface SessionInfo {
  id: string
  parentID?: string
  title?: string
  agent?: string
  cost?: number
  location: { directory: string }
}

interface PermissionAsked {
  id: string
  sessionID: string
  action: string
  resources: string[]
  save?: string[]
  message?: string
}

interface Prompt {
  token: string
  kind: "form" | "permission"
  key: string
  sessionID: string
  id: string
  header: string
  threadId?: number
  messageId?: number
  /** Body currently shown in `messageId`, without the header. */
  body: string
  sentAt: number
  acceptsText: boolean
  walker?: FormWalker
  /** Set when this bridge answered the prompt, so the echo event is ignored. */
  settling?: boolean
}

interface TopicRecord {
  threadId: number
  name: string
  account: string
}

interface State {
  version: 1
  offset?: number
  topics: Record<string, TopicRecord>
}

const POLL_SECONDS = 25
const DECISION_LABEL: Record<Decision, string> = { once: "✅ Allowed once", always: "✅ Always allowed", reject: "⛔ Rejected" }

export class Bridge {
  private ctx?: Context
  private readonly hosts = new Set<Context>()
  private readonly listeners = new Set<() => void>()
  private config?: TelegramConfig
  private configError?: string
  private client?: TelegramClient
  private subscription?: AbortController
  private poller?: AbortController
  private pollError?: string
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly prompts = new Map<string, Prompt>()
  private readonly promptsByKey = new Map<string, Prompt>()
  private readonly turnStarted = new Map<string, number>()
  private readonly sessions = new Map<string, SessionInfo>()
  private readonly topicCreation = new Map<string, Promise<number | undefined>>()
  private topicsSupported?: Promise<boolean>
  private state: State = { version: 1, topics: {} }
  private stateWrite = Promise.resolve()
  private counter = 0
  private ready: Promise<void> = Promise.resolve()
  private stopped = false
  private readonly server: Pick<ServerApi, "formState" | "replyForm" | "cancelForm">
  private readonly fetchImpl?: typeof fetch

  constructor(options: { fetch?: typeof fetch; server?: Pick<ServerApi, "formState" | "replyForm" | "cancelForm"> } = {}) {
    this.fetchImpl = options.fetch
    this.server = options.server ?? new ServerApi()
  }

  /** Resolves once configuration and state are loaded (used by tests). */
  whenReady(): Promise<void> {
    return this.ready
  }

  get active(): boolean {
    return Boolean(this.config?.enabled && this.client)
  }

  attach(ctx: Context): void {
    this.hosts.add(ctx)
    if (this.ctx) return
    this.ctx = ctx
    this.ready = this.ready.then(() => this.loadAll(ctx.options))
    this.subscribe()
  }

  detach(ctx: Context): void {
    this.hosts.delete(ctx)
    if (this.ctx !== ctx) return
    this.subscription?.abort()
    this.ctx = this.hosts.values().next().value
    if (this.ctx) this.subscribe()
    else this.stop()
  }

  get empty(): boolean {
    return this.hosts.size === 0
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  stop(): void {
    this.stopped = true
    this.subscription?.abort()
    this.poller?.abort()
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  // ---- Commands (RPC / tool) ------------------------------------------------

  async status(): Promise<string> {
    await this.ready
    const lines = [`Config: ${(await loadConfig()).path}`]
    if (!this.config) return [...lines, `Not configured: ${this.configError}`].join("\n")
    lines.push(
      `Enabled: ${this.config.enabled ? "yes" : "no"}`,
      `Forward forms/permissions after: ${this.config.delayMinutes} min`,
      `Turn alerts: failures, and successes ≥ ${this.config.minTurnSeconds}s (${this.config.details})`,
    )
    try {
      const me = await this.client!.getMe()
      lines.push(`Bot: @${me.username ?? me.id}`)
      lines.push(`Topics: ${!this.config.topics ? "off" : (await this.supportsTopics()) ? "one per session" : "unavailable (General chat)"}`)
      if (await this.client!.getWebhookUrl()) lines.push("⚠️ A webhook is set; replies cannot be received while it exists.")
    } catch (error) {
      lines.push(`⚠️ Telegram: ${message(error)}`)
    }
    lines.push(`Waiting in Telegram: ${this.prompts.size} · scheduled: ${this.timers.size}`)
    lines.push(`Reply polling: ${this.poller ? "running" : "idle"}${this.pollError ? ` (last error: ${this.pollError})` : ""}`)
    return lines.join("\n")
  }

  async test(): Promise<string> {
    await this.ready
    if (!this.config || !this.client) return `Not configured: ${this.configError}`
    await this.client.send("✅ <b>OpenCode</b> is connected to this chat.")
    return "Test message sent."
  }

  async reload(): Promise<string> {
    // Bot settings such as topics can change in BotFather without a new token.
    this.topicsSupported = undefined
    await this.loadAll(this.ctx?.options ?? {})
    return this.config ? `Reloaded (${this.config.enabled ? "enabled" : "disabled"}).` : `Not configured: ${this.configError}`
  }

  async setEnabled(enabled: boolean): Promise<string> {
    await updateConfigFile({ enabled })
    await this.loadAll(this.ctx?.options ?? {})
    if (!enabled) this.clearPending()
    return this.config ? `Telegram ${enabled ? "enabled" : "disabled"}.` : `Not configured: ${this.configError}`
  }

  async setDelay(minutes: number): Promise<string> {
    await updateConfigFile({ delayMinutes: minutes })
    await this.loadAll(this.ctx?.options ?? {})
    return `Forms and permissions are forwarded after ${minutes} min.`
  }

  /** Send Markdown to the session's topic (or General without a session). */
  async notify(sessionID: string | undefined, markdown: string): Promise<string> {
    await this.ready
    if (!this.active) throw new Error(this.config ? "Telegram is disabled (/telegram on)." : `Telegram is not configured: ${this.configError}`)
    if (!clean(markdown)) throw new Error("The message is empty.")
    const html = markdownExcerpt(markdown, 3_800)
    if (sessionID) await this.post(sessionID, html)
    else await this.client!.send(html)
    return "Sent to Telegram."
  }

  // ---- Lifecycle --------------------------------------------------------------

  private async loadAll(options: Record<string, unknown>): Promise<void> {
    const result = await loadConfig(process.env, options)
    const previous = this.config
    this.config = result.ok ? result.config : undefined
    this.configError = result.ok ? undefined : result.error
    const sameAccount = previous && this.config && previous.botToken === this.config.botToken && previous.chatId === this.config.chatId
    if (!sameAccount) {
      this.poller?.abort()
      this.topicsSupported = undefined
      this.client = this.config ? new TelegramClient(this.config.botToken, this.config.chatId, this.fetchImpl) : undefined
    }
    if (!result.ok) warn(result.error)
    await this.loadState()
    for (const listener of this.listeners) listener()
  }

  private async loadState(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(statePath(), "utf8"))
      if (raw?.version === 1 && raw.topics && typeof raw.topics === "object") this.state = raw
    } catch {}
  }

  private saveState(): void {
    const snapshot = structuredClone(this.state)
    this.stateWrite = this.stateWrite.then(() => writePrivateJson(statePath(), snapshot)).catch((error) => warn(`state: ${message(error)}`))
  }

  private subscribe(): void {
    const ctx = this.ctx
    if (!ctx) return
    const controller = new AbortController()
    this.subscription = controller
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            void this.handle(event as unknown as { type: string; created?: number; data: any }).catch((error) => warn(`${(event as any).type}: ${message(error)}`))
          }
        } catch (error) {
          if (controller.signal.aborted) return
          warn(`event stream: ${message(error)}`)
        }
        await sleep(2_000, controller.signal).catch(() => {})
      }
    })()
  }

  private async handle(event: { type: string; created?: number; data: any }): Promise<void> {
    switch (event.type) {
      case "session.execution.started":
        this.turnStarted.set(event.data.sessionID, event.created ?? Date.now())
        return
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted": {
        const started = this.turnStarted.get(event.data.sessionID)
        this.turnStarted.delete(event.data.sessionID)
        await this.ready
        if (!this.active || event.type === "session.execution.interrupted") return
        await this.turnAlert(event.data.sessionID, event.type === "session.execution.failed" ? event.data.error : undefined, started, event.created)
        return
      }
      case "session.renamed":
        await this.renamed(event.data.sessionID, event.data.title)
        return
      case "session.deleted":
        this.sessions.delete(event.data.sessionID)
        this.turnStarted.delete(event.data.sessionID)
        return
      case "form.created": {
        const form = event.data.form as FormInfo
        this.schedule(`form:${form.id}`, () => this.forwardForm(form))
        return
      }
      case "form.replied":
        await this.settle(`form:${event.data.id}`, "✔️ Answered in OpenCode")
        return
      case "form.cancelled":
        await this.settle(`form:${event.data.id}`, "✖ Cancelled")
        return
      case "permission.asked": {
        const request = event.data as PermissionAsked
        this.schedule(`permission:${request.id}`, () => this.forwardPermission(request))
        return
      }
      case "permission.replied":
        await this.settle(`permission:${event.data.requestID}`, `✔️ Answered in OpenCode: ${event.data.reply}`)
        return
    }
  }

  // ---- Forms & permissions ----------------------------------------------------

  private schedule(key: string, forward: () => Promise<void>): void {
    void this.ready.then(() => {
      if (!this.active || this.stopped || this.timers.has(key) || this.promptsByKey.has(key)) return
      const run = () => {
        this.timers.delete(key)
        forward().catch((error) => warn(`forward ${key}: ${message(error)}`))
      }
      this.timers.set(key, setTimeout(run, this.config!.delayMinutes * 60_000))
    })
  }

  private clearPending(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.prompts.clear()
    this.promptsByKey.clear()
    this.poller?.abort()
  }

  private async settle(key: string, note: string): Promise<void> {
    const timer = this.timers.get(key)
    if (timer) clearTimeout(timer)
    this.timers.delete(key)
    const prompt = this.promptsByKey.get(key)
    if (!prompt) return
    this.forget(prompt)
    if (prompt.settling || !prompt.messageId) return
    await this.client?.edit(prompt.messageId, `${prompt.header}\n\n${prompt.body}\n\n<i>${escapeHtml(note)}</i>`).catch(() => {})
  }

  private async forwardForm(form: FormInfo): Promise<void> {
    if (!this.active) return
    const state = await this.server.formState(form.sessionID, form.id)
    if (state.status !== "pending") return
    const walker = new FormWalker(form)
    const header = await this.header(form.sessionID, `❓ <b>${escapeHtml(form.title || "Question")}</b>`)
    if (!walker.answerable) {
      const links: Button[][] = form.fields.flatMap((field) => (field.type === "external" ? [[{ text: field.title || "Open", url: field.url }]] : []))
      const body = "This needs a browser step. Finish it from the link or in OpenCode."
      const sent = await this.post(form.sessionID, `${header}\n\n${body}`, links)
      this.register({ kind: "form", key: `form:${form.id}`, sessionID: form.sessionID, id: form.id, header, body, acceptsText: false, ...sent })
      return
    }
    const prompt = this.register({ kind: "form", key: `form:${form.id}`, sessionID: form.sessionID, id: form.id, header, body: "", acceptsText: false, walker })
    try {
      await this.sendField(prompt)
    } catch (error) {
      this.forget(prompt)
      throw error
    }
  }

  private async forwardPermission(request: PermissionAsked): Promise<void> {
    if (!this.active || !this.ctx) return
    try {
      await this.ctx.permission.get({ sessionID: request.sessionID, requestID: request.id } as any)
    } catch {
      return
    }
    const header = await this.header(request.sessionID, `🔐 <b>Permission: ${escapeHtml(request.action)}</b>`)
    const resources = request.resources.filter(Boolean)
    const parts = []
    if (resources.length) parts.push(`<pre>${escapeHtml(clip(resources.join("\n"), 1_500))}</pre>`)
    if (request.message) parts.push(escapeHtml(clip(request.message, 800)))
    const body = parts.join("\n\n") || "<i>No details.</i>"
    const prompt = this.register({ kind: "permission", key: `permission:${request.id}`, sessionID: request.sessionID, id: request.id, header, body, acceptsText: false })
    const buttons: Button[][] = [
      [
        { text: "Allow once", data: `${prompt.token}:o` },
        ...(request.save?.length ? [{ text: "Always", data: `${prompt.token}:a` }] : []),
        { text: "Reject", data: `${prompt.token}:r` },
      ],
    ]
    try {
      Object.assign(prompt, await this.post(request.sessionID, `${header}\n\n${body}`, buttons), { sentAt: Date.now() })
    } catch (error) {
      this.forget(prompt)
      throw error
    }
  }

  private register(input: Omit<Prompt, "token" | "sentAt"> & Partial<Pick<Prompt, "sentAt">>): Prompt {
    const prompt: Prompt = { sentAt: Date.now(), ...input, token: (++this.counter).toString(36) }
    this.prompts.set(prompt.token, prompt)
    this.promptsByKey.set(prompt.key, prompt)
    this.ensurePolling()
    return prompt
  }

  private forget(prompt: Prompt): void {
    this.prompts.delete(prompt.token)
    if (this.promptsByKey.get(prompt.key) === prompt) this.promptsByKey.delete(prompt.key)
  }

  private async sendField(prompt: Prompt): Promise<void> {
    const view = prompt.walker!.view()
    prompt.body = view.html
    prompt.acceptsText = view.acceptsText
    const buttons = withToken(prompt.token, view.buttons)
    const sent = await this.post(prompt.sessionID, `${prompt.header}\n\n${view.html}`, buttons, prompt.threadId)
    Object.assign(prompt, sent, { sentAt: Date.now() })
  }

  private async rerenderField(prompt: Prompt): Promise<void> {
    const view = prompt.walker!.view()
    prompt.body = view.html
    await this.client!.edit(prompt.messageId!, `${prompt.header}\n\n${view.html}`, withToken(prompt.token, view.buttons))
  }

  /** Apply a button press or text reply to a form and move the conversation on. */
  private async step(prompt: Prompt, step: ReturnType<FormWalker["press"]>, answeredField: FormInfo["fields"][number] | undefined): Promise<string | undefined> {
    const walker = prompt.walker!
    switch (step.kind) {
      case "invalid":
        return step.message
      case "rerender":
        await this.rerenderField(prompt)
        return
      case "cancel":
        prompt.settling = true
        try {
          await this.server.cancelForm(prompt.sessionID, prompt.id, "Cancelled from Telegram")
        } catch (error) {
          prompt.settling = false
          return `Could not cancel: ${message(error)}`
        }
        this.forget(prompt)
        await this.client!.edit(prompt.messageId!, `${prompt.header}\n\n${prompt.body}\n\n<i>✖ Cancelled from Telegram</i>`)
        return
      case "next": {
        if (answeredField) {
          prompt.body = walker.answered(answeredField)
          await this.client!.edit(prompt.messageId!, `${prompt.header}\n\n${prompt.body}`)
        }
        if (!walker.done) {
          await this.sendField(prompt)
          return
        }
        prompt.settling = true
        try {
          await this.server.replyForm(prompt.sessionID, prompt.id, walker.answer)
        } catch (error) {
          prompt.settling = false
          this.forget(prompt)
          const reason = error instanceof ServerApiError && error.status === 404 ? "it is no longer pending" : message(error)
          await this.post(prompt.sessionID, `⚠️ OpenCode did not accept the answer: ${escapeHtml(reason)}\nAnswer it in OpenCode instead.`, undefined, prompt.threadId)
          return
        }
        this.forget(prompt)
        await this.client!.edit(prompt.messageId!, `${prompt.header}\n\n${prompt.body}\n\n<i>📨 Sent to OpenCode</i>`)
        return
      }
    }
  }

  private async replyPermission(prompt: Prompt, decision: Decision): Promise<string | undefined> {
    prompt.settling = true
    try {
      await this.ctx!.permission.reply({ sessionID: prompt.sessionID, requestID: prompt.id, decision } as any)
    } catch (error) {
      prompt.settling = false
      return `Could not reply: ${message(error)}`
    }
    this.forget(prompt)
    await this.client!.edit(prompt.messageId!, `${prompt.header}\n\n${prompt.body}\n\n<i>${DECISION_LABEL[decision]} from Telegram</i>`)
    return
  }

  // ---- Telegram updates -----------------------------------------------------------

  private ensurePolling(): void {
    if (this.poller || !this.client || this.stopped) return
    const controller = new AbortController()
    const client = this.client
    this.poller = controller
    void (async () => {
      let failures = 0
      while (!controller.signal.aborted && this.prompts.size > 0) {
        let updates: Update[]
        try {
          updates = await client.getUpdates(this.state.offset, POLL_SECONDS, controller.signal)
          failures = 0
          this.pollError = undefined
        } catch (error) {
          if (controller.signal.aborted) break
          failures++
          this.pollError = message(error)
          if (failures === 1 || failures % 20 === 0) warn(`polling: ${this.pollError}`)
          await sleep(Math.min(30_000, 2_000 * failures), controller.signal).catch(() => {})
          continue
        }
        for (const update of updates) {
          this.state.offset = update.update_id + 1
          await this.update(update).catch((error) => warn(`update: ${message(error)}`))
        }
        if (updates.length) this.saveState()
      }
      if (this.poller === controller) this.poller = undefined
      // A prompt registered while the loop was exiting needs a fresh poller.
      if (!controller.signal.aborted && this.prompts.size > 0) this.ensurePolling()
    })()
  }

  private async update(update: Update): Promise<void> {
    const chatId = this.config?.chatId
    const query = update.callback_query
    if (query) {
      if (String(query.message?.chat.id) !== chatId) return
      const [token, action] = (query.data ?? "").split(":")
      const prompt = token ? this.prompts.get(token) : undefined
      if (!prompt || !action || prompt.messageId !== query.message?.message_id) {
        await this.client!.answerCallback(query.id, "This prompt is no longer active.")
        return
      }
      let notice: string | undefined
      if (prompt.kind === "permission") {
        const decision = ({ o: "once", a: "always", r: "reject" } as const)[action as "o" | "a" | "r"]
        notice = decision ? await this.replyPermission(prompt, decision) : "Unknown action."
      } else if (prompt.walker) {
        const field = prompt.walker.field
        notice = await this.step(prompt, prompt.walker.press(action), field)
      }
      await this.client!.answerCallback(query.id, notice)
      return
    }

    const msg = update.message
    if (!msg?.text || String(msg.chat.id) !== chatId || msg.from?.is_bot) return
    const prompt = this.textTarget(msg)
    if (!prompt?.walker) return
    const field = prompt.walker.field
    const notice = await this.step(prompt, prompt.walker.reply(msg.text), field)
    if (notice) await this.client!.send(`⚠️ ${escapeHtml(notice)}`, { threadId: msg.message_thread_id }).catch(() => {})
  }

  /** A reply to a prompt message, or the only text-accepting prompt in that topic. */
  private textTarget(msg: Message): Prompt | undefined {
    const replyTo = msg.reply_to_message?.message_id
    if (replyTo !== undefined) {
      const direct = [...this.prompts.values()].find((prompt) => prompt.messageId === replyTo)
      if (direct) return direct.acceptsText ? direct : undefined
    }
    const sentAt = (msg.date ?? 0) * 1_000
    const candidates = [...this.prompts.values()].filter(
      (prompt) => prompt.acceptsText && prompt.threadId === msg.message_thread_id && sentAt >= prompt.sentAt - 2_000,
    )
    return candidates.length === 1 ? candidates[0] : undefined
  }

  // ---- Turn alerts ------------------------------------------------------------------

  private async turnAlert(sessionID: string, error: { type?: string; message?: string } | undefined, startedAt: number | undefined, endedAt = Date.now()): Promise<void> {
    const session = await this.session(sessionID, true)
    if (!session || session.parentID) return
    const duration = startedAt === undefined ? undefined : endedAt - startedAt
    if (!error && (duration === undefined || duration < this.config!.minTurnSeconds * 1_000)) return

    const meta = [duration !== undefined ? formatDuration(duration) : undefined, session.cost ? `$${session.cost.toFixed(2)}` : undefined].filter(Boolean).join(" · ")
    const title = escapeHtml(sessionName(session))
    const lines = [`${error ? "❌" : "✅"} <b>${title}</b> ${error ? "failed" : "finished"}${meta ? ` · ${meta}` : ""}`]
    if (error) lines.push(`<pre>${escapeHtml(clip(error.message || error.type || "Unknown error", 800))}</pre>`)
    else if (this.config!.details === "summary") {
      const text = await this.lastAssistantText(sessionID).catch(() => undefined)
      if (text) lines.push(markdownExcerpt(text, 3_000))
    }
    await this.post(sessionID, lines.join("\n\n"))
  }

  private async lastAssistantText(sessionID: string): Promise<string | undefined> {
    const messages = (await this.ctx!.session.context({ sessionID } as any)) as unknown as Array<{ type: string; content?: Array<{ type: string; text?: string }> }>
    for (let index = messages.length - 1; index >= 0; index--) {
      const message = messages[index]!
      if (message.type !== "assistant") continue
      const text = (message.content ?? [])
        .filter((part) => part.type === "text" && part.text?.trim())
        .map((part) => part.text!)
        .join("\n\n")
      if (text.trim()) return text
    }
    return undefined
  }

  // ---- Sessions & topics ----------------------------------------------------------

  private async session(sessionID: string, fresh = false): Promise<SessionInfo | undefined> {
    if (!fresh && this.sessions.has(sessionID)) return this.sessions.get(sessionID)
    try {
      const result = (await this.ctx!.session.get({ sessionID } as any)) as any
      const info = (result?.data ?? result) as SessionInfo
      this.sessions.set(sessionID, info)
      return info
    } catch {
      return this.sessions.get(sessionID)
    }
  }

  private async root(sessionID: string): Promise<SessionInfo | undefined> {
    let current = await this.session(sessionID)
    for (let depth = 0; current?.parentID && depth < 8; depth++) {
      const parent = await this.session(current.parentID)
      if (!parent) break
      current = parent
    }
    return current
  }

  /** First line of every prompt: which session (in General) and which subagent. */
  private async header(sessionID: string, title: string): Promise<string> {
    const session = await this.session(sessionID)
    const root = await this.root(sessionID)
    const threadId = await this.thread(sessionID)
    const context: string[] = []
    if (threadId === undefined && root) context.push(escapeHtml(sessionName(root)))
    if (session && root && session.id !== root.id) context.push(`↳ ${escapeHtml(session.agent ?? "subagent")}: ${escapeHtml(session.title ?? session.id)}`)
    return context.length ? `${title}\n<i>${context.join("\n")}</i>` : title
  }

  /** Send into the session's topic, recreating it once if it was deleted. */
  private async post(sessionID: string, html: string, buttons?: Button[][], knownThread?: number): Promise<{ messageId: number; threadId?: number }> {
    let threadId = knownThread ?? (await this.thread(sessionID))
    try {
      return { messageId: await this.client!.send(html, { threadId, buttons }), threadId }
    } catch (error) {
      if (!(error instanceof TelegramError && error.threadMissing && threadId !== undefined)) throw error
      const root = await this.root(sessionID)
      if (root) delete this.state.topics[root.id]
      this.saveState()
      threadId = await this.thread(sessionID)
      return { messageId: await this.client!.send(html, { threadId, buttons }), threadId }
    }
  }

  private async thread(sessionID: string): Promise<number | undefined> {
    if (!this.config?.topics) return undefined
    const root = await this.root(sessionID)
    if (!root) return undefined
    const account = this.account()
    const existing = this.state.topics[root.id]
    if (existing?.account === account) return existing.threadId
    if (!(await this.supportsTopics().catch(() => false))) return undefined
    let pending = this.topicCreation.get(root.id)
    if (!pending) {
      pending = (async () => {
        const name = topicName(root)
        try {
          const threadId = await this.client!.createTopic(name)
          this.state.topics[root.id] = { threadId, name, account }
          this.saveState()
          return threadId
        } catch (error) {
          warn(`topic: ${message(error)}`)
          return undefined
        } finally {
          this.topicCreation.delete(root.id)
        }
      })()
      this.topicCreation.set(root.id, pending)
    }
    return pending
  }

  private async renamed(sessionID: string, title: string): Promise<void> {
    const cached = this.sessions.get(sessionID)
    if (cached) cached.title = title
    const record = this.state.topics[sessionID]
    await this.ready
    if (!record || !this.active || record.account !== this.account()) return
    const session = await this.session(sessionID)
    if (!session) return
    const name = topicName({ ...session, title })
    if (name === record.name) return
    try {
      await this.client!.renameTopic(record.threadId, name)
      record.name = name
      this.saveState()
    } catch (error) {
      warn(`rename topic: ${message(error)}`)
    }
  }

  private supportsTopics(): Promise<boolean> {
    const client = this.client!
    this.topicsSupported ??= (
      client.chatId.startsWith("-") ? client.getChat().then((chat) => chat.is_forum === true) : client.getMe().then((me) => me.has_topics_enabled === true)
    ).catch((error) => {
      this.topicsSupported = undefined
      throw error
    })
    return this.topicsSupported
  }

  private account(): string {
    return `${this.client!.botId}:${this.config!.chatId}`
  }
}

function withToken(token: string, rows: Button[][]): Button[][] {
  return rows.map((row) => row.map((button) => (button.data ? { ...button, data: `${token}:${button.data}` } : button)))
}

export function sessionName(session: Pick<SessionInfo, "id" | "title" | "location">): string {
  return session.title?.trim() || `${basename(session.location.directory) || "OpenCode"} · ${session.id.slice(-6)}`
}

export function topicName(session: Pick<SessionInfo, "id" | "title" | "location">): string {
  const project = basename(session.location.directory)
  const title = session.title?.trim()
  const name = title ? (project ? `${project} · ${title}` : title) : sessionName(session)
  return clip(name.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim() || "OpenCode", 128)
}

export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function warn(text: string): void {
  console.warn(`[telegram] ${text}`)
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
