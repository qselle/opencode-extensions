import { describe, expect, test } from "bun:test"
import { FormWalker, actions, type FormInfo } from "./forms.ts"

const question: FormInfo = {
  id: "frm_1",
  sessionID: "ses_1",
  title: "Questions",
  fields: [
    {
      key: "q0",
      title: "Scope",
      type: "string",
      custom: true,
      options: [
        { value: "Minimal (Recommended)", label: "Minimal (Recommended)", description: "Small change" },
        { value: "Complete", label: "Complete" },
      ],
    },
    {
      key: "q1",
      title: "Targets",
      type: "multiselect",
      custom: true,
      options: [
        { value: "macos", label: "macOS" },
        { value: "linux", label: "Linux" },
      ],
    },
  ],
}

describe("FormWalker", () => {
  test("walks a question-tool form with buttons", () => {
    const walker = new FormWalker(question)
    const first = walker.view()
    expect(first.acceptsText).toBe(true)
    expect(first.html).toContain("Scope")
    expect(first.html).toContain("(1/2)")
    expect(first.html).toContain("Small change")
    expect(first.buttons.flat().map((button) => button.data)).toEqual(["o0", "o1", "s", "x"])

    expect(walker.press(actions.option(0))).toEqual({ kind: "next" })
    expect(walker.field?.key).toBe("q1")
    expect(walker.press(actions.toggle(1))).toEqual({ kind: "rerender" })
    expect(walker.view().buttons[1]?.[0]?.text).toStartWith("☑")
    expect(walker.reply("windows")).toEqual({ kind: "rerender" })
    expect(walker.press(actions.done)).toEqual({ kind: "next" })
    expect(walker.done).toBe(true)
    expect(walker.answer).toEqual({ q0: "Minimal (Recommended)", q1: ["linux", "windows"] })
  })

  test("accepts option numbers, labels and custom text", () => {
    expect(new FormWalker(question).reply("2")).toEqual({ kind: "next" })
    const byLabel = new FormWalker(question)
    byLabel.reply("complete")
    expect(byLabel.answer.q0).toBe("Complete")
    const custom = new FormWalker(question)
    custom.reply("Something else")
    expect(custom.answer.q0).toBe("Something else")
  })

  test("skips optional fields and enforces required ones", () => {
    const walker = new FormWalker({
      ...question,
      fields: [
        { key: "a", type: "string" },
        { key: "b", type: "boolean", required: true },
      ],
    })
    expect(walker.press(actions.skip)).toEqual({ kind: "next" })
    expect(walker.view().buttons.flat().map((button) => button.data)).toEqual(["y", "n", "x"])
    expect(walker.press(actions.skip).kind).toBe("invalid")
    expect(walker.press(actions.no)).toEqual({ kind: "next" })
    expect(walker.answer).toEqual({ b: false })
    expect(walker.answered({ key: "a", type: "string" })).toContain("skipped")
  })

  test("validates numbers", () => {
    const walker = new FormWalker({ ...question, fields: [{ key: "n", type: "integer", minimum: 1, maximum: 5 }] })
    expect(walker.view().html).toContain("between 1 and 5")
    expect(walker.reply("abc").kind).toBe("invalid")
    expect(walker.reply("2.5").kind).toBe("invalid")
    expect(walker.reply("9").kind).toBe("invalid")
    expect(walker.reply("3")).toEqual({ kind: "next" })
    expect(walker.answer).toEqual({ n: 3 })
  })

  test("honors when conditions and hidden defaults", () => {
    const walker = new FormWalker({
      ...question,
      fields: [
        { key: "mode", type: "boolean" },
        { key: "detail", type: "string", when: [{ key: "mode", op: "eq", value: true }] },
        { key: "secret", type: "string", hidden: true, default: "x" },
      ],
    })
    walker.press(actions.no)
    expect(walker.done).toBe(true)
    expect(walker.answer).toEqual({ mode: false, secret: "x" })
  })

  test("rejects stale and foreign actions", () => {
    const walker = new FormWalker(question)
    expect(walker.press("o9").kind).toBe("invalid")
    expect(walker.press(actions.cancel)).toEqual({ kind: "cancel" })
  })

  test("marks forms with external fields as not answerable", () => {
    const walker = new FormWalker({ ...question, fields: [{ key: "oauth", type: "external", url: "https://example.com" }] })
    expect(walker.answerable).toBe(false)
    expect(walker.done).toBe(true)
  })
})
