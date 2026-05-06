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

async function saveState(filePath: string, state: PersistedState): Promise<void> {
  try {
    const dir = filePath.substring(0, filePath.lastIndexOf("/"));
    await Bun.write(dir + "/.gitkeep", "");
    await Bun.write(filePath, JSON.stringify(state));
  } catch {
    // persistence failure is non-fatal
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
  const busyBySession = new Map<string, boolean>();
  const queueBySession = new Map<string, QueuedItem[]>();
  const draining = new Set<string>();
  const pausedBySession = new Set<string>();
  let persistTimer: ReturnType<typeof setTimeout> | null = null;

  async function persistState() {
    if (!persistQueue) return;
    const queues: Record<string, any[]> = {};
    for (const [sessionID, queue] of queueBySession.entries()) {
      const serializable = serializeQueue(queue);
      if (serializable.length > 0) queues[sessionID] = serializable;
    }
    const state: PersistedState = {
      version: 1,
      mode: currentMode,
      queues,
      pausedSessions: [...pausedBySession],
    };
    await saveState(resolvedPersistPath, state);
  }

  function schedulePersist() {
    if (!persistQueue) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      persistState().catch(() => {});
    }, persistDebounceMs);
  }

  async function restoreState() {
    if (!persistQueue) return;
    const state = await loadState(resolvedPersistPath);
    if (!state) return;
    if (state.mode === "hold" || state.mode === "immediate") currentMode = state.mode;
    if (state.pausedSessions) {
      for (const s of state.pausedSessions) pausedBySession.add(s);
    }
    if (state.queues) {
      for (const [sessionID, items] of Object.entries(state.queues)) {
        const queue = deserializeQueue(items);
        if (queue.length > 0) queueBySession.set(sessionID, queue);
      }
    }
  }

  await restoreState();

  function getQueue(sessionID: string): QueuedItem[] {
    const existing = queueBySession.get(sessionID);
    if (existing) return existing;
    const next: QueuedItem[] = [];
    queueBySession.set(sessionID, next);
    return next;
  }

  async function showToast(sessionID: string, forceEmpty = false) {
    const queue = queueBySession.get(sessionID) ?? [];
    const pending = getPendingCount(queue);
    if (queue.length === 0 && !forceEmpty) return;
    const isEmpty = pending === 0;
    const variant = isEmpty ? "success" : "info";
    const duration = isEmpty ? emptyToastDurationMs : toastDurationMs;
    const message = isEmpty ? "Queue empty. All queued messages sent." : buildToastMessage(queue, maxPreviews);
    try {
      await client.tui.showToast({
        body: { title: "Message Queue", message, variant, duration },
      });
    } catch {
      // TUI may not be active (e.g., API-only usage)
    }
  }

  async function drain(sessionID: string) {
    if (draining.has(sessionID)) return;
    if (pausedBySession.has(sessionID)) return;
    const queue = queueBySession.get(sessionID) ?? [];
    if (queue.length === 0) return;
    draining.add(sessionID);
    try {
      if (drainDelayMs > 0) await sleep(drainDelayMs);
      let showedEmptyToast = false;
      while (true) {
        if (pausedBySession.has(sessionID)) break;
        const next = queue.find((item) => item.status === "queued" || (item.status === "failed" && autoRetryOnIdle));
        if (!next) {
          const failedOnly = queue.find((item) => item.status === "failed");
          if (failedOnly) break;
          break;
        }
        next.status = "sending";
        schedulePersist();
        try {
          await showToast(sessionID);
        } catch { /* TUI may not be active */ }

        let sent = false;
        let attempts = 0;
        const maxAttempts = maxRetries + 1;

        while (!sent && attempts < maxAttempts) {
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
              } catch { /* TUI may not be active */ }
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
              } catch { /* TUI may not be active */ }
              break;
            }
          }
        }

        schedulePersist();
        try {
          await showToast(sessionID);
        } catch { /* TUI may not be active */ }
        if (getPendingCount(queue) === 0) showedEmptyToast = true;
      }

      const remaining = queue.filter((item) => item.status !== "sent");
      queueBySession.set(sessionID, remaining);

      if (!showedEmptyToast) {
        try {
          await showToast(sessionID, remaining.length === 0);
        } catch { /* TUI may not be active */ }
      }
      schedulePersist();
    } finally {
      draining.delete(sessionID);
    }
  }

  function isBusy(sessionID: string): boolean {
    return busyBySession.get(sessionID) ?? false;
  }

  function markBusy(sessionID: string) {
    busyBySession.set(sessionID, true);
  }

  const queueTool = tool({
    description:
      "Control message queue. Actions: hold, immediate, status, clear, drop, peek, retry, pause, resume, count, config. Only switch modes when explicitly requested.",
    args: {
      action: tool.schema
        .enum(["hold", "immediate", "status", "clear", "drop", "peek", "retry", "pause", "resume", "count", "config"])
        .optional()
        .describe("Action to perform"),
      index: tool.schema
        .number()
        .optional()
        .describe("1-based index for drop"),
    },
    async execute({ action, index }: { action?: string; index?: number }, ctx: any) {
      const nextAction = action ?? "status";
      const queue = queueBySession.get(ctx.sessionID) ?? [];
      const pendingCount = getPendingCount(queue);
      const busy = isBusy(ctx.sessionID);
      const paused = pausedBySession.has(ctx.sessionID);
      const failedCount = queue.filter((i) => i.status === "failed").length;

      if (nextAction === "status") {
        const lines = [
          `Mode: ${currentMode}`,
          `Session busy: ${busy}`,
          `Paused: ${paused}`,
          `Queued: ${pendingCount}`,
          `Failed: ${failedCount}`,
          `Persist: ${persistQueue}${persistQueue ? ` (${resolvedPersistPath})` : ""}`,
        ];
        if (queue.length > 0) {
          lines.push("", "Queue:");
          queue.forEach((item, i) => {
            const icon = item.status === "sent" ? "[x]" : item.status === "sending" ? "[>]" : item.status === "failed" ? "[!]" : "[ ]";
            const retry = item.retries > 0 ? ` (${item.retries} retries)` : "";
            const age = Math.round((Date.now() - item.enqueuedAt) / 1000);
            lines.push(`  ${i + 1}. ${icon} ${item.preview}${retry} [${age}s ago]`);
          });
        }
        return lines.join("\n");
      }

      if (nextAction === "config") {
        return [
          "Queue Configuration:",
          `  mode: ${currentMode} (default: ${defaultMode})`,
          `  maxQueueSize: ${maxQueueSize}`,
          `  maxRetries: ${maxRetries}`,
          `  retryBaseDelayMs: ${retryBaseDelayMs}`,
          `  retryMaxDelayMs: ${retryMaxDelayMs}`,
          `  drainDelayMs: ${drainDelayMs}`,
          `  autoRetryOnIdle: ${autoRetryOnIdle}`,
          `  persistQueue: ${persistQueue}`,
          `  persistPath: ${resolvedPersistPath}`,
          `  persistDebounceMs: ${persistDebounceMs}`,
          `  previewLength: ${previewLength}`,
          `  maxPreviews: ${maxPreviews}`,
          `  toastDurationMs: ${toastDurationMs}`,
          `  emptyToastDurationMs: ${emptyToastDurationMs}`,
          `  placeholderTemplate: "${placeholderTemplate}"`,
        ].join("\n");
      }

      if (nextAction === "count") {
        return `${pendingCount} messages in queue (${failedCount} failed)`;
      }

      if (nextAction === "peek") {
        const next = queue.find((item) => item.status === "queued" || item.status === "failed");
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
      await drain(ctx.sessionID);
      return `Mode: immediate (messages sent right away)`;
    }

      if (nextAction === "clear") {
        const cleared = queue.length;
        queueBySession.set(ctx.sessionID, []);
        schedulePersist();
        try { await showToast(ctx.sessionID, true); } catch { /* noop */ }
        return `Cleared ${cleared} messages from queue`;
      }

      if (nextAction === "drop") {
        const idx = (index ?? 1) - 1;
        if (idx < 0 || idx >= queue.length) return `Invalid index. Queue has ${queue.length} items.`;
        const dropped = queue.splice(idx, 1)[0];
        schedulePersist();
        try { await showToast(ctx.sessionID); } catch { /* noop */ }
        return `Dropped: ${dropped.preview}`;
      }

      if (nextAction === "retry") {
        const failedItems = queue.filter((i) => i.status === "failed");
        if (failedItems.length === 0) return "No failed items to retry.";
        for (const item of failedItems) {
          item.status = "queued";
          item.retries = 0;
          item.lastError = undefined;
        }
        schedulePersist();
        try { await showToast(ctx.sessionID); } catch { /* noop */ }
        if (!paused) await drain(ctx.sessionID);
        return `Retrying ${failedItems.length} failed messages`;
      }

      if (nextAction === "pause") {
        pausedBySession.add(ctx.sessionID);
        schedulePersist();
        return "Queue paused.";
      }

      if (nextAction === "resume") {
        pausedBySession.delete(ctx.sessionID);
        schedulePersist();
        await drain(ctx.sessionID);
        return "Queue resumed. Draining pending messages.";
      }

      return `Unknown action: ${nextAction}`;
    },
  });

  return {
    tool: { queue: queueTool },

  event: async ({ event }: { event: any }) => {
    if (event.type === "session.status") {
        const { sessionID, status } = event.properties;
        const busy = status.type !== "idle";
        busyBySession.set(sessionID, busy);
        if (!busy && currentMode === "hold" && !pausedBySession.has(sessionID)) {
          await drain(sessionID);
        }
        return;
      }

      if (event.type === "session.idle") {
        const { sessionID } = event.properties;
        busyBySession.set(sessionID, false);
        if (currentMode === "hold" && !pausedBySession.has(sessionID)) {
          await drain(sessionID);
        }
      }
    },

  "chat.message": async (input: any, output: any) => {
    if (currentMode !== "hold") return;
    if (isInternalMessage(output.parts)) return;

    const parts = output.parts ?? [];
    const isUserMessage = parts.some((p: any) => p.type === "text" && typeof p.text === "string" && p.text.length > 0);
    if (!isUserMessage) return;

    const textParts = parts.filter((p: any) => p.type === "text");
    const allSystemReminders = textParts.every((p: any) =>
      typeof p.text === "string" && (p.text.startsWith("<system-reminder") || p.text.includes("Instructions from:"))
    );
    if (allSystemReminders) return;

    const allSynthetic = parts.every((p: any) => p.synthetic || p.ignored || p.type !== "text");
    if (allSynthetic) return;

    const busy = isBusy(input.sessionID);
    const pendingCount = getPendingCount(queueBySession.get(input.sessionID) ?? []);
    const shouldQueue = busy || draining.has(input.sessionID) || pendingCount > 0;

    if (!shouldQueue) {
      markBusy(input.sessionID);
      return;
    }

    const queue = getQueue(input.sessionID);
    if (queue.length >= maxQueueSize) {
      try {
        await client.tui.showToast({
          body: {
            title: "Message Queue",
            message: `Queue full (${maxQueueSize} max). Message dropped.`,
            variant: "error",
            duration: emptyToastDurationMs * 3,
          },
        });
      } catch { /* noop */ }
      const placeholder = makePlaceholder(output.parts, queue.length, `Queue full; dropped.`);
      if (placeholder) {
        output.parts.length = 0;
        output.parts.push(placeholder);
      }
      return;
    }

    const originalParts = [...output.parts];
    const queuedParts = originalParts.map(toPromptPart).filter((p: any) => p !== null);
    const preview = extractPreview(queuedParts);

    queue.push({
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

    const queueSize = getPendingCount(queue);
    const placeholder = makePlaceholder(originalParts, queueSize, placeholderTemplate);
    if (placeholder) {
      output.parts.length = 0;
      output.parts.push(placeholder);
    }

    schedulePersist();
    try {
      await showToast(input.sessionID);
    } catch { /* TUI may not be active */ }
  },
  };
  },
};

export default AutoQueuePlugin;
