# opencode-auto-queue

OpenCode plugin that automatically queues messages when the session is busy and drains them when idle.

Replaces `@0xsero/open-queue` with a clean, configurable alternative that requires no manual mode switching.

## Features

- Auto-queues messages when the session is busy
- Drains queued messages automatically when the session goes idle
- Toast notifications showing queue status
- `queue` tool with `status`, `immediate`, and `hold` actions
- No prompts, no patching of OpenCode internals

## Installation

Add to your `opencode.json`:

```json
{
  "plugin": [
    "plugins/opencode-auto-queue"
  ]
}
```

## Configuration

Pass options as a tuple:

```json
{
  "plugin": [
    ["plugins/opencode-auto-queue", {
      "defaultMode": "hold",
      "toastDurationMs": 86400000,
      "emptyToastDurationMs": 4000,
      "maxPreviews": 3
    }]
  ]
}
```

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaultMode` | `"hold" \| "immediate"` | `"hold"` | Initial queue mode |
| `toastDurationMs` | `number` | `86400000` | Toast duration for queue status (ms) |
| `emptyToastDurationMs` | `number` | `4000` | Toast duration when queue empties (ms) |
| `maxPreviews` | `number` | `3` | Max preview items in toast |

## Build

```bash
bun install
bun build src/index.ts --outdir dist --target bun
```

## License

MIT
