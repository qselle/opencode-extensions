import type { Button } from "./telegram.ts"
import { escapeHtml } from "./markdown.ts"

export type FormValue = string | number | boolean | string[]
export type FormAnswer = Record<string, FormValue>
type Numeric = number | "Infinity" | "-Infinity" | "NaN"

export interface FormOption {
  value: string
  label: string
  description?: string
}

export interface FormWhen {
  key: string
  op: "eq" | "neq"
  value: string | number | boolean
}

interface FieldBase {
  key: string
  title?: string
  description?: string
  required?: boolean
  hidden?: boolean
  when?: FormWhen[]
}

export type FormField =
  | (FieldBase & {
      type: "string"
      format?: string
      minLength?: number
      maxLength?: number
      pattern?: string
      placeholder?: string
      default?: string
      options?: FormOption[]
      custom?: boolean
    })
  | (FieldBase & { type: "number" | "integer"; minimum?: Numeric; maximum?: Numeric; default?: Numeric })
  | (FieldBase & { type: "boolean"; default?: boolean })
  | (FieldBase & { type: "multiselect"; options: FormOption[]; minItems?: number; maxItems?: number; custom?: boolean; default?: string[] })
  | { key: string; type: "external"; url: string; title?: string; description?: string }

export interface FormInfo {
  id: string
  sessionID: string
  title: string
  metadata?: Record<string, unknown>
  fields: FormField[]
}

export interface FieldView {
  html: string
  buttons: Button[][]
  /** The field also accepts a typed reply. */
  acceptsText: boolean
  placeholder?: string
}

export type Step = { kind: "next" } | { kind: "rerender" } | { kind: "invalid"; message: string } | { kind: "cancel" }

/** Callback data is `<token>:<action>`; Telegram allows 64 bytes, actions stay tiny. */
export const actions = {
  option: (index: number) => `o${index}`,
  toggle: (index: number) => `t${index}`,
  done: "d",
  yes: "y",
  no: "n",
  skip: "s",
  cancel: "x",
} as const

/**
 * Walks a form one field at a time. OpenCode validates the final answer, so
 * local checks only exist to give quick feedback in Telegram.
 */
export class FormWalker {
  readonly answer: FormAnswer = {}
  private index = -1
  private selection = new Set<string>()
  private customSelection: string[] = []

  constructor(readonly form: FormInfo) {
    this.advance()
  }

  get field(): FormField | undefined {
    return this.form.fields[this.index]
  }

  get done(): boolean {
    return this.index >= this.form.fields.length
  }

  /** External fields need a browser; forms containing one are notified, not answered. */
  get answerable(): boolean {
    return this.form.fields.every((field) => field.type !== "external")
  }

  view(): FieldView {
    const field = this.field
    if (!field || field.type === "external") return { html: "", buttons: [], acceptsText: false }
    const visible = this.form.fields.filter((candidate) => candidate.type !== "external" && !candidate.hidden)
    const position = visible.length > 1 ? ` (${visible.indexOf(field) + 1}/${visible.length})` : ""
    const lines = [`<b>${escapeHtml(field.title || field.key)}</b>${position}`]
    if (field.description) lines.push(escapeHtml(field.description))
    const buttons: Button[][] = []
    let acceptsText = false
    let placeholder: string | undefined

    switch (field.type) {
      case "boolean":
        buttons.push([
          { text: "Yes", data: actions.yes },
          { text: "No", data: actions.no },
        ])
        break
      case "string":
        if (field.options?.length) {
          lines.push(optionList(field.options))
          field.options.forEach((option, index) => buttons.push([{ text: `${index + 1}. ${option.label}`, data: actions.option(index) }]))
          acceptsText = field.custom === true
          if (acceptsText) lines.push("<i>Or reply with your own answer.</i>")
        } else {
          acceptsText = true
          placeholder = field.placeholder
          lines.push(`<i>Reply with ${describeString(field)}.</i>`)
        }
        break
      case "number":
      case "integer":
        acceptsText = true
        lines.push(`<i>Reply with ${field.type === "integer" ? "a whole number" : "a number"}${range(field)}.</i>`)
        break
      case "multiselect": {
        lines.push(optionList(field.options))
        field.options.forEach((option, index) =>
          buttons.push([{ text: `${this.selection.has(option.value) ? "☑" : "☐"} ${index + 1}. ${option.label}`, data: actions.toggle(index) }]),
        )
        if (this.customSelection.length) lines.push(`Also: ${this.customSelection.map(escapeHtml).join(", ")}`)
        acceptsText = field.custom === true
        if (acceptsText) lines.push("<i>Reply to add your own choice.</i>")
        buttons.push([{ text: "✅ Done", data: actions.done }])
        break
      }
    }

    const footer: Button[] = []
    if (!field.required) footer.push({ text: "Skip", data: actions.skip })
    footer.push({ text: "✖ Cancel", data: actions.cancel })
    buttons.push(footer)
    return { html: lines.filter(Boolean).join("\n\n"), buttons, acceptsText, placeholder }
  }

