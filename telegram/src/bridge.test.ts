import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Bridge } from "./bridge.ts"
import type { FormAnswer } from "./forms.ts"

const CHAT = "4242"

class Channel<T> {
  private items: T[] = []
  private waiters: ((value: T) => void)[] = []
  push(item: T) {
    const waiter = this.waiters.shift()
    if (waiter) waiter(item)
    else this.items.push(item)
  }
  next(): Promise<T> {
    const item = this.items.shift()
    return item !== undefined ? Promise.resolve(item) : new Promise((resolve) => this.waiters.push(resolve))
  }
}

/** Minimal Telegram Bot API double: records calls and serves queued updates. */
function fakeTelegram(options: { topics?: boolean } = {}) {
  const calls: { method: string; body: any }[] = []
  const updates = new Channel<any[]>()
  let messageId = 100
  let threadId = 7
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = String(url).split("/").pop()!
    const body = JSON.parse(String(init.body))
    calls.push({ method, body })
    const ok = (result: unknown) => new Response(JSON.stringify({ ok: true, result }))
    switch (method) {
      case "sendMessage":
        return ok({ message_id: ++messageId })
      case "getMe":
        return ok({ id: 1, username: "bot", has_topics_enabled: options.topics ?? true })
      case "createForumTopic":
        return ok({ message_thread_id: ++threadId })
      case "getUpdates": {
        const signal = init.signal!
        const batch = await Promise.race([
          updates.next(),
          new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
        ])
        return ok(batch)
      }
      default:
        return ok(true)
    }
  }) as unknown as typeof globalThis.fetch
  return {
    fetch: fetchImpl,
    calls,
    sent: () => calls.filter((call) => call.method === "sendMessage").map((call) => call.body),
    edits: () => calls.filter((call) => call.method === "editMessageText").map((call) => call.body),
    press: (data: string, messageId: number) =>
      updates.push([{ update_id: Date.now(), callback_query: { id: "cb", from: { id: 1 }, data, message: { message_id: messageId, chat: { id: Number(CHAT) } } } }]),
    say: (text: string, threadId?: number) =>
      updates.push([
        {
          update_id: Date.now(),
          message: { message_id: 999, date: Math.ceil(Date.now() / 1000) + 5, message_thread_id: threadId, chat: { id: Number(CHAT) }, from: { id: 1 }, text },
        },
      ]),
  }
}

function fakeContext(sessions: Record<string, any>) {
  const events = new Channel<any>()
  const permissionReplies: any[] = []
  const ctx = {
    options: {},
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            const next = await Promise.race([events.next(), new Promise<undefined>((resolve) => signal.addEventListener("abort", () => resolve(undefined), { once: true }))])
            if (!next) return
            yield next
          }
        },
      }),
    },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        if (!sessions[sessionID]) throw new Error("not found")
        return sessions[sessionID]
      },
      context: async () => [
        { type: "user", content: [{ type: "text", text: "do it" }] },
        { type: "assistant", content: [{ type: "text", text: "All **done**." }, { type: "tool" }] },
      ],
    },
    permission: {
      get: async () => ({}),
      reply: async (input: any) => void permissionReplies.push(input),
    },
  }
  return { ctx: ctx as any, emit: (type: string, data: unknown, created = Date.now()) => events.push({ type, data, created }), permissionReplies }
}

const until = async (check: () => boolean, timeout = 2_000) => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error("timed out")
    await Bun.sleep(5)
  }
}

let dir: string
let bridge: Bridge | undefined
const env = { ...process.env }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "telegram-bridge-"))
  const config = join(dir, "telegram.json")
  await writeFile(config, JSON.stringify({ botToken: "1:ABCDEFGHIJKLMNOPQRSTUVWXYZ", chatId: CHAT, delayMinutes: 0, minTurnSeconds: 60 }))
  await chmod(config, 0o600)
  process.env.OPENCODE_TELEGRAM_CONFIG = config
  process.env.XDG_STATE_HOME = dir
})

afterEach(async () => {
  bridge?.stop()
  bridge = undefined
  process.env = { ...env }
  await rm(dir, { recursive: true, force: true })
})

const root = { id: "ses_root01", title: "Fix flaky test", cost: 0.4, location: { directory: "/work/app" } }
const child = { id: "ses_child1", parentID: "ses_root01", title: "Explore", agent: "explore", location: { directory: "/work/app" } }

function setup(options: { topics?: boolean } = {}) {
  const telegram = fakeTelegram(options)
  const replies: { sessionID: string; formID: string; answer: FormAnswer }[] = []
  const server = {
    formState: async () => ({ status: "pending" as const }),
    replyForm: async (sessionID: string, formID: string, answer: FormAnswer) => void replies.push({ sessionID, formID, answer }),
    cancelForm: async () => {},
  }
  const opencode = fakeContext({ [root.id]: root, [child.id]: child })
  bridge = new Bridge({ fetch: telegram.fetch, server })
  bridge.attach(opencode.ctx)
  return { telegram, opencode, replies }
}

