import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { ThreadManager } from "../src/manager.ts";
import type {
  AgentDriver,
  AgentType,
  DriverOptions,
  ManagerOptions,
  ThreadEvent,
} from "../src/types.ts";

const user = (text: string): AgentMessage => ({
  role: "user",
  content: text,
  timestamp: Date.now(),
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(extra: Partial<ManagerOptions> = {}) {
  const drivers = new Map<
    string,
    {
      options: DriverOptions;
      driver: AgentDriver;
      finish: () => void;
      steering: string[];
      messages: AgentMessage[];
      runs: string[];
      disposed: boolean;
    }
  >();
  const events: ThreadEvent[] = [];
  const root = [user("root context")];
  const manager = new ThreadManager({
    rootSnapshot: () => root,
    getType: (name) => ({ name, description: "test", systemPrompt: "child prompt" }),
    toolsFor: () => [],
    onEvent: (event) => events.push(event),
    createDriver: async (options) => {
      let finish = () => {};
      const data = {
        options,
        driver: {} as AgentDriver,
        finish: () => finish(),
        steering: [] as string[],
        messages: structuredClone(options.inherited),
        runs: [] as string[],
        disposed: false,
      };
      data.driver = {
        sessionFile: `/tmp/${options.path.replaceAll("/", "-")}.jsonl`,
        prompt: async (message) => {
          data.runs.push(message);
          data.messages.push(user(message));
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        },
        steer: async (message) => {
          assert.ok(data.runs.length, "initial task must be prompted before steering");
          data.steering.push(message);
        },
        snapshot: () => data.messages,
        output: () => `answer: ${data.runs.at(-1)}`,
        abort: async () => {
          finish();
        },
        dispose: () => {
          data.disposed = true;
        },
        sendUpdate: (message) => {
          data.messages.push(user(message));
        },
      };
      drivers.set(options.path, data);
      return data.driver;
    },
    ...extra,
  });
  return { manager, drivers, events, root };
}

test("spawn snapshots only lexical parent; independent roots have no root context", async () => {
  const { manager, drivers, root } = fixture();
  await manager.spawn("/root", { path: "worker", type: "worker", task: "do work", wait: false });
  await tick();
  assert.deepEqual(drivers.get("/root/worker")!.options.inherited, root);
  root.push(user("later root message"));
  assert.equal(drivers.get("/root/worker")!.options.inherited.length, 1);
  await manager.spawn("/root", { path: "/k", type: "worker", task: "separate", wait: false });
  await tick();
  assert.deepEqual(drivers.get("/k")!.options.inherited, []);
  await manager.spawn("/root", { path: "/k/l", type: "worker", task: "nested", wait: false });
  await tick();
  assert.deepEqual(
    drivers.get("/k/l")!.options.inherited,
    [user("separate")].map((message) => ({
      ...message,
      timestamp: drivers.get("/k")!.messages[0].timestamp,
    })),
  );
  assert.equal(
    drivers.get("/k/l")!.options.parentSessionFile,
    drivers.get("/k")!.driver.sessionFile,
  );
  await assert.rejects(
    manager.spawn("/root/worker", { path: "/k/forbidden", type: "worker", task: "cross-tree" }),
    /descendants/,
  );
  await manager.shutdown();
});

test("pause stops without handback; completed and paused revive SAME driver", async () => {
  const { manager, drivers, events } = fixture();
  const waiting = manager.spawn("/root", { path: "worker", type: "worker", task: "first" });
  await tick();
  const data = drivers.get("/root/worker")!;
  manager.pause("/root/worker", "need feedback");
  data.finish();
  const paused = await waiting;
  assert.equal(paused.state, "paused");
  assert.equal(paused.output, undefined);
  assert.equal(manager.output(paused.path), "");
  assert.ok(events.some((event) => event.kind === "settled" && event.thread.state === "paused"));
  await manager.steer("/root", paused.path, "second");
  await tick();
  data.finish();
  const completed = await manager.wait("/root", paused.path);
  assert.equal(completed.state, "completed");
  assert.equal(completed.output, "answer: second");
  assert.equal(completed.task, "first"); // Stable task label, independent of steering history.
  await manager.steer("/root", paused.path, "third");
  await tick();
  data.finish();
  await manager.wait("/root", paused.path);
  assert.deepEqual(data.runs, ["first", "second", "third"]);
  assert.equal(drivers.size, 1);
  await manager.shutdown();
});

test("busy steering queues while progress stays nonfinal and goes to parent", async () => {
  const { manager, drivers, events } = fixture();
  await manager.spawn("/root", { path: "worker", type: "worker", task: "task", wait: false });
  await manager.steer("/root", "worker", "more detail");
  assert.deepEqual(drivers.get("/root/worker")!.steering, ["more detail"]);
  manager.update("/root/worker", "halfway");
  assert.ok(events.some((event) => event.kind === "update" && event.recipient === "/root"));
  assert.equal(manager.get("worker").state, "running");
  await manager.shutdown();
});

test("concurrent steer after failed startup reserves one restart and queues the next", async () => {
  let rejectFirst!: (error: Error) => void;
  let finish = () => {};
  let attempts = 0;
  const runs: string[] = [];
  const steering: string[] = [];
  const manager = new ThreadManager({
    rootSnapshot: () => [],
    getType: (name) => ({ name, description: "test", systemPrompt: "child prompt" }),
    toolsFor: () => [],
    createDriver: async () => {
      attempts++;
      if (attempts === 1) {
        return new Promise<AgentDriver>((_resolve, reject) => {
          rejectFirst = reject;
        });
      }
      return {
        prompt: async (message) => {
          runs.push(message);
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        },
        steer: async (message) => {
          assert.ok(runs.length, "restart must prompt before queued steering");
          steering.push(message);
        },
        snapshot: () => [],
        output: () => `answer: ${runs.at(-1)}`,
        abort: async () => {
          finish();
        },
        dispose: () => {},
        sendUpdate: () => {},
      };
    },
  });

  await manager.spawn("/root", { path: "worker", type: "worker", task: "first", wait: false });
  await tick();
  const first = manager.steer("/root", "worker", "retry");
  const second = manager.steer("/root", "worker", "queued");
  rejectFirst(new Error("bad model"));
  await Promise.all([first, second]);
  await tick();

  assert.equal(attempts, 2);
  assert.deepEqual(runs, ["retry"]);
  assert.deepEqual(steering, ["queued"]);

  finish();
  assert.equal((await manager.wait("/root", "worker")).output, "answer: retry");
  await manager.shutdown();
});

test("lazy child context retries after parent reopen and does not keep a rejected promise", async () => {
  let rejectParentOpen!: (error: Error) => void;
  let parentFinish = () => {};
  let childFinish = () => {};
  let parentAttempts = 0;
  const parentMessages: AgentMessage[] = [];
  const childInherited: AgentMessage[][] = [];
  const manager = new ThreadManager({
    rootSnapshot: () => [],
    getType: (name) => ({ name, description: "test", systemPrompt: "child prompt" }),
    toolsFor: () => [],
    createDriver: async (options) => {
      if (options.path === "/root/worker") {
        parentAttempts++;
        if (parentAttempts === 1) {
          return new Promise<AgentDriver>((_resolve, reject) => {
            rejectParentOpen = reject;
          });
        }
        return {
          sessionFile: "/tmp/worker.jsonl",
          prompt: async (message) => {
            parentMessages.push(user(message));
            await new Promise<void>((resolve) => {
              parentFinish = resolve;
            });
          },
          steer: async () => {},
          snapshot: () => structuredClone(parentMessages),
          output: () => "parent output",
          abort: async () => {
            parentFinish();
          },
          dispose: () => {},
          sendUpdate: () => {},
        };
      }
      childInherited.push(structuredClone(options.inherited));
      return {
        prompt: async () => {
          await new Promise<void>((resolve) => {
            childFinish = resolve;
          });
        },
        steer: async () => {},
        snapshot: () => [],
        output: () => "child output",
        abort: async () => {
          childFinish();
        },
        dispose: () => {},
        sendUpdate: () => {},
      };
    },
  });

  manager.restore([
    {
      view: {
        path: "/root/worker",
        parent: "/root",
        owner: "/root",
        type: "worker",
        state: "paused",
        task: "parent",
        status: "Paused",
        createdAt: 0,
        sessionFile: "/tmp/saved-parent.jsonl",
      },
      definition: { name: "worker", description: "test", systemPrompt: "child prompt" },
    },
  ]);

  await manager.spawn("/root", {
    path: "worker/child",
    type: "worker",
    task: "nested",
    wait: false,
  });
  rejectParentOpen(new Error("parent unavailable"));
  const failed = await manager.wait("/root", "worker/child");
  assert.equal(failed.state, "failed");
  assert.equal(childInherited.length, 0);

  await manager.steer("/root", "worker", "resume parent");
  await tick();
  parentFinish();
  await manager.wait("/root", "worker");

  await manager.steer("/root", "worker/child", "resume child");
  await tick();
  assert.equal(parentAttempts, 2);
  assert.deepEqual(childInherited, [structuredClone(parentMessages)]);

  childFinish();
  assert.equal((await manager.wait("/root", "worker/child")).state, "completed");
  await manager.shutdown();
});

test("cancelling a wait or timing out does not stop detached child", async () => {
  const { manager, drivers } = fixture();
  await manager.spawn("/root", { path: "worker", type: "worker", task: "task", wait: false });
  await tick();
  const abort = new AbortController();
  const waiting = manager.wait("/root", "worker", undefined, abort.signal);
  abort.abort();
  await assert.rejects(waiting, /Waiting cancelled/);
  assert.equal((await manager.wait("/root", "worker", 0)).state, "running");
  drivers.get("/root/worker")!.finish();
  assert.equal((await manager.wait("/root", "worker")).state, "completed");
  await manager.shutdown();
});

test("stop cascades but retains sessions, and children cannot wait on ancestors", async () => {
  const { manager, drivers } = fixture({ maxLevels: 4 });
  await manager.spawn("/root", { path: "worker", type: "worker", task: "parent", wait: false });
  await tick();
  await manager.spawn("/root/worker", {
    path: "child",
    type: "worker",
    task: "child",
    wait: false,
  });
  await tick();
  await manager.spawn("/root/worker", {
    path: "finished",
    type: "worker",
    task: "finished",
    wait: false,
  });
  await tick();
  drivers.get("/root/worker/finished")!.finish();
  await manager.wait("/root", "/root/worker/finished");
  await assert.rejects(manager.wait("/root/worker/child", "/root/worker"), /descendants/);
  await assert.rejects(manager.stop("/root/worker", "/root/worker"), /descendants/);
  assert.equal((await manager.stop("/root", "worker")).state, "stopped");
  assert.equal(manager.get("/root/worker/child").state, "stopped");
  assert.equal(manager.get("/root/worker/finished").state, "completed");
  await assert.rejects(
    manager.steer("/root", "worker/finished", "continue finished"),
    /stopped ancestor/,
  );
  await assert.rejects(
    manager.spawn("/root", {
      path: "worker/finished/new",
      type: "worker",
      task: "work",
      wait: false,
    }),
    /stopped ancestor/,
  );
  assert.equal(drivers.get("/root/worker")!.disposed, false);
  await manager.steer("/root", "worker", "continue");
  await tick();
  drivers.get("/root/worker")!.finish();
  assert.equal((await manager.wait("/root", "worker")).state, "completed");
  await manager.shutdown();
  assert.equal(drivers.get("/root/worker")!.disposed, true);
});

test("duplicate concurrent spawn is rejected and concurrency/depth limits apply", async () => {
  const { manager } = fixture({ maxConcurrent: 1, maxDepth: 1 });
  const results = await Promise.allSettled([
    manager.spawn("/root", { path: "worker", type: "worker", task: "task", wait: false }),
    manager.spawn("/root", { path: "worker", type: "worker", task: "task", wait: false }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  await assert.rejects(
    manager.spawn("/root", { path: "other", type: "worker", task: "task", wait: false }),
    /Concurrent/,
  );
  await assert.rejects(
    manager.spawn("/root", { path: "worker/child", type: "worker", task: "task", wait: false }),
    /depth/,
  );
  await manager.shutdown();
});

test("save/restore retains definition snapshot and reopens JSONL on resume", async () => {
  const first = fixture();
  await first.manager.spawn("/root", { path: "worker", type: "worker", task: "work", wait: false });
  await tick();
  const saved = first.manager.saved();
  await first.manager.shutdown();

  const second = fixture();
  assert.throws(
    () => second.manager.restore([{ ...saved[0], view: { ...saved[0].view, parent: "/wrong" } }]),
    /Invalid saved parent/,
  );
  assert.deepEqual(second.manager.list(), []); // Restore is atomic on corrupt registries.
  second.manager.restore(saved);
  assert.equal(second.manager.get("worker").state, "paused");
  assert.match(second.manager.get("worker").status, /Interrupted/);
  await second.manager.spawn("/root", {
    path: "worker/child",
    type: "worker",
    task: "nested",
    wait: false,
  });
  const pending = second.manager.saved();
  const pendingChild = pending.find((thread) => thread.view.path === "/root/worker/child");
  assert.ok(pendingChild);
  assert.equal(Object.prototype.hasOwnProperty.call(pendingChild, "inherited"), false);
  await second.manager.shutdown();

  const third = fixture();
  third.manager.restore(pending);
  await third.manager.deliver("/root/worker", "child progress while parent is unopened");
  assert.equal(third.drivers.get("/root/worker")!.messages.at(-1)?.role, "user");
  assert.match(JSON.stringify(third.drivers.get("/root/worker")!.messages), /child progress/);
  const inspected = JSON.parse(await third.manager.transcript("/root", "worker/child"));
  assert.deepEqual(inspected, third.drivers.get("/root/worker")!.messages);
  assert.deepEqual(third.drivers.get("/root/worker/child")!.options.inherited, inspected);
  await third.manager.steer("/root", "worker", "resume");
  await tick();
  assert.equal(third.drivers.get("/root/worker")!.options.sessionFile, saved[0].view.sessionFile);
  await third.manager.steer("/root", "worker/child", "resume child");
  await tick();
  assert.deepEqual(third.drivers.get("/root/worker/child")!.options.inherited, inspected);
  third.drivers.get("/root/worker/child")!.finish();
  await third.manager.wait("/root", "worker/child");
  third.drivers.get("/root/worker")!.finish();
  await third.manager.wait("/root", "worker");
  await third.manager.shutdown();
});

for (const name of ["worker", "researcher"]) {
  test(`retained ${name} resumes its saved contract after bundled defaults are replaced`, async () => {
    const original: AgentType = {
      name,
      description: `Legacy ${name}`,
      systemPrompt: `Original ${name} prompt`,
      thinkingLevel: "low",
      tools: { allow: ["read", "agent_update", "agent_pause"] },
    };
    const first = fixture({ getType: () => original });
    await first.manager.spawn("/root", {
      path: name,
      type: name,
      task: "legacy work",
      wait: false,
    });
    await tick();
    const saved = first.manager.saved();
    await first.manager.shutdown();

    let lookups = 0;
    const second = fixture({
      getType: (type) => {
        lookups++;
        if (type === "worker") throw new Error("worker is no longer bundled");
        return {
          name: type,
          description: "New research contract",
          systemPrompt: "New evidence research prompt",
          thinkingLevel: "high",
          tools: { allow: ["read", "bash", "agent_update", "agent_pause"] },
        };
      },
    });
    try {
      second.manager.restore(saved);
      await second.manager.steer("/root", name, "continue legacy work");
      await tick();
      const driver = second.drivers.get(`/root/${name}`)!;
      assert.equal(lookups, 0, "resume must not resolve the replacement or removed definition");
      assert.deepEqual(driver.options.type, original);
      assert.deepEqual(second.manager.saved()[0].definition, original);
      assert.equal(driver.options.sessionFile, saved[0].view.sessionFile);
      driver.finish();
      assert.equal((await second.manager.wait("/root", name)).state, "completed");
    } finally {
      await second.manager.shutdown();
    }
  });
}

test("restored nested child opens parent first but keeps its saved inherited snapshot", async () => {
  const order: string[] = [];
  const childInherited: AgentMessage[][] = [];
  const savedChildSnapshot = [user("saved child snapshot")];
  let childFinish = () => {};
  const manager = new ThreadManager({
    rootSnapshot: () => [],
    getType: (name) => ({ name, description: "test", systemPrompt: "child prompt" }),
    toolsFor: () => [],
    createDriver: async (options) => {
      order.push(options.path);
      if (options.path === "/root/parent") {
        return {
          sessionFile: "/tmp/parent.jsonl",
          prompt: async () => {},
          steer: async () => {},
          snapshot: () => [user("live parent snapshot")],
          output: () => "parent output",
          abort: async () => {},
          dispose: () => {},
          sendUpdate: () => {},
        };
      }
      childInherited.push(structuredClone(options.inherited));
      return {
        prompt: async () => {
          await new Promise<void>((resolve) => {
            childFinish = resolve;
          });
        },
        steer: async () => {},
        snapshot: () => [],
        output: () => "child output",
        abort: async () => {
          childFinish();
        },
        dispose: () => {},
        sendUpdate: () => {},
      };
    },
  });

  manager.restore([
    {
      view: {
        path: "/root/parent",
        parent: "/root",
        owner: "/root",
        type: "worker",
        state: "paused",
        task: "parent",
        status: "Paused",
        createdAt: 0,
        sessionFile: "/tmp/saved-parent.jsonl",
      },
      definition: { name: "worker", description: "test", systemPrompt: "child prompt" },
    },
    {
      view: {
        path: "/root/parent/child",
        parent: "/root/parent",
        owner: "/root/parent",
        type: "worker",
        state: "paused",
        task: "child",
        status: "Paused",
        createdAt: 0,
      },
      definition: { name: "worker", description: "test", systemPrompt: "child prompt" },
      inherited: savedChildSnapshot,
    },
  ]);

  await manager.steer("/root", "parent/child", "resume child");
  await tick();
  assert.deepEqual(order, ["/root/parent", "/root/parent/child"]);
  assert.deepEqual(childInherited, [savedChildSnapshot]);

  childFinish();
  assert.equal((await manager.wait("/root", "parent/child")).state, "completed");
  await manager.shutdown();
});

test("startup failure returns a failed thread and does not reject detached spawn", async () => {
  const { manager } = fixture({
    createDriver: async () => {
      throw new Error("bad model");
    },
  });
  const result = await manager.spawn("/root", { path: "worker", type: "worker", task: "task" });
  assert.equal(result.state, "failed");
  assert.equal(result.error, "bad model");
  await manager.shutdown();
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("elapsed freezes across runs and usage deltas do not persist partials", async () => {
  let run = 0;
  let releasePartial = () => {};
  let releaseFinal = () => {};
  const { manager, events } = fixture({
    createDriver: async (options) => ({
      sessionFile: "/tmp/metrics.jsonl",
      prompt: async () => {
        run++;
        if (run === 1) {
          options.onEvent({ kind: "usage", inputTokens: 9, outputTokens: 1, partial: true });
          options.onEvent({ kind: "usage", inputTokens: 11, outputTokens: 2, partial: true });
          await new Promise<void>((resolve) => {
            releasePartial = resolve;
          });
          options.onEvent({ kind: "usage", inputTokens: 15, outputTokens: 4 });
          options.onEvent({ kind: "usage", inputTokens: 15, outputTokens: 4 });
          await new Promise<void>((resolve) => {
            releaseFinal = resolve;
          });
          return;
        }
        options.onEvent({ kind: "usage", inputTokens: 18, outputTokens: 5, partial: true });
        options.onEvent({ kind: "usage", inputTokens: 21, outputTokens: 7 });
      },
      steer: async () => {},
      snapshot: () => [],
      output: () => "answer",
      abort: async () => {
        releasePartial();
        releaseFinal();
      },
      dispose: () => {},
      sendUpdate: () => {},
    }),
  });

  await manager.spawn("/root", { path: "worker", type: "worker", task: "work", wait: false });
  await tick();
  const live = manager.get("worker");
  assert.equal(live.state, "running");
  assert.equal(typeof live.startedAt, "number");
  assert.equal(live.inputTokens, 11);
  assert.equal(live.outputTokens, 2);
  assert.equal(live.elapsedMs, 0);
  assert.equal(
    events.some((event) => event.kind === "metrics" && event.thread.inputTokens === 11),
    true,
  );
  const stable = JSON.stringify(manager.saved());
  assert.equal(JSON.parse(stable)[0].view.inputTokens, 0);
  assert.equal(JSON.parse(stable)[0].view.outputTokens, 0);
  assert.equal(Object.hasOwn(JSON.parse(stable)[0].view, "startedAt"), false);
  await delay(30);
  assert.equal(JSON.stringify(manager.saved()), stable);

  releasePartial();
  await tick();
  assert.equal(manager.get("worker").inputTokens, 15);
  assert.equal(manager.get("worker").outputTokens, 4);
  assert.equal(manager.saved()[0]?.view.inputTokens, 15);
  assert.equal(manager.saved()[0]?.view.outputTokens, 4);
  assert.equal(manager.get("worker").startedAt !== undefined, true);
  const settledBeforeFreeze = JSON.stringify(manager.saved());
  await delay(20);
  assert.equal(JSON.stringify(manager.saved()), settledBeforeFreeze);

  releaseFinal();
  const completed = await manager.wait("/root", "worker");
  assert.equal(completed.state, "completed");
  assert.equal(completed.startedAt, undefined);
  assert.equal(completed.inputTokens, 15);
  assert.equal(completed.outputTokens, 4);
  assert.ok((completed.elapsedMs ?? 0) >= 20);
  assert.equal(Object.hasOwn(manager.saved()[0]!.view, "startedAt"), false);
  const frozen = completed.elapsedMs!;
  await delay(30);
  assert.equal(manager.get("worker").elapsedMs, frozen);

  await manager.steer("/root", "worker", "continue");
  await tick();
  const resumed = await manager.wait("/root", "worker");
  assert.equal(resumed.inputTokens, 21);
  assert.equal(resumed.outputTokens, 7);
  assert.ok((resumed.elapsedMs ?? 0) >= frozen);
  assert.equal(resumed.startedAt, undefined);

  const saved = manager.saved();
  await manager.shutdown();
  await delay(40);
  const restored = fixture();
  restored.manager.restore(saved);
  assert.equal(restored.manager.get("worker").elapsedMs, saved[0]?.view.elapsedMs);
  assert.equal(restored.manager.get("worker").inputTokens, 21);
  assert.equal(restored.manager.get("worker").outputTokens, 7);
  assert.equal(restored.manager.get("worker").startedAt, undefined);
  await delay(30);
  assert.equal(restored.manager.get("worker").elapsedMs, saved[0]?.view.elapsedMs);
  await restored.manager.shutdown();
});

test("legacy restore defaults missing metrics to zero and resumes add driver deltas", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 });
  let emitUsage: ((input: number, output: number) => void) | undefined;
  const { manager } = fixture({
    createDriver: async (options) => ({
      sessionFile: "/tmp/legacy.jsonl",
      prompt: async () => {
        emitUsage = (input, output) =>
          options.onEvent({ kind: "usage", inputTokens: input, outputTokens: output });
      },
      steer: async () => {},
      snapshot: () => [],
      output: () => "answer",
      abort: async () => {},
      dispose: () => {},
      sendUpdate: () => {},
    }),
  });
  manager.restore([
    {
      view: {
        path: "/root/worker",
        parent: "/root",
        owner: "/root",
        type: "worker",
        state: "completed",
        task: "old",
        status: "Completed",
        createdAt: 1,
        sessionFile: "/tmp/legacy.jsonl",
      },
      definition: { name: "worker", description: "test", systemPrompt: "child prompt" },
    },
  ]);
  assert.equal(manager.get("worker").elapsedMs, 0);
  assert.equal(manager.get("worker").inputTokens, 0);
  assert.equal(manager.get("worker").outputTokens, 0);
  assert.equal(manager.get("worker").startedAt, undefined);

  await manager.steer("/root", "worker", "resume");
  await tick();
  emitUsage!(4, 2);
  assert.equal(manager.get("worker").inputTokens, 4);
  assert.equal(manager.get("worker").outputTokens, 2);
  assert.equal(manager.saved()[0]?.view.inputTokens, 4);
  await manager.shutdown();

  let resumedEmit: ((input: number, output: number) => void) | undefined;
  const resumed = fixture({
    createDriver: async (options) => ({
      sessionFile: "/tmp/legacy.jsonl",
      prompt: async () => {
        resumedEmit = (input, output) =>
          options.onEvent({ kind: "usage", inputTokens: input, outputTokens: output });
      },
      steer: async () => {},
      snapshot: () => [],
      output: () => "answer",
      abort: async () => {},
      dispose: () => {},
      sendUpdate: () => {},
    }),
  });
  resumed.manager.restore([
    {
      view: {
        path: "/root/worker",
        parent: "/root",
        owner: "/root",
        type: "worker",
        state: "paused",
        task: "old",
        status: "Paused",
        createdAt: 1,
        sessionFile: "/tmp/legacy.jsonl",
        elapsedMs: 80,
        inputTokens: 10,
        outputTokens: 3,
      },
      definition: { name: "worker", description: "test", systemPrompt: "child prompt" },
    },
  ]);
  await resumed.manager.steer("/root", "worker", "again");
  await tick();
  resumedEmit!(5, 1);
  assert.equal(resumed.manager.get("worker").inputTokens, 15);
  assert.equal(resumed.manager.get("worker").outputTokens, 4);
  assert.equal(resumed.manager.get("worker").elapsedMs, 80);
  assert.equal(resumed.manager.saved()[0]?.view.inputTokens, 15);
  await resumed.manager.shutdown();
});
