import { tool } from "@opencode-ai/plugin";
import { appendFileSync, mkdirSync } from "node:fs";
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
  toastDurationMs?: number;
  emptyToastDurationMs?: number;
  maxPreviews?: number;
  previewLength?: number;
  placeholderTemplate?: string;
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

const INTERNAL_KEY = "__auto_queue_internal";

interface QueuedItem {
  sessionID: string;
  agent?: string;
  model?: { providerID: string; modelID: string };
  system?: string;
  tools?: string[];
  messageID?: string;
  variant?: string;
  parts: any[];
  preview: string;
  status: "queued" | "sending" | "sent" | "failed";
  retries: number;
  lastError?: string;
  enqueuedAt: number;
}

interface PersistedState {
  version: number;
  mode: string;
  queues: Record<string, QueuedItem[]>;
  pausedSessions: string[];
}

function serializeQueue(queue: QueuedItem[]): any[] {
  return queue.filter((i) => i.status !== "sent").map((item) => ({
    sessionID: item.sessionID,
    agent: item.agent,
    model: item.model,
    system: item.system,
    tools: item.tools,
    messageID: item.messageID,
    variant: item.variant,
    parts: item.parts,
    preview: item.preview,
    status: item.status === "sending" ? "queued" : item.status,
    retries: item.retries,
    lastError: item.lastError,
    enqueuedAt: item.enqueuedAt,
  }));
}

function deserializeQueue(items: any[]): QueuedItem[] {
  return items.map((item) => ({
    sessionID: item.sessionID ?? "",
    agent: item.agent,
    model: item.model,
    system: item.system,
    tools: item.tools,
    messageID: item.messageID,
    variant: item.variant,
    parts: item.parts ?? [],
    preview: item.preview ?? "[restored]",
    status: (item.status === "queued" || item.status === "failed") ? item.status : "queued",
    retries: item.retries ?? 0,
    lastError: item.lastError,
    enqueuedAt: item.enqueuedAt ?? Date.now(),
  }));
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

function makeExtractPreview(truncatePreview: (text: string) => string) {
  return function extractPreview(parts: any[]): string {
    const text = parts.find((p: any) => p.type === "text");
    if (text && "text" in text) return truncatePreview(text.text);
    if (parts.some((p: any) => p.type === "file")) return "[file]";
    if (parts.some((p: any) => p.type === "agent")) return "[agent]";
    if (parts.some((p: any) => p.type === "subtask")) return "[subtask]";
    return "[message]";
  };
}

function toPromptPart(part: any): any {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "file":
      return { type: "file", url: part.url, mime: part.mime, filename: part.filename, source: part.source };
    case "agent":
      return { type: "agent", name: part.name, source: part.source };
    case "subtask":
      return { type: "subtask", prompt: part.prompt, description: part.description, agent: part.agent };
    default:
      return null;
  }
}

function makePlaceholder(parts: any[], count: number, template: string): any {
  const tmpl = parts.find((p: any) => p.type === "text") ?? parts[0];
  if (!tmpl) return null;
  return {
    id: tmpl.id,
    sessionID: tmpl.sessionID,
    messageID: tmpl.messageID,
    type: "text",
    text: template.replace("{count}", String(count)),
    synthetic: true,
    ignored: true,
  };
}

function isInternalMessage(parts: any[]): boolean {
  return parts.some((p: any) => p.type === "text" && Boolean(p.metadata?.[INTERNAL_KEY]));
}

function markInternalParts(parts: any[]): any[] {
  let hasText = false;
  const marked = parts.map((part: any) => {
    if (part.type !== "text") return part;
    hasText = true;
    const existing = part.metadata ?? {};
    return { ...part, metadata: { ...existing, [INTERNAL_KEY]: true } };
  });
  if (hasText) return marked;
  const markerPart = { type: "text", text: "", synthetic: true, ignored: true, metadata: { [INTERNAL_KEY]: true } };
  return [markerPart, ...marked];
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
  const delay = Math.min(base * Math.pow(2, attempt) + jitter, max);
  return delay;
}

