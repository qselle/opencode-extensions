/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { Animator, CAT_WIDTH, MODES, parseCommand, pose, type Mode } from "./cat.ts"

interface Settings {
  visible: boolean
  mode: Mode
}

/** Rendered in the sidebar footer, so it only exists while the sidebar is open. */
function Cat(props: { sessionID: string; settings: Settings }) {
  const context = usePlugin()
  const [frame, setFrame] = createSignal(0)
  const animator = new Animator(setFrame)
  onCleanup(() => animator.dispose())

  createEffect(() =>
    animator.update({
      mode: props.settings.mode,
      working: context.data.session.status(props.sessionID) === "running",
      active: props.settings.visible,
    }),
  )

  return (
    <Show when={props.settings.visible}>
      {/* Absolute: shares the folder line's rows instead of adding its own. */}
      <box position="absolute" right={0} bottom={0} zIndex={1} flexDirection="column" alignItems="flex-end">
        {/* Lines are padded to one width so right alignment keeps the art intact. */}
        <For each={pose(frame())}>{(line) => <text fg={context.theme.text.base}>{line.padEnd(CAT_WIDTH)}</text>}</For>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "opencode-extensions.cat",
  setup(context) {
    const [settings, update] = context.storage.store<Settings>("settings", { initial: { visible: true, mode: "smart" } })
    const status = () => `Cat ${settings.visible ? "visible" : "hidden"} · ${settings.mode}`
    const save = async (mutation: (draft: Settings) => void) => {
      await update(mutation)
      context.ui.toast.show({ title: "Cat", message: status(), variant: "info", duration: 2_000 })
    }

    const panel = async () => {
      const choice = await context.ui.dialog.select({
        title: "Cat",
        current: settings.mode,
        options: [
          ...MODES.map((entry) => ({ title: entry.label, value: entry.mode as string, description: entry.description, category: "Animation" })),
          { title: settings.visible ? "Hide" : "Show", value: "toggle", description: "Toggle visibility (ctrl+shift+c)", category: "Visibility" },
        ],
      })
      if (choice === "toggle") await save((draft) => void (draft.visible = !draft.visible))
      else if (choice) await save((draft) => void (draft.mode = choice as Mode))
    }

    const run = async (input?: string) => {
      const command = parseCommand(input)
      switch (command.type) {
        case "panel":
          return panel()
        case "status":
          return void context.ui.toast.show({ title: "Cat", message: status(), variant: "info" })
        case "visible":
          return save((draft) => void (draft.visible = command.visible))
        case "mode":
          return save((draft) => void (draft.mode = command.mode))
        case "invalid":
          return void context.ui.toast.show({ title: "Cat", message: "Usage: /cat [status|show|hide|smart|always|working|static]", variant: "error" })
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        { id: "cat.panel", title: "Cat", group: "Cat", palette: true, slash: { name: "cat", arguments: true }, run: (input) => void run(input) },
        { id: "cat.toggle", title: "Show or hide the cat", group: "Cat", palette: true, bind: "ctrl+shift+c", run: () => void run(settings.visible ? "hide" : "show") },
      ],
      bindings: ["cat.toggle"],
    }))

    return context.ui.slot({
      append: "sidebar.footer",
      render: (input) => <Cat sessionID={input.sessionID} settings={settings} />,
    })
  },
})
