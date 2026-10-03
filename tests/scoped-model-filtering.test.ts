import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ThreadView } from "../src/types.ts";
import { withOfflineHarness } from "./helpers/integrationHarness.ts";

const definition = (name: string, models: string[]) =>
  `---\nname: ${name}\ndescription: Filtering test\nmodels:\n${models.map((model) => `  - ${model}`).join("\n")}\ntools:\n  allow: []\n---\nFinish the task.\n`;
const answer = (model: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text: "done" }],
  provider: "integration-test",
  model,
  api: "openai-completions",
  stopReason: "stop",
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

test("scoped filtering reload changes new and retained agents without reopening the parent", { timeout: 30000 }, async () => {
  await withOfflineHarness(
    {
      agentFiles: {
        ordered: definition("ordered", ["integration-test/offline-alt", "integration-test/offline"]),
        unscoped: definition("unscoped", ["integration-test/offline-alt"]),
      },
      scopedModels: ["integration-test/offline"],
      managerSettings: { scopedModelFiltering: false },
      onRequest: (request) => answer(request.modelId),
    },
    async ({ directory, cwd, open, tool, requests, errors }) => {
      const session = await open(SessionManager.create(cwd));
      const spawn = (path: string, type = "ordered") =>
        tool<ThreadView>(session, "agent_spawn", { path, type, task: "Work" });
      assert.equal((await spawn("first")).state, "completed");
      assert.equal(requests.at(-1)?.modelId, "offline-alt", "off uses the first available preference even outside scope");

      const settingsPath = join(directory, "subagent-manager", "settings.json");
      await writeFile(settingsPath, JSON.stringify({ scopedModelFiltering: true }));
      await session.prompt("/agents reload");
      assert.equal((await spawn("second")).state, "completed");
      assert.equal(requests.at(-1)?.modelId, "offline", "on skips the first, unscoped preference");
      await tool(session, "agent_steer", { path: "first", message: "Continue" });
      assert.equal((await tool<ThreadView>(session, "agent_wait", { path: "first" })).state, "completed");
      assert.equal(requests.at(-1)?.modelId, "offline", "retained agent observes re-enabled filtering");
      const count = requests.length;
      const rejected = await spawn("rejected", "unscoped");
      assert.equal(rejected.state, "failed");
      assert.match(rejected.error ?? "", /\/scoped-models/);
      assert.equal(requests.length, count, "no request for rejected preferences");

      await writeFile(settingsPath, JSON.stringify({ scopedModelFiltering: false }));
      await session.prompt("/agents reload");
      assert.equal((await spawn("third", "unscoped")).state, "completed");
      assert.equal(requests.at(-1)?.modelId, "offline-alt", "disabling is live too");
      assert.deepEqual(errors, []);
    },
  );
});

test("disabled filtering works with empty scope but fails if no preference is available", { timeout: 30000 }, async () => {
  await withOfflineHarness(
    {
      agentFiles: {
        ordered: definition("ordered", ["integration-test/missing", "integration-test/offline-alt", "integration-test/offline"]),
        unavailable: definition("unavailable", ["integration-test/missing"]),
      },
      scopedModels: [],
      managerSettings: { scopedModelFiltering: false },
      onRequest: (request) => answer(request.modelId),
    },
    async ({ cwd, open, tool, requests, errors }) => {
      const session = await open(SessionManager.create(cwd));
      const result = await tool<ThreadView>(session, "agent_spawn", { path: "worker", type: "ordered", task: "Work" });
      assert.equal(result.state, "completed");
      assert.equal(requests[0]?.modelId, "offline-alt");
      const failed = await tool<ThreadView>(session, "agent_spawn", { path: "missing", type: "unavailable", task: "Work" });
      assert.equal(failed.state, "failed");
      assert.match(failed.error ?? "", /available models/i);
      assert.doesNotMatch(failed.error ?? "", /\/scoped-models/);
      assert.equal(requests.length, 1);
      assert.deepEqual(errors, []);
    },
  );
});
