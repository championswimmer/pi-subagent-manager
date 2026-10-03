import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { withOfflineHarness } from "./helpers/integrationHarness.ts";

async function waitFor(predicate: () => boolean, description: string) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out: ${description}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const answer = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  provider: "integration-test",
  model: "offline",
  api: "openai-completions",
  stopReason: "stop",
  timestamp: Date.now(),
  usage: {
    input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
const worker = "---\nname: worker\ndescription: Execute work\n---\nExecute your assigned task.\n";

test("real SDK off hides all agent tools, including discovery, and leaves the prompt untouched", { timeout: 15000 }, async () => {
  await withOfflineHarness({
    agentFiles: { worker },
    managerSettings: { subagentMode: "off" },
    builtinTools: true,
    onRequest(request) {
      assert.doesNotMatch(request.system, /## pi-subagent|agent_spawn|agent_types|Opportunistic|Orchestration/);
      assert.ok(request.toolNames.includes("read"), "unrelated tools remain available");
      assert.ok(request.toolNames.every((name) => !name.startsWith("agent_")));
      return answer("ordinary root answer");
    },
  }, async ({ cwd, errors, open }) => {
    const session = await open(SessionManager.create(cwd));
    assert.ok(session.getActiveToolNames().includes("read"));
    assert.ok(session.getCallableToolNames().every((name) => !name.startsWith("agent_")));
    assert.ok(session.getAllTools().every((tool) => !tool.name.startsWith("agent_") || tool.exposure === "hidden"));
    await session.prompt("Do an ordinary task");
    assert.deepEqual(errors, []);
  });
});

test("real SDK mode changes update tool visibility and prompt on reload without disabling other tools", { timeout: 15000 }, async () => {
  await withOfflineHarness({
    agentFiles: { worker },
    managerSettings: { subagentMode: "opportunistic" },
    builtinTools: true,
    onRequest: () => answer("done"),
  }, async ({ directory, cwd, errors, open, requests }) => {
    const session = await open(SessionManager.create(cwd));
    const reload = session.extensionRunner.getCommand("agents");
    assert.ok(reload);
    await session.prompt("Initial task");
    assert.match(requests.at(-1)!.system, /Opportunistic mode/);
    const stale = session.getToolDefinition("agent_spawn")!;
    const otherTools = session.getActiveToolNames().filter((name) => !name.startsWith("agent_"));
    for (const mode of ["off", "orchestration", "off", "opportunistic"] as const) {
      await writeFile(join(directory, "subagent-manager", "settings.json"), JSON.stringify({ subagentMode: mode }));
      await reload.handler("reload", session.extensionRunner.createCommandContext());
      const enabled = mode !== "off";
      assert.equal(session.getActiveToolNames().includes("agent_spawn"), enabled);
      assert.equal(session.getCallableToolNames().includes("agent_spawn"), enabled);
      assert.equal(session.getAllTools().some((tool) => tool.name === "agent_spawn" && tool.exposure !== "hidden"), enabled);
      assert.deepEqual(session.getActiveToolNames().filter((name) => !name.startsWith("agent_")), otherTools);
      if (!enabled) {
        assert.throws(() => stale.execute("stale", {}, undefined, undefined, session.extensionRunner.createToolContext("stale", undefined)), /Subagent Mode is off/);
      }
      await session.prompt(`Task after switching to ${mode}`);
      const request = requests.at(-1)!;
      assert.equal(request.toolNames.includes("agent_spawn"), enabled);
      if (!enabled) assert.doesNotMatch(request.system, /## pi-subagent|agent_spawn|Opportunistic mode|Orchestration mode/);
      else assert.match(request.system, new RegExp(mode === "orchestration" ? "Orchestration mode" : "Opportunistic mode"));
    }
    assert.deepEqual(errors, []);
  });
});

test("off keeps running work but suppresses its notifications until re-enabled", { timeout: 15000 }, async () => {
  let finish!: (message: AssistantMessage) => void;
  const workerResult = new Promise<AssistantMessage>((resolve) => { finish = resolve; });
  await withOfflineHarness({
    agentFiles: { worker },
    onRequest(request) {
      if (request.path) return workerResult;
      if (request.pathCall === 1) return {
        ...answer(""), stopReason: "toolUse",
        content: [{ type: "toolCall", id: "background", name: "agent_spawn", arguments: {
          path: "background", type: "worker", task: "Finish retained work", wait: false,
        } }],
      };
      return answer("Assigned work");
    },
  }, async ({ directory, cwd, errors, open, requests }) => {
    const session = await open(SessionManager.create(cwd));
    await session.prompt("Assign background work");
    await waitFor(() => requests.some((request) => request.path === "/root/background"), "worker starts");
    const reload = session.extensionRunner.getCommand("agents")!;
    await writeFile(join(directory, "subagent-manager", "settings.json"), JSON.stringify({ subagentMode: "off" }));
    await reload.handler("reload", session.extensionRunner.createCommandContext());
    finish(answer("Retained result"));
    await waitFor(() => session.sessionManager.getEntries().some((entry) =>
      entry.type === "custom" && entry.customType === "pi-subagent:root-mailbox:v1"), "worker result retained");
    const notifications = () => session.sessionManager.getEntries().filter((entry) =>
      entry.type === "custom_message" && entry.customType === "pi-subagent:update");
    assert.equal(notifications().length, 0, "no plugin message while off");
    await writeFile(join(directory, "subagent-manager", "settings.json"), JSON.stringify({ subagentMode: "opportunistic" }));
    await reload.handler("reload", session.extensionRunner.createCommandContext());
    await waitFor(() => notifications().length === 1, "retained result delivered on re-enable");
    assert.deepEqual(errors, []);
  });
});

test("streaming notifications stay in the mailbox, do not duplicate on reload, and respect off at settlement", { timeout: 15000 }, async () => {
  let finishWorker!: (message: AssistantMessage) => void;
  let finishRoot!: (message: AssistantMessage) => void;
  const workerResult = new Promise<AssistantMessage>((resolve) => { finishWorker = resolve; });
  const rootResult = new Promise<AssistantMessage>((resolve) => { finishRoot = resolve; });
  await withOfflineHarness({
    agentFiles: { worker },
    onRequest(request) {
      if (request.path) return workerResult;
      if (request.pathCall === 1) return {
        ...answer(""), stopReason: "toolUse",
        content: [{ type: "toolCall", id: "streaming", name: "agent_spawn", arguments: {
          path: "background", type: "worker", task: "Finish during root streaming", wait: false,
        } }],
      };
      return rootResult;
    },
  }, async ({ directory, cwd, errors, open, requests }) => {
    const session = await open(SessionManager.create(cwd));
    const prompt = session.prompt("Assign background work and continue");
    const reload = session.extensionRunner.getCommand("agents")!;
    const notifications = () => session.sessionManager.getEntries().filter((entry) =>
      entry.type === "custom_message" && entry.customType === "pi-subagent:update");
    try {
      await waitFor(() => requests.some((request) => !request.path && request.pathCall === 2), "root remains streaming");
      finishWorker(answer("Early result"));
      await waitFor(() => session.sessionManager.getEntries().some((entry) =>
        entry.type === "custom" && entry.customType === "pi-subagent:root-mailbox:v1"), "result retained while enabled");
      await reload.handler("reload", session.extensionRunner.createCommandContext());
      await reload.handler("reload", session.extensionRunner.createCommandContext());
      assert.equal(notifications().length, 0, "do not enqueue mailbox replay while streaming");
      await writeFile(join(directory, "subagent-manager", "settings.json"), JSON.stringify({ subagentMode: "off" }));
      await reload.handler("reload", session.extensionRunner.createCommandContext());
      finishRoot(answer("Root settled"));
      await prompt;
      assert.equal(notifications().length, 0, "off prevents previously accepted delivery at turn end");
      await writeFile(join(directory, "subagent-manager", "settings.json"), JSON.stringify({ subagentMode: "opportunistic" }));
      await reload.handler("reload", session.extensionRunner.createCommandContext());
      await reload.handler("reload", session.extensionRunner.createCommandContext());
      assert.equal(notifications().length, 1, "deliver once when enabled and idle");
      assert.deepEqual(errors, []);
    } finally {
      finishWorker(answer("Cleanup"));
      finishRoot(answer("Cleanup"));
      await prompt;
    }
  });
});

test("enabled streaming mailbox is delivered once at agent settlement without another model turn", { timeout: 15000 }, async () => {
  let finishRoot!: (message: AssistantMessage) => void;
  const rootResult = new Promise<AssistantMessage>((resolve) => { finishRoot = resolve; });
  await withOfflineHarness({
    agentFiles: { worker },
    onRequest(request) {
      if (request.path) return answer("Worker result");
      if (request.pathCall === 1) return {
        ...answer(""), stopReason: "toolUse",
        content: [{ type: "toolCall", id: "settled", name: "agent_spawn", arguments: {
          path: "background", type: "worker", task: "Finish while root works", wait: false,
        } }],
      };
      return rootResult;
    },
  }, async ({ cwd, errors, open, requests }) => {
    const session = await open(SessionManager.create(cwd));
    const prompt = session.prompt("Assign background work and continue");
    const notifications = () => session.sessionManager.getEntries().filter((entry) =>
      entry.type === "custom_message" && entry.customType === "pi-subagent:update");
    try {
      await waitFor(() => session.sessionManager.getEntries().some((entry) =>
        entry.type === "custom" && entry.customType === "pi-subagent:root-mailbox:v1"), "streaming result retained");
      assert.equal(notifications().length, 0);
      finishRoot(answer("Root settled"));
      await prompt;
      assert.equal(notifications().length, 1);
      assert.equal(requests.filter((request) => !request.path).length, 2, "notification does not resume root");
      assert.deepEqual(errors, []);
    } finally {
      finishRoot(answer("Cleanup"));
      await prompt;
    }
  });
});

test("orchestration restricts /root's prompt, not the child worker's prompt", { timeout: 15000 }, async () => {
  await withOfflineHarness({
    agentFiles: { worker },
    managerSettings: { subagentMode: "orchestration" },
    onRequest(request) {
      if (request.path) {
        assert.doesNotMatch(request.system, /Orchestration mode|Delegate every user task|\/root only coordinates/);
        assert.match(request.system, /Execute your assigned task/);
        return answer("worker result");
      }
      assert.match(request.system, /Delegate every user task/);
      if (request.pathCall === 1) return {
        ...answer(""),
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "delegate", name: "agent_spawn", arguments: {
          path: "task", type: "worker", task: "Execute a small sequential task", wait: true,
        } }],
      };
      return answer("Synthesized worker result");
    },
  }, async ({ cwd, errors, open, requests }) => {
    const session = await open(SessionManager.create(cwd));
    await session.prompt("Complete a small task");
    assert.ok(requests.some((request) => request.path === "/root/task"));
    assert.deepEqual(errors, []);
  });
});
