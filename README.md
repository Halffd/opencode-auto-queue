# opencode-auto-queue

Makes **Enter** queue instead of steer in OpenCode v2.

OpenCode v2 admits every prompt into a durable **session inbox** with a delivery:

- `steer` — handed to the running turn at the next step boundary. This is what
  Enter sends, and it is why a message interrupts work in progress.
- `queue` — parked until the session is idle, then delivered **one at a time**.

This plugin changes that decision. In **hold** mode, a prompt submitted while
the session is busy is admitted as `queue` instead of `steer`, so the server
parks it rather than injecting it into the running turn. Holding, ordering,
retries and delivery are the server's job from that point on; the plugin never
re-sends a parked prompt, so a message cannot be delivered twice.

That also means it never rewrites your text. Earlier versions swapped the
message for a `Queued; N pending` placeholder, which the model then answered as
a real prompt.

Upstream: [anomalyco/opencode#5408](https://github.com/anomalyco/opencode/issues/5408)
(delayed queue, shipped in [#40922](https://github.com/anomalyco/opencode/pull/40922)),
[anomalyco/opencode#47229](https://github.com/anomalyco/opencode/issues/47229)
(expose more v2 session APIs to plugins).

## Versions

| Tag | Line | Target |
|-----|------|--------|
| `v1` | plugin-owned queue, `chat.message` hook | OpenCode v1 |
| `v2` | session-inbox delivery flip | OpenCode v2.0.x |

## How it works

`ctx.session.hook("prompt", …)` runs before the server admits the prompt, and
the hook input carries the delivery the client asked for. In hold mode, when
the session is busy:

```ts
event.delivery = "queue"; // the server parks it; nothing is rewritten
```

Everything after that is the server's: it delivers parked messages one at a
time once the session is idle. Throwing from the hook instead — the v2 port's
first attempt — surfaces as `Failed to send prompt UnexpectedStatus: 500`,
because the hook has no way to refuse admission.

The plugin mirrors what is parked from the `session.inbox.*` events for
`status` / `peek` / `count` and for `.git/queue.json`.

## Features

- **Hold / immediate modes** — park prompts while busy, or keep steering
- **No duplicate sends** — delivery is the server's inbox, not a plugin queue
- **Status mirror** — what is parked right now, per session, with inbox ids
- **Append** — park extra text at the end of the inbox
- **Status file** — `.git/queue.json` mirrors the parked set (read-only)
- **Synthetic notices** — a queued confirmation lands when the turn ends

## What it deliberately does not do

OpenCode v2.0.23 does **not** expose the inbox API (`list` / `cancel` /
`update`) to plugins, so the plugin cannot delete, reorder or pause messages
that the server has parked. Those are client-side actions. Features that
required owning a second copy of the queue — retry with backoff, completion
detection, pause/resume/cancel drain, reorder/insert/prepend/delete/set/sort/
invert, and `q.py` driving the queue file — were removed rather than left
behind as commands that silently do nothing.

Tracked upstream as [#47229](https://github.com/anomalyco/opencode/issues/47229).

## Installation

In `opencode.json`:

```json
{
  "plugin": ["file:///absolute/path/to/opencode-auto-queue"]
}
```

The plugin is discovered from `~/.config/opencode/plugins/` as well; a symlink
from there to the checkout is enough. OpenCode v2 loads the root `index.js`,
so `dist/` must be built:

```bash
bun install && bun build src/index.ts --outdir dist --target bun
```

## Tool

`queue` tool actions:

| Action | Description |
|--------|-------------|
| `hold` | Park prompts while the session is busy |
| `immediate` | Let prompts steer into the running turn |
| `status` | Mode, busy state, and what is parked |
| `count` | Number of parked messages |
| `peek` | Preview the next parked message |
| `list` | List parked messages with inbox ids |
| `get <n>` | Full content of parked message `n` |
| `append <text>` | Park text at the end of the inbox |
| `config` | Show configuration |

## Slash Commands

```
/queue-hold
/queue-immediate
/queue-status
/queue-count
/queue-peek
/queue-list
/queue-get <index>
/queue-append <text>
/queue-config
```

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `defaultMode` | `"hold"` | Starting mode ("hold" or "immediate") |
| `previewLength` | `28` | Character limit for message previews |
| `maxPreviews` | `3` | Previews shown in status |
| `persistQueue` | `true` | Write the status file |
| `persistPath` | `""` | Status file path (default: `.git/queue.json`) |
| `persistDebounceMs` | `1000` | Debounce interval for writes |

## Status file

`.git/queue.json` mirrors what is parked, for `q status`-style reads:

```json
{
  "version": 1,
  "mode": "hold",
  "queues": {
    "ses_abc123": [
      {
        "inboxID": "msg_123",
        "text": "…",
        "preview": "…",
        "delivery": "queue",
        "enqueuedAt": 1791603005612
      }
    ]
  }
}
```

The plugin writes this file; it does not read edits back. Parked messages live
in the session inbox, which is durable on its own.

## Client-side controls

While a message is parked, the client can move it between queue and steer or
delete it — the same controls the plugin used to expose.

## Tests

```bash
bun test/smoke.ts
```