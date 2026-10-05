import { Rpc } from "@opencode/plugin/rpc"

const none = { type: "object", properties: {}, additionalProperties: false } as const
const text = { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } as const

/** Contract between the server plugin (bridge) and the TUI plugin (slash commands). */
export const TelegramRpc = Rpc.define({
  id: "telegram",
  methods: {
    status: { input: none, output: text },
    test: { input: none, output: text },
    reload: { input: none, output: text },
    send: {
      input: {
        type: "object",
        properties: { message: { type: "string" }, sessionID: { type: "string" } },
        required: ["message"],
        additionalProperties: false,
      },
      output: text,
    },
    enable: {
      input: { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"], additionalProperties: false },
      output: text,
    },
    delay: {
      input: { type: "object", properties: { minutes: { type: "number", minimum: 0 } }, required: ["minutes"], additionalProperties: false },
      output: text,
    },
  },
  events: {},
})
