import { Plugin } from "@opencode/plugin"
import { Bridge } from "./bridge.ts"
import { TelegramRpc } from "./rpc.ts"

/**
 * OpenCode creates one plugin instance per location, but the event stream
 * covers every location and Telegram allows a single poller per bot. All
 * instances in the process therefore share one bridge. A reloaded module
 * replaces the previous module's bridge instead of joining it.
 */
const REGISTRY = Symbol.for("opencode-extensions.telegram")
const MODULE = Symbol("module")
type Registry = { module: symbol; bridge: Bridge }
const global = globalThis as typeof globalThis & { [REGISTRY]?: Registry }

function acquire(): Bridge {
  const current = global[REGISTRY]
  if (current?.module === MODULE) return current.bridge
  current?.bridge.stop()
  const bridge = new Bridge()
  global[REGISTRY] = { module: MODULE, bridge }
  return bridge
}

export default Plugin.define({
  id: "opencode-extensions.telegram",
  async setup(ctx) {
    const bridge = acquire()
    bridge.attach(ctx)

    await ctx.rpc.register(TelegramRpc, {
      status: async () => ({ text: await bridge.status() }),
      test: async () => ({ text: await bridge.test().catch(failure) }),
      reload: async () => ({ text: await bridge.reload() }),
      send: async (input) => {
        const { message, sessionID } = input as { message: string; sessionID?: string }
        return { text: await bridge.notify(sessionID, message).catch(failure) }
      },
      enable: async (input) => ({ text: await bridge.setEnabled((input as { enabled: boolean }).enabled) }),
      delay: async (input) => ({ text: await bridge.setDelay((input as { minutes: number }).minutes) }),
    })

    await ctx.tool.transform((editor) => {
      if (!bridge.active) return
      editor.add({
        name: "telegram_notify",
        description: [
          "Send a short Markdown message to the user's Telegram, in this session's topic.",
          "Use it only when the user asked to be notified, or for an update they explicitly requested (for example when a long task finishes).",
          "It does not wait for a reply; use the question tool when you need an answer. Never include secrets or credentials.",
        ].join(" "),
        input: {
          type: "object",
          properties: { message: { type: "string", description: "Markdown message, at most a few paragraphs." } },
          required: ["message"],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const { message } = input as { message: string }
          return { content: await bridge.notify(context.sessionID, message) }
        },
      })
    })
    // The tool only exists while Telegram is configured and enabled.
    const unsubscribe = bridge.onChange(() => void ctx.tool.reload().catch(() => {}))

    return () => {
      unsubscribe()
      bridge.detach(ctx)
      if (bridge.empty && global[REGISTRY]?.bridge === bridge) delete global[REGISTRY]
    }
  },
})

function failure(error: unknown): string {
  return `⚠️ ${error instanceof Error ? error.message : String(error)}`
}
