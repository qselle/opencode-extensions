import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

export type Details = "summary" | "minimal"

export interface TelegramConfig {
  botToken: string
  chatId: string
  enabled: boolean
  /** Minutes a form or permission must stay pending before it is forwarded. */
  delayMinutes: number
  /** Successful root turns shorter than this are not announced. Failures always are. */
  minTurnSeconds: number
  /** `summary` includes an excerpt of the final assistant message. */
  details: Details
  /** Create one forum topic per root session when the chat supports it. */
  topics: boolean
}

export type ConfigResult = { ok: true; config: TelegramConfig; path: string } | { ok: false; error: string; path: string }

const DEFAULTS = { enabled: true, delayMinutes: 5, minTurnSeconds: 120, details: "summary", topics: true } as const
const MAX_CONFIG_BYTES = 16 * 1024

export function configPath(env = process.env): string {
  if (env.OPENCODE_TELEGRAM_CONFIG) return env.OPENCODE_TELEGRAM_CONFIG
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config")
  return join(base, "opencode", "telegram.json")
}

export function statePath(env = process.env): string {
  const base = env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(base, "opencode", "telegram-state.json")
}

export async function loadConfig(env = process.env, options: Record<string, unknown> = {}): Promise<ConfigResult> {
  const path = configPath(env)
  let file: Record<string, unknown> = {}
  try {
    const stat = await lstat(path)
    if (!stat.isFile()) return { ok: false, path, error: `${path} is not a regular file.` }
    if (stat.size > MAX_CONFIG_BYTES) return { ok: false, path, error: `${path} is too large.` }
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      return { ok: false, path, error: `${path} must not be readable by other users (chmod 600).` }
    }
    file = JSON.parse(await readFile(path, "utf8"))
    if (!file || typeof file !== "object" || Array.isArray(file)) return { ok: false, path, error: `${path} must contain a JSON object.` }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { ok: false, path, error: `Could not read ${path}: ${error instanceof SyntaxError ? "invalid JSON" : (error as Error).message}` }
    }
  }

  // Plugin options can tune behavior but never carry credentials.
  const merged: Record<string, unknown> = { ...DEFAULTS, ...file, ...pick(options, ["delayMinutes", "minTurnSeconds", "details", "topics"]) }
  const botToken = env.OPENCODE_TELEGRAM_BOT_TOKEN || merged.botToken
  const chatId = env.OPENCODE_TELEGRAM_CHAT_ID || merged.chatId

  if (typeof botToken !== "string" || !/^\d+:[\w-]{20,}$/.test(botToken)) {
    return { ok: false, path, error: `Missing or invalid botToken (set it in ${path} or OPENCODE_TELEGRAM_BOT_TOKEN).` }
  }
  const chat = typeof chatId === "number" ? String(chatId) : chatId
  if (typeof chat !== "string" || !/^-?\d+$/.test(chat)) {
    return { ok: false, path, error: `Missing or invalid chatId (numeric chat ID expected).` }
  }
  const delayMinutes = Number(merged.delayMinutes)
  const minTurnSeconds = Number(merged.minTurnSeconds)
  if (!Number.isFinite(delayMinutes) || delayMinutes < 0) return { ok: false, path, error: "delayMinutes must be a number ≥ 0." }
  if (!Number.isFinite(minTurnSeconds) || minTurnSeconds < 0) return { ok: false, path, error: "minTurnSeconds must be a number ≥ 0." }
  if (merged.details !== "summary" && merged.details !== "minimal") return { ok: false, path, error: 'details must be "summary" or "minimal".' }

  return {
    ok: true,
    path,
    config: {
      botToken,
      chatId: chat,
      enabled: merged.enabled !== false,
      delayMinutes,
      minTurnSeconds,
      details: merged.details,
      topics: merged.topics !== false,
    },
  }
}

/** Merge a patch into the config file, keeping it owner-only. */
export async function updateConfigFile(patch: Record<string, unknown>, env = process.env): Promise<void> {
  const path = configPath(env)
  let current: Record<string, unknown> = {}
  try {
    current = JSON.parse(await readFile(path, "utf8"))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
  await writePrivateJson(path, { ...current, ...patch })
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await chmod(temp, 0o600)
  await rename(temp, path)
}

function pick(source: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]))
}
