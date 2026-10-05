import { Plugin } from "@opencode/plugin/tui"
import { TelegramRpc } from "./rpc.ts"

const USAGE = "/telegram [status|test|on|off|delay <minutes>|send <markdown>|reload]"

export default Plugin.define({
  id: "opencode-extensions.telegram.tui",
  setup(context) {
    const raw = context.client.rpc(TelegramRpc)
    // JSON Schema methods are typed `unknown`; every method returns `{ text }`.
    const text = async (call: Promise<unknown>) => ({ text: String((await call as { text?: unknown })?.text ?? "") })
    const rpc = {
      status: (input: {}) => text(raw.status(input)),
      test: (input: {}) => text(raw.test(input)),
      reload: (input: {}) => text(raw.reload(input)),
      enable: (input: { enabled: boolean }) => text(raw.enable(input)),
      delay: (input: { minutes: number }) => text(raw.delay(input)),
      send: (input: { message: string; sessionID?: string }) => text(raw.send(input)),
    }
    const toast = (message: string, variant: "success" | "error" | "info" = "info") =>
      context.ui.toast.show({ title: "Telegram", message, variant: message.startsWith("⚠️") ? "error" : variant })

    const run = async (input = "") => {
      const [command = "status", ...rest] = input.trim().split(/\s+/)
      const argument = input.trim().slice(command.length).trim()
      try {
        switch (command) {
          case "":
          case "status":
            await context.ui.dialog.alert({ title: "Telegram", message: (await rpc.status({})).text })
            return
          case "test":
            toast((await rpc.test({})).text, "success")
            return
          case "on":
          case "off":
            toast((await rpc.enable({ enabled: command === "on" })).text, "success")
            return
          case "delay": {
            const minutes = Number(rest[0])
            if (!Number.isFinite(minutes) || minutes < 0) return toast(`Usage: /telegram delay <minutes>`, "error")
            toast((await rpc.delay({ minutes })).text, "success")
            return
          }
          case "send": {
            if (!argument) return toast("Usage: /telegram send <markdown>", "error")
            const route = context.ui.router.current()
            const sessionID = route.type === "session" ? route.sessionID : undefined
            toast((await rpc.send({ message: argument, ...(sessionID ? { sessionID } : {}) })).text, "success")
            return
          }
          case "reload":
            toast((await rpc.reload({})).text, "success")
            return
          default:
            toast(`Usage: ${USAGE}`, "error")
        }
      } catch (error) {
        toast(`⚠️ ${error instanceof Error ? error.message : String(error)}`, "error")
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "telegram.command",
          title: "Telegram",
          group: "Telegram",
          palette: true,
          slash: { name: "telegram", arguments: true },
          run: (input) => void run(input),
        },
        { id: "telegram.test", title: "Telegram: send test message", group: "Telegram", palette: true, run: () => void run("test") },
      ],
    }))
  },
})
