import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ThreadView } from "../src/types.ts";
import { registry, withOfflineHarness } from "./helpers/integrationHarness.ts";

const reply: AssistantMessage = {
  role: "assistant",
  content: [{ type: "text", text: "Security reviewed" }],
  provider: "integration-test",
  model: "offline",
  api: "openai-completions",
  stopReason: "stop",
  timestamp: Date.now(),
  usage: {
    input: 10,
    output: 4,
    cacheRead: 2,
    cacheWrite: 3,
    totalTokens: 19,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
};

test("extension persists agent-only metrics across shutdown and resume", async () => {
  await withOfflineHarness(
    {
      agentFiles: {
        researcher:
          "---\nname: researcher\ndescription: Security researcher\n---\nReview security\n",
      },
      onRequest: () => structuredClone(reply),
    },
    async ({ cwd, open, close, tool, requests, errors }) => {
      const root = SessionManager.create(cwd);
      // Inherited context must not be billed to the child's counters.
      root.appendMessage({ ...reply, usage: { ...reply.usage, input: 1000, output: 1000 } });
      const session = await open(root);
      const agentPath = "/root/controller-security-research";
      const completed = await tool<ThreadView>(session, "agent_spawn", {
        path: agentPath,
        type: "researcher",
        task: "Review controller security",
        wait: true,
      });
      assert.equal(completed.path, agentPath);
      assert.equal(completed.type, "researcher");
      assert.equal(completed.inputTokens, 15);
      assert.equal(completed.outputTokens, 4);
      assert.equal(typeof completed.elapsedMs, "number");
      assert.ok(completed.elapsedMs! >= 0);
      assert.equal(completed.startedAt, undefined);
      assert.match(requests[0].system, /task-based.*kebab-case/);
      await close(session);
      assert.equal(registry(root).threads[0].view.inputTokens, 15);

      const reopened = await open(SessionManager.open(root.getSessionFile()!));
      await tool(reopened, "agent_steer", { path: agentPath, message: "Check once more" });
      const resumed = await tool<ThreadView>(reopened, "agent_wait", { path: agentPath });
      assert.equal(resumed.inputTokens, 30);
      assert.equal(resumed.outputTokens, 8);
      assert.ok(resumed.elapsedMs! >= completed.elapsedMs!);
      await close(reopened);
      assert.deepEqual(errors, []);
    },
  );
});
