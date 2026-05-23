import fs from "fs/promises";
import path from "path";

type QueueMode = "immediate" | "hold";

type QueueStatus =
  | "queued"
  | "sending"
  | "sent"
  | "failed";

interface QueuedItem {
  id: string;
  sessionID: string;
  parts: any[];
  agent?: string;
  model?: { providerID: string; modelID: string };
  system?: string;
  tools?: { [key: string]: boolean };
  preview: string;
  status: QueueStatus;
  retries: number;
  lastError?: string;
  enqueuedAt: number;
}

export const AutoQueuePlugin = {
  name: "auto-queue",

  async setup(ctx: any) {
    const client = ctx.client;

    const persistPath = `${ctx.directory}/.git/queue.json`;

    const maxQueueSize = 100;
    const toastDurationMs = 3000;
    const maxPreviewLength = 120;

    let currentMode: QueueMode = "immediate";

    const busyBySession = new Map<string, boolean>();

    const draining = new Set<string>();

    const pausedBySession = new Set<string>();

    const queueBySession = new Map<string, QueuedItem[]>();

    let persistTimer: ReturnType<typeof setTimeout> | null = null;

    // ---------------------------------------------------
    // persistence
    // ---------------------------------------------------

    async function loadPersisted() {
      try {
        const raw = await fs.readFile(persistPath, "utf8");
        const parsed = JSON.parse(raw);
        currentMode = parsed.currentMode ?? "immediate";
        for (const [sessionID, queue] of Object.entries(parsed.queues ?? {})) {
          queueBySession.set(
            sessionID,
            (queue as any[]).map((x) => ({
              ...x,
              status: x.status === "sending" ? "queued" : x.status,
            })),
          );
        }
      } catch {}
    }

    function schedulePersist() {
      if (persistTimer) clearTimeout(persistTimer);
      persistTimer = setTimeout(async () => {
        try {
          await fs.mkdir(path.dirname(persistPath), { recursive: true });
          const queues: Record<string, any> = {};
          for (const [k, v] of queueBySession.entries()) {
            queues[k] = v;
          }
          await fs.writeFile(
            persistPath,
            JSON.stringify({ currentMode, queues }, null, 2),
            "utf8",
          );
        } catch (err) {
          console.error("[queue] persist failed", err);
        }
      }, 500);
    }

    await loadPersisted();

    // ---------------------------------------------------
    // utils
    // ---------------------------------------------------

    function makeID() {
      return Math.random().toString(36).slice(2);
    }

    function truncate(text: string) {
      if (text.length <= maxPreviewLength) return text;
      return text.slice(0, maxPreviewLength) + "...";
    }

    function getQueue(sessionID: string) {
      let q = queueBySession.get(sessionID);
      if (!q) {
        q = [];
        queueBySession.set(sessionID, q);
      }
      return q;
    }

    function isBusy(sessionID: string) {
      return busyBySession.get(sessionID) ?? false;
    }

    function markBusy(sessionID: string) {
      busyBySession.set(sessionID, true);
    }

    function getPendingCount(queue: QueuedItem[]) {
      return queue.filter(
        (x) => x.status === "queued" || x.status === "sending" || x.status === "failed",
      ).length;
    }

    function buildPreview(parts: any[]) {
      const text =
        parts
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join("\n") || "(non-text)";
      return truncate(text);
    }

    function isInternalParts(parts: any[]) {
      return parts?.every((p: any) => p.synthetic || p.ignored);
    }

    function isSystemReminder(parts: any[]) {
      const textParts = parts?.filter((p: any) => p.type === "text") ?? [];
      if (textParts.length === 0) return false;
      return textParts.every(
        (p: any) =>
          typeof p.text === "string" &&
          (p.text.startsWith("<system-reminder") || p.text.includes("Instructions from:")),
      );
    }

    async function showToast(sessionID: string) {
      const queue = getQueue(sessionID);
      const pending = getPendingCount(queue);
      if (pending <= 0) return;

      const lines = queue.map((item, i) => {
        const icon =
          item.status === "sent"
            ? "[x]"
            : item.status === "sending"
              ? "[>]"
              : item.status === "failed"
                ? "[!]"
                : "[ ]";
        return `${i + 1}. ${icon} ${item.preview}`;
      });

      try {
        await client.tui.showToast({
          body: {
            title: "Message Queue",
            message: lines.join("\n"),
            variant: "info",
            duration: toastDurationMs,
          },
        });
      } catch {}
    }

    // ---------------------------------------------------
    // drain worker
    // ---------------------------------------------------

    async function drain(sessionID: string) {
      if (draining.has(sessionID)) return;
      if (pausedBySession.has(sessionID)) return;

      const queue = getQueue(sessionID);
      if (!queue.some((x) => x.status === "queued" || x.status === "failed")) return;

      draining.add(sessionID);

      try {
        while (true) {
          if (isBusy(sessionID)) break;

          const next = queue.find((x) => x.status === "queued" || x.status === "failed");
          if (!next) break;

          next.status = "sending";
          schedulePersist();

          try {
            await client.session.promptAsync({
              path: { id: sessionID },
              body: {
                agent: next.agent,
                model: next.model,
                system: next.system,
                tools: next.tools,
                parts: next.parts,
              },
            });

            next.status = "sent";
            next.lastError = undefined;
            schedulePersist();
          } catch (err: any) {
            next.status = "failed";
            next.retries++;
            next.lastError = String(err);
            schedulePersist();
            break;
          }
        }

        const remaining = queue.filter((x) => x.status !== "sent");
        queueBySession.set(sessionID, remaining);
        schedulePersist();
        await showToast(sessionID);
      } finally {
        draining.delete(sessionID);
      }
    }

    // ---------------------------------------------------
    // slash commands
    // ---------------------------------------------------

    function handleSlashCommand(cmd: string, args: string, sessionID: string): string | null {
      const queue = getQueue(sessionID);

      switch (cmd) {
        case "queue-immediate": {
          currentMode = "immediate";
          schedulePersist();
          drain(sessionID).catch(() => {});
          return "Queue mode: immediate";
        }

        case "queue-hold": {
          currentMode = "hold";
          schedulePersist();
          return "Queue mode: hold";
        }

        case "queue-status": {
          const pending = getPendingCount(queue);
          return [
            `Mode: ${currentMode}`,
            `Busy: ${isBusy(sessionID)}`,
            `Draining: ${draining.has(sessionID)}`,
            `Queued: ${pending}`,
          ].join("\n");
        }

        case "queue-clear": {
          queueBySession.set(sessionID, []);
          schedulePersist();
          return "Queue cleared";
        }

        default:
          return null;
      }
    }

    // ---------------------------------------------------
    // plugin hooks
    // ---------------------------------------------------

    return {
      tool: {},

      event: async ({ event }: { event: any }) => {
        if (event.type === "session.status") {
          const { sessionID, status } = event.properties;
          const busy = status.type !== "idle";
          busyBySession.set(sessionID, busy);

          if (!busy && currentMode === "immediate" && !pausedBySession.has(sessionID)) {
            drain(sessionID).catch(() => {});
          }
          return;
        }

        if (event.type === "session.idle") {
          const { sessionID } = event.properties;
          if (currentMode === "immediate" && !pausedBySession.has(sessionID)) {
            drain(sessionID).catch(() => {});
          }
        }
      },

      "chat.prompt.before": async (input: any, output: any) => {
        const parts = input.parts ?? [];

        if (isInternalParts(parts)) return;
        if (isSystemReminder(parts)) return;

        const firstText = parts.find(
          (p: any) => p.type === "text" && typeof p.text === "string" && p.text.trim().length > 0,
        );

        if (firstText) {
          const trimmed = firstText.text.trim();
          if (trimmed.startsWith("/queue")) {
            const cmd = trimmed.replace(/^\//, "").split(/\s+/)[0];
            const args = trimmed.replace(/^\//, "").slice(cmd.length).trim();
            const result = handleSlashCommand(cmd, args, input.sessionID);
            if (result !== null) {
              output.cancel = true;
              return;
            }
          }
        }

        const hasPending = getQueue(input.sessionID).some(
          (x) => x.status === "queued" || x.status === "sending" || x.status === "failed",
        );

        const shouldQueue =
          currentMode === "hold" ||
          isBusy(input.sessionID) ||
          draining.has(input.sessionID) ||
          hasPending;

        if (!shouldQueue) {
          markBusy(input.sessionID);
          return;
        }

        const queue = getQueue(input.sessionID);

        if (queue.length >= maxQueueSize) {
          try {
            await client.tui.showToast({
              body: {
                title: "Queue Full",
                message: "Maximum queue size reached",
                variant: "warning",
                duration: 4000,
              },
            });
          } catch {}
          output.cancel = true;
          return;
        }

        const item: QueuedItem = {
          id: makeID(),
          sessionID: input.sessionID,
          parts,
          agent: input.agent,
          model: input.model,
          system: input.system,
          tools: input.tools,
          preview: buildPreview(parts),
          status: "queued",
          retries: 0,
          enqueuedAt: Date.now(),
        };

        queue.push(item);
        schedulePersist();
        output.cancel = true;

        try {
          await showToast(input.sessionID);
        } catch {}
      },
    };
  },
};
