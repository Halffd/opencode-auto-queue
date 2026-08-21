# opencode-auto-queue

Queues outgoing chat messages when the session is busy, automatically draining and sending them once the session becomes idle. Prevents messages from being dropped or lost when the AI is still processing a previous prompt.

## Features

- **Hold and immediate modes** - queue messages when busy ("hold"), or send right away ("immediate")
- **Automatic retry** with exponential backoff for transient errors (network, 429 rate-limit, 5xx)
- **Queue persistence** to `.git/queue.json` (shared with `q.py` CLI) so queued messages survive restarts
- **File watcher** detects external changes (e.g. from `q.py`) and reloads state dynamically
- **Completion detection** pauses queue when the model's response contains only text (no tool calls) and matches completion patterns — stops mindless "continue" loops
- **Toast notifications** showing queue status (pending/sending/sent/failed items)
- **Pause/resume/cancel** queue processing per session
- **Full queue manipulation** (reorder, insert, append, prepend, delete, set, sort, invert)
- **Configurable** max queue size, retry delays, and drain behavior

## Installation

In `opencode.json`:

**npm/bun:**
```json
{
  "plugin": [
    "@Halffd/opencode-auto-queue"
  ]
}
```

**GitHub:**
```json
{
  "plugin": [
    "github:Halffd/opencode-auto-queue"
  ]
}
```

**Local:**
```json
{
  "plugin": [
    "file:///absolute/path/to/opencode-auto-queue"
  ]
}
```

## Tool

`queue` tool actions:

| Action | Description |
|--------|-------------|
| `hold` | Switch to hold mode (queue messages when busy) |
| `immediate` | Switch to immediate mode (send right away) |
| `status` | Show current queue status |
| `clear` | Clear all queued messages |
| `drop` | Drop a specific queued message |
| `peek` | Preview the next queued message |
| `retry` | Retry all failed messages |
| `pause` | Pause queue processing |
| `resume` | Resume queue processing |
| `cancel` | Cancel queue drain (keeps items, stops auto-send) |
| `count` | Show number of queued messages |
| `config` | Show configuration |
| `reorder` | Move item from one position to another |
| `insert` | Insert text at position |
| `append` | Append text to end of queue |
| `prepend` | Prepend text to front of queue |
| `delete` | Delete item at position |
| `set` | Replace item at position with new text |
| `sort` | Sort queue by enqueue time (oldest first) |
| `invert` | Reverse queue order |
| `get` | Show full details of an item |
| `sessions` | List all session queues with counts |

## Slash Commands

All tool actions also available as slash commands:

```
/queue-hold
/queue-immediate
/queue-status
/queue-clear
/queue-pause
/queue-resume
/queue-cancel
/queue-count
/queue-reorder <from> <to>
/queue-insert <pos> <text>
/queue-append <text>
/queue-prepend <text>
/queue-delete <index>
/queue-set <index> <text>
/queue-sort
/queue-invert
/queue-get <index>
/queue-sessions
```

Session targeting with `-s` flag:
```
/queue-status -s 1
/queue-drop 2 -s ses_abc123
```

## Configuration

Config (in `opencode.json`):

| Option | Default | Description |
|--------|---------|-------------|
| `toastDurationMs` | `10000` | Duration for queue status toasts |
| `emptyToastDurationMs` | `4000` | Duration for "queue empty" toast |
| `maxPreviews` | `3` | Max preview items shown in toast |
| `previewLength` | `28` | Character limit for message previews |
| `placeholderTemplate` | `"Queued; {count} pending"` | Template for placeholder text |
| `defaultMode` | `"hold"` | Default queue mode ("hold" or "immediate") |
| `maxRetries` | `5` | Max retry attempts per message |
| `retryBaseDelayMs` | `2000` | Base delay for exponential backoff |
| `retryMaxDelayMs` | `30000` | Cap for backoff delay |
| `maxQueueSize` | `5000` | Max queued messages per session |
| `drainDelayMs` | `500` | Delay before starting drain |
| `autoRetryOnIdle` | `true` | Auto-retry failed items on idle |
| `persistQueue` | `true` | Persist queue state to disk |
| `persistPath` | `""` | Custom path for queue state file (default: `.git/queue.json`) |
| `persistDebounceMs` | `1000` | Debounce interval for state saves |

## Completion Detection

When the assistant responds with **only text parts** (no tool calls, file ops, agent invocations), the plugin captures the response. If the text matches completion patterns (e.g., "all tasks complete", "nothing remaining to do") **and** the queue contains "continue" messages, it:

1. Pauses the queue
2. Shows a warning toast: `"Last response looked complete. Skipping N queued 'continue' messages — resume manually if more work is needed."`
3. Stops auto-draining until you run `/queue-resume`

This prevents the runaway loop where queued "continue" messages keep firing after the task is already done.

## q.py CLI Compatibility

The plugin shares `.git/queue.json` with the included `q.py` CLI. Both read/write the same JSON format:

```json
{
  "version": 1,
  "mode": "hold",
  "queues": { "sessionID": [...] },
  "pausedSessions": []
}
```

Changes from either tool are detected via file watcher and applied instantly — no restart needed.

### q.py Usage
```bash
q status              # show queue for first non-empty session
q status -s 2         # show queue for session index 2
q hold                # switch to hold mode
q immediate           # switch to immediate mode
q clear               # clear queue
q drop 1              # drop item 1
q peek                # preview next item
q retry               # retry failed items
q pause               # pause auto-drain
q resume              # resume auto-drain
q count               # pending count
q config              # show config
q sessions            # list all sessions
q reorder 2 1         # move item 2 to position 1
q insert 1 "text"     # insert at position 1
q append "text"       # append to end
q prepend "text"      # prepend to front
q delete 1            # delete item 1
q set 1 "text"        # replace item 1
q sort                # sort by time
q invert              # reverse order
q get 1               # show item details
```

Install `q.py` anywhere on PATH, or run `python3 /path/to/q.py`.