// opencode-auto-queue — OpenCode V2 server plugin.
//
// Holds user prompts in a per-session queue while the model is busy and drains
// them one at a time on idle. Supports hold/immediate modes, pause/resume,
// reorder/insert/delete, retry with backoff, completion detection, persistence
// to .git/queue.json (compatible with the external q.py CLI), and a queue
// management tool plus queue-* commands.
//
// V2 plugin API: default-export a definition with an id and setup(ctx).

import { Plugin } from "@opencode/plugin";
import { appendFileSync, mkdirSync, statSync, watch as fsWatch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEBUG_LOG_PATH = join(tmpdir(), "opencode-auto-queue-debug.log");

function debugLog(source: string, message: string, data?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const dataStr = data ? " " + JSON.stringify(data) : "";
  const line = `[${ts}] [${source}] ${message}${dataStr}\n`;
  try {
    appendFileSync(DEBUG_LOG_PATH, line);
  } catch {
    try {
      mkdirSync(tmpdir(), { recursive: true });
      appendFileSync(DEBUG_LOG_PATH, line);
    } catch { }
  }
}

interface AutoQueueOptions {
  maxPreviews?: number;
  previewLength?: number;
  defaultMode?: "hold" | "immediate";
  maxRetries?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  maxQueueSize?: number;
  drainDelayMs?: number;
  autoRetryOnIdle?: boolean;
  persistQueue?: boolean;
  persistPath?: string;
  persistDebounceMs?: number;
}

interface QueuedItem {
  sessionID: string;
  text: string;
  files?: { uri: string; name?: string; description?: string }[];
  agents?: string[];
  preview: string;
  status: "queued" | "sending" | "sent" | "failed";
  retries: number;
  lastError?: string;
  enqueuedAt: number;
}

// Persisted item shape (q.py compatible): parts array instead of plain text.
interface PersistedItem {
  sessionID: string;
  parts: { type: string; text?: string }[];
  files?: QueuedItem["files"];
  agents?: string[];
  preview: string;
  status: string;
  retries: number;
  lastError?: string;
  enqueuedAt: number;
}

interface PersistedState {
  version: number;
  mode: string;
  queues: Record<string, PersistedItem[]>;
  pausedSessions: string[];
}

function serializeItem(item: QueuedItem): PersistedItem {
  return {
    sessionID: item.sessionID,
    parts: [{ type: "text", text: item.text }],
    files: item.files,
    agents: item.agents,
    preview: item.preview,
    status: item.status === "sending" ? "queued" : item.status,
    retries: item.retries,
    lastError: item.lastError,
    enqueuedAt: item.enqueuedAt,
  };
}

function deserializeItem(item: PersistedItem): QueuedItem {
  const text = (item.parts ?? [])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");
  return {
    sessionID: item.sessionID ?? "",
    text,
    files: item.files,
    agents: item.agents,
    preview: item.preview ?? "[restored]",
    status: item.status === "failed" ? "failed" : "queued",
    retries: item.retries ?? 0,
    lastError: item.lastError,
    enqueuedAt: item.enqueuedAt ?? Date.now(),
  };
}

async function loadState(filePath: string): Promise<PersistedState | null> {
  try {
    const file = Bun.file(filePath);
    const exists = await file.exists();
    if (!exists) return null;
    const data = await file.json();
    if (!data || data.version !== 1) return null;
    return data as PersistedState;
  } catch {
    return null;
  }
}

function makeTruncate(previewLength: number) {
  return function truncatePreview(text: string): string {
    const len = previewLength;
    const trimmed = text.replace(/\s+/g, " ").trim();
    if (trimmed.length <= len) return trimmed;
    return `${trimmed.slice(0, len - 3)}...`;
  };
}

function extractPreview(text: string, truncatePreview: (t: string) => string): string {
  if (!text.trim()) return "[message]";
  return truncatePreview(text);
}

function getPendingCount(queue: QueuedItem[]): number {
  return queue.filter((item) => item.status === "queued" || item.status === "sending" || item.status === "failed").length;
}

function isTransientError(error: any): boolean {
  if (!error) return true;
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes("network") ||
    lower.includes("fetch") ||
    lower.includes("econnrefused") ||
    lower.includes("econnreset") ||
    lower.includes("etimedout") ||
    lower.includes("socket") ||
    lower.includes("abort") ||
    lower.includes("interrupt") ||
    lower.includes("cancel") ||
    lower.includes("timeout") ||
    lower.includes("429") ||
    lower.includes("rate") ||
    lower.includes("502") ||
    lower.includes("503") ||
    lower.includes("504") ||
    lower.includes("500") ||
    lower.includes("overloaded") ||
    lower.includes("capacity") ||
    lower.includes("temporarily") ||
    lower.includes("unavailable") ||
    lower.includes("retry") ||
    lower.includes("connection") ||
    lower.includes("refused") ||
    lower.includes("reset") ||
    lower.includes("broken pipe")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt: number, base: number, max: number): number {
  const jitter = Math.random() * base * 0.5;
  return Math.min(base * Math.pow(2, attempt) + jitter, max);
}

function makeBuildQueueStatus(truncatePreview: (text: string) => string) {
  return function buildQueueStatus(
    s: { modelBusy: boolean; queueOwner: boolean; paused: boolean; queue: QueuedItem[] },
    mode: string,
    maxPreviews: number,
    persistInfo: string,
  ): string {
    const pendingCount = getPendingCount(s.queue);
    const failedCount = s.queue.filter((i) => i.status === "failed").length;
    const lines = [
      `Mode: ${mode}`,
      `Model busy: ${s.modelBusy}`,
      `Queue owner: ${s.queueOwner}`,
      `Paused: ${s.paused}`,
      `Queued: ${pendingCount}`,
      `Failed: ${failedCount}`,
      `Persist: ${persistInfo}`,
    ];
    if (s.queue.length > 0) {
      lines.push("", "Queue:");
      s.queue.forEach((item, i) => {
        const icon = item.status === "sent" ? "[x]" : item.status === "sending" ? "[>]" : item.status === "failed" ? "[!]" : "[ ]";
        const retry = item.retries > 0 ? ` (${item.retries} retries)` : "";
        const age = Math.round((Date.now() - item.enqueuedAt) / 1000);
        lines.push(` ${i + 1}. ${icon} ${item.preview}${retry} [${age}s ago]`);
      });
    } else if (maxPreviews >= 0) {
      // keep quiet when empty; maxPreviews<0 disables this branch in compact status
    }
    return lines.join("\n");
  };
}

function snapshotState(s: { modelBusy: boolean; queueOwner: boolean; cancelled: boolean; paused: boolean; queue: QueuedItem[] }) {
  return {
    modelBusy: s.modelBusy,
    queueOwner: s.queueOwner,
    cancelled: s.cancelled,
    paused: s.paused,
    queueLen: s.queue.length,
    queueSummary: s.queue.map((i) => `${i.preview.slice(0, 20)}:${i.status}`),
  };
}

const COMPLETION_PATTERNS = [
  /all (tasks?|objectives?) (are )?complete/i,
  /nothing (remaining|more|left) to do/i,
  /all tests? pass.*nothing remaining/i,
  /task (is |has been )?complete/i,
  /work (is |has been )?complete/i,
  /done\.? (no|nothing) (more|else) (to do|needed)/i,
  /that (completes|finishes|wraps up) (it|this|everything)/i,
];

function looksComplete(text: string): boolean {
  return COMPLETION_PATTERNS.some((re) => re.test(text));
}

/** Thrown from the prompt hook to block admission of a message we queued. */
class QueuedByAutoQueueError extends Error {
  constructor(pendingCount: number) {
    super(`queued by opencode-auto-queue (${pendingCount} pending)`);
    this.name = "QueuedByAutoQueueError";
  }
}

export const AutoQueuePlugin = Plugin.define({
  id: "opencode-auto-queue",

  async setup(ctx: any) {
    const options: AutoQueueOptions = (ctx.options ?? {}) as AutoQueueOptions;
    const locationDir: string = ctx.location?.directory ?? process.cwd();

    debugLog("setup", "Plugin setup starting", { directory: locationDir, options });

    const {
      maxPreviews = 3,
      previewLength = 28,
      defaultMode = "hold",
      maxRetries = 5,
      retryBaseDelayMs = 2_000,
      retryMaxDelayMs = 30_000,
      maxQueueSize = 5000,
      drainDelayMs = 500,
      autoRetryOnIdle = true,
      persistQueue = true,
      persistPath = "",
      persistDebounceMs = 1_000,
    } = options;

    const truncatePreview = makeTruncate(previewLength);
    const buildQueueStatus = makeBuildQueueStatus(truncatePreview);

    const resolvedPersistPath = persistPath || `${locationDir}/.git/queue.json`;

    let currentMode: string = defaultMode;

    const stateBySession = new Map<string, {
      modelBusy: boolean;
      queueOwner: boolean;
      cancelled: boolean;
      paused: boolean;
      queue: QueuedItem[];
      lastAssistantResponse: string;
      modelWorking: boolean;
      textBuffer: string;
    }>();

    const workerRunning = new Set<string>();
    // Sessions whose prompt is being submitted by our own drain loop. The
    // prompt hook lets these through unconditionally to avoid re-queueing.
    const sendingNow = new Set<string>();

    let persistTimer: ReturnType<typeof setTimeout> | null = null;
    let fileWatcher: any = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let lastPersistedRaw = "";
    let disposed = false;

    function getSession(sessionID: string) {
      let s = stateBySession.get(sessionID);
      if (!s) {
        s = {
          modelBusy: false, queueOwner: false, cancelled: false, paused: false,
          queue: [], lastAssistantResponse: "", modelWorking: false, textBuffer: "",
        };
        stateBySession.set(sessionID, s);
        debugLog("getSession", "Created new session state", { sessionID });
      }
      return s;
    }

    async function persistState() {
      if (!persistQueue) return;
      const queues: Record<string, PersistedItem[]> = {};
      const pausedSessions: string[] = [];
      for (const [sessionID, s] of stateBySession.entries()) {
        const serializable = s.queue.filter((i) => i.status !== "sent").map(serializeItem);
        if (serializable.length > 0) queues[sessionID] = serializable;
        if (s.paused) pausedSessions.push(sessionID);
      }
      const state: PersistedState = { version: 1, mode: currentMode, queues, pausedSessions };
      try {
        const raw = JSON.stringify(state);
        await Bun.write(resolvedPersistPath, raw);
        lastPersistedRaw = raw;
        debugLog("persistState", "Persisted state", { path: resolvedPersistPath, queueCount: Object.keys(queues).length });
      } catch (e: any) {
        debugLog("persistState", "FAILED to persist state", { error: String(e) });
      }
    }

    function schedulePersist() {
      if (!persistQueue) return;
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = setTimeout(() => {
        persistTimer = null;
        persistState().catch(() => { });
      }, persistDebounceMs);
    }

    async function applyLoadedState(state: PersistedState) {
      if (state.mode === "hold" || state.mode === "immediate") currentMode = state.mode;
      if (state.pausedSessions) {
        for (const sid of state.pausedSessions) getSession(sid).paused = true;
      }
      if (state.queues) {
        for (const [sessionID, items] of Object.entries(state.queues)) {
          if (workerRunning.has(sessionID)) {
            debugLog("applyLoadedState", "SKIP session: worker running, avoiding clobber", { sessionID });
            continue;
          }
          getSession(sessionID).queue = items.map(deserializeItem);
        }
      }
    }

    async function restoreState() {
      if (!persistQueue) return;
      const state = await loadState(resolvedPersistPath);
      if (!state) {
        debugLog("restoreState", "No persisted state found", { path: resolvedPersistPath });
        return;
      }
      debugLog("restoreState", "Loaded persisted state", {
        path: resolvedPersistPath, mode: state.mode,
        pausedCount: state.pausedSessions?.length,
        queueCount: Object.keys(state.queues ?? {}).length,
      });
      await applyLoadedState(state);
    }

    await restoreState();

    if (persistQueue) {
      const reloadExternal = async () => {
        try {
          const file = Bun.file(resolvedPersistPath);
          if (!(await file.exists())) return;
          const raw = await file.text();
          if (raw === lastPersistedRaw || raw === lastExternalRaw) return;
          const data = JSON.parse(raw);
          if (!data || data.version !== 1) return;
          lastExternalRaw = raw;
          debugLog("fileWatcher", "External queue change detected, reloading", { mode: data.mode, queueCount: Object.keys(data.queues ?? {}).length });
          await applyLoadedState(data as PersistedState);
          debugLog("fileWatcher", "State reloaded", { mode: data.mode });
        } catch (e: any) {
          debugLog("fileWatcher", "Failed to process change", { error: String(e?.message ?? e) });
        }
      };

      let lastExternalRaw = "";
      let lastSeenMtime = 0;
      try {
        lastSeenMtime = statSync(resolvedPersistPath).mtimeMs;
      } catch { }

      try {
        const watchDir = resolvedPersistPath.substring(0, resolvedPersistPath.lastIndexOf("/")) || ".";
        const baseName = resolvedPersistPath.substring(resolvedPersistPath.lastIndexOf("/") + 1);
        // Bun.watch is unavailable inside the OpenCode server runtime; use the
        // Node-compatible fs.watch instead.
        fileWatcher = fsWatch(watchDir, { recursive: false }, (_eventType, filename) => {
          if (disposed) return;
          if (filename && filename !== baseName) return;
          reloadExternal().catch(() => { });
        });
        debugLog("fileWatcher", "Watching directory for queue file changes", { watchDir, baseName });
      } catch (e: any) {
        fileWatcher = null;
        debugLog("fileWatcher", "Watcher stopped", { error: String(e?.message ?? e) });
      }

      // Polling fallback: inotify does not fire on every filesystem/mount
      // (container bind mounts, network fs). Poll the file so external edits
      // via q.py are picked up everywhere.
      pollTimer = setInterval(() => {
        if (disposed) return;
        try {
          const mtime = statSync(resolvedPersistPath).mtimeMs;
          if (mtime !== lastSeenMtime) {
            lastSeenMtime = mtime;
            reloadExternal().catch(() => { });
          }
        } catch { }
      }, 2_000);
    }

    /** User-visible feedback. V2 server plugins have no toast API; inject a
     *  synthetic message instead. */
    async function notify(sessionID: string, message: string, description = "opencode-auto-queue") {
      try {
        await ctx.session.synthetic({ sessionID, text: message, description });
      } catch (e: any) {
        debugLog("notify", "synthetic failed", { sessionID, error: String(e?.message ?? e) });
      }
    }

    function makeTextItem(sessionID: string, text: string): QueuedItem {
      return {
        sessionID,
        text,
        preview: extractPreview(text, truncatePreview),
        status: "queued",
        retries: 0,
        enqueuedAt: Date.now(),
      };
    }

    async function tick(sessionID: string) {
      if (disposed) return;
      if (workerRunning.has(sessionID)) {
        debugLog("tick", "EXIT: worker already running", { sessionID });
        return;
      }
      const s = getSession(sessionID);

      if (s.queue.length === 0) {
        debugLog("tick", "EXIT: queue empty", { sessionID });
        return;
      }
      if (s.modelBusy) {
        debugLog("tick", "EXIT: modelBusy=true", { sessionID });
        return;
      }
      if (s.paused) {
        debugLog("tick", "EXIT: paused=true", { sessionID });
        return;
      }
      if (s.cancelled) {
        debugLog("tick", "EXIT: cancelled=true, clearing cancelled+queueOwner", { sessionID });
        s.cancelled = false;
        s.queueOwner = false;
        return;
      }

      workerRunning.add(sessionID);
      debugLog("tick", "Worker started", { sessionID });
      try {
        if (drainDelayMs > 0) await sleep(drainDelayMs);
        if (disposed) return;

        const next = s.queue.find((item) => item.status === "queued" || (item.status === "failed" && autoRetryOnIdle));
        if (!next) {
          debugLog("tick", "EXIT: no queued/failed item found after delay", { sessionID });
          return;
        }

        if (!s.modelWorking && s.lastAssistantResponse && looksComplete(s.lastAssistantResponse)) {
          const continueCount = s.queue.filter((item) => item.status === "queued" && item.preview.toLowerCase().includes("continue")).length;
          if (continueCount > 0) {
            debugLog("tick", "COMPLETION DETECTED: pausing queue instead of draining continues", {
              sessionID, continueCount, lastResponse: s.lastAssistantResponse.slice(0, 200),
            });
            s.paused = true;
            await notify(
              sessionID,
              `Last response looked complete. Skipping ${continueCount} queued "continue" message${continueCount > 1 ? "s" : ""} — resume manually if more work is needed.`,
            );
            schedulePersist();
            return;
          }
        }

        if (s.modelBusy) {
          debugLog("tick", "EXIT: modelBusy became true after delay", { sessionID });
          return;
        }
        if (s.paused) {
          debugLog("tick", "EXIT: paused became true after delay", { sessionID });
          return;
        }
        if (s.cancelled) {
          debugLog("tick", "EXIT: cancelled became true after delay, clearing", { sessionID });
          s.cancelled = false;
          s.queueOwner = false;
          return;
        }

        debugLog("tick", "Sending item", { sessionID, preview: next.preview, status: next.status, retries: next.retries });
        next.status = "sending";
        s.queueOwner = true;
        schedulePersist();

        let sent = false;
        let attempts = 0;
        const maxAttempts = maxRetries + 1;

        while (!sent && attempts < maxAttempts) {
          if (s.cancelled) {
            debugLog("tick", "CANCELLED during send loop, aborting", { sessionID, attempts });
            s.cancelled = false;
            s.queueOwner = false;
            next.status = "queued";
            return;
          }
          attempts++;
          try {
            debugLog("tick", "Calling session.prompt", { sessionID, attempt: attempts, preview: next.preview });
            sendingNow.add(sessionID);
            try {
              await ctx.session.prompt({
                sessionID,
                text: next.text,
                files: next.files,
                agents: next.agents,
              });
            } finally {
              sendingNow.delete(sessionID);
            }
            debugLog("tick", "session.prompt RESOLVED (accepted)", { sessionID, preview: next.preview });
            if (s.cancelled) {
              debugLog("tick", "CANCELLED after prompt resolved, aborting", { sessionID });
              s.cancelled = false;
              s.queueOwner = false;
              next.status = "queued";
              return;
            }
            next.status = "sent";
            next.lastError = undefined;
            sent = true;
          } catch (error: any) {
            const errMsg = error instanceof Error ? error.message : String(error);
            debugLog("tick", "session.prompt REJECTED", {
              sessionID, error: errMsg.slice(0, 200), isTransient: isTransientError(error), attempt: attempts,
            });
            if (isTransientError(error) && attempts < maxAttempts) {
              next.retries = attempts;
              next.lastError = errMsg;
              next.status = "failed";
              const delay = backoffDelay(attempts - 1, retryBaseDelayMs, retryMaxDelayMs);
              debugLog("tick", "Transient error, retrying", { sessionID, delay, attempt: attempts });
              await notify(
                sessionID,
                `Retrying "${truncatePreview(next.preview)}" in ${Math.round(delay / 1000)}s (attempt ${attempts}/${maxRetries})\nError: ${errMsg.slice(0, 80)}`,
              );
              await sleep(delay);
              next.status = "queued";
            } else {
              next.retries = attempts;
              next.lastError = errMsg;
              next.status = "failed";
              debugLog("tick", "Non-transient error or max retries, marking failed", { sessionID, attempt: attempts });
              await notify(sessionID, `Failed "${truncatePreview(next.preview)}" after ${attempts} attempts: ${errMsg.slice(0, 100)}`);
              break;
            }
          }
        }

        const beforeFilter = s.queue.length;
        s.queue = s.queue.filter((item) => item.status !== "sent");
        debugLog("tick", "Filtered sent items", { sessionID, before: beforeFilter, after: s.queue.length, sent });
        schedulePersist();

        if (sent) {
          s.queueOwner = true;
          const hasMore = s.queue.some((item) => item.status === "queued" || (item.status === "failed" && autoRetryOnIdle));
          if (hasMore) {
            debugLog("tick", "Item sent, queue has more items, scheduling re-tick", { sessionID, queueRemaining: s.queue.length });
            setTimeout(() => tick(sessionID).catch(() => { }), 0);
          } else {
            debugLog("tick", "Item sent, queue empty, waiting for idle", { sessionID });
          }
        } else if (next.status === "failed") {
          const more = s.queue.find((item) => item.status === "queued" || (item.status === "failed" && autoRetryOnIdle));
          if (more) {
            debugLog("tick", "Send failed permanently, but more items in queue, re-ticking", { sessionID });
            s.queueOwner = false;
            tick(sessionID).catch(() => { });
          } else {
            s.queueOwner = false;
          }
        }
      } finally {
        workerRunning.delete(sessionID);
        debugLog("tick", "Worker finished", { sessionID, state: snapshotState(s) });
      }
    }

    // ---------------------------------------------------------------
    // Shared action handler for the queue tool and queue-* commands.
    // Returns a human-readable result string.
    // ---------------------------------------------------------------

    const VALID_SLASH_COMMANDS = [
      "hold", "immediate", "status", "clear", "pause", "resume", "cancel", "count",
      "reorder", "insert", "append", "prepend", "delete", "set", "sort", "invert", "get",
    ];

    function parseIndex(arg: string): number | null {
      const n = parseInt(arg, 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    }

    function normalizeCommandName(cmd: string): string {
      let name = cmd.replace(/^\//, "").toLowerCase();
      if (name.startsWith("queue-")) name = name.slice("queue-".length);
      if (name.startsWith("queue ")) name = name.slice("queue ".length).trim();
      return name.trim();
    }

    async function handleAction(rawCmd: string, args: string, sessionID: string): Promise<string | null> {
      const normalized = normalizeCommandName(rawCmd);
      const s = getSession(sessionID);
      const pendingCount = getPendingCount(s.queue);
      const failedCount = s.queue.filter((i) => i.status === "failed").length;

      switch (normalized) {
        case "hold":
          if (currentMode === "hold") return "Queue mode: hold (already active)";
          currentMode = "hold";
          schedulePersist();
          return "Queue mode: hold (messages queued when busy)";
        case "immediate":
          if (currentMode === "immediate") return "Queue mode: immediate (already active)";
          currentMode = "immediate";
          schedulePersist();
          tick(sessionID).catch(() => { });
          return "Queue mode: immediate (messages sent right away)";
        case "status":
          return buildQueueStatus(s, currentMode, maxPreviews, persistQueue ? `true (${resolvedPersistPath})` : "false");
        case "config":
          return [
            "Queue Configuration:",
            ` mode: ${currentMode} (default: ${defaultMode})`,
            ` maxQueueSize: ${maxQueueSize}`,
            ` maxRetries: ${maxRetries}`,
            ` retryBaseDelayMs: ${retryBaseDelayMs}`,
            ` retryMaxDelayMs: ${retryMaxDelayMs}`,
            ` drainDelayMs: ${drainDelayMs}`,
            ` autoRetryOnIdle: ${autoRetryOnIdle}`,
            ` persistQueue: ${persistQueue}`,
            ` persistPath: ${resolvedPersistPath}`,
            ` persistDebounceMs: ${persistDebounceMs}`,
            ` previewLength: ${previewLength}`,
            ` maxPreviews: ${maxPreviews}`,
          ].join("\n");
        case "count":
          return `${pendingCount} messages in queue (${failedCount} failed)`;
        case "peek": {
          const next = s.queue.find((item) => item.status === "queued" || item.status === "failed");
          if (!next) return "Queue is empty";
          const retry = next.retries > 0 ? ` (retried ${next.retries}x)` : "";
          const age = Math.round((Date.now() - next.enqueuedAt) / 1000);
          return `Next: ${next.preview}${retry} [waiting ${age}s]`;
        }
        case "clear": {
          const cleared = s.queue.length;
          s.queue = [];
          s.queueOwner = false;
          schedulePersist();
          return `Cleared ${cleared} messages from queue`;
        }
        case "drop": {
          const idx = parseIndex(args) ?? 1;
          if (idx < 1 || idx > s.queue.length) return `Invalid index. Queue has ${s.queue.length} items.`;
          const dropped = s.queue.splice(idx - 1, 1)[0];
          schedulePersist();
          return `Dropped: ${dropped.preview}`;
        }
        case "retry": {
          const failedItems = s.queue.filter((i) => i.status === "failed");
          if (failedItems.length === 0) return "No failed items to retry.";
          for (const item of failedItems) {
            item.status = "queued";
            item.retries = 0;
            item.lastError = undefined;
          }
          schedulePersist();
          tick(sessionID).catch(() => { });
          return `Retrying ${failedItems.length} failed messages`;
        }
        case "pause":
          s.paused = true;
          schedulePersist();
          return "Queue paused.";
        case "resume":
          s.paused = false;
          schedulePersist();
          tick(sessionID).catch(() => { });
          return "Queue resumed. Draining pending messages.";
        case "cancel":
          s.cancelled = true;
          s.queueOwner = false;
          schedulePersist();
          return "Queue drain cancelled. No more items will be auto-sent.";
        case "reorder": {
          const parts = args.trim().split(/\s+/);
          const from = parseIndex(parts[0]);
          const to = parseIndex(parts[1]);
          if (!from || !to) return "Usage: reorder <from> <to> (1-based indices)";
          if (from > s.queue.length || to > s.queue.length) return `Index out of range. Queue has ${s.queue.length} items.`;
          const [item] = s.queue.splice(from - 1, 1);
          s.queue.splice(to - 1, 0, item);
          schedulePersist();
          return `Moved item ${from} to position ${to}`;
        }
        case "insert": {
          const firstSpace = args.indexOf(" ");
          if (firstSpace === -1) return "Usage: insert <index> <text>";
          const idx = parseIndex(args.slice(0, firstSpace));
          const txt = args.slice(firstSpace + 1).trim();
          if (!idx) return "Invalid index. Must be a positive number.";
          if (!txt) return "No text provided.";
          if (idx > s.queue.length + 1) return `Index out of range. Queue has ${s.queue.length} items.`;
          const item = makeTextItem(sessionID, txt);
          s.queue.splice(idx - 1, 0, item);
          schedulePersist();
          return `Inserted at position ${idx}: ${item.preview}`;
        }
        case "append": {
          const txt = args.trim();
          if (!txt) return "Usage: append <text>";
          const item = makeTextItem(sessionID, txt);
          s.queue.push(item);
          schedulePersist();
          return `Appended: ${item.preview}`;
        }
        case "prepend": {
          const txt = args.trim();
          if (!txt) return "Usage: prepend <text>";
          const item = makeTextItem(sessionID, txt);
          s.queue.unshift(item);
          schedulePersist();
          return `Prepended: ${item.preview}`;
        }
        case "delete": {
          const idx = parseIndex(args.trim());
          if (!idx) return "Usage: delete <index> (1-based)";
          if (idx < 1 || idx > s.queue.length) return `Index out of range. Queue has ${s.queue.length} items.`;
          const dropped = s.queue.splice(idx - 1, 1)[0];
          schedulePersist();
          return `Deleted: ${dropped.preview}`;
        }
        case "set": {
          const firstSpace = args.indexOf(" ");
          if (firstSpace === -1) return "Usage: set <index> <text>";
          const idx = parseIndex(args.slice(0, firstSpace));
          const txt = args.slice(firstSpace + 1).trim();
          if (!idx) return "Invalid index.";
          if (!txt) return "No text provided.";
          if (idx < 1 || idx > s.queue.length) return `Index out of range. Queue has ${s.queue.length} items.`;
          const item = makeTextItem(sessionID, txt);
          s.queue[idx - 1] = item;
          schedulePersist();
          return `Set position ${idx}: ${item.preview}`;
        }
        case "sort":
          s.queue.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
          schedulePersist();
          return `Sorted ${s.queue.length} items by time (oldest first)`;
        case "invert":
          s.queue.reverse();
          schedulePersist();
          return `Reversed ${s.queue.length} items`;
        case "get": {
          const idx = parseIndex(args.trim());
          if (!idx) return "Usage: get <index> (1-based)";
          if (idx < 1 || idx > s.queue.length) return `Index out of range. Queue has ${s.queue.length} items.`;
          const item = s.queue[idx - 1];
          const age = Math.round((Date.now() - item.enqueuedAt) / 1000);
          const retry = item.retries > 0 ? `\nRetries: ${item.retries}` : "";
          const err = item.lastError ? `\nError: ${item.lastError}` : "";
          return [
            `Item ${idx}/${s.queue.length} status: ${item.status} age: ${age}s${retry}${err}`,
            `Preview: ${item.preview}`,
            `Content:`,
            item.text || "(no text content)",
          ].join("\n");
        }
        default:
          return null;
      }
    }

    // ---------------------------------------------------------------
    // Tool registration: "queue" tool with all actions.
    // ---------------------------------------------------------------

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "queue",
        description:
          "Control message queue. Actions: hold, immediate, status, clear, drop, peek, retry, pause, resume, cancel, count, config, reorder, insert, append, prepend, delete, set, sort, invert, get. Only switch modes when explicitly requested.",
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["hold", "immediate", "status", "clear", "drop", "peek", "retry", "pause", "resume", "cancel", "count", "config", "reorder", "insert", "append", "prepend", "delete", "set", "sort", "invert", "get"],
              description: "Action to perform",
            },
            args: {
              type: "string",
              description: "Arguments for the action (e.g. '2' for delete, '2 new text' for set, '1 3' for reorder)",
            },
          },
          required: ["action"],
          additionalProperties: false,
        },
        async execute(input: any, context: any) {
          const action = input?.action ?? "status";
          const args = input?.args ?? "";
          const sessionID = context?.sessionID;
          debugLog("tool", "Queue tool invoked", { action, args, sessionID });
          if (!sessionID) return { content: "queue tool requires a session context" };
          const result = await handleAction(action, args, sessionID);
          return { content: result ?? `Unknown action: ${action}` };
        },
      });
    });

    // ---------------------------------------------------------------
    // Command registration: /queue-* commands.
    // ---------------------------------------------------------------

    const commandDescriptions: Record<string, string> = {
      "queue-hold": "Switch queue to hold mode (auto-drain on idle)",
      "queue-immediate": "Switch queue to immediate mode",
      "queue-status": "Show queue status",
      "queue-clear": "Clear the queue",
      "queue-pause": "Pause auto-drain",
      "queue-resume": "Resume auto-drain",
      "queue-cancel": "Cancel active queue drain",
      "queue-count": "Show pending item count",
      "queue-reorder": "Reorder: /queue-reorder <from> <to>",
      "queue-insert": "Insert: /queue-insert <pos> <text>",
      "queue-append": "Append text to queue",
      "queue-prepend": "Prepend text to queue",
      "queue-delete": "Delete: /queue-delete <index>",
      "queue-set": "Set: /queue-set <index> <text>",
      "queue-sort": "Sort queue by time",
      "queue-invert": "Reverse queue order",
      "queue-get": "Get: /queue-get <index>",
    };

    await ctx.command.transform((editor: any) => {
      for (const [name, description] of Object.entries(commandDescriptions)) {
        editor.add({
          name,
          description,
          execute: async ({ sessionID, prompt }: any) => {
            const args = prompt?.text ?? "";
            debugLog("command", "Command invoked", { name, sessionID, argsLen: args.length });
            const result = await handleAction(name, args, sessionID);
            if (result === null) return;
            await notify(sessionID, result);
          },
        });
      }
    });

    // ---------------------------------------------------------------
    // Prompt hook: the queueing core. Runs before durable inbox admission.
    // ---------------------------------------------------------------

    await ctx.session.hook("prompt", async (event: any) => {
      if (disposed) return;
      const sessionID: string = event.sessionID;
      if (!sessionID) return;

      // Allow our own drain prompts to pass through unmodified
      if (sendingNow.has(sessionID)) {
        debugLog("prompt", "EXIT: our own drain prompt, passing through", { sessionID });
        return;
      }

      if (currentMode !== "hold") {
        debugLog("prompt", "EXIT: not in hold mode", { sessionID, mode: currentMode });
        return;
      }

      const s = getSession(sessionID);
      const prompt = event.prompt ?? {};

      // If the prompt is internal (drain), skip queueing
      if (prompt.metadata?.internal) {
        debugLog("prompt", "EXIT: internal prompt, passing through", { sessionID });
        return;
      }

      const text: string = prompt.text ?? "";
      const files = prompt.files;
      const agents = prompt.agents;
      const skills = prompt.skills;

      if (!s.modelBusy) {
        debugLog("prompt", "Model NOT busy -> letting message through (setting modelBusy=true)", { sessionID });
        s.modelBusy = true;
        if (s.cancelled) {
          debugLog("prompt", "Clearing stale cancelled flag (fresh user message)", { sessionID });
          s.cancelled = false;
        }
        return;
      }

      debugLog("prompt", "Model IS busy -> queuing message", { sessionID, queueLenBefore: s.queue.length });

      if (s.queue.length >= maxQueueSize) {
        debugLog("prompt", "Queue FULL, replacing with placeholder", { sessionID, maxQueueSize });
        await notify(sessionID, `Queue full (${maxQueueSize} max). Message dropped.`);
        // Replace the user's message with a placeholder so it is not lost
        event.prompt.text = `Queue full (${maxQueueSize} max). Message dropped.`;
        event.prompt.files = [];
        event.prompt.agents = [];
        event.prompt.skills = [];
        return;
      }

      const item: QueuedItem = {
        sessionID,
        text,
        files: files && files.length > 0 ? files : undefined,
        agents: agents && agents.length > 0 ? agents : undefined,
        preview: extractPreview(text, truncatePreview),
        status: "queued",
        retries: 0,
        enqueuedAt: Date.now(),
      };
      s.queue.push(item);
      schedulePersist();

      const pending = getPendingCount(s.queue);
      debugLog("prompt", "Message enqueued, replacing with placeholder", {
        sessionID, preview: item.preview, queueLenAfter: s.queue.length,
      });
      await notify(sessionID, `Queued (${pending} pending): ${item.preview}`);

      // Replace the user's message with a placeholder to prevent it from being sent now.
      event.prompt.text = `Queued; ${pending} pending`;
      event.prompt.files = [];
      event.prompt.agents = [];
      event.prompt.skills = [];
    });

    // ---------------------------------------------------------------
    // Event stream: busy tracking, completion detection, abort handling.
    // ---------------------------------------------------------------

    const controller = new AbortController();

    const isOtherLocation = (ev: any) =>
      ev?.location?.directory && ctx.location?.directory && ev.location.directory !== ctx.location.directory;

    async function handleIdleTransition(sessionID: string, source: string, wasBusy: boolean) {
      const s = getSession(sessionID);
      s.modelBusy = false;
      debugLog(source, "idle", { sessionID, wasBusy, queueOwnerBefore: s.queueOwner, queueLen: s.queue.length });
      if (!wasBusy) {
        debugLog(source, "was NOT busy, ignoring (duplicate idle?)", { sessionID });
        return;
      }
      const hasQueued = s.queue.some((item) => item.status === "queued" || (item.status === "failed" && autoRetryOnIdle));
      if (!hasQueued) {
        debugLog(source, "was busy, no queued items to drain", { sessionID });
        return;
      }
      if (!s.modelWorking && s.lastAssistantResponse && looksComplete(s.lastAssistantResponse)) {
        const continueCount = s.queue.filter((item) => item.status === "queued" && item.preview.toLowerCase().includes("continue")).length;
        if (continueCount > 0) {
          debugLog(source, "COMPLETION DETECTED: not auto-draining continues", {
            sessionID, continueCount, lastResponse: s.lastAssistantResponse.slice(0, 200),
          });
          s.paused = true;
          await notify(
            sessionID,
            `Last response looked complete. Skipping ${continueCount} queued "continue" message${continueCount > 1 ? "s" : ""} — resume manually if more work is needed.`,
          );
          schedulePersist();
          return;
        }
      }
      debugLog(source, "busy->idle with queued items, ticking", { sessionID });
      s.queueOwner = false;
      s.cancelled = false;
      tick(sessionID).catch(() => { });
    }

    (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
          if (disposed) return;
          if (!ev || typeof ev.type !== "string") continue;
          const data = ev.data ?? {};
          const sessionID: string | undefined = data.sessionID;
          if (!sessionID) continue;
          if (isOtherLocation(ev)) continue;
          const s = getSession(sessionID);

          switch (ev.type) {
            case "session.status": {
              const nowBusy = data.status?.type !== "idle";
              const wasBusy = s.modelBusy;
              s.modelBusy = nowBusy;
              debugLog("event", "session.status", { sessionID, statusType: data.status?.type, nowBusy, wasBusy });
              if (wasBusy && !nowBusy) await handleIdleTransition(sessionID, "session.status", wasBusy);
              break;
            }
            case "session.idle": {
              const wasBusy = s.modelBusy;
              await handleIdleTransition(sessionID, "session.idle", wasBusy);
              break;
            }
            case "session.execution.interrupted": {
              // User pressed escape / session interrupted: stop draining.
              debugLog("event", "session.execution.interrupted", { sessionID, reason: data.reason });
              if (data.reason === "user" || data.reason === "superseded") {
                s.cancelled = true;
                s.queueOwner = false;
                s.modelBusy = false;
              }
              break;
            }
            case "session.execution.failed": {
              const errName = data.error?.name ?? "";
              debugLog("event", "session.execution.failed", { sessionID, errorName: errName, msg: String(data.error?.message ?? "").slice(0, 200) });
              if (/abort/i.test(errName)) {
                s.cancelled = true;
                s.queueOwner = false;
                s.modelBusy = false;
              }
              break;
            }
            case "session.execution.started": {
              s.modelBusy = true;
              debugLog("event", "session.execution.started", { sessionID });
              break;
            }
            case "session.execution.succeeded": {
              debugLog("event", "session.execution.succeeded", { sessionID });
              s.modelBusy = false;
              break;
            }
            case "session.text.started": {
              s.textBuffer = "";
              break;
            }
            case "session.text.delta": {
              s.textBuffer += data.delta ?? "";
              break;
            }
            case "session.text.ended": {
              if (s.textBuffer.trim()) {
                s.lastAssistantResponse = s.textBuffer;
                s.modelWorking = false;
                debugLog("event", "Captured assistant text response", { sessionID, len: s.textBuffer.length, looksComplete: looksComplete(s.textBuffer) });
              }
              s.textBuffer = "";
              break;
            }
            case "session.tool.called":
            case "session.tool.success":
            case "session.tool.failed": {
              // Tool activity means the model is still working; a plain-text
              // answer afterwards is what counts as the final response.
              s.modelWorking = true;
              s.lastAssistantResponse = "";
              break;
            }
            default:
              break;
          }
        }
      } catch (e: any) {
        if (!disposed) debugLog("events", "Event stream ended", { error: String(e?.message ?? e) });
      }
    })();

    debugLog("setup", "Plugin setup complete", { directory: locationDir, persistPath: resolvedPersistPath });

    // Cleanup: abort event loop, close watcher, flush state.
    return () => {
      disposed = true;
      controller.abort();
      try { fileWatcher?.close?.(); } catch { }
      if (pollTimer) clearInterval(pollTimer);
      if (persistTimer) clearTimeout(persistTimer);
      persistState().catch(() => { });
      debugLog("setup", "Plugin cleanup complete", { directory: locationDir });
    };  },
});

export default AutoQueuePlugin;
