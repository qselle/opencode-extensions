import { Lexer, type Token, type Tokens } from "marked"

/** Telegram's limit is 4096 characters of visible text; keep headroom for headers. */
export const MESSAGE_LIMIT = 4_000

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

/** Remove terminal controls and collapse excess blank lines. */
export function clean(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** Visible length after Telegram parses the HTML. */
export function visibleLength(html: string): number {
  return html.replace(/<[^>]*>/g, "").replace(/&(?:amp|lt|gt|quot);/g, "x").length
}

/** Render Markdown with only the HTML tags Telegram supports. */
export function markdownToHtml(source: string): string {
  return render(new Lexer({ gfm: true, breaks: true }).lex(clean(source))).trim()
}

/**
 * Render an excerpt that fits `limit` visible characters. Markdown is shortened
 * at a paragraph or line boundary before rendering so tags never get cut.
 */
export function markdownExcerpt(source: string, limit: number): string {
  let text = clean(source)
  for (let attempt = 0; attempt < 6; attempt++) {
    const html = markdownToHtml(text)
    if (visibleLength(html) <= limit) return html
    const target = Math.floor(Math.min(text.length, limit) * (attempt < 3 ? 0.9 : 0.6))
    const cut = Math.max(text.lastIndexOf("\n\n", target), text.lastIndexOf("\n", target))
    text = `${text.slice(0, cut > target / 2 ? cut : target).trimEnd()}\n\n…`
  }
  return escapeHtml(`${[...clean(source)].slice(0, Math.max(0, limit - 1)).join("")}…`)
}

function safeHref(value: string): string | undefined {
  if (/[\x00-\x20\x7f-\x9f]/u.test(value)) return
  try {
    const url = new URL(value)
    if (!["https:", "http:", "mailto:"].includes(url.protocol) || url.username || url.password) return
    return escapeHtml(url.href)
  } catch {
    return
  }
}

function render(tokens: readonly Token[], insideStyle = false, depth = 0): string {
  if (depth > 32) return ""
  return tokens
    .map((token): string => {
      const children = (styled = insideStyle) => render("tokens" in token ? (token.tokens ?? []) : [], styled, depth + 1)
      switch (token.type) {
        case "space":
        case "def":
        case "checkbox":
          return ""
        case "br":
          return "\n"
        case "hr":
          return "─────\n\n"
        case "heading":
          return `<b>${children(true)}</b>\n\n`
        case "paragraph":
          return `${children()}\n\n`
        case "strong":
          return `<b>${children(true)}</b>`
        case "em":
          return `<i>${children(true)}</i>`
        case "del":
          return `<s>${children(true)}</s>`
        case "codespan":
          return insideStyle ? escapeHtml(token.text) : `<code>${escapeHtml(token.text)}</code>`
        case "code": {
          const language = (token.lang ?? "").split(/\s/u)[0] ?? ""
          const code = escapeHtml(token.text)
          return /^[a-z0-9_+-]{1,40}$/iu.test(language)
            ? `<pre><code class="language-${language}">${code}</code></pre>\n\n`
            : `<pre>${code}</pre>\n\n`
        }
        case "blockquote":
          return `<blockquote>${children().trim()}</blockquote>\n\n`
        case "list":
          return `${(token.items as Tokens.ListItem[])
            .map((item, index) => {
              const prefix = item.task ? (item.checked ? "☑" : "☐") : token.ordered ? `${Number(token.start || 1) + index}.` : "•"
              return `${prefix} ${render(item.tokens, insideStyle, depth + 1).trim().replace(/\n/g, "\n  ")}`
            })
            .join("\n")}\n\n`
        case "table":
          return `<pre>${escapeHtml(token.raw.trim())}</pre>\n\n`
        case "link": {
          const href = safeHref(token.href)
          const label = children(true)
          return href ? `<a href="${href}">${label}</a>` : label
        }
        case "image":
          return escapeHtml(token.text || "[image]")
        case "text":
          return "tokens" in token && token.tokens ? children() : escapeHtml(token.text)
        case "escape":
          return escapeHtml(token.text)
        case "html":
          return escapeHtml(token.raw)
        default:
          return escapeHtml("raw" in token ? String(token.raw) : "")
      }
    })
    .join("")
}
