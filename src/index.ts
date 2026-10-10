// opencode-auto-queue — OpenCode v2 server plugin.
//
// OpenCode v2 ships its own durable prompt inbox. Every prompt is admitted with
// a delivery:
//   "steer" — handed to the running turn at the next step boundary (what Enter
//             sends, and the reason messages interrupt work in progress)
//   "queue" — parked until the session is idle, then delivered one at a time
//
// This plugin flips that decision. In hold mode, when the session is busy, a
// user prompt is admitted as "queue" instead of "steer", so the server parks it
// rather than injecting it into the running turn. Holding, ordering, retries
// and delivery are the server's job from there: the plugin never re-sends a
// parked prompt, so a message cannot be delivered twice.
//
// The plugin keeps a read-only mirror of what is parked, built from the
// session.inbox.* events, for status/peek and for the queue.json status file.
// The inbox API (list/cancel/update) is not exposed to plugins on v2.0.23, so
// the mirror cannot delete or reorder parked messages — that stays a client
// action.

import { Plugin } from "@opencode/plugin";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEBUG_LOG_PATH = join(tmpdir(), "opencode-auto-queue-debug.log");

function debugLog(source: string, message: string, data?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const dataStr = data ? " " + JSON.stringify(data) : "";
  try {
    appendFileSync(DEBUG_LOG_PATH, `[${ts}] [${source}] ${message}${dataStr}\n`);
  } catch {
    // Debug logging must never break queueing.
  }
}

type Delivery = "steer" | "queue";

/** One message parked in the session inbox. */
interface HeldItem {
  inboxID: string;
  text: string;
  preview: string;
  delivery: Delivery;
  enqueuedAt: number;
}

interface PersistedItem {
  inboxID?: string;
  text: string;
  preview: string;
  delivery?: Delivery;
  enqueuedAt: number;
}

interface PersistedState {
  version: number;
  mode: string;
  queues: Record<string, PersistedItem[]>;
}

interface AutoQueueOptions {
  defaultMode?: "hold" | "immediate";
  previewLength?: number;
  maxPreviews?: number;
  persistQueue?: boolean;
  persistPath?: string;
  persistDebounceMs?: number;
}

function makeTruncate(previewLength: number) {
  return (text: string): string => {
    const flat = String(text ?? "").replace(/\s+/g, " ").trim();
    return flat.length > previewLength ? `${flat.slice(0, previewLength - 1)}…` : flat;
  };
}

