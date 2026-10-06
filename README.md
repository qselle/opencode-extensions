# opencode-extensions

Personal plugins for [OpenCode](https://opencode.ai) V2, ported from my [Pi extensions](https://github.com/qselle/pi-extensions) where OpenCode doesn't already cover them.

| Plugin | Purpose |
| --- | --- |
| [`telegram`](telegram) | Answer questions and permissions from Telegram, turn alerts, one topic per session |
| [`cat`](cat) | Small animated cat in the sidebar's bottom-right corner (TUI-only, goes in `cli.json`) |

## Install

```sh
git clone https://github.com/qselle/opencode-extensions ~/Work/opencode-extensions
cd ~/Work/opencode-extensions && bun install
```

Then add a plugin directory to `plugins` in `~/.config/opencode/opencode.jsonc`, for example:

```jsonc
{ "plugins": ["/Users/you/Work/opencode-extensions/telegram"] }
```

Use an absolute path; `~` is not expanded. Each plugin's README covers its own configuration.

## Development

```sh
bun run check   # typecheck + tests
```

Requires Bun. Built and tested against OpenCode 2.0.23.
