import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { JsonObject } from "@earendil-works/pi-ai";
import { withOfflineHarness } from "./helpers/integrationHarness.ts";
import { ThreadManager } from "../src/orch/manager.ts";
import { agentTools } from "../src/orch/tools.ts";
import {
  readRegistry,
  REGISTRY_ENTRY,
  RegistryWriter,
  type RegistryDelta,
  type SavedRegistry,
} from "../src/orch/registry.ts";
import type {
  AgentDriver,
  AgentType,
  ManagerOptions,
  SavedThread,
  SavedThreadView,
  ThreadEvent,
} from "../src/types.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
/** Let a finished prompt settle and the manager wake whoever was waiting. */
const settle = async () => {
  for (let i = 0; i < 4; i++) await tick();
};
const workerType: AgentType = { name: "worker", description: "test", systemPrompt: "child prompt" };

function fixture(extra: Partial<ManagerOptions> = {}, answer?: (path: string) => string) {
  const drivers = new Map<
    string,
    {
      runs: string[];
      steering: string[];
      finish: () => void;
      fail: (error: Error) => void;
    }
  >();
  const events: ThreadEvent[] = [];
  const manager = new ThreadManager({
    rootSnapshot: () => [],
    getType: (name) => ({ ...workerType, name }),
    toolsFor: () => [],
    maxConcurrent: 4,
    onEvent: (event) => events.push(event),
    createDriver: async (options) => {
      let finish = () => {};
      let fail = (_error: Error) => {};
      const data = {
        runs: [] as string[],
        steering: [] as string[],
        finish: () => finish(),
        fail: (e: Error) => fail(e),
      };
      const driver: AgentDriver = {
        prompt: async (message) => {
          data.runs.push(message);
          await new Promise<void>((resolve, reject) => {
            finish = resolve;
            fail = reject;
          });
        },
        steer: async (message) => {
          data.steering.push(message);
        },
        snapshot: () => [],
        output: () => answer?.(options.path) ?? `answer: ${data.runs[0]!.split("\n")[0]}`,
        abort: async () => finish(),
        dispose: () => {},
        sendUpdate: () => {},
        sessionFile: `/tmp/${options.path.replaceAll("/", "-")}.jsonl`,
      };
      drivers.set(options.path, data);
      return driver;
    },
    ...extra,
  });
  const spawn = async (path: string, args: { after?: string[]; task?: string } = {}) => {
    await manager.spawn("/root", {
      path,
      type: "worker",
      task: args.task ?? `task ${path.split("/").at(-1)}`,
      wait: false,
      ...(args.after ? { after: args.after } : {}),
    });
    await tick();
  };
  /** The waiter calls agent_sleep, then its turn ends (agent_sleep terminates it). */
  const sleep = async (waiter: string, until: string[], note?: string) => {
    const result = manager.scope(waiter).sleep(until, note);
    drivers.get(waiter)!.finish();
    await settle();
    return result;
  };
  const complete = async (path: string) => {
    drivers.get(path)!.finish();
    await settle();
  };
  const notices = () => events.filter((event) => event.kind === "waitNotice");
  return { manager, drivers, events, spawn, sleep, complete, notices };
}

const P = "/root/p";
const W = "/root/w";