describe("Bridge", () => {
  test("answers a question form from Telegram in the session topic", async () => {
    const { telegram, opencode, replies } = setup()
    await bridge!.whenReady()
    opencode.emit("form.created", {
      form: {
        id: "frm_1",
        sessionID: child.id,
        title: "Questions",
        fields: [
          { key: "q0", title: "Pick", type: "string", options: [{ value: "A", label: "A" }, { value: "B", label: "B" }] },
          { key: "q1", title: "Why", type: "string" },
        ],
      },
    })
    await until(() => telegram.sent().length === 1)
    const first = telegram.sent()[0]
    expect(telegram.calls.find((call) => call.method === "createForumTopic")?.body.name).toBe("app · Fix flaky test")
    expect(first.message_thread_id).toBe(8)
    expect(first.text).toContain("↳ explore: Explore")
    const option = first.reply_markup.inline_keyboard[1][0].callback_data
    telegram.press(option, 101)
    await until(() => telegram.sent().length === 2)
    expect(telegram.edits()[0].text).toContain("→ B")

    telegram.say("because", 8)
    await until(() => replies.length === 1)
    expect(replies[0]).toEqual({ sessionID: child.id, formID: "frm_1", answer: { q0: "B", q1: "because" } })
    await until(() => telegram.edits().some((edit) => edit.text.includes("Sent to OpenCode")))

    // The echo of our own answer must not overwrite the result.
    opencode.emit("form.replied", { id: "frm_1", sessionID: child.id, answer: {} })
    await Bun.sleep(20)
    expect(telegram.edits().some((edit) => edit.text.includes("Answered in OpenCode"))).toBe(false)
  })

  test("replies to permissions and reflects answers given in OpenCode", async () => {
    const { telegram, opencode } = setup()
    await bridge!.whenReady()
    opencode.emit("permission.asked", { id: "per_1", sessionID: root.id, action: "shell", resources: ["rm -rf dist"], save: ["rm *"] })
    await until(() => telegram.sent().length === 1)
    const buttons = telegram.sent()[0].reply_markup.inline_keyboard[0].map((button: any) => button.text)
    expect(buttons).toEqual(["Allow once", "Always", "Reject"])
    expect(telegram.sent()[0].text).toContain("<pre>rm -rf dist</pre>")
    const reject = telegram.sent()[0].reply_markup.inline_keyboard[0][2].callback_data
    telegram.press(reject, 101)
    await until(() => opencode.permissionReplies.length === 1)
    expect(opencode.permissionReplies[0]).toMatchObject({ sessionID: root.id, requestID: "per_1", decision: "reject" })

    opencode.emit("permission.asked", { id: "per_2", sessionID: root.id, action: "edit", resources: ["a.ts"] })
    await until(() => telegram.sent().length === 2)
    opencode.emit("permission.replied", { sessionID: root.id, requestID: "per_2", reply: "once" })
    await until(() => telegram.edits().some((edit) => edit.text.includes("Answered in OpenCode: once")))
  })

  test("sends turn alerts for long root turns and failures only", async () => {
    const { telegram, opencode } = setup({ topics: false })
    await bridge!.whenReady()
    const now = Date.now()
    opencode.emit("session.execution.started", { sessionID: root.id }, now - 5_000)
    opencode.emit("session.execution.succeeded", { sessionID: root.id }, now)
    opencode.emit("session.execution.started", { sessionID: child.id }, now - 600_000)
    opencode.emit("session.execution.succeeded", { sessionID: child.id }, now)
    opencode.emit("session.execution.started", { sessionID: root.id }, now - 180_000)
    opencode.emit("session.execution.succeeded", { sessionID: root.id }, now)
    await until(() => telegram.sent().length === 1)
    expect(telegram.sent()[0].text).toBe("✅ <b>Fix flaky test</b> finished · 3m · $0.40\n\nAll <b>done</b>.")
    expect(telegram.sent()[0].message_thread_id).toBeUndefined()

    opencode.emit("session.execution.failed", { sessionID: root.id, error: { type: "provider", message: "rate <limited>" } })
    await until(() => telegram.sent().length === 2)
    expect(telegram.sent()[1].text).toContain("<pre>rate &lt;limited&gt;</pre>")
  })

  test("waits for the configured delay before forwarding", async () => {
    const { telegram, opencode } = setup()
    await bridge!.whenReady()
    await bridge!.setDelay(1)
    opencode.emit("permission.asked", { id: "per_9", sessionID: root.id, action: "shell", resources: ["ls"] })
    opencode.emit("permission.replied", { sessionID: root.id, requestID: "per_9", reply: "once" })
    await Bun.sleep(50)
    expect(telegram.sent()).toHaveLength(0)
    expect(await bridge!.status()).toContain("scheduled: 0")
  })
})