  press(action: string): Step {
    const field = this.field
    if (!field || field.type === "external") return { kind: "invalid", message: "This question is no longer active." }
    if (action === actions.cancel) return { kind: "cancel" }
    if (action === actions.skip) {
      if (field.required) return { kind: "invalid", message: "This field is required." }
      if (field.type === "multiselect") this.resetSelection()
      this.advance()
      return { kind: "next" }
    }
    const index = Number(action.slice(1))
    switch (field.type) {
      case "boolean":
        if (action !== actions.yes && action !== actions.no) break
        return this.set(field.key, action === actions.yes)
      case "string": {
        const option = action.startsWith("o") ? field.options?.[index] : undefined
        if (!option) break
        return this.set(field.key, option.value)
      }
      case "multiselect": {
        if (action === actions.done) {
          const values = [...field.options.filter((option) => this.selection.has(option.value)).map((option) => option.value), ...this.customSelection]
          if (field.minItems !== undefined && values.length < field.minItems) return { kind: "invalid", message: `Choose at least ${field.minItems}.` }
          if (field.required && values.length === 0) return { kind: "invalid", message: "Choose at least one option." }
          this.resetSelection()
          return this.set(field.key, values)
        }
        const option = action.startsWith("t") ? field.options[index] : undefined
        if (!option) break
        if (this.selection.has(option.value)) this.selection.delete(option.value)
        else {
          if (field.maxItems !== undefined && this.selection.size + this.customSelection.length >= field.maxItems) {
            return { kind: "invalid", message: `Choose at most ${field.maxItems}.` }
          }
          this.selection.add(option.value)
        }
        return { kind: "rerender" }
      }
    }
    return { kind: "invalid", message: "That button does not belong to this question." }
  }

  reply(raw: string): Step {
    const field = this.field
    const text = raw.trim()
    if (!field || field.type === "external") return { kind: "invalid", message: "This question is no longer active." }
    if (!text) return { kind: "invalid", message: "Send a non-empty answer." }
    switch (field.type) {
      case "string": {
        if (field.options?.length) {
          const numbered = /^\d+$/.test(text) ? field.options[Number(text) - 1] : undefined
          const match = numbered ?? field.options.find((option) => [option.label, option.value].some((value) => value.toLowerCase() === text.toLowerCase()))
          if (match) return this.set(field.key, match.value)
          if (!field.custom) return { kind: "invalid", message: "Pick one of the buttons." }
        }
        if (field.minLength !== undefined && text.length < field.minLength) return { kind: "invalid", message: `Use at least ${field.minLength} characters.` }
        if (field.maxLength !== undefined && text.length > field.maxLength) return { kind: "invalid", message: `Use at most ${field.maxLength} characters.` }
        if (field.pattern && !safeTest(field.pattern, text)) return { kind: "invalid", message: "That answer does not match the expected format." }
        return this.set(field.key, text)
      }
      case "number":
      case "integer": {
        const value = Number(text.replace(",", "."))
        if (!Number.isFinite(value)) return { kind: "invalid", message: "Send a number." }
        if (field.type === "integer" && !Number.isInteger(value)) return { kind: "invalid", message: "Send a whole number." }
        if (typeof field.minimum === "number" && value < field.minimum) return { kind: "invalid", message: `Send at least ${field.minimum}.` }
        if (typeof field.maximum === "number" && value > field.maximum) return { kind: "invalid", message: `Send at most ${field.maximum}.` }
        return this.set(field.key, value)
      }
      case "multiselect": {
        if (!field.custom) return { kind: "invalid", message: "Use the buttons, then press Done." }
        if (!this.customSelection.includes(text)) this.customSelection.push(text)
        return { kind: "rerender" }
      }
      case "boolean": {
        if (/^(y|yes|true|oui|1)$/i.test(text)) return this.set(field.key, true)
        if (/^(n|no|false|non|0)$/i.test(text)) return this.set(field.key, false)
        return { kind: "invalid", message: "Use the Yes or No button." }
      }
    }
  }