test("1. one producer completes: the waiter is resumed with its answer, and /root is not triggered", async () => {
  const { manager, drivers, events, spawn, sleep, complete, notices } = fixture();
  try {
    await spawn("p");
    await spawn("w");
    const result = await sleep(W, [P], "need p");
    assert.equal(result.sleeping, true);
    assert.equal(manager.get(W).state, "paused");
    assert.equal(manager.get(W).status, "Sleeping until /root/p");
    // The waiter's settle is flagged so /root persists it without a turn.
    const asleep = events.find((e) => e.kind === "settled" && e.thread.path === W);
    assert.ok(asleep?.kind === "settled" && asleep.sleeping === true);

    await complete("/root/p");
    const woke = events.find((e) => e.kind === "settled" && e.thread.path === P);
    assert.ok(woke?.kind === "settled" && woke.wokeWaiters?.join() === W);
    assert.equal(manager.get(W).state, "running");
    const resume = drivers.get(W)!.runs[1]!;
    assert.match(resume, /## \/root\/p\nanswer: task p/);
    assert.match(resume, /need p/);
    assert.deepEqual(notices(), []);
    // The wake is a normal resume: when the waiter finishes it completes with its own answer.
    await complete(W);
    assert.equal(manager.get(W).state, "completed");
  } finally {
    await manager.shutdown();
  }
});

test("2. two producers: the waiter wakes only after both complete", async () => {
  const { manager, drivers, spawn, sleep, complete } = fixture();
  try {
    await spawn("a");
    await spawn("b");
    await spawn("w");
    await sleep(W, ["/root/a", "/root/b"]);
    await complete("/root/a");
    assert.equal(manager.get(W).state, "paused");
    assert.equal(drivers.get(W)!.runs.length, 1);
    assert.equal(manager.get(W).status, "Sleeping until /root/b");
    await complete("/root/b");
    assert.equal(manager.get(W).state, "running");
    const resume = drivers.get(W)!.runs[1]!;
    assert.match(resume, /## \/root\/a\nanswer: task a/);
    assert.match(resume, /## \/root\/b\nanswer: task b/);
  } finally {
    await manager.shutdown();
  }
});

test("3. a failed or stopped producer leaves the waiter asleep and notifies /root", async () => {
  const { manager, drivers, spawn, sleep, notices } = fixture();
  try {
    await spawn("a");
    await spawn("b");
    await spawn("w");
    await sleep(W, ["/root/a", "/root/b"]);
    drivers.get("/root/a")!.fail(new Error("boom"));
    await settle();
    assert.equal(manager.get("/root/a").state, "failed");
    assert.equal(manager.get(W).state, "paused");
    assert.equal(drivers.get(W)!.runs.length, 1);
    assert.deepEqual(
      notices().map((event) => event.kind === "waitNotice" && [event.recipient, event.text]),
      [["/root", "/root/w sleeps on /root/a; /root/a failed: boom"]],
    );
    await manager.stop("/root", "/root/b");
    assert.equal(manager.get(W).state, "paused");
    assert.equal(notices().length, 2);
    assert.match(
      notices()
        .map((event) => (event.kind === "waitNotice" ? event.text : ""))
        .at(-1)!,
      /\/root\/w sleeps on \/root\/b; \/root\/b stopped/,
    );
  } finally {
    await manager.shutdown();
  }
});

test("4. every producer already completed: agent_sleep returns the answers and does not pause", async () => {
  const { manager, drivers, spawn, complete } = fixture();
  try {
    await spawn("p");
    await spawn("w");
    await complete("/root/p");
    const result = manager.scope(W).sleep([P]);
    assert.deepEqual(result, {
      sleeping: false,
      until: [P],
      status: "All producers already completed",
      answers: [{ path: P, output: "answer: task p" }],
    });
    assert.equal(manager.get(W).state, "running");
    await complete(W);
    assert.equal(manager.get(W).state, "completed");
    assert.equal(drivers.get(W)!.runs.length, 1);
  } finally {
    await manager.shutdown();
  }
});

test("5. a producer completing before the waiter has settled as paused wakes it at once", async () => {
  const { manager, drivers, events, spawn, complete } = fixture();
  try {
    await spawn("p");
    await spawn("w");
    manager.scope(W).sleep([P]);
    // The waiter is still winding down its turn when the producer completes.
    await complete("/root/p");
    assert.equal(drivers.get(W)!.runs.length, 1);
    assert.equal(manager.get(W).state, "running");
    await complete(W); // Its turn ends: it settles as paused and is woken immediately.
    assert.equal(drivers.get(W)!.runs.length, 2);
    assert.match(drivers.get(W)!.runs[1]!, /## \/root\/p\nanswer: task p/);
    const asleep = events.find((e) => e.kind === "settled" && e.thread.path === W);
    assert.ok(asleep?.kind === "settled" && asleep.sleeping === true);
  } finally {
    await manager.shutdown();
  }
});

test("6. unknown paths, self, ancestors, cycles, bad counts and dead producers are refused", async () => {
  const { manager, drivers, spawn } = fixture({ maxConcurrent: 10 });
  try {
    await spawn("parent");
    await manager.spawn("/root/parent", { path: "child", type: "worker", task: "c", wait: false });
    await tick();
    for (const name of ["a", "b", "c", "d"]) await spawn(name);
    const child = manager.scope("/root/parent/child");
    assert.throws(() => child.sleep(["/root/nope"]), /Unknown thread \/root\/nope/);
    // Relative paths resolve against the caller, like other path arguments.
    assert.throws(() => child.sleep(["sibling"]), /Unknown thread \/root\/parent\/child\/sibling/);
    assert.throws(() => child.sleep(["/root/parent/child"]), /cannot wait for itself/);
    assert.throws(() => child.sleep(["/root/parent"]), /ancestor/);
    assert.throws(() => child.sleep(["bad path"]), /Agent paths require/);
    assert.throws(() => child.sleep([]), /1–16/);
    assert.throws(() => child.sleep(Array.from({ length: 17 }, (_, i) => `/root/n${i}`)), /1–16/);
    assert.throws(() => manager.scope("/root").sleep([P]), /Only a working child/);
    assert.equal(child.sleep(["/root/a"]).sleeping, true, "the refusals changed nothing");

    // A sleeps on B: B sleeping on A closes a loop. So does B -> C -> A -> B.
    assert.equal(manager.scope("/root/a").sleep(["/root/b"]).sleeping, true);
    assert.throws(() => manager.scope("/root/b").sleep(["/root/a"]), /wait cycle/);
    assert.equal(manager.scope("/root/c").sleep(["/root/a"]).sleeping, true);
    assert.throws(() => manager.scope("/root/b").sleep(["/root/c"]), /wait cycle/);

    // A failed producer cannot be waited for until it is resumed.
    drivers.get("/root/d")!.fail(new Error("boom"));
    await settle();
    assert.throws(() => manager.scope("/root/b").sleep(["/root/d"]), /\/root\/d is failed/);
  } finally {
    await manager.shutdown();
  }
});

test("7. stopping a sleeping waiter removes its entry: no later wake", async () => {
  const { manager, drivers, spawn, sleep, complete } = fixture();
  try {
    await spawn("p");
    await spawn("w");
    await sleep(W, [P]);
    await manager.stop("/root", W);
    assert.equal(manager.get(W).state, "stopped");
    await complete("/root/p");
    assert.equal(manager.get(W).state, "stopped");
    assert.equal(drivers.get(W)!.runs.length, 1);
    assert.equal(manager.saved().find((t) => t.view.path === W)!.view.sleepUntil, undefined);
  } finally {
    await manager.shutdown();
  }
});

test("8. a manual agent_steer on a sleeping waiter clears its entry", async () => {
  const { manager, drivers, spawn, sleep, complete } = fixture();
  try {
    await spawn("p");
    await spawn("w");
    await sleep(W, [P]);
    await manager.steer("/root", W, "manual resume");
    await settle();
    assert.equal(drivers.get(W)!.runs[1], "manual resume");
    assert.equal(manager.saved().find((t) => t.view.path === W)!.view.sleepUntil, undefined);
    await complete("/root/p");
    // No second resume or injected steering when the producer completes.
    assert.equal(drivers.get(W)!.runs.length, 2);
    assert.deepEqual(drivers.get(W)!.steering, []);
  } finally {
    await manager.shutdown();
  }
});

test("9. agent_spawn after: reserved until the producers complete, then starts with their answers", async () => {
  const { manager, drivers, events, spawn, complete } = fixture();
  try {
    await spawn("h");
    await spawn("i");
    await spawn("l", { after: ["/root/h", "i"], task: "assemble" });
    const reserved = manager.get("/root/l");
    assert.equal(reserved.state, "paused");
    assert.equal(reserved.task, "assemble");
    assert.equal(reserved.status, "Waiting for /root/h, /root/i");
    assert.equal(drivers.has("/root/l"), false, "not started");
    await complete("/root/h");
    assert.equal(drivers.has("/root/l"), false);
    await complete("/root/i");
    assert.equal(manager.get("/root/l").state, "running");
    const task = drivers.get("/root/l")!.runs[0]!;
    assert.ok(task.startsWith("assemble\n\n"));
    assert.match(task, /## \/root\/h\nanswer: task h/);
    assert.match(task, /## \/root\/i\nanswer: task i/);
    const done = events.find((e) => e.kind === "settled" && e.thread.path === "/root/i");
    assert.ok(done?.kind === "settled" && done.wokeWaiters?.join() === "/root/l");

    // Producers already complete: it starts at once.
    await spawn("m", { after: ["/root/h"], task: "now" });
    assert.equal(manager.get("/root/m").state, "running");
    assert.match(drivers.get("/root/m")!.runs[0]!, /^now\n\n[\s\S]*## \/root\/h\nanswer: task h/);
    // Refused like agent_sleep.
    await assert.rejects(spawn("n", { after: ["/root/nope"] }), /Unknown thread/);
    await assert.rejects(spawn("n", { after: [] }), /1–16/);
    assert.equal(
      manager.list().some((t) => t.path === "/root/n"),
      false,
    );
  } finally {
    await manager.shutdown();
  }
});

test("10. at capacity the wake is queued and retried on later settles", async () => {
  const { manager, drivers, spawn, sleep, complete } = fixture();
  try {
    await spawn("w");
    await spawn("p");
    await spawn("f");
    await spawn("g");
    await sleep(W, [P]);
    await spawn("h");
    manager.setLimits({ maxConcurrent: 2 } as never);
    await complete("/root/p"); // active: f, g, h
    assert.equal(manager.get(W).state, "paused");
    await complete("/root/f"); // active: g, h
    assert.equal(manager.get(W).state, "paused");
    assert.equal(drivers.get(W)!.runs.length, 1);
    await complete("/root/g"); // active: h -> room
    assert.equal(manager.get(W).state, "running");
    assert.match(drivers.get(W)!.runs[1]!, /## \/root\/p/);
  } finally {
    await manager.shutdown();
  }
});

const savedThread = (path: string, view: Partial<SavedThreadView> = {}): SavedThread => ({
  view: {
    path,
    parent: "/root",
    owner: "/root",
    type: "worker",
    state: "paused",
    task: "task",
    status: "Paused",
    createdAt: 0,
    ...view,
  },
  definition: workerType,
});

test("11a. the wait list survives save, registry write/read and restore, and stays asleep", async () => {
  const first = fixture();
  let snapshot: SavedThread[];
  try {
    await first.spawn("p");
    await first.spawn("w");
    await first.spawn("l", { after: [P], task: "assemble" });
    await first.sleep(W, [P], "need p");
    snapshot = first.manager.saved();
  } finally {
    await first.manager.shutdown();
  }
  const view = (path: string) => snapshot.find((t) => t.view.path === path)!.view;
  assert.deepEqual(view(W).sleepUntil, [P]);
  assert.equal(view(W).sleepKind, "sleep");
  assert.equal(view(W).sleepNote, "need p");
  assert.equal(view("/root/l").sleepKind, "spawn");
  assert.equal(view("/root/l").sleepTask, "assemble");
  assert.equal(view(P).sleepUntil, undefined);

  // Through the registry (full entry, then a delta clearing a wait), as Pi reloads it.
  const entries: { customType: string; data: SavedRegistry | RegistryDelta }[] = [];
  const writer = new RegistryWriter((customType, data) => entries.push({ customType, data }));
  writer.write("s", snapshot);
  const branch = entries.map(({ customType, data }, i) => ({
    type: "custom" as const,
    id: String(i),
    parentId: null,
    timestamp: "",
    customType,
    data: JSON.parse(JSON.stringify(data)),
  }));
  assert.equal(branch[0]!.customType, REGISTRY_ENTRY);
  const restoredThreads = readRegistry(branch)!.threads;
  assert.deepEqual(restoredThreads, JSON.parse(JSON.stringify(snapshot)));

  const second = fixture();
  try {
    second.manager.restore(restoredThreads);
    assert.equal(second.manager.get(W).state, "paused");
    assert.equal(second.manager.get("/root/l").state, "paused");
    assert.deepEqual(second.notices(), []);
    // The producer was interrupted by the reload; resuming it and completing wakes both.
    await second.manager.steer("/root", P, "continue");
    await tick();
    await second.complete(P);
    assert.equal(second.manager.get(W).state, "running");
    assert.match(second.drivers.get(W)!.runs[0]!, /## \/root\/p\nanswer: continue/);
    assert.equal(second.manager.get("/root/l").state, "running");
    assert.match(second.drivers.get("/root/l")!.runs[0]!, /^assemble\n\n/);
  } finally {
    await second.manager.shutdown();
  }
});

test("11b. restore with every producer completed notifies /root and never auto-starts", async () => {
  const { manager, drivers, events, notices } = fixture();
  try {
    manager.restore([
      savedThread(P, { state: "completed", output: "P done", status: "Completed" }),
      savedThread(W, { sleepUntil: [P], sleepKind: "sleep" }),
      savedThread("/root/l", { sleepUntil: [P], sleepKind: "spawn", sleepTask: "assemble" }),
    ]);
    await settle();
    assert.deepEqual(
      notices().map((event) => event.kind === "waitNotice" && [event.recipient, event.text]),
      [
        ["/root", "/root/w can wake: all producers completed"],
        ["/root", "/root/l can start: all producers completed"],
      ],
    );
    assert.equal(drivers.size, 0, "no driver was created");
    assert.equal(manager.get(W).state, "paused");
    assert.equal(manager.get("/root/l").state, "paused");
    assert.equal(
      events.some((e) => e.kind === "settled"),
      false,
    );
    // A later settle must not start them either; /root decides.
    assert.deepEqual(manager.saved().find((t) => t.view.path === W)!.view.sleepUntil, [P]);
  } finally {
    await manager.shutdown();
  }
});

test("agent_sleep tool: description, terminate on sleep, answers when nothing to wait for", async () => {
  const { manager, spawn, complete } = fixture();
  try {
    await spawn("p");
    await spawn("w");
    const tool = agentTools(
      () => manager,
      W,
      () => [workerType],
      () => ({}) as never,
    ).find((t) => t.name === "agent_sleep")!;
    assert.equal(
      tool.description,
      "Child-only: when you need the result of other agents, call this instead of polling. You pause with 0 tokens; when all listed agents complete, you are resumed in the same session with their final answers. Never loop on agent_status or agent_wait.",
    );
    const run = (params: unknown) =>
      tool.execute("id", params as never, undefined, undefined, undefined as never);
    const slept = (await run({ until: [P] })) as {
      terminate?: boolean;
      details: { sleeping: boolean };
    };
    assert.equal(slept.terminate, true);
    assert.equal(slept.details.sleeping, true);
    await assert.rejects(
      Promise.resolve().then(() => run({ until: [P] })),
      /Already sleeping/,
    );

    await complete("/root/p");
    const second = agentTools(
      () => manager,
      "/root/q",
      () => [workerType],
      () => ({}) as never,
    ).find((t) => t.name === "agent_sleep")!;
    await manager.spawn("/root", { path: "q", type: "worker", task: "q", wait: false });
    await tick();
    const now = (await second.execute(
      "id",
      { until: [P] } as never,
      undefined,
      undefined,
      undefined as never,
    )) as {
      terminate?: boolean;
      details: { sleeping: boolean; answers: { path: string; output: string }[] };
    };
    assert.equal(now.terminate, undefined);
    assert.deepEqual(now.details.answers, [{ path: P, output: "answer: task p" }]);
  } finally {
    await manager.shutdown();
  }
});

test("a long answer is truncated to 16000 characters in the wake message", async () => {
  const { manager, drivers, spawn, sleep, complete } = fixture({}, () => "x".repeat(20000));
  try {
    await spawn("p");
    await spawn("w");
    await sleep(W, [P]);
    await complete("/root/p");
    const resume = drivers.get(W)!.runs[1]!;
    assert.ok(resume.includes("x".repeat(16000)));
    assert.ok(!resume.includes("x".repeat(16001)));
    assert.match(resume, /truncated at 16000/);
  } finally {
    await manager.shutdown();
  }
});

test(
  "root mailbox: a sleeping settle and a result that woke a waiter do not trigger /root; the waiter's own result does",
  { timeout: 15000 },
  async () => {
    const text = (value: string) => ({
      role: "assistant" as const,
      content: [{ type: "text" as const, text: value }],
      provider: "integration-test",
      model: "offline",
      api: "openai-completions" as const,
      stopReason: "stop" as const,
      timestamp: Date.now(),
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const toolCalls = (calls: { name: string; arguments: JsonObject }[]) => ({
      ...text(""),
      stopReason: "toolUse" as const,
      content: calls.map((call, i) => ({ type: "toolCall" as const, id: `call-${i}`, ...call })),
    });
    let release!: (message: ReturnType<typeof text>) => void;
    const producerAnswer = new Promise<ReturnType<typeof text>>((resolve) => (release = resolve));
    let rootCalls = 0;
    await withOfflineHarness(
      {
        agentFiles: {
          worker:
            "---\nname: worker\ndescription: Execute work\ntools:\n  allow: [agent_sleep]\n---\nExecute your assigned task.\n",
        },
        onRequest(request) {
          if (request.path === "/root/producer") return producerAnswer;
          if (request.path === "/root/waiter") {
            if (request.pathCall === 1)
              return toolCalls([
                { name: "agent_sleep", arguments: { until: ["/root/producer"], note: "need it" } },
              ]);
            assert.match(request.messagesText, /Producer answer text/);
            return text("Waiter used the producer answer");
          }
          rootCalls++;
          if (rootCalls === 1)
            return toolCalls(
              ["producer", "waiter"].map((path) => ({
                name: "agent_spawn",
                arguments: { path, type: "worker", task: `Task ${path}`, wait: false },
              })),
            );
          return text(rootCalls === 2 ? "Initial root answer" : "Root saw the waiter");
        },
      },
      async ({ cwd, open, close, requests, errors }) => {
        const session = await open(SessionManager.create(cwd));
        try {
          await session.prompt("Delegate");
          const deadline = Date.now() + 5000;
          const waitFor = async (done: () => boolean, what: string) => {
            while (!done()) {
              assert.ok(Date.now() < deadline, `Timed out: ${what}`);
              await new Promise<void>((resolve) => setTimeout(resolve, 5));
            }
          };
          const mailbox = () =>
            session.sessionManager
              .getBranch()
              .flatMap((entry) =>
                entry.type === "custom" && entry.customType === "pi-subagent:root-mailbox:v1"
                  ? [
                      entry.data as {
                        trigger: boolean;
                        details: { path: string; state: string };
                      },
                    ]
                  : [],
              )
              .map(({ trigger, details }) => `${details.path} ${details.state} ${trigger}`);
          await waitFor(
            () => requests.some((r) => r.path === "/root/producer"),
            "producer is working",
          );
          await waitFor(() => mailbox().length === 1, "waiter went to sleep");
          assert.deepEqual(mailbox(), ["/root/waiter paused false"]);
          assert.equal(requests.filter((r) => !r.path).length, 2, "sleeping does not wake root");

          release(text("Producer answer text"));
          await waitFor(
            () => requests.filter((r) => !r.path).length === 3 && session.isIdle,
            "root woke once",
          );
          assert.deepEqual(mailbox(), [
            "/root/waiter paused false",
            "/root/producer completed false",
            "/root/waiter completed true",
          ]);
          assert.equal(requests.filter((r) => !r.path).length, 3);
          assert.deepEqual(errors, []);
        } finally {
          release(text("cleanup"));
          await close(session);
        }
      },
    );
  },
);
