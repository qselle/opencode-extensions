# telegram

Telegram bridge for [OpenCode](https://opencode.ai) V2. Runs inside the background service, so it keeps working with every terminal closed.

- **Questions and forms**: anything still waiting for you after a delay (default 5 min) is forwarded, one field at a time. Buttons for choices, yes/no and multi-select; reply with text for free-form, numbers or a custom answer. Answers go straight back to the session.
- **Permissions**: Allow once / Always / Reject from Telegram.
- **Turn alerts**: failures always; successes when the turn took at least 2 minutes, with an excerpt of the final answer.
- **One topic per session** when the bot or group supports topics, renamed with the session. Subagent prompts go to their parent's topic.
- **`telegram_notify` tool** so the agent can message you when you ask it to.

Answer in OpenCode instead and the Telegram message is updated to say so.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather), enable topics in its settings, and press **Start** in its chat.
2. Create `~/.config/opencode/telegram.json` with mode `600`:

   ```json
   {
     "botToken": "123456:ABC…",
     "chatId": "your numeric user ID (or a -100… forum group ID)"
   }
   ```

3. Add the plugin to `~/.config/opencode/opencode.jsonc`:

   ```jsonc
   { "plugins": ["/path/to/opencode-extensions/telegram"] }
   ```

   Run `bun install` in the repository first. The TUI part (`/telegram`) loads automatically.

4. Run `/telegram test`.

## Commands

```text
/telegram                 Status: bot, topics, pending prompts, polling
/telegram test            Send a test message
/telegram send <markdown> Send a message to this session's topic
/telegram on|off          Enable or disable everything
/telegram delay <minutes> Delay before forwarding forms and permissions (0 = immediately)
/telegram reload          Re-read the config file and bot settings
```

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `botToken` | — | Bot token (or `OPENCODE_TELEGRAM_BOT_TOKEN`) |
| `chatId` | — | Destination chat (or `OPENCODE_TELEGRAM_CHAT_ID`) |
| `enabled` | `true` | Master switch |
| `delayMinutes` | `5` | How long a form/permission must stay pending before it is forwarded |
| `minTurnSeconds` | `120` | Shortest successful turn that sends an alert |
| `details` | `"summary"` | `"minimal"` keeps conversation text out of turn alerts |
| `topics` | `true` | One topic per root session when supported |

`delayMinutes`, `minTurnSeconds`, `details` and `topics` can also be set as plugin `options`. Credentials are only read from the file or the environment. `OPENCODE_TELEGRAM_CONFIG` overrides the file path.

Topic mappings and the update offset live in `~/.local/state/opencode/telegram-state.json`.

## How it works

- OpenCode creates one plugin instance per location, but the event stream covers all of them, so all instances share one bridge per process.
- Forms are answered through the server's HTTP API (the plugin context has no form API yet). The plugin reads `~/.local/state/opencode/service.json` and only uses it when its `pid` is the plugin's own process.
- Telegram is polled only while a forwarded prompt is waiting. Replies are accepted only from the configured chat, and only for a pending prompt: either as a reply to its message, or as the single text-accepting prompt in that topic.

## Limitations

- Fields that need a browser (`external`) are sent as a link and must be finished there.
- A service restart forgets prompts already in Telegram; their buttons then answer "no longer active".
- One bot per machine: Telegram allows only one poller per bot.
