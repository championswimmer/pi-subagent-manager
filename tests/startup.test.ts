import { test } from "node:test";
import assert from "node:assert/strict";
import { ThreadManager } from "../src/manager.ts";
import type { AgentDriver, DriverOptions } from "../src/types.ts";

// One regression scenario guards reservation visibility, lazy reopen and late-driver cleanup.
test(
  "stop sees reserved children during lazy parent reopen and startup cannot strand shutdown",
  { timeout: 2000 },
  async () => {
    let release!: (driver: AgentDriver) => void;
    let options: DriverOptions | undefined;
    let disposed = false;
    const manager = new ThreadManager({
      rootSnapshot: () => [],
      getType: (name) => ({ name, description: "worker", systemPrompt: "prompt" }),
      toolsFor: () => [],
      createDriver: async (input) => {
        options = input;
        return new Promise((resolve) => {
          release = resolve;
        });
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
          task: "work",
          status: "Paused",
          createdAt: 0,
          sessionFile: "/tmp/saved.jsonl",
        },
        definition: { name: "worker", description: "worker", systemPrompt: "prompt" },
      },
    ]);
    const child = await manager.spawn("/root", {
      path: "worker/child",
      type: "worker",
      task: "nested",
      wait: false,
    });
    assert.equal(child.state, "starting");
    assert.ok(manager.saved().some((item) => item.view.path === child.path));
    const steering = assert.rejects(
      manager.steer("/root", child.path, "later"),
      /Thread is stopping/,
    );
    await manager.stop("/root", "worker");
    await steering;
    assert.equal(manager.get(child.path).state, "stopped");
    assert.equal(options?.signal.aborted, true);
    await assert.rejects(
      manager.spawn("/root/worker", { path: "late", type: "worker", task: "late" }),
      /working agent/,
    );
    await manager.shutdown();
    release({
      prompt: async () => {},
      steer: async () => {},
      snapshot: () => [],
      output: () => "",
      abort: async () => {},
      dispose: () => {
        disposed = true;
      },
      sendUpdate: () => {},
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(disposed, true);
  },
);
