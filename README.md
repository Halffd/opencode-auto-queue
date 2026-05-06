# opencode-auto-queue

Queues outgoing chat messages when the session is busy, automatically draining and sending them once the session becomes idle. Prevents messages from being dropped or lost when the AI is still processing a previous prompt.

## Features

- **Hold and immediate modes** - queue messages when busy ("hold"), or send right away ("immediate")
- **Automatic retry** with exponential backoff for transient errors (network, 429 rate-limit, 5xx)
- **Queue persistence** to disk (JSON file) so queued messages survive restarts
- **Toast notifications** showing queue status (pending/sending/sent/failed items)
- **Pause/resume** queue processing per session
- **Configurable** max queue size, retry delays, and drain behavior

## Installation

In `opencode.json`:

**From GitHub:**

```json
{
  "plugin": [
    "github:Halffd/opencode-auto-queue"
  ]
}
```

**From local path:**

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
| `retry` | Retry a failed message |
| `pause` | Pause queue processing |
| `resume` | Resume queue processing |
| `count` | Show number of queued messages |
| `config` | Update queue configuration |

## Configuration

Config (in `opencode.json`):

| Option | Default | Description |
|--------|---------|-------------|
| `toastDurationMs` | `86400000` | Duration for queue status toasts |
| `emptyToastDurationMs` | `4000` | Duration for "queue empty" toast |
| `maxPreviews` | `3` | Max preview items shown in toast |
| `previewLength` | `28` | Character limit for message previews |
| `placeholderTemplate` | `"Queued; {count} pending"` | Template for placeholder text |
| `defaultMode` | `"hold"` | Default queue mode ("hold" or "immediate") |
| `maxRetries` | `5` | Max retry attempts per message |
| `retryBaseDelayMs` | `2000` | Base delay for exponential backoff |
| `retryMaxDelayMs` | `30000` | Cap for backoff delay |
| `maxQueueSize` | `100` | Max queued messages per session |
| `drainDelayMs` | `500` | Delay before starting drain |
| `autoRetryOnIdle` | `true` | Auto-retry failed items on idle |
| `persistQueue` | `true` | Persist queue state to disk |
| `persistPath` | `""` | Custom path for queue state file |
| `persistDebounceMs` | `1000` | Debounce interval for state saves |
