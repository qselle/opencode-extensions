import { afterEach, describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadConfig, updateConfigFile } from "./config.ts"

const token = "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZ_-abc"
let dir: string

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

async function setup(content: unknown, mode = 0o600) {
  dir = await mkdtemp(join(tmpdir(), "telegram-config-"))
  const path = join(dir, "telegram.json")
  await writeFile(path, JSON.stringify(content))
  await chmod(path, mode)
  return { OPENCODE_TELEGRAM_CONFIG: path }
}

describe("loadConfig", () => {
  test("applies defaults", async () => {
    const result = await loadConfig(await setup({ botToken: token, chatId: 42 }))
    expect(result).toMatchObject({ ok: true, config: { chatId: "42", enabled: true, delayMinutes: 5, minTurnSeconds: 120, details: "summary", topics: true } })
  })

  test("rejects group-readable files", async () => {
    const result = await loadConfig(await setup({ botToken: token, chatId: "42" }, 0o644))
    expect(result.ok).toBe(false)
  })

  test("environment overrides credentials, options override behavior", async () => {
    const env = { ...(await setup({ chatId: "1" })), OPENCODE_TELEGRAM_BOT_TOKEN: token, OPENCODE_TELEGRAM_CHAT_ID: "-100" }
    const result = await loadConfig(env, { delayMinutes: 0, botToken: "ignored" })
    expect(result).toMatchObject({ ok: true, config: { botToken: token, chatId: "-100", delayMinutes: 0 } })
  })

  test("reports invalid values", async () => {
    expect((await loadConfig(await setup({ botToken: "nope", chatId: "1" }))).ok).toBe(false)
    expect((await loadConfig(await setup({ botToken: token, chatId: "1", delayMinutes: -1 }))).ok).toBe(false)
  })

  test("updates keep the file private", async () => {
    const env = await setup({ botToken: token, chatId: "1" })
    await updateConfigFile({ enabled: false }, env)
    const result = await loadConfig(env)
    expect(result).toMatchObject({ ok: true, config: { enabled: false } })
  })
})
