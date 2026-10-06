# cat

A small animated cat in the bottom-right corner of the OpenCode sidebar, sitting on the same rows as the folder line. It only exists while the sidebar is open and adds no rows, so it never takes space from the transcript or the prompt. A very long folder path can run under it.

## Install

TUI-only, so it goes in `~/.config/opencode/cli.json`:

```json
{ "plugins": ["/path/to/opencode-extensions/cat"] }
```

## Usage

```text
/cat                Open the panel (animation mode, show/hide)
/cat status         Show current settings
/cat smart          Occasional movement, livelier while OpenCode works (default)
/cat always         Animate continuously
/cat working        Animate only while OpenCode works
/cat static         Stay in the neutral pose
/cat show|hide      Change visibility
ctrl+shift+c        Toggle visibility
```

Settings persist and are shared by every TUI window. The cat uses the theme's text color and stops animating while hidden.
