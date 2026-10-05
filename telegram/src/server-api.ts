import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { FormAnswer, FormInfo } from "./forms.ts"

export type FormState = { status: "pending" } | { status: "answered" } | { status: "cancelled"; message?: string }

export class ServerApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
    this.name = "ServerApiError"
  }
}

/**
 * The plugin context has no form API yet, so forms go through the HTTP API of
 * the server hosting this plugin. Its registration file carries the URL and
 * password; the pid check makes sure we talk to our own process.
 */
export class ServerApi {
  private endpoint?: Promise<{ url: string; authorization?: string }>

  constructor(private readonly env = process.env) {}

  async formState(sessionID: string, formID: string): Promise<FormState> {
    const result = await this.request("GET", `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}`)
    return (result?.data?.state ?? { status: "cancelled" }) as FormState
  }

  async formInfo(sessionID: string, formID: string): Promise<FormInfo & { state: FormState }> {
    const result = await this.request("GET", `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}`)
    return result.data
  }

  async replyForm(sessionID: string, formID: string, answer: FormAnswer): Promise<void> {
    await this.request("POST", `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}/reply`, { answer })
  }

  async cancelForm(sessionID: string, formID: string, message: string): Promise<void> {
    await this.request("DELETE", `/api/session/${encodeURIComponent(sessionID)}/form/${encodeURIComponent(formID)}`, { message })
  }

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const endpoint = await this.resolve()
    let response: Response
    try {
      response = await fetch(new URL(path, endpoint.url), {
        method,
        headers: {
          ...(endpoint.authorization ? { authorization: endpoint.authorization } : {}),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      })
    } catch (error) {
      this.endpoint = undefined
      throw new ServerApiError(`OpenCode server unreachable: ${(error as Error).message}`, 0)
    }
    const text = await response.text()
    if (response.status === 401) this.endpoint = undefined
    if (!response.ok) {
      let message = `HTTP ${response.status}`
      try {
        message = JSON.parse(text).message ?? message
      } catch {}
      throw new ServerApiError(message, response.status)
    }
    return text ? JSON.parse(text) : undefined
  }

  private resolve(): Promise<{ url: string; authorization?: string }> {
    this.endpoint ??= (async () => {
      if (this.env.OPENCODE_TELEGRAM_SERVER_URL) {
        const password = this.env.OPENCODE_TELEGRAM_SERVER_PASSWORD
        return { url: this.env.OPENCODE_TELEGRAM_SERVER_URL, authorization: password ? basic(password) : undefined }
      }
      const base = this.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
      const file = join(base, "opencode", "service.json")
      const info = JSON.parse(await readFile(file, "utf8")) as { url?: string; pid?: number; password?: string }
      if (!info.url) throw new ServerApiError(`${file} has no URL.`, 0)
      if (info.pid !== process.pid) {
        throw new ServerApiError(
          "This plugin is not running inside the background service, so forms cannot be answered (set OPENCODE_TELEGRAM_SERVER_URL to override).",
          0,
        )
      }
      return { url: info.url, authorization: info.password ? basic(info.password) : undefined }
    })().catch((error) => {
      this.endpoint = undefined
      throw error
    })
    return this.endpoint
  }
}

function basic(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`
}
