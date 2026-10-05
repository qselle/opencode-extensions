import { describe, expect, test } from "bun:test"
import { markdownExcerpt, markdownToHtml, visibleLength } from "./markdown.ts"

describe("markdownToHtml", () => {
  test("uses Telegram's HTML subset", () => {
    expect(markdownToHtml("# Done\n\n**bold** _it_ `x<y`\n\n- a\n- b")).toBe(
      "<b>Done</b>\n\n<b>bold</b> <i>it</i> <code>x&lt;y</code>\n\n• a\n• b",
    )
  })

  test("escapes raw HTML and unsafe links", () => {
    expect(markdownToHtml("Hi <script>x</script> [a](javascript:alert(1)) [b](https://ok.dev)")).toBe(
      'Hi &lt;script&gt;x&lt;/script&gt; a <a href="https://ok.dev/">b</a>',
    )
    expect(markdownToHtml("<b onclick=x>block</b>")).toBe("&lt;b onclick=x&gt;block&lt;/b&gt;")
  })

  test("keeps fenced code languages", () => {
    expect(markdownToHtml("```ts\nconst a = 1\n```")).toBe('<pre><code class="language-ts">const a = 1</code></pre>')
  })
})

describe("markdownExcerpt", () => {
  test("shortens long text without breaking tags", () => {
    const source = Array.from({ length: 200 }, (_, index) => `Paragraph **${index}** with some text.`).join("\n\n")
    const html = markdownExcerpt(source, 500)
    expect(visibleLength(html)).toBeLessThanOrEqual(500)
    expect(html.match(/<b>/g)?.length).toBe(html.match(/<\/b>/g)?.length)
    expect(html).toEndWith("…")
  })
})
