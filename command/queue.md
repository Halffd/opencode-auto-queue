---
description: Control message queue mode (hold/immediate/status)
---
Use the queue tool with action: $ARGUMENTS.

Auto-queue is always active: messages are held when the session is busy and drained automatically when idle.

Available actions:
- `status` — show current queue state
- `immediate` — drain all queued messages now
- `hold` — confirm auto-queue is active
