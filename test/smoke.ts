// Smoke test for opencode-auto-queue (V2 plugin API).
//
// Verifies with a mock plugin context:
// 1. setup completes and registers tool + commands + prompt hook
// 2. first prompt passes through (sets busy)
// 3. second prompt while busy is queued and admission is blocked
// 4. idle transition drains the queue via session.prompt
// 5. completion detection pauses queued "continue" items
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
  options: { persistQueue: false, drainDelayMs: 0, retryBaseDelayMs: 1, retryMaxDelayMs: 1 },
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
if (Object.keys(registeredCommands).length !== 17) throw new Error(`expected 17 commands, got ${Object.keys(registeredCommands).length}`);
if (typeof promptHook !== "function") throw new Error("prompt hook not registered");
console.log("PASS setup registers tool, commands, and prompt hook");

const sid = "ses_smoke";

// 2. first prompt passes through (model idle -> optimistic busy)
await promptHook({ sessionID: sid, prompt: { text: "do the task" } });
if (promptCalls.length !== 0) throw new Error("first message should not be queued");
console.log("PASS first message passes through");

// 3. second prompt while busy -> queued + admission blocked via throw
let queued = false;
try {
  await promptHook({ sessionID: sid, prompt: { text: "continue" } });
} catch (e: any) {
  queued = e instanceof Error && e.message.includes("queued by opencode-auto-queue");
}
if (!queued) throw new Error("second message while busy must throw to block admission");
console.log("PASS second message queued, admission blocked");

// 3b. tool reports the queued item
const queueTool = registeredTools.find((t) => t.name === "queue")!;
const statusRes = await queueTool.execute({ action: "status", args: "" }, { sessionID: sid });
if (!String((statusRes as any).content).includes("Queued: 1")) throw new Error(`status should show 1 queued: ${JSON.stringify(statusRes)}`);
console.log("PASS queue tool sees the queued item");

// 4. idle transition drains the queue
emit({ type: "session.status", data: { sessionID: sid, status: { type: "idle" } } });
await new Promise((r) => setTimeout(r, 100));
if (promptCalls.length !== 1) throw new Error(`expected 1 drained prompt, got ${promptCalls.length}`);
if (promptCalls[0].text !== "continue") throw new Error(`drained wrong text: ${JSON.stringify(promptCalls[0])}`);
if (promptCalls[0].sessionID !== sid) throw new Error("drained prompt missing sessionID");
console.log("PASS idle drain sends queued item via session.prompt");

// 5. completion detection: assistant says done, queued continues -> paused, no drain
await promptHook({ sessionID: sid, prompt: { text: "continue" } }); // idle now -> passes through, sets busy
let blocked = 0;
for (const text of ["continue", "continue"]) {
  try {
    await promptHook({ sessionID: sid, prompt: { text } });
  } catch { blocked++; }
}
if (blocked !== 2) throw new Error(`expected 2 blocked messages, got ${blocked}`);

// assistant produces a completion-looking final text, then goes idle
emit({ type: "session.text.started", data: { sessionID: sid } });
emit({ type: "session.text.delta", data: { sessionID: sid, delta: "All tasks are complete. " } });
emit({ type: "session.text.delta", data: { sessionID: sid, delta: "Nothing remaining to do." } });
emit({ type: "session.text.ended", data: { sessionID: sid } });
emit({ type: "session.status", data: { sessionID: sid, status: { type: "idle" } } });
await new Promise((r) => setTimeout(r, 100));
const drainAfterComplete = promptCalls.length;
if (drainAfterComplete !== 1) throw new Error(`completion detection failed: drained ${drainAfterComplete - 1} extra item(s)`);
const statusAfterComplete = await queueTool.execute({ action: "status", args: "" }, { sessionID: sid });
if (!String((statusAfterComplete as any).content).includes("Paused: true")) {
  throw new Error(`completion detection should pause the queue: ${JSON.stringify(statusAfterComplete)}`);
}
console.log("PASS completion detection pauses queued continues");

// 6. resume drains non-continue items even after a completion-looking response
//    (V1 parity: queued "continue"s stay paused while the last response looks
//    complete; other items drain normally.)
await registeredCommands["queue-clear"].execute({ sessionID: sid, prompt: { text: "" }, delivery: "steer" });
await registeredCommands["queue-append"].execute({ sessionID: sid, prompt: { text: "next task please" }, delivery: "steer" });
await registeredCommands["queue-resume"].execute({ sessionID: sid, prompt: { text: "" }, delivery: "steer" });
await new Promise((r) => setTimeout(r, 200));
if (promptCalls.length !== 2) throw new Error(`resume should drain non-continue item, got ${promptCalls.length - 1} drained total`);
if (promptCalls[1].text !== "next task please") throw new Error(`drained wrong item: ${JSON.stringify(promptCalls[1])}`);
console.log("PASS resume drains non-continue item after completion pause");

// 7. cancel prevents further drains
await registeredCommands["queue-append"].execute({ sessionID: sid, prompt: { text: "should not send" }, delivery: "steer" });
await registeredCommands["queue-cancel"].execute({ sessionID: sid, prompt: { text: "" }, delivery: "steer" });
emit({ type: "session.status", data: { sessionID: sid, status: { type: "idle" } } });
await new Promise((r) => setTimeout(r, 100));
if (promptCalls.length !== 2) throw new Error(`cancel should prevent drains, got ${promptCalls.length - 2} extra`);
console.log("PASS cancel stops queue drain");

// 8. cleanup runs without throwing
await cleanup!();
console.log("PASS cleanup runs");

console.log("ALL SMOKE TESTS PASSED");