function makeBuildToastMessage(truncatePreview: (text: string) => string) {
  return function buildToastMessage(queue: QueuedItem[], maxPreviews: number): string {
    const pendingCount = getPendingCount(queue);
    const failedCount = queue.filter((i) => i.status === "failed").length;
    const previewCount = Math.min(queue.length, maxPreviews);
    const previews = queue.slice(0, previewCount).map((item, index) => {
      const text = truncatePreview(item.preview);
      if (item.status === "sent") return ` ${index + 1}. [x] ~~${text}~~`;
      if (item.status === "sending") return ` ${index + 1}. [>] ${text}`;
      if (item.status === "failed") return ` ${index + 1}. [!] ${text} (${item.retries} retries)`;
      return ` ${index + 1}. [ ] ${text}`;
    });
    const current = queue.find((item) => item.status === "sending")?.preview;
    const currentLine = current ? `Current: ${truncatePreview(current)}\n` : "";
    const more = queue.length > previewCount ? `\n +${queue.length - previewCount} more` : "";
    const failedLine = failedCount > 0 ? ` (${failedCount} failed, will retry)` : "";
    const header = `Queue (${pendingCount} pending${failedLine})`;
    const rule = "-".repeat(header.length);
    const body = previews.length ? previews.join("\n") : " (empty)";
    return `${header}\n${rule}\n${currentLine}${body}${more}`;
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

export const AutoQueuePlugin = {
  id: "opencode-auto-queue",
  server: async (ctx: any, options: AutoQueueOptions = {}) => {
    const client = ctx.client;

    debugLog("server", "Plugin server starting", { directory: ctx.directory, options });

    const {
      toastDurationMs = 10_000,
      emptyToastDurationMs = 4_000,
      maxPreviews = 3,
      previewLength = 28,
      placeholderTemplate = "Queued; {count} pending",
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
    const extractPreview = makeExtractPreview(truncatePreview);
    const buildToastMessage = makeBuildToastMessage(truncatePreview);

    const resolvedPersistPath = persistPath || `${ctx.directory}/.git/queue.json`;

    let currentMode: string = defaultMode;

    const stateBySession = new Map<string, {
      modelBusy: boolean;
      queueOwner: boolean;
      cancelled: boolean;
      paused: boolean;
      queue: QueuedItem[];
      lastAssistantResponse: string;
      modelWorking: boolean;
    }>();

    const workerRunning = new Set<string>();

    let persistTimer: ReturnType<typeof setTimeout> | null = null;

    let tickCallCount = 0;
    let eventCount = 0;
    let chatMessageCount = 0;

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

    function getSession(sessionID: string) {
      let s = stateBySession.get(sessionID);
      if (!s) {
        s = { modelBusy: false, queueOwner: false, cancelled: false, paused: false, queue: [], lastAssistantResponse: "", modelWorking: false };
        stateBySession.set(sessionID, s);
        debugLog("getSession", "Created new session state", { sessionID });
      }
      return s;
    }

    async function persistState() {
      if (!persistQueue) return;
      const queues: Record<string, any[]> = {};
      const pausedSessions: string[] = [];
      for (const [sessionID, s] of stateBySession.entries()) {
        const serializable = serializeQueue(s.queue);
        if (serializable.length > 0) queues[sessionID] = serializable;
        if (s.paused) pausedSessions.push(sessionID);
      }
      const state: PersistedState = {
        version: 1,
        mode: currentMode,
        queues,
        pausedSessions,
      };
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

    async function restoreState() {
      if (!persistQueue) return;
      const state = await loadState(resolvedPersistPath);
      if (!state) {
        debugLog("restoreState", "No persisted state found", { path: resolvedPersistPath });
        return;
      }
      debugLog("restoreState", "Loaded persisted state", { path: resolvedPersistPath, mode: state.mode, pausedCount: state.pausedSessions?.length, queueCount: Object.keys(state.queues ?? {}).length });
      await applyLoadedState(state);
    }

    let lastPersistedRaw = "";

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
          getSession(sessionID).queue = deserializeQueue(items);
        }
      }
    }

    await restoreState();

    if (persistQueue) {
      (async () => {
        try {
          const watchDir = resolvedPersistPath.substring(0, resolvedPersistPath.lastIndexOf("/")) || ".";
          const baseName = resolvedPersistPath.substring(resolvedPersistPath.lastIndexOf("/") + 1);
          const watcher = Bun.watch(watchDir, { recursive: false });
          debugLog("fileWatcher", "Watching directory for queue file changes", { watchDir, baseName });
          for await (const event of watcher) {
            const changedName = (event as any).fileName;
            if (changedName && changedName !== baseName) continue;
            try {
              const file = Bun.file(resolvedPersistPath);
              if (!(await file.exists())) continue;
              const raw = await file.text();
              if (raw === lastPersistedRaw) continue;
              const data = JSON.parse(raw);
              if (!data || data.version !== 1) continue;
              debugLog("fileWatcher", "External queue change detected, reloading", { event: event.type });
              await applyLoadedState(data as PersistedState);
              debugLog("fileWatcher", "State reloaded", { mode: data.mode, queueCount: Object.keys(data.queues ?? {}).length });
            } catch (e: any) {
              debugLog("fileWatcher", "Failed to process change", { error: String(e?.message ?? e) });
            }
          }
        } catch (e: any) {
          debugLog("fileWatcher", "Watcher stopped", { error: String(e?.message ?? e) });
        }
      })();
    }

    async function showToast(sessionID: string, forceEmpty = false) {
      const s = getSession(sessionID);
      const pending = getPendingCount(s.queue);
      if (s.queue.length === 0 && !forceEmpty) return;
      const isEmpty = pending === 0;
      const variant = isEmpty ? "success" : "info";
      const duration = isEmpty ? emptyToastDurationMs : toastDurationMs;
      const message = isEmpty ? "Queue empty. All queued messages sent." : buildToastMessage(s.queue, maxPreviews);
      try {
        await client.tui.showToast({
          body: { title: "Message Queue", message, variant, duration },
        });
      } catch {
      }
    }

    async function tick(sessionID: string) {
      const tickId = ++tickCallCount;
      const tickLabel = `tick#${tickId}`;

      debugLog(tickLabel, "Called", { sessionID, workerRunning: workerRunning.has(sessionID) });

      if (workerRunning.has(sessionID)) {
        debugLog(tickLabel, "EXIT: worker already running", { sessionID });
        return;
      }
      const s = getSession(sessionID);

      debugLog(tickLabel, "State at entry", snapshotState(s));

      if (s.queue.length === 0) {
        debugLog(tickLabel, "EXIT: queue empty");
        return;
      }
      if (s.modelBusy) {
        debugLog(tickLabel, "EXIT: modelBusy=true");
        return;
      }
      if (s.paused) {
        debugLog(tickLabel, "EXIT: paused=true");
        return;
      }
      if (s.cancelled) {
        debugLog(tickLabel, "EXIT: cancelled=true, clearing cancelled+queueOwner");
        s.cancelled = false;
        s.queueOwner = false;
        return;
      }

      workerRunning.add(sessionID);
      debugLog(tickLabel, "Worker started", { sessionID });
      try {
        if (drainDelayMs > 0) {
          debugLog(tickLabel, "Sleeping for drainDelay", { drainDelayMs });
          await sleep(drainDelayMs);
        }

        const next = s.queue.find((item) => item.status === "queued" || (item.status === "failed" && autoRetryOnIdle));
        if (!next) {
          debugLog(tickLabel, "EXIT: no queued/failed item found after delay", { queueSummary: s.queue.map((i) => `${i.preview.slice(0, 20)}:${i.status}`) });
          return;
        }

        if (!s.modelWorking && s.lastAssistantResponse && looksComplete(s.lastAssistantResponse)) {
          const continueCount = s.queue.filter((item) => item.status === "queued" && item.preview.toLowerCase().includes("continue")).length;
          if (continueCount > 0) {
            debugLog(tickLabel, "COMPLETION DETECTED: last response indicates task complete, pausing queue instead of draining continues", { continueCount, lastResponse: s.lastAssistantResponse.slice(0, 200) });
            s.paused = true;
            try {
              await client.tui.showToast({
                body: {
                  title: "Message Queue",
                  message: `Last response looked complete. Skipping ${continueCount} queued "continue" message${continueCount > 1 ? "s" : ""} — resume manually if more work is needed.`,
                  variant: "warning",
                  duration: 10000,
                },
              });
            } catch { }
            schedulePersist();
            return;
          }
        }

        if (s.modelBusy) {
          debugLog(tickLabel, "EXIT: modelBusy became true after delay", snapshotState(s));
          return;
        }
        if (s.paused) {
          debugLog(tickLabel, "EXIT: paused became true after delay");
          return;
        }
        if (s.cancelled) {
          debugLog(tickLabel, "EXIT: cancelled became true after delay, clearing");
          s.cancelled = false;
          s.queueOwner = false;
          return;
        }

        debugLog(tickLabel, "Sending item", { preview: next.preview, status: next.status, retries: next.retries });
        next.status = "sending";
        s.queueOwner = true;
        debugLog(tickLabel, "State after marking sending", snapshotState(s));
        schedulePersist();
        try { await showToast(sessionID); } catch { }

        let sent = false;
        let attempts = 0;
        const maxAttempts = maxRetries + 1;

        while (!sent && attempts < maxAttempts) {
          if (s.cancelled) {
            debugLog(tickLabel, "CANCELLED during send loop, aborting", { attempts });
            s.cancelled = false;
            s.queueOwner = false;
            next.status = "queued";
            return;
          }
          attempts++;
          debugLog(tickLabel, "Attempt sending", { attempt: attempts, maxAttempts, preview: next.preview });
          try {
            const promptArgs = {
              path: { id: sessionID },
              body: {
                agent: next.agent,
                model: next.model,
                system: next.system,
                tools: next.tools,
                parts: markInternalParts(next.parts),
              },
            };
            debugLog(tickLabel, "Calling session.prompt", { sessionID, agent: next.agent, partsCount: next.parts.length });
            await client.session.prompt(promptArgs);
            debugLog(tickLabel, "session.prompt RESOLVED (accepted)", { preview: next.preview });
            if (s.cancelled) {
              debugLog(tickLabel, "CANCELLED after prompt resolved, aborting");
              s.cancelled = false;
              s.queueOwner = false;
              next.status = "queued";
              return;
            }
            next.status = "sent";
            next.lastError = undefined;
            sent = true;
            debugLog(tickLabel, "State after prompt accepted", snapshotState(s));
          } catch (error: any) {
            const errMsg = error instanceof Error ? error.message : String(error);
            const errName = error?.name ?? "unknown";
            debugLog(tickLabel, "session.prompt REJECTED", { error: errMsg.slice(0, 200), errorName: errName, isTransient: isTransientError(error), attempt: attempts });
            if (isTransientError(error) && attempts < maxAttempts) {
              next.retries = attempts;
              next.lastError = errMsg;
              next.status = "failed";
              const delay = backoffDelay(attempts - 1, retryBaseDelayMs, retryMaxDelayMs);
              debugLog(tickLabel, "Transient error, retrying", { delay, attempt: attempts });
              try {
                await client.tui.showToast({
                  body: {
                    title: "Message Queue",
                    message: `Retrying "${truncatePreview(next.preview)}" in ${Math.round(delay / 1000)}s (attempt ${attempts}/${maxRetries})\nError: ${errMsg.slice(0, 80)}`,
                    variant: "warning",
                    duration: delay + 2000,
                  },
                });
              } catch { }
              await sleep(delay);
              next.status = "queued";
            } else {
              next.retries = attempts;
              next.lastError = errMsg;
              next.status = "failed";
              debugLog(tickLabel, "Non-transient error or max retries, marking failed", { attempt: attempts, preview: next.preview });
              try {
                await client.tui.showToast({
                  body: {
                    title: "Message Queue",
                    message: `Failed "${truncatePreview(next.preview)}" after ${attempts} attempts: ${errMsg.slice(0, 100)}`,
                    variant: "error",
                    duration: toastDurationMs,
                  },
                });
              } catch { }
              break;
            }
          }
        }

        const beforeFilter = s.queue.length;
        s.queue = s.queue.filter((item) => item.status !== "sent");
        debugLog(tickLabel, "Filtered sent items", { before: beforeFilter, after: s.queue.length, sent });
        schedulePersist();
        try { await showToast(sessionID); } catch { }

        debugLog(tickLabel, "State after send completion", { sent, ...snapshotState(s) });

        if (sent) {
          s.queueOwner = true;
          const hasMore = s.queue.some((item) => item.status === "queued" || (item.status === "failed" && autoRetryOnIdle));
          if (hasMore) {
            debugLog(tickLabel, "Item sent successfully, queue has more items, scheduling re-tick (idle may have been consumed during await)", { queueRemaining: s.queue.length });
            setTimeout(() => tick(sessionID).catch(() => { }), 0);
          } else {
            debugLog(tickLabel, "Item sent successfully, queue empty, waiting for idle event if more items arrive", { queueRemaining: s.queue.length, queueOwner: s.queueOwner });
          }
        } else if (next.status === "failed") {
          const more = s.queue.find((item) => item.status === "queued" || (item.status === "failed" && autoRetryOnIdle));
          if (more) {
            debugLog(tickLabel, "Send failed permanently, but more items in queue, re-ticking", { morePreview: more.preview });
            s.queueOwner = false;
            tick(sessionID).catch(() => { });
          } else {
            debugLog(tickLabel, "Send failed permanently, no more items to process");
            s.queueOwner = false;
          }
        }
      } finally {
        workerRunning.delete(sessionID);
        debugLog(tickLabel, "Worker finished", { sessionID, state: snapshotState(s) });
      }
    }

    function makeTextItem(sessionID: string, text: string): QueuedItem {
      const truncate = makeTruncate(previewLength);
      const extract = makeExtractPreview(truncate);
      const parts = [{ type: "text", text }];
      return {
        sessionID,
        parts,
        preview: extract(parts),
        status: "queued",
        retries: 0,
        enqueuedAt: Date.now(),
      };
    }

    const queueTool = tool({
      description:
        "Control message queue. Actions: hold, immediate, status, clear, drop, peek, retry, pause, resume, cancel, count, config, reorder, insert, append, prepend, delete, set, sort, invert, get. Only switch modes when explicitly requested.",
      args: {
        action: tool.schema
          .enum(["hold", "immediate", "status", "clear", "drop", "peek", "retry", "pause", "resume", "cancel", "count", "config", "reorder", "insert", "append", "prepend", "delete", "set", "sort", "invert", "get"])
          .optional()
          .describe("Action to perform"),
        index: tool.schema
          .number()
          .optional()
          .describe("1-based index for drop/delete/get/set"),
        to: tool.schema
          .number()
          .optional()
          .describe("Target position for reorder"),
        text: tool.schema
          .string()
          .optional()
          .describe("Text content for insert/append/prepend/set"),
      },
      async execute({ action, index, to, text }: { action?: string; index?: number; to?: number; text?: string }, ctx: any) {
        const nextAction = action ?? "status";
        debugLog("tool", "Queue tool invoked", { action: nextAction, index, to, textLen: text?.length, sessionID: ctx.sessionID });
        const s = getSession(ctx.sessionID);
        const pendingCount = getPendingCount(s.queue);
        const failedCount = s.queue.filter((i) => i.status === "failed").length;

        if (nextAction === "status") {
          const lines = [
            `Mode: ${currentMode}`,
            `Model busy: ${s.modelBusy}`,
            `Queue owner: ${s.queueOwner}`,
            `Paused: ${s.paused}`,
            `Queued: ${pendingCount}`,
            `Failed: ${failedCount}`,
            `Persist: ${persistQueue}${persistQueue ? ` (${resolvedPersistPath})` : ""}`,
          ];
          if (s.queue.length > 0) {
            lines.push("", "Queue:");
            s.queue.forEach((item, i) => {
              const icon = item.status === "sent" ? "[x]" : item.status === "sending" ? "[>]" : item.status === "failed" ? "[!]" : "[ ]";
              const retry = item.retries > 0 ? ` (${item.retries} retries)` : "";
              const age = Math.round((Date.now() - item.enqueuedAt) / 1000);
              lines.push(` ${i + 1}. ${icon} ${item.preview}${retry} [${age}s ago]`);
            });
          }
          return lines.join("\n");
        }

        if (nextAction === "config") {
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
            ` toastDurationMs: ${toastDurationMs}`,
            ` emptyToastDurationMs: ${emptyToastDurationMs}`,
            ` placeholderTemplate: "${placeholderTemplate}"`,
          ].join("\n");
        }

        if (nextAction === "count") {
          return `${pendingCount} messages in queue (${failedCount} failed)`;
        }

        if (nextAction === "peek") {
          const next = s.queue.find((item) => item.status === "queued" || item.status === "failed");
          if (!next) return "Queue is empty";
          const retry = next.retries > 0 ? ` (retried ${next.retries}x)` : "";
          const age = Math.round((Date.now() - next.enqueuedAt) / 1000);
          return `Next: ${next.preview}${retry} [waiting ${age}s]`;
        }

        if (nextAction === "hold") {
          if (currentMode === "hold") return `Mode: hold`;
          currentMode = "hold";
          schedulePersist();
          return `Mode: hold (messages queued when busy)`;
        }

        if (nextAction === "immediate") {
          if (currentMode === "immediate") return `Mode: immediate`;
          currentMode = "immediate";
          schedulePersist();
          tick(ctx.sessionID).catch(() => { });
          return `Mode: immediate (messages sent right away)`;
        }

        if (nextAction === "clear") {
          const cleared = s.queue.length;
          s.queue = [];
          s.queueOwner = false;
          schedulePersist();
          try { await showToast(ctx.sessionID, true); } catch { }
          return `Cleared ${cleared} messages from queue`;
        }

        if (nextAction === "drop") {
          const idx = (index ?? 1) - 1;
          if (idx < 0 || idx >= s.queue.length) return `Invalid index. Queue has ${s.queue.length} items.`;
          const dropped = s.queue.splice(idx, 1)[0];
          schedulePersist();
          try { await showToast(ctx.sessionID); } catch { }
          return `Dropped: ${dropped.preview}`;
        }

        if (nextAction === "retry") {
          const failedItems = s.queue.filter((i) => i.status === "failed");
          if (failedItems.length === 0) return "No failed items to retry.";
          for (const item of failedItems) {
            item.status = "queued";
            item.retries = 0;
            item.lastError = undefined;
          }
          schedulePersist();
          try { await showToast(ctx.sessionID); } catch { }
          tick(ctx.sessionID).catch(() => { });
          return `Retrying ${failedItems.length} failed messages`;
        }

        if (nextAction === "pause") {
          s.paused = true;
          schedulePersist();
          return "Queue paused.";
        }

        if (nextAction === "resume") {
          s.paused = false;
          schedulePersist();
          tick(ctx.sessionID).catch(() => { });
          return "Queue resumed. Draining pending messages.";
        }

        if (nextAction === "cancel") {
          s.cancelled = true;
          s.queueOwner = false;
          schedulePersist();
          return "Queue drain cancelled. No more items will be auto-sent.";
        }

        if (nextAction === "reorder") {
          const from = index ?? 1;
          const target = to ?? 1;
          if (from < 1 || from > s.queue.length || target < 1 || target > s.queue.length)
            return `Index out of range. Queue has ${s.queue.length} items.`;
          const [item] = s.queue.splice(from - 1, 1);
          s.queue.splice(target - 1, 0, item);
          schedulePersist();
          return `Moved item ${from} to position ${target}`;
        }

        if (nextAction === "insert") {
          const idx = index ?? 1;
          if (!text) return "No text provided.";
          if (idx < 1 || idx > s.queue.length + 1) return `Index out of range. Queue has ${s.queue.length} items.`;
          const item = makeTextItem(ctx.sessionID, text);
          s.queue.splice(idx - 1, 0, item);
          schedulePersist();
          return `Inserted at position ${idx}: ${item.preview}`;
        }

        if (nextAction === "append") {
          if (!text) return "No text provided.";
          const item = makeTextItem(ctx.sessionID, text);
          s.queue.push(item);
          schedulePersist();
          return `Appended: ${item.preview}`;
        }

        if (nextAction === "prepend") {
          if (!text) return "No text provided.";
          const item = makeTextItem(ctx.sessionID, text);
          s.queue.unshift(item);
          schedulePersist();
          try { await showToast(ctx.sessionID); } catch { }
          return `Prepended: ${item.preview}`;
        }

        if (nextAction === "delete") {
          const idx = index ?? 1;
          if (idx < 1 || idx > s.queue.length) return `Index out of range. Queue has ${s.queue.length} items.`;
          const dropped = s.queue.splice(idx - 1, 1)[0];
          schedulePersist();
          try { await showToast(ctx.sessionID); } catch { }
          return `Deleted: ${dropped.preview}`;
        }

        if (nextAction === "set") {
          const idx = index ?? 1;
          if (!text) return "No text provided.";
          if (idx < 1 || idx > s.queue.length) return `Index out of range. Queue has ${s.queue.length} items.`;
          const item = makeTextItem(ctx.sessionID, text);
          s.queue[idx - 1] = item;
          schedulePersist();
          return `Set position ${idx}: ${item.preview}`;
        }

        if (nextAction === "sort") {
          s.queue.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
          schedulePersist();
          return `Sorted ${s.queue.length} items by time (oldest first)`;
        }

        if (nextAction === "invert") {
          s.queue.reverse();
          schedulePersist();
          return `Reversed ${s.queue.length} items`;
        }

        if (nextAction === "get") {
          const idx = index ?? 1;
          if (idx < 1 || idx > s.queue.length) return `Index out of range. Queue has ${s.queue.length} items.`;
          const item = s.queue[idx - 1];
          const age = Math.round((Date.now() - item.enqueuedAt) / 1000);
          const retry = item.retries > 0 ? `\nRetries: ${item.retries}` : "";
          const err = item.lastError ? `\nError: ${item.lastError}` : "";
          const textParts = item.parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
          return [
            `Item ${idx}/${s.queue.length} status: ${item.status} age: ${age}s${retry}${err}`,
            `Preview: ${item.preview}`,
            `Content:`,
            textParts || "(no text content)",
          ].join("\n");
        }

        return `Unknown action: ${nextAction}`;
      },
    });

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
      return name;
    }

    function handleSlashCommand(cmd: string, args: string, sessionID: string): string | null {
      const normalized = normalizeCommandName(cmd);
      if (!VALID_SLASH_COMMANDS.includes(normalized)) return null;

      debugLog("slashCmd", "Handling slash command", { cmd, normalized, argsLen: args.length, sessionID });

      const s = getSession(sessionID);
      const pendingCount = getPendingCount(s.queue);
      const failedCount = s.queue.filter((i) => i.status === "failed").length;

      switch (normalized) {
        case "hold": {
          if (currentMode === "hold") return `Queue mode: hold (already active)`;
          currentMode = "hold";
          schedulePersist();
          return `Queue mode: hold (messages queued when busy)`;
        }
        case "immediate": {
          if (currentMode === "immediate") return `Queue mode: immediate (already active)`;
          currentMode = "immediate";
          schedulePersist();
          tick(sessionID).catch(() => { });
          return `Queue mode: immediate (messages sent right away)`;
        }
        case "status": {
          const lines = [
            `Mode: ${currentMode}`,
            `Model busy: ${s.modelBusy}`,
            `Queue owner: ${s.queueOwner}`,
            `Paused: ${s.paused}`,
            `Queued: ${pendingCount}`,
            `Failed: ${failedCount}`,
          ];
          if (s.queue.length > 0) {
            lines.push("", "Queue:");
            s.queue.forEach((item, i) => {
              const icon = item.status === "sent" ? "[x]" : item.status === "sending" ? "[>]" : item.status === "failed" ? "[!]" : "[ ]";
              lines.push(` ${i + 1}. ${icon} ${item.preview}`);
            });
          }
          return lines.join("\n");
        }
        case "clear": {
          const cleared = s.queue.length;
          s.queue = [];
          s.queueOwner = false;
          schedulePersist();
          showToast(sessionID, true).catch(() => { });
          return `Cleared ${cleared} messages from queue`;
        }
        case "pause": {
          s.paused = true;
          schedulePersist();
          return "Queue paused.";
        }
        case "resume": {
          s.paused = false;
          schedulePersist();
          tick(sessionID).catch(() => { });
          return "Queue resumed. Draining pending messages.";
        }
        case "cancel": {
          s.cancelled = true;
          s.queueOwner = false;
          schedulePersist();
          return "Queue drain cancelled. No more items will be auto-sent.";
        }
        case "count": {
          return `${pendingCount} messages in queue (${failedCount} failed)`;
        }
        case "reorder": {
          const parts = args.trim().split(/\s+/);
          const from = parseIndex(parts[0]);
          const to = parseIndex(parts[1]);
          if (!from || !to) return "Usage: /reorder <from> <to> (1-based indices)";
          if (from > s.queue.length || to > s.queue.length) return `Index out of range. Queue has ${s.queue.length} items.`;
          const [item] = s.queue.splice(from - 1, 1);
          s.queue.splice(to - 1, 0, item);
          schedulePersist();
          return `Moved item ${from} to position ${to}`;
        }
        case "insert": {
          const firstSpace = args.indexOf(" ");
          if (firstSpace === -1) return "Usage: /insert <index> <text>";
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
          if (!txt) return "Usage: /append <text>";
          const item = makeTextItem(sessionID, txt);
          s.queue.push(item);
          schedulePersist();
          return `Appended: ${item.preview}`;
        }
        case "prepend": {
          const txt = args.trim();
          if (!txt) return "Usage: /prepend <text>";
          const item = makeTextItem(sessionID, txt);
          s.queue.unshift(item);
          schedulePersist();
          showToast(sessionID).catch(() => { });
          return `Prepended: ${item.preview}`;
        }
        case "delete": {
          const idx = parseIndex(args.trim());
          if (!idx) return "Usage: /delete <index> (1-based)";
          if (idx < 1 || idx > s.queue.length) return `Index out of range. Queue has ${s.queue.length} items.`;
          const dropped = s.queue.splice(idx - 1, 1)[0];
          schedulePersist();
          showToast(sessionID).catch(() => { });
          return `Deleted: ${dropped.preview}`;
        }
        case "set": {
          const firstSpace = args.indexOf(" ");
          if (firstSpace === -1) return "Usage: /set <index> <text>";
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
        case "sort": {
          s.queue.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
          schedulePersist();
          return `Sorted ${s.queue.length} items by time (oldest first)`;
        }
        case "invert": {
          s.queue.reverse();
          schedulePersist();
          return `Reversed ${s.queue.length} items`;
        }
        case "get": {
          const idx = parseIndex(args.trim());
          if (!idx) return "Usage: /get <index> (1-based)";
          if (idx < 1 || idx > s.queue.length) return `Index out of range. Queue has ${s.queue.length} items.`;
          const item = s.queue[idx - 1];
          const age = Math.round((Date.now() - item.enqueuedAt) / 1000);
          const retry = item.retries > 0 ? `\nRetries: ${item.retries}` : "";
          const err = item.lastError ? `\nError: ${item.lastError}` : "";
          const textParts = item.parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
          return [
            `Item ${idx}/${s.queue.length} status: ${item.status} age: ${age}s${retry}${err}`,
            `Preview: ${item.preview}`,
            `Content:`,
            textParts || "(no text content)",
          ].join("\n");
        }
        default:
          return null;
      }
    }

    const queueCommands: Record<string, { template: string; description: string }> = {
      "queue-hold": { template: "$ARGUMENTS", description: "Switch queue to hold mode (auto-drain on idle)" },
      "queue-immediate": { template: "$ARGUMENTS", description: "Switch queue to immediate mode" },
      "queue-status": { template: "$ARGUMENTS", description: "Show queue status" },
      "queue-clear": { template: "$ARGUMENTS", description: "Clear the queue" },
      "queue-pause": { template: "$ARGUMENTS", description: "Pause auto-drain" },
      "queue-resume": { template: "$ARGUMENTS", description: "Resume auto-drain" },
      "queue-cancel": { template: "$ARGUMENTS", description: "Cancel active queue drain" },
      "queue-count": { template: "$ARGUMENTS", description: "Show pending item count" },
      "queue-reorder": { template: "$ARGUMENTS", description: "Reorder: /queue-reorder <from> <to>" },
      "queue-insert": { template: "$ARGUMENTS", description: "Insert: /queue-insert <pos> <text>" },
      "queue-append": { template: "$ARGUMENTS", description: "Append text to queue" },
      "queue-prepend": { template: "$ARGUMENTS", description: "Prepend text to queue" },
      "queue-delete": { template: "$ARGUMENTS", description: "Delete: /queue-delete <index>" },
      "queue-set": { template: "$ARGUMENTS", description: "Set: /queue-set <index> <text>" },
      "queue-sort": { template: "$ARGUMENTS", description: "Sort queue by time" },
      "queue-invert": { template: "$ARGUMENTS", description: "Reverse queue order" },
      "queue-get": { template: "$ARGUMENTS", description: "Get: /queue-get <index>" },
    };

    debugLog("server", "Plugin server ready, returning hooks");

    return {
      tool: { queue: queueTool },

      config: async (inputConfig: any) => {
        debugLog("config", "Config hook called", { keys: Object.keys(inputConfig ?? {}) });
      },

      "command.execute.before": async (
        input: { command: string; sessionID: string; arguments: string },
        output: { parts: any[] },
      ) => {
        debugLog("command.before", "Command intercepted", { command: input.command, sessionID: input.sessionID, argsLen: input.arguments?.length });
        const result = handleSlashCommand(input.command, input.arguments ?? "", input.sessionID);
        if (result === null) return;
        output.parts = markInternalParts([{ type: "text", text: result }]);
      },

      event: async ({ event }: { event: any }) => {
        const eNum = ++eventCount;
        const eLabel = `event#${eNum}`;

        debugLog(eLabel, "Event received", { type: event.type, sessionID: event.properties?.sessionID, props: Object.keys(event.properties ?? {}) });

        const s = getSession(event.properties?.sessionID);
        if (!s) {
          debugLog(eLabel, "EXIT: no session for event properties", { type: event.type });
          return;
        }

        if (event.type === "session.status") {
          const { sessionID, status } = event.properties;
          const sess = getSession(sessionID);
          const nowBusy = status.type !== "idle";
          const wasBusy = sess.modelBusy;

          debugLog(eLabel, "session.status", { sessionID, statusType: status.type, nowBusy, wasBusy, queueOwnerBefore: sess.queueOwner, queueLen: sess.queue.length });

          sess.modelBusy = nowBusy;

      if (wasBusy && !nowBusy) {
        const hasQueued = sess.queue.some((item) => item.status === "queued" || (item.status === "failed" && autoRetryOnIdle));
        if (hasQueued) {
          if (!sess.modelWorking && sess.lastAssistantResponse && looksComplete(sess.lastAssistantResponse)) {
            const continueCount = sess.queue.filter((item) => item.status === "queued" && item.preview.toLowerCase().includes("continue")).length;
            if (continueCount > 0) {
              debugLog(eLabel, "COMPLETION DETECTED: last response indicates task complete, NOT auto-draining continues", { sessionID, continueCount, lastResponse: sess.lastAssistantResponse.slice(0, 200) });
              sess.paused = true;
              try {
                await client.tui.showToast({
                  body: {
                    title: "Message Queue",
                    message: `Last response looked complete. Skipping ${continueCount} queued "continue" message${continueCount > 1 ? "s" : ""} — resume manually if more work is needed.`,
                    variant: "warning",
                    duration: 10000,
                  },
                });
              } catch { }
              schedulePersist();
            }
          } else {
            debugLog(eLabel, "session.status: busy->idle AND queue has items, clearing queueOwner/cancelled and ticking", { sessionID, queueOwnerBefore: sess.queueOwner, cancelledBefore: sess.cancelled, queueRemaining: sess.queue.length });
            sess.queueOwner = false;
            sess.cancelled = false;
            tick(sessionID).catch(() => { });
          }
        } else {
          debugLog(eLabel, "session.status: busy->idle, no queued items to drain", { sessionID });
        }
      } else {
        debugLog(eLabel, "session.status: no idle transition, no action", { sessionID, wasBusy, nowBusy });
      }

          debugLog(eLabel, "session.status: state after", snapshotState(sess));
          return;
        }

        if (event.type === "session.idle") {
          const { sessionID } = event.properties;
          const sess = getSession(sessionID);
          const wasBusy = sess.modelBusy;

          debugLog(eLabel, "session.idle", { sessionID, wasBusy, queueOwnerBefore: sess.queueOwner, queueLen: sess.queue.length });

          sess.modelBusy = false;

          if (wasBusy) {
            const hasQueued = sess.queue.some((item) => item.status === "queued" || (item.status === "failed" && autoRetryOnIdle));
            if (hasQueued) {
              if (!sess.modelWorking && sess.lastAssistantResponse && looksComplete(sess.lastAssistantResponse)) {
                const continueCount = sess.queue.filter((item) => item.status === "queued" && item.preview.toLowerCase().includes("continue")).length;
                if (continueCount > 0) {
                  debugLog(eLabel, "COMPLETION DETECTED: last response indicates task complete, NOT auto-draining continues", { sessionID, continueCount, lastResponse: sess.lastAssistantResponse.slice(0, 200) });
                  sess.paused = true;
                  try {
                    await client.tui.showToast({
                      body: {
                        title: "Message Queue",
                        message: `Last response looked complete. Skipping ${continueCount} queued "continue" message${continueCount > 1 ? "s" : ""} — resume manually if more work is needed.`,
                        variant: "warning",
                        duration: 10000,
                      },
                    });
                  } catch { }
                  schedulePersist();
                }
              } else {
                debugLog(eLabel, "session.idle: was busy AND queue has items, clearing queueOwner/cancelled and ticking", { sessionID, queueOwnerBefore: sess.queueOwner, cancelledBefore: sess.cancelled, queueRemaining: sess.queue.length });
                sess.queueOwner = false;
                sess.cancelled = false;
                tick(sessionID).catch(() => { });
              }
            } else {
              debugLog(eLabel, "session.idle: was busy, no queued items to drain", { sessionID });
            }
          } else {
            debugLog(eLabel, "session.idle: was NOT busy, ignoring (duplicate idle?)", { sessionID });
          }

          debugLog(eLabel, "session.idle: state after", snapshotState(sess));
          return;
        }

        if (event.type === "session.error") {
          const { sessionID, error } = event.properties ?? {};
          debugLog(eLabel, "session.error", { sessionID, errorName: error?.name, errorMsg: error?.message?.slice(0, 200) });
          if (sessionID) {
            const sess = getSession(sessionID);
            debugLog(eLabel, "session.error: state before", snapshotState(sess));
            if (error?.name === "MessageAbortedError") {
              debugLog(eLabel, "session.error: MessageAbortedError detected, setting cancelled=true", { sessionID });
              sess.cancelled = true;
              sess.queueOwner = false;
              sess.modelBusy = false;
            } else {
              debugLog(eLabel, "session.error: non-abort error, not modifying state", { sessionID, errorName: error?.name });
            }
            debugLog(eLabel, "session.error: state after", snapshotState(sess));
          }
          return;
        }

        if (event.type === "message.updated") {
          const info = event.properties?.info;
          const sid = event.properties?.sessionID;
          if (sid && info?.role === "assistant") {
            const parts = info.parts ?? [];
            const hasNonTextParts = parts.some((p: any) => p.type !== "text" && p.type !== "thinking");
            const text = parts
              .filter((p: any) => p.type === "text" && typeof p.text === "string")
              .map((p: any) => p.text)
              .join("\n");
            const sess = getSession(sid);
            if (hasNonTextParts) {
              // Model is still working (tool calls, agent invocations, etc.)
              sess.lastAssistantResponse = "";
              sess.modelWorking = true;
              debugLog(eLabel, "Assistant working (non-text parts)", { sessionID: sid, partTypes: parts.map((p: any) => p.type) });
            } else if (text.trim()) {
              // Pure text response - likely final
              sess.lastAssistantResponse = text;
              sess.modelWorking = false;
              debugLog(eLabel, "Captured assistant text response", { sessionID: sid, len: text.length, looksComplete: looksComplete(text) });
            }
          }
          return;
        }

        debugLog(eLabel, "Unhandled event type", { type: event.type });
      },

      "chat.message": async (input: any, output: any) => {
        const cmNum = ++chatMessageCount;
        const cmLabel = `chatMsg#${cmNum}`;

        debugLog(cmLabel, "chat.message called", { sessionID: input.sessionID, mode: currentMode, partsCount: output.parts?.length });

        if (currentMode !== "hold") {
          debugLog(cmLabel, "EXIT: not in hold mode", { mode: currentMode });
          return;
        }
        if (isInternalMessage(output.parts)) {
          debugLog(cmLabel, "EXIT: internal message, ignoring");
          return;
        }

        const parts = output.parts ?? [];
        const firstText = parts.find((p: any) => p.type === "text" && typeof p.text === "string" && p.text.length > 0);
        if (firstText) {
          const trimmed = firstText.text.trim();
          if (trimmed.startsWith("/queue-") || trimmed.startsWith("/queue ")) {
            const cmdName = trimmed.replace(/^\//, "").split(/\s+/)[0];
            const cmdArgs = trimmed.replace(/^\//, "").slice(cmdName.length).trim();
            debugLog(cmLabel, "Detected queue slash command in chat", { cmdName, cmdArgs });
            const result = handleSlashCommand(cmdName, cmdArgs, input.sessionID);
            if (result !== null) {
              output.parts.length = 0;
              output.parts.push(...markInternalParts([{ type: "text", text: result }]));
              debugLog(cmLabel, "Replaced message with command result");
              return;
            }
          }
        }

        const s = getSession(input.sessionID);

        const textParts = parts.filter((p: any) => p.type === "text");
        const allSystemReminders = textParts.every((p: any) =>
          typeof p.text === "string" && (p.text.startsWith("<system-reminder") || p.text.includes("Instructions from:"))
        );
        if (allSystemReminders) {
          debugLog(cmLabel, "EXIT: all parts are system reminders");
          return;
        }

        const allSynthetic = parts.every((p: any) => p.synthetic || p.ignored || p.type !== "text");
        if (allSynthetic) {
          debugLog(cmLabel, "EXIT: all parts are synthetic/ignored");
          return;
        }

        debugLog(cmLabel, "State before queue decision", { modelBusy: s.modelBusy, queueLen: s.queue.length, queueOwner: s.queueOwner });

        if (!s.modelBusy) {
          debugLog(cmLabel, "Model NOT busy → letting message through (setting modelBusy=true)", { sessionID: input.sessionID });
          s.modelBusy = true;
          if (s.cancelled) {
            debugLog(cmLabel, "Clearing stale cancelled flag (fresh user message)", { sessionID: input.sessionID });
            s.cancelled = false;
          }
          debugLog(cmLabel, "State after let-through", snapshotState(s));
          return;
        }

        debugLog(cmLabel, "Model IS busy → queuing message", { sessionID: input.sessionID, queueLenBefore: s.queue.length });

        if (s.queue.length >= maxQueueSize) {
          debugLog(cmLabel, "Queue FULL, dropping message", { maxQueueSize });
          try {
            await client.tui.showToast({
              body: {
                title: "Message Queue",
                message: `Queue full (${maxQueueSize} max). Message dropped.`,
                variant: "error",
                duration: emptyToastDurationMs * 3,
              },
            });
          } catch { }
          const placeholder = makePlaceholder(output.parts, s.queue.length, `Queue full; dropped.`);
          if (placeholder) {
            output.parts.length = 0;
            output.parts.push(placeholder);
          }
          return;
        }

        const originalParts = [...output.parts];
        const queuedParts = originalParts.map(toPromptPart).filter((p: any) => p !== null);
        const preview = extractPreview(queuedParts);

        s.queue.push({
          sessionID: input.sessionID,
          agent: input.agent ?? output.message?.agent,
          model: input.model ?? output.message?.model,
          system: output.message?.system,
          tools: output.message?.tools,
          messageID: input.messageID,
          variant: input.variant,
          parts: queuedParts,
          preview,
          status: "queued",
          retries: 0,
          enqueuedAt: Date.now(),
        });

        const queueSize = getPendingCount(s.queue);
        const placeholder = makePlaceholder(originalParts, queueSize, placeholderTemplate);
        if (placeholder) {
          output.parts.length = 0;
          output.parts.push(placeholder);
        }

        debugLog(cmLabel, "Message enqueued", { preview, queueSize, queueLenAfter: s.queue.length, state: snapshotState(s) });

        schedulePersist();
        try {
          await showToast(input.sessionID);
        } catch { }
      },
    };
  },
};

export default AutoQueuePlugin;
