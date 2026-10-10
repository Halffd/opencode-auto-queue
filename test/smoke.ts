// Smoke test for opencode-auto-queue (V2 plugin API).
//
// The plugin does not own a queue: OpenCode v2 does. It flips the admission
// delivery of a prompt from "steer" to "queue" while the session is busy, and
// mirrors what the session inbox holds. These checks pin that contract:
//
// 1. setup completes and registers tool + commands + prompt hook
// 2. first prompt on an idle session is left alone
// 3. a prompt on a busy session is flipped to delivery "queue" and mirrored
// 4. the plugin never re-sends parked prompts (no session.prompt on drain)
// 5. inbox events keep the mirror in sync (enqueued / delivered / cancelled)
// 6. append parks new text through the session inbox
//
// Run: bun test/smoke.ts

import AutoQueuePlugin from "../dist/index.js";

const tmp = `/tmp/opencode/aq-smoke-${Date.now()}`;
await Bun.write(`${tmp}/.keep`, "");

let cleanup: (() => any) | undefined;
let promptHook: any = undefined;
const promptCalls: any[] = [];
const syntheticCalls: any[] = [];
const registeredTools: any[] = [];
const registeredCommands: Record<string, any> = {};
const eventQueue: any[] = [];
let eventNotify: (() => void) | undefined = undefined;

function emit(ev: any) {
  eventQueue.push(ev);
  eventNotify?.();
}

const mockCtx = {
  options: { persistQueue: false },
  location: { directory: tmp },
  tool: {
    transform: async (cb: any) => {
      cb({
        add: (t: any) => registeredTools.push(t),
      });
    },
  },
  command: {
    transform: async (cb: any) => {
      cb({
        add: (c: any) => { registeredCommands[c.name] = c; },
      });
    },
  },
  session: {
    hook: async (name: string, cb: any) => {
      if (name === "prompt") promptHook = cb;
      return { dispose: async () => {} };
    },
    prompt: async (args: any) => { promptCalls.push(args); },
    synthetic: async (args: any) => { syntheticCalls.push(args); },
  },
  event: {
    subscribe: async function* () {
      while (true) {
        while (eventQueue.length) yield eventQueue.shift();
        await new Promise<void>((r) => { eventNotify = r; });
        eventNotify = undefined;
      }
    },
  },
};

// 1. setup registers everything and resolves
cleanup = await AutoQueuePlugin.setup(mockCtx);
if (typeof cleanup !== "function") throw new Error("setup must return a cleanup function");
if (!registeredTools.some((t) => t.name === "queue")) throw new Error("queue tool not registered");
if (Object.keys(registeredCommands).length !== 9) throw new Error(`expected 9 commands, got ${Object.keys(registeredCommands).length}`);
if (typeof promptHook !== "function") throw new Error("prompt hook not registered");
console.log("PASS setup registers tool, commands, and prompt hook");

const sid = "ses_smoke";
const queueTool = registeredTools.find((t) => t.name === "queue")!;

// 2. idle session: prompt is left exactly as the client sent it
const first = { sessionID: sid, messageID: "msg_1", delivery: "steer", prompt: { text: "do the task" } };
await promptHook(first);
if (first.delivery !== "steer") throw new Error(`idle prompt must stay steer, got ${first.delivery}`);
if (first.prompt.text !== "do the task") throw new Error("idle prompt text must not be rewritten");
console.log("PASS idle prompt is left untouched");

// 3. busy session: prompt is parked by flipping delivery, text untouched
emit({ type: "session.status", data: { sessionID: sid, status: { type: "busy" } } });
await new Promise((r) => setTimeout(r, 20));

const second = { sessionID: sid, messageID: "msg_2", delivery: "steer", prompt: { text: "and then this" } };
await promptHook(second);
if (second.delivery !== "queue") throw new Error(`busy prompt must be flipped to queue, got ${second.delivery}`);
if (second.prompt.text !== "and then this") throw new Error("queued prompt text must not be rewritten");