  /** Summary for the message of an answered field. */
  answered(field: FormField): string {
    const value = this.answer[field.key]
    const title = `<b>${escapeHtml(field.title || field.key)}</b>`
    if (value === undefined) return `${title}\n→ <i>skipped</i>`
    const label = (raw: string) =>
      "options" in field && field.options ? (field.options.find((option) => option.value === raw)?.label ?? raw) : raw
    const shown = Array.isArray(value)
      ? value.length
        ? value.map((item) => label(item)).join(", ")
        : "none"
      : typeof value === "boolean"
        ? value
          ? "Yes"
          : "No"
        : label(String(value))
    return `${title}\n→ ${escapeHtml(shown)}`
  }

  private set(key: string, value: FormValue): Step {
    this.answer[key] = value
    this.advance()
    return { kind: "next" }
  }

  private resetSelection(): void {
    this.selection = new Set()
    this.customSelection = []
  }

  /** Move to the next field that is shown, applying defaults for hidden ones. */
  private advance(): void {
    for (this.index++; this.index < this.form.fields.length; this.index++) {
      const field = this.form.fields[this.index]!
      if (field.type === "external") continue
      if (!visible(field, this.answer)) continue
      if (field.hidden) {
        if (field.default !== undefined) this.answer[field.key] = field.default as FormValue
        continue
      }
      if (field.type === "multiselect") this.selection = new Set(field.default ?? [])
      return
    }
  }
}

function visible(field: Exclude<FormField, { type: "external" }>, answer: FormAnswer): boolean {
  return (field.when ?? []).every((condition) => {
    const equal = answer[condition.key] === condition.value
    return condition.op === "eq" ? equal : !equal
  })
}

function optionList(options: FormOption[]): string {
  const detailed = options.some((option) => option.description || option.label.length > 28)
  if (!detailed) return ""
  return options
    .map((option, index) => `${index + 1}. ${escapeHtml(option.label)}${option.description ? ` — <i>${escapeHtml(option.description)}</i>` : ""}`)
    .join("\n")
}

function describeString(field: Extract<FormField, { type: "string" }>): string {
  const kind = field.format === "email" ? "an email address" : field.format === "uri" ? "a URL" : field.format?.startsWith("date") ? "a date" : "text"
  return field.placeholder ? `${kind} (${escapeHtml(field.placeholder)})` : kind
}

function range(field: { minimum?: Numeric; maximum?: Numeric }): string {
  const min = typeof field.minimum === "number" ? field.minimum : undefined
  const max = typeof field.maximum === "number" ? field.maximum : undefined
  if (min !== undefined && max !== undefined) return ` between ${min} and ${max}`
  if (min !== undefined) return ` ≥ ${min}`
  if (max !== undefined) return ` ≤ ${max}`
  return ""
}

function safeTest(pattern: string, value: string): boolean {
  try {
    return new RegExp(pattern, "u").test(value)
  } catch {
    return true
  }
}
