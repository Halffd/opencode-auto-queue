import { AutoQueuePlugin } from "/home/all/dotfiles/.config/opencode/plugins/opencode-auto-queue/dist/index.js";

const tmp = `/tmp/opencode/aq-smoke-${Date.now()}`;
await Bun.write(`${tmp}/.keep`, "");

let toastCalls: any[] = [];
let promptCalls = 0;

const client = {
  tui: { showToast: async (args: any) => { toastCalls.push(args?.body ?? args); } },
  session: { prompt: async () => { promptCalls++; return {}; } },
};

// 1. server must resolve (hooks registered) — regression for blocking watcher bug
const hooks: any = await AutoQueuePlugin.server({ client, directory: tmp } as any, { persistQueue: false });
if (typeof hooks.event !== "function") throw new Error("event hook missing");
if (typeof hooks["chat.message"] !== "function") throw new Error("chat.message hook missing");
console.log("PASS server returns hooks immediately");

const sid = "ses_smoke";
const mkOutput = (text: string) => ({ parts: [{ type: "text", text }] });

// 2. first message let-through -> busy
const out1: any = mkOutput("do the task");
await hooks["chat.message"]({ sessionID: sid }, out1);
if (out1.parts[0].text !== "do the task") throw new Error("first message should pass through");
console.log("PASS first message passes through");

// 3. second message while busy -> queued placeholder
const out2: any = mkOutput("continue");
await hooks["chat.message"]({ sessionID: sid }, out2);
if (!String(out2.parts[0]?.text).includes("Queued")) throw new Error(`expected queued placeholder, got ${JSON.stringify(out2.parts[0])}`);
console.log("PASS second message queued with placeholder:", JSON.stringify(out2.parts[0].text));

// 4. assistant says done -> captured via main event hook
await hooks.event({
  event: {
    type: "message.updated",
    properties: {
      sessionID: sid,
      info: { role: "assistant", parts: [{ type: "text", text: "All tasks are complete. Nothing remaining to do." }] },
    },
  },
} as any);

// give any stray tick time to (wrongly) fire
await new Promise((r) => setTimeout(r, 800));

// 5. idle with queued 'continue' + completion detected -> pause, no drain
await hooks.event({ event: { type: "session.idle", properties: { sessionID: sid } } } as any);
await new Promise((r) => setTimeout(r, 800));

const completionToasts = toastCalls.filter((t) => String(t.message || "").includes("looked complete"));
if (completionToasts.length === 0) throw new Error("expected completion-pause toast, got: " + JSON.stringify(toastCalls));
if (promptCalls !== 0) throw new Error(`queued continue should NOT have been sent, promptCalls=${promptCalls}`);
console.log("PASS completion detected, queue paused, no auto-drain. toast:", JSON.stringify(completionToasts[0].message));

process.exit(0);