const countRes = await queueTool.execute({ action: "count", args: "" }, { sessionID: sid });
if (!String((countRes as any).content).includes("1 parked")) {
  throw new Error(`mirror should hold 1 parked message: ${JSON.stringify(countRes)}`);
}
console.log("PASS busy prompt is parked in the session inbox, mirror counts it");

// 3b. a prompt the client already queued is mirrored but not re-flipped
const third = { sessionID: sid, messageID: "msg_3", delivery: "queue", prompt: { text: "third" } };
await promptHook(third);
const peekRes = await queueTool.execute({ action: "peek", args: "" }, { sessionID: sid });
if (!String((peekRes as any).content).includes("and then this")) {
  throw new Error(`peek should show the oldest parked message: ${JSON.stringify(peekRes)}`);
}
console.log("PASS client-queued prompt is mirrored without a second flip");

// 4. the plugin never re-sends parked prompts
emit({ type: "session.inbox.delivered", data: { sessionID: sid, inboxID: "msg_2" } });
emit({ type: "session.status", data: { sessionID: sid, status: { type: "idle" } } });
await new Promise((r) => setTimeout(r, 50));
if (promptCalls.length !== 0) throw new Error(`plugin must not re-send parked prompts, got ${promptCalls.length} sends`);
console.log("PASS plugin does not re-send parked prompts on idle");

// 5. inbox events drive the mirror
const countAfterDeliver = await queueTool.execute({ action: "count", args: "" }, { sessionID: sid });
if (!String((countAfterDeliver as any).content).includes("1 parked")) {
  throw new Error(`delivered item should leave the mirror: ${JSON.stringify(countAfterDeliver)}`);
}
emit({
  type: "session.inbox.enqueued",
  data: {
    sessionID: sid,
    inboxID: "msg_9",
    item: { type: "user", delivery: "queue", payload: { text: "from the client" }, time: { created: Date.now() } },
  },
});
emit({ type: "session.inbox.cancelled", data: { sessionID: sid, inboxID: "msg_3" } });
await new Promise((r) => setTimeout(r, 50));
const countAfterEvents = await queueTool.execute({ action: "count", args: "" }, { sessionID: sid });
if (!String((countAfterEvents as any).content).includes("1 parked")) {
  throw new Error(`enqueued/cancelled events should leave exactly the client item: ${JSON.stringify(countAfterEvents)}`);
}
const listRes = await queueTool.execute({ action: "list", args: "" }, { sessionID: sid });
if (!String((listRes as any).content).includes("from the client")) {
  throw new Error(`list should show the client-queued item: ${JSON.stringify(listRes)}`);
}
console.log("PASS inbox enqueued/delivered/cancelled events keep the mirror in sync");

// 6. append parks text through the session inbox instead of sending it
const appendRes = await queueTool.execute({ action: "append", args: "run the tests" }, { sessionID: sid });
if (promptCalls.length !== 1) throw new Error(`append must send exactly one prompt, got ${promptCalls.length}`);
if (promptCalls[0].delivery !== "queue") throw new Error(`append must use delivery queue, got ${promptCalls[0].delivery}`);
if (promptCalls[0].text !== "run the tests") throw new Error(`append sent wrong text: ${promptCalls[0].text}`);
if (!String((appendRes as any).content).includes("Queued:")) throw new Error("append should confirm it queued");
console.log("PASS append parks text through the session inbox");

// 7. immediate mode stops flipping deliveries
emit({ type: "session.status", data: { sessionID: sid, status: { type: "busy" } } });
await queueTool.execute({ action: "immediate", args: "" }, { sessionID: sid });
await new Promise((r) => setTimeout(r, 20));
const steerInImmediate = { sessionID: sid, messageID: "msg_10", delivery: "steer", prompt: { text: "now" } };
await promptHook(steerInImmediate);
if (steerInImmediate.delivery !== "steer") throw new Error("immediate mode must not flip delivery");
console.log("PASS immediate mode leaves delivery alone");

cleanup?.();
console.log("ALL SMOKE TESTS PASSED");