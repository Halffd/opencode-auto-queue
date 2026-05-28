import { tool } from "@opencode-ai/plugin";

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

export const AutoQueuePlugin = {
  id: "opencode-auto-queue",
  server: async (ctx: any, options: AutoQueueOptions = {}) => {
    const client = ctx.client;

    const {
      toastDurationMs = 86_400_000,
      emptyToastDurationMs = 4_000,
      maxPreviews = 3,
      previewLength = 28,
      placeholderTemplate = "Queued; {count} pending",
      defaultMode = "hold",
      maxRetries = 5,
      retryBaseDelayMs = 2_000,
      retryMaxDelayMs = 30_000,
      maxQueueSize = 100,
      drainDelayMs = 500,
      autoRetryOnIdle = true,
      persistQueue = true,
      persistPath = "",
      persistDebounceMs = 1_000,
    } = options;

    const truncatePreview = makeTruncate(previewLength);
    const extractPreview = makeExtractPreview(truncatePreview);
    const buildToastMessage = makeBuildToastMessage(truncatePreview);

    const resolvedPersistPath = persistPath || `${ctx.directory}/.opencode/queue-state.json`;

    let currentMode: string = defaultMode;

    const stateBySession = new Map<string, {
      modelBusy: boolean;
      queueOwner: boolean;
      cancelled: boolean;
      paused: boolean;
      queue: QueuedItem[];
    }>();

    const workerRunning = new Set<string>();

    let persistTimer: ReturnType<typeof setTimeout> | null = null;
    let persistDirEnsured = false;

    function getSession(sessionID: string) {
      let s = stateBySession.get(sessionID);
      if (!s) {
        s = { modelBusy: false, queueOwner: false, cancelled: false, paused: false, queue: [] };
        stateBySession.set(sessionID, s);
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
        if (!persistDirEnsured) {
          const dir = resolvedPersistPath.substring(0, resolvedPersistPath.lastIndexOf("/"));
          await Bun.write(dir + "/.gitkeep", "").then(() => { persistDirEnsured = true; }).catch(() => { });
        }
        await Bun.write(resolvedPersistPath, JSON.stringify(state));
      } catch { }
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
      if (!state) return;
      if (state.mode === "hold" || state.mode === "immediate") currentMode = state.mode;
      if (state.pausedSessions) {
        for (const sid of state.pausedSessions) getSession(sid).paused = true;
      }
      if (state.queues) {
        for (const [sessionID, items] of Object.entries(state.queues)) {
          const queue = deserializeQueue(items);
          if (queue.length > 0) getSession(sessionID).queue = queue;
        }
      }
    }

    await restoreState();

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
      if (workerRunning.has(sessionID)) return;
      const s = getSession(sessionID);
      if (s.queue.length === 0) return;
      if (s.modelBusy) return;
      if (s.paused) return;
      if (s.cancelled) {
        s.cancelled = false;
        s.queueOwner = false;
        return;
      }

    workerRunning.add(sessionID);
    try {
      if (drainDelayMs > 0) await sleep(drainDelayMs);

      const next = s.queue.find((item) => item.status === "queued" || (item.status === "failed" && autoRetryOnIdle));
      if (!next) return;
      if (s.modelBusy) return;
      if (s.paused) return;
      if (s.cancelled) {
        s.cancelled = false;
        s.queueOwner = false;
        return;
      }

      next.status = "sending";
      s.queueOwner = true;
      schedulePersist();
      try { await showToast(sessionID); } catch { }

      let sent = false;
      let attempts = 0;
      const maxAttempts = maxRetries + 1;

      while (!sent && attempts < maxAttempts) {
        if (s.cancelled) {
          s.cancelled = false;
          s.queueOwner = false;
          next.status = "queued";
          return;
        }
        attempts++;
        try {
          await client.session.prompt({
            path: { id: sessionID },
            body: {
              agent: next.agent,
              model: next.model,
              system: next.system,
              tools: next.tools,
              parts: markInternalParts(next.parts),
            },
          });
          next.status = "sent";
          next.lastError = undefined;
          sent = true;
          s.modelBusy = true;
        } catch (error: any) {
          const errMsg = error instanceof Error ? error.message : String(error);
          if (isTransientError(error) && attempts < maxAttempts) {
            next.retries = attempts;
            next.lastError = errMsg;
            next.status = "failed";
            const delay = backoffDelay(attempts - 1, retryBaseDelayMs, retryMaxDelayMs);
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

      s.queue = s.queue.filter((item) => item.status !== "sent");
      schedulePersist();
      try { await showToast(sessionID); } catch { }

      if (!sent && next.status === "failed") {
        const more = s.queue.find((item) => item.status === "queued" || (item.status === "failed" && autoRetryOnIdle));
        if (more) {
          s.queueOwner = false;
          tick(sessionID).catch(() => { });
        }
      }
    } finally {
      workerRunning.delete(sessionID);
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

    return {
      tool: { queue: queueTool },

      config: async (inputConfig: any) => { },

      "command.execute.before": async (
        input: { command: string; sessionID: string; arguments: string },
        output: { parts: any[] },
      ) => {
        const result = handleSlashCommand(input.command, input.arguments ?? "", input.sessionID);
        if (result === null) return;
        output.parts = markInternalParts([{ type: "text", text: result }]);
      },

      event: async ({ event }: { event: any }) => {
        const s = getSession(event.properties?.sessionID);
        if (!s) return;

        if (event.type === "session.status") {
          const { sessionID, status } = event.properties;
          const sess = getSession(sessionID);
          const nowBusy = status.type !== "idle";
          const wasBusy = sess.modelBusy;
          sess.modelBusy = nowBusy;
          if (wasBusy && !nowBusy && sess.queueOwner) {
            sess.queueOwner = false;
            tick(sessionID).catch(() => { });
          }
          return;
        }

        if (event.type === "session.idle") {
          const { sessionID } = event.properties;
          const sess = getSession(sessionID);
          const wasBusy = sess.modelBusy;
          sess.modelBusy = false;
          if (wasBusy && sess.queueOwner) {
            sess.queueOwner = false;
            tick(sessionID).catch(() => { });
          }
          return;
        }

        if (event.type === "session.error") {
          const { sessionID, error } = event.properties ?? {};
          if (sessionID) {
            const sess = getSession(sessionID);
            if (error?.name === "MessageAbortedError") {
              sess.cancelled = true;
              sess.queueOwner = false;
              sess.modelBusy = false;
            }
          }
          return;
        }
      },

      "chat.message": async (input: any, output: any) => {
        if (currentMode !== "hold") return;
        if (isInternalMessage(output.parts)) return;

        const parts = output.parts ?? [];
        const firstText = parts.find((p: any) => p.type === "text" && typeof p.text === "string" && p.text.length > 0);
        if (firstText) {
          const trimmed = firstText.text.trim();
          if (trimmed.startsWith("/queue-") || trimmed.startsWith("/queue ")) {
            const cmdName = trimmed.replace(/^\//, "").split(/\s+/)[0];
            const cmdArgs = trimmed.replace(/^\//, "").slice(cmdName.length).trim();
            const result = handleSlashCommand(cmdName, cmdArgs, input.sessionID);
            if (result !== null) {
              output.parts.length = 0;
              output.parts.push(...markInternalParts([{ type: "text", text: result }]));
              return;
            }
          }
        }

        const s = getSession(input.sessionID);

        const textParts = parts.filter((p: any) => p.type === "text");
        const allSystemReminders = textParts.every((p: any) =>
          typeof p.text === "string" && (p.text.startsWith("<system-reminder") || p.text.includes("Instructions from:"))
        );
        if (allSystemReminders) return;

        const allSynthetic = parts.every((p: any) => p.synthetic || p.ignored || p.type !== "text");
        if (allSynthetic) return;

        if (!s.modelBusy) {
          s.modelBusy = true;
          return;
        }

        if (s.queue.length >= maxQueueSize) {
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
          agent: input.agent ?? output.message.agent,
          model: input.model ?? output.message.model,
          system: output.message.system,
          tools: output.message.tools,
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

        schedulePersist();
        try {
          await showToast(input.sessionID);
        } catch { }
      },
    };
  },
};

export default AutoQueuePlugin;
