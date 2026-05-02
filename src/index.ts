import { tool } from "@opencode-ai/plugin";

interface AutoQueueOptions {
  toastDurationMs?: number;
  emptyToastDurationMs?: number;
  maxPreviews?: number;
  defaultMode?: "hold" | "immediate";
}

const INTERNAL_KEY = "__auto_queue_internal";

interface QueuedItem {
  sessionID: string;
  agent?: string;
  model?: { providerID: string; modelID: string };
  messageID?: string;
  variant?: string;
  parts: any[];
  preview: string;
  status: "queued" | "sending" | "sent";
}

function truncatePreview(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= 28) return trimmed;
  return `${trimmed.slice(0, 25)}...`;
}

function extractPreview(parts: any[]): string {
  const text = parts.find((p: any) => p.type === "text");
  if (text && "text" in text) return truncatePreview(text.text);
  if (parts.some((p: any) => p.type === "file")) return "[file]";
  if (parts.some((p: any) => p.type === "agent")) return "[agent]";
  if (parts.some((p: any) => p.type === "subtask")) return "[subtask]";
  return "[message]";
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

function makePlaceholder(parts: any[], count: number): any {
  const template = parts.find((p: any) => p.type === "text") ?? parts[0];
  if (!template) return null;
  return {
    id: template.id,
    sessionID: template.sessionID,
    messageID: template.messageID,
    type: "text",
    text: `Queued (will send after current run); ${count} pending`,
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
  return queue.filter((item) => item.status !== "sent").length;
}

function buildToastMessage(queue: QueuedItem[], maxPreviews: number): string {
  const pendingCount = getPendingCount(queue);
  const previewCount = Math.min(queue.length, maxPreviews);
  const previews = queue.slice(0, previewCount).map((item, index) => {
    const text = truncatePreview(item.preview);
    if (item.status === "sent") return `  ${index + 1}. [x] ~~${text}~~`;
    if (item.status === "sending") return `  ${index + 1}. [>] ${text}`;
    return `  ${index + 1}. [ ] ${text}`;
  });
  const current = queue.find((item) => item.status === "sending")?.preview;
  const currentLine = current ? `Current: ${truncatePreview(current)}\n` : "";
  const more = queue.length > previewCount ? `\n  +${queue.length - previewCount} more` : "";
  const header = `Message Queue (${pendingCount} pending)`;
  const rule = "-".repeat(header.length);
  const body = previews.length ? previews.join("\n") : "  (empty)";
  return `${header}\n${rule}\n${currentLine}${body}${more}\nUse /queue status to check details`;
}

export default async function AutoQueuePlugin(ctx: any, options: AutoQueueOptions = {}) {
  const client = ctx.client;

  const {
    toastDurationMs = 86_400_000,
    emptyToastDurationMs = 4_000,
    maxPreviews = 3,
    defaultMode = "hold",
  } = options;

  let currentMode = defaultMode;
  const busyBySession = new Map<string, boolean>();
  const queueBySession = new Map<string, QueuedItem[]>();
  const draining = new Set<string>();

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
      // TUI may not be active
    }
  }

  async function drain(sessionID: string) {
    if (draining.has(sessionID)) return;
    const queue = queueBySession.get(sessionID) ?? [];
    if (queue.length === 0) return;
    draining.add(sessionID);
    try {
      let showedEmptyToast = false;
      while (true) {
        const next = queue.find((item) => item.status === "queued");
        if (!next) break;
        next.status = "sending";
        await showToast(sessionID);
        try {
          await client.session.prompt({
            path: { id: sessionID },
            body: {
              agent: next.agent,
              model: next.model,
              parts: markInternalParts(next.parts),
            },
          });
          next.status = "sent";
        } catch (error) {
          next.status = "queued";
          throw error;
        }
        await showToast(sessionID);
        if (getPendingCount(queue) === 0) showedEmptyToast = true;
      }
      queueBySession.set(sessionID, []);
      if (!showedEmptyToast) {
        await showToast(sessionID, true);
      }
    } finally {
      draining.delete(sessionID);
    }
  }

  function isBusy(sessionID: string): boolean {
    return busyBySession.get(sessionID) ?? false;
  }

  const queueTool = tool({
    description:
      "Control message queue mode. Use 'hold' to queue messages until the session is idle, 'immediate' to send right away, or 'status' to check current state. Only switch modes when explicitly requested.",
    args: {
      action: tool.schema
        .enum(["hold", "immediate", "status"])
        .optional()
        .describe("Action to perform: hold, immediate, or status"),
    },
    async execute({ action }: { action?: string }, ctx: any) {
      const nextAction = action ?? "status";
      const queue = queueBySession.get(ctx.sessionID) ?? [];
      const queueSize = getPendingCount(queue);
      const busy = isBusy(ctx.sessionID);

      if (nextAction === "status") {
        return `Mode: ${currentMode}\nQueued messages: ${queueSize}\nSession busy: ${busy}`;
      }

      if (nextAction === "immediate") {
        const prev = currentMode;
        currentMode = "immediate";
        await drain(ctx.sessionID);
        currentMode = prev;
        return `Draining ${queueSize} queued messages now.`;
      }

      if (nextAction === "hold") {
        currentMode = "hold";
        return `Mode set to hold. Messages will be queued when session is busy.`;
      }

      return `Unknown action: ${nextAction}. Use hold, immediate, or status.`;
    },
  });

  return {
    tool: { queue: queueTool },

    event: async ({ event }: { event: any }) => {
      if (event.type === "session.status") {
        const { sessionID, status } = event.properties;
        const busy = status.type !== "idle";
        busyBySession.set(sessionID, busy);
        if (!busy && currentMode === "hold") {
          await drain(sessionID);
        }
        return;
      }
      if (event.type === "session.idle") {
        const { sessionID } = event.properties;
        busyBySession.set(sessionID, false);
        if (currentMode === "hold") {
          await drain(sessionID);
        }
      }
    },

    "chat.message": async (input: any, output: any) => {
      if (currentMode !== "hold") return;
      if (isInternalMessage(output.parts)) return;

      const busy = isBusy(input.sessionID);
      const pendingCount = getPendingCount(queueBySession.get(input.sessionID) ?? []);
      const shouldQueue = busy || draining.has(input.sessionID) || pendingCount > 0;

      if (!shouldQueue) return;

      const originalParts = [...output.parts];
      const queuedParts = originalParts.map(toPromptPart).filter((p: any) => p !== null);
      const preview = extractPreview(queuedParts);

      const queue = getQueue(input.sessionID);
      queue.push({
        sessionID: input.sessionID,
        agent: input.agent ?? output.message.agent,
        model: input.model ?? output.message.model,
        messageID: input.messageID,
        variant: input.variant,
        parts: queuedParts,
        preview,
        status: "queued",
      });

      const queueSize = getPendingCount(queue);
      const placeholder = makePlaceholder(originalParts, queueSize);
      if (placeholder) {
        output.parts.length = 0;
        output.parts.push(placeholder);
      }

      await showToast(input.sessionID);
    },
  };
}