export const AutoQueuePlugin = Plugin.define({
  id: "opencode-auto-queue",

  async setup(ctx: any) {
    const options: AutoQueueOptions = (ctx.options ?? {}) as AutoQueueOptions;
    const locationDir: string = ctx.location?.directory ?? process.cwd();

    debugLog("setup", "Plugin setup starting", { directory: locationDir, options });

    const {
      defaultMode = "hold",
      previewLength = 28,
      maxPreviews = 3,
      persistQueue = true,
      persistPath = "",
      persistDebounceMs = 1_000,
    } = options;

    const truncatePreview = makeTruncate(previewLength);
    const resolvedPersistPath = persistPath || `${locationDir}/.git/queue.json`;

    let currentMode: string = defaultMode;
    let disposed = false;
    let persistTimer: ReturnType<typeof setTimeout> | null = null;

    const stateBySession = new Map<string, { modelBusy: boolean; held: HeldItem[] }>();

    function getSession(sessionID: string) {
      let s = stateBySession.get(sessionID);
      if (!s) {
        s = { modelBusy: false, held: [] };
        stateBySession.set(sessionID, s);
        debugLog("getSession", "Created new session state", { sessionID });
      }
      return s;
    }

    /** Record a parked message once, keyed by its inbox id. */
    function track(s: { held: HeldItem[] }, item: HeldItem) {
      if (!item.inboxID) return;
      const existing = s.held.find((i) => i.inboxID === item.inboxID);
      if (existing) {
        existing.delivery = item.delivery;
        return;
      }
      s.held.push(item);
      debugLog("inbox", "tracked parked message", {
        inboxID: item.inboxID, preview: item.preview, held: s.held.length,
      });
    }

    function untrack(s: { held: HeldItem[] }, inboxID: string, reason: string) {
      const before = s.held.length;
      s.held = s.held.filter((i) => i.inboxID !== inboxID);
      if (s.held.length !== before) {
        debugLog("inbox", `untracked parked message (${reason})`, { inboxID, held: s.held.length });
        schedulePersist();
      }
    }

    async function persistState() {
      if (!persistQueue) return;
      const queues: Record<string, PersistedItem[]> = {};
      for (const [sessionID, s] of stateBySession.entries()) {
        if (s.held.length === 0) continue;
        queues[sessionID] = s.held.map((item) => ({
          inboxID: item.inboxID,
          text: item.text,
          preview: item.preview,
          delivery: item.delivery,
          enqueuedAt: item.enqueuedAt,
        }));
      }
      const state: PersistedState = { version: 1, mode: currentMode, queues };
      try {
        await Bun.write(resolvedPersistPath, JSON.stringify(state));
        debugLog("persistState", "Persisted state", { path: resolvedPersistPath, sessions: Object.keys(queues).length });
      } catch (e: any) {
        debugLog("persistState", "FAILED to persist state", { error: String(e?.message ?? e) });
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

    /** User-visible feedback. V2 server plugins have no toast API; inject a
     *  synthetic message instead. Delivery is "queue" so the note lands when
     *  the running turn finishes instead of steering into it. */
    async function notify(sessionID: string, message: string, description = "opencode-auto-queue") {
      try {
        await ctx.session.synthetic({ sessionID, text: message, description, delivery: "queue" });
      } catch (e: any) {
        debugLog("notify", "synthetic failed", { sessionID, error: String(e?.message ?? e) });
      }
    }

    function buildStatus(s: { modelBusy: boolean; held: HeldItem[] }): string {
      const lines = [
        `Queue mode: ${currentMode}`,
        `Session busy: ${s.modelBusy ? "yes" : "no"}`,
        `Parked in session inbox: ${s.held.length}`,
      ];
      const previews = s.held.slice(0, maxPreviews).map((i, idx) => `  ${idx + 1}. ${i.preview}`);
      if (previews.length > 0) lines.push("Next:", ...previews);
      if (s.held.length > maxPreviews) lines.push(`  …and ${s.held.length - maxPreviews} more`);
      if (s.held.length > 0) {
        lines.push("Held by the session inbox; delivered one at a time when idle.");
      }
      return lines.join("\n");
    }

    // ---------------------------------------------------------------
    // Shared action handler for the queue tool and queue-* commands.
    // Returns a human-readable result string, or null for unknown actions.
    // ---------------------------------------------------------------

    const ACTIONS = [
      "hold", "immediate", "status", "count", "peek", "list", "get", "append", "config",
    ] as const;

    function normalizeCommandName(cmd: string): string {
      let name = String(cmd ?? "").replace(/^\//, "").toLowerCase();
      if (name.startsWith("queue-")) name = name.slice("queue-".length);
      return name.trim();
    }

    function parseIndex(arg: string): number | null {
      const n = parseInt(arg, 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    }

    async function handleAction(rawCmd: string, args: string, sessionID: string): Promise<string | null> {
      const action = normalizeCommandName(rawCmd);
      const s = getSession(sessionID);

      switch (action) {
        case "hold":
          if (currentMode === "hold") return "Queue mode: hold (already active)";
          currentMode = "hold";
          schedulePersist();
          return "Queue mode: hold (busy sessions park prompts instead of steering)";
        case "immediate":
          if (currentMode === "immediate") return "Queue mode: immediate (already active)";
          currentMode = "immediate";
          schedulePersist();
          return "Queue mode: immediate (prompts steer into the running turn)";
        case "status":
          return buildStatus(s);
        case "count":
          return `${s.held.length} parked in the session inbox`;
        case "peek": {
          const next = s.held[0];
          if (!next) return "Nothing parked";
          const age = Math.round((Date.now() - next.enqueuedAt) / 1000);
          return `Next: ${next.preview} [parked ${age}s]`;
        }
        case "list": {
          if (s.held.length === 0) return "Nothing parked";
          return s.held
            .map((item, idx) => `${idx + 1}. ${item.preview} (${item.inboxID})`)
            .join("\n");
        }
        case "get": {
          const idx = parseIndex(args.trim());
          if (!idx) return "Usage: get <index> (1-based)";
          if (idx < 1 || idx > s.held.length) return `Index out of range. ${s.held.length} parked.`;
          const item = s.held[idx - 1];
          const age = Math.round((Date.now() - item.enqueuedAt) / 1000);
          return [
            `Item ${idx}/${s.held.length} delivery: ${item.delivery} parked: ${age}s`,
            `Inbox id: ${item.inboxID}`,
            `Content:`,
            item.text || "(no text content)",
          ].join("\n");
        }
        case "append": {
          const text = args.trim();
          if (!text) return "Usage: append <text>";
          await ctx.session.prompt({ sessionID, text, delivery: "queue" });
          return `Queued: ${truncatePreview(text)}`;
        }
        case "config":
          return [
            "Queue Configuration:",
            ` mode: ${currentMode} (default: ${defaultMode})`,
            ` previewLength: ${previewLength}`,
            ` maxPreviews: ${maxPreviews}`,
            ` persistQueue: ${persistQueue}`,
            ` persistPath: ${resolvedPersistPath}`,
            ` persistDebounceMs: ${persistDebounceMs}`,
          ].join("\n");
        default:
          return null;
      }
    }

    // ---------------------------------------------------------------
    // Tool registration: "queue" tool.
    // ---------------------------------------------------------------

    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "queue",
        description:
          "Inspect the prompts parked in the session inbox and control queue mode. Actions: hold, immediate, status, count, peek, list, get, append, config. Only switch modes when explicitly requested.",
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: [...ACTIONS],
              description: "Action to perform",
            },
            args: {
              type: "string",
              description: "Arguments for the action (e.g. '2' for get, 'some text' for append)",
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
      "queue-hold": "Park prompts while the session is busy",
      "queue-immediate": "Let prompts steer into the running turn",
      "queue-status": "Show queue status",
      "queue-count": "Show parked message count",
      "queue-peek": "Show the next parked message",
      "queue-list": "List parked messages",
      "queue-get": "Get: /queue-get <index>",
      "queue-append": "Park text at the end of the session inbox",
      "queue-config": "Show queue configuration",
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
    // Prompt hook: the queueing core. Runs before inbox admission, so the
    // delivery it writes is the delivery the server admits with.
    // ---------------------------------------------------------------

    await ctx.session.hook("prompt", async (event: any) => {
      if (disposed) return;
      const sessionID: string = event.sessionID;
      if (!sessionID) return;
      if (currentMode !== "hold") {
        debugLog("prompt", "EXIT: not in hold mode", { sessionID, mode: currentMode });
        return;
      }

      const s = getSession(sessionID);

      if (!s.modelBusy) {
        // Idle: run now, and assume busy until the status events say otherwise.
        s.modelBusy = true;
        debugLog("prompt", "session idle -> prompt runs now", { sessionID, delivery: event.delivery });
        return;
      }

      const text: string = event.prompt?.text ?? "";
      const alreadyQueued = event.delivery === "queue";

      if (!alreadyQueued) event.delivery = "queue";

      const item: HeldItem = {
        inboxID: event.messageID,
        text,
        preview: truncatePreview(text),
        delivery: "queue",
        enqueuedAt: Date.now(),
      };
      track(s, item);
      schedulePersist();

      debugLog("prompt", "session busy -> parked in session inbox", {
        sessionID, inboxID: item.inboxID, wasDelivery: alreadyQueued ? "queue" : "steer", preview: item.preview,
      });

      if (!alreadyQueued) {
        await notify(sessionID, `Queued (${s.held.length} pending): ${item.preview}`);
      }
    });

    // ---------------------------------------------------------------
    // Event stream: busy tracking and the mirror of parked inbox items.
    // ---------------------------------------------------------------

    const controller = new AbortController();

    (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ signal: controller.signal })) {
          if (disposed) return;
          if (!ev || typeof ev.type !== "string") continue;
          const data = ev.data ?? {};
          const sessionID: string | undefined = data.sessionID;
          if (!sessionID) continue;
          if (ev.location?.directory && ctx.location?.directory && ev.location.directory !== ctx.location.directory) continue;
          const s = getSession(sessionID);

          switch (ev.type) {
            case "session.status": {
              const nowBusy = data.status?.type !== "idle";
              const wasBusy = s.modelBusy;
              s.modelBusy = nowBusy;
              debugLog("event", "session.status", { sessionID, statusType: data.status?.type, wasBusy, nowBusy });
              break;
            }
            case "session.execution.started": {
              s.modelBusy = true;
              debugLog("event", "session.execution.started", { sessionID });
              break;
            }
            case "session.execution.succeeded":
            case "session.execution.failed":
            case "session.execution.interrupted": {
              if (s.modelBusy) debugLog("event", ev.type, { sessionID });
              s.modelBusy = false;
              break;
            }
            case "session.inbox.enqueued": {
              const item = data.item;
              // Only parked items belong in the mirror; a "steer" item is
              // enqueued and delivered in the same tick.
              if (item?.type !== "user" || item?.delivery !== "queue") break;
              track(s, {
                inboxID: data.inboxID,
                text: item.payload?.text ?? "",
                preview: truncatePreview(item.payload?.text ?? ""),
                delivery: item.delivery ?? "queue",
                enqueuedAt: data.item?.time?.created ?? Date.now(),
              });
              schedulePersist();
              break;
            }
            case "session.inbox.delivered":
              untrack(s, data.inboxID, "delivered");
              break;
            case "session.inbox.cancelled":
              untrack(s, data.inboxID, "cancelled");
              break;
            case "session.inbox.delivery.changed": {
              const held = s.held.find((i) => i.inboxID === data.inboxID);
              if (held) {
                held.delivery = data.delivery;
                schedulePersist();
              }
              debugLog("event", "session.inbox.delivery.changed", { sessionID, inboxID: data.inboxID, delivery: data.delivery });
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

    // Cleanup: abort event loop, flush the mirror.
    return () => {
      disposed = true;
      controller.abort();
      if (persistTimer) clearTimeout(persistTimer);
      persistState().catch(() => { });
      debugLog("setup", "Plugin cleanup complete", { directory: locationDir });
    };
  },
});

export default AutoQueuePlugin;