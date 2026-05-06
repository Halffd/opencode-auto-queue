---
description: Control message queue (hold/immediate/status/clear/drop/peek/retry/pause/resume/count/config)
---
Use the queue tool with action: $ARGUMENTS.

Auto-queue is always active: messages are held when the session is busy and drained automatically when idle. Network and request errors are retried with exponential backoff. Queue state is persisted to disk and restored on restart.

Available actions:
- `status` — show full queue state with item list, ages, and retry counts
- `config` — show all queue configuration values
- `hold` — queue messages when session is busy (default)
- `immediate` — send all queued messages now
- `clear` — remove all messages from queue
- `drop N` — remove item at 1-based index N
- `peek` — show the next message that will be sent
- `retry` — re-queue all failed messages for retry
- `pause` — stop automatic drain (messages accumulate but won't send)
- `resume` — resume automatic drain after pause
- `count` — show number of pending messages

Configuration (in opencode.json plugin options):
- `defaultMode` — "hold" (default) or "immediate"
- `maxQueueSize` — max messages per session (default: 100)
- `maxRetries` — retry attempts on transient errors (default: 5)
- `retryBaseDelayMs` — initial retry delay (default: 2000)
- `retryMaxDelayMs` — max retry delay cap (default: 30000)
- `drainDelayMs` — pause before draining starts (default: 500)
- `autoRetryOnIdle` — auto-retry failed items on idle (default: true)
- `persistQueue` — persist queue to disk (default: true)
- `persistPath` — custom path for queue state file
- `persistDebounceMs` — debounce disk writes (default: 1000)
- `previewLength` — max chars for message previews (default: 28)
- `maxPreviews` — items shown in toast (default: 3)
- `placeholderTemplate` — text shown for queued messages, use {count} (default: "Queued (will send after current run); {count} pending")
- `toastDurationMs` — how long queue toasts stay (default: 86400000)
- `emptyToastDurationMs` — how long "queue empty" toast stays (default: 4000)
