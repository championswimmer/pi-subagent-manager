import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  discoverAndLoadExtensions,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionError,
} from "@earendil-works/pi-coding-agent";
import piSubagent from "../src/index.ts";
import type { SavedThread, ThreadView } from "../src/types.ts";

const REGISTRY_ENTRY = "pi-subagent:registry:v1";
const answer = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  provider: "integration-test",
  model: "offline",
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
const registry = (manager: SessionManager) => {
  const entry = [...manager.getBranch()]
    .reverse()
    .find((item) => item.type === "custom" && item.customType === REGISTRY_ENTRY);
  assert.ok(entry?.type === "custom", "durable registry entry exists");
  return entry.data as { version: number; rootSessionId: string; threads: SavedThread[] };
};

// One lifecycle scenario using real SDK sessions, JSONL storage, and extension binding; no driver mocks.
test(
  "offline extension retains paused/completed child across parent reopen and isolates a fork",
  { timeout: 30000 },
  async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-integration-"));
    const previous = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = directory;
    const sessions = new Set<AgentSession>();
    const errors: ExtensionError[] = [];
    const requests: { system: string; messages: string }[] = [];
    let unexpectedCalls = 0;
    try {
      const cwd = path.join(directory, "workspace");
      await mkdir(cwd);
      await mkdir(path.join(directory, "agents"));
      await writeFile(
        path.join(directory, "agents", "offline.md"),
        "---\nname: offline\ndescription: Offline lifecycle worker\ntools:\n  allow: [agent_pause]\n---\nONLY OFFLINE CHILD\n",
      );
      // Exercise the file loader (Jiti) as well as the inline factory used for the bound sessions.
      const loaded = await discoverAndLoadExtensions(
        [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
        cwd,
        directory,
      );
      assert.deepEqual(loaded.errors, []);
      assert.ok(loaded.extensions.some((extension) => extension.tools.has("agent_spawn")));

      const runtime = await ModelRuntime.create({
        authPath: path.join(directory, "auth.json"),
        modelsPath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
      });
      runtime.registerProvider("integration-test", {
        api: "openai-completions",
        baseUrl: "http://invalid.local",
        models: [
          {
            id: "offline",
            name: "Offline",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 100000,
            maxTokens: 1000,
          },
        ],
        streamSimple(_model, context) {
          const system = JSON.stringify(
            context.messages.filter((message) => message.role === "system"),
          );
          requests.push({ system, messages: JSON.stringify(context.messages) });
          const isChild =
            system.includes("Your thread path is /root/worker") &&
            system.includes("ONLY OFFLINE CHILD");
          if (!isChild) unexpectedCalls++;
          const reply =
            isChild && requests.length === 1
              ? {
                  ...answer(""),
                  content: [
                    {
                      type: "toolCall" as const,
                      id: "pause-1",
                      name: "agent_pause",
                      arguments: { reason: "Need parent input" },
                    },
                  ],
                  stopReason: "toolUse" as const,
                }
              : answer(`child answer ${requests.length}`);
          const stream = createAssistantMessageEventStream();
          void Promise.resolve().then(() => {
            stream.push({ type: "start", partial: reply });
            stream.push({
              type: "done",
              reason: reply.stopReason as "stop" | "toolUse",
              message: reply,
            });
            stream.end(reply);
          });
          return stream;
        },
      });
      await runtime.setRuntimeApiKey("integration-test", "offline-runtime-key");
      const open = async (manager: SessionManager) => {
        const settingsManager = SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: false },
        });
        const resourceLoader = new DefaultResourceLoader({
          cwd,
          agentDir: directory,
          settingsManager,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          systemPrompt: "OFFLINE PARENT",
          appendSystemPrompt: [],
          extensionFactories: [piSubagent],
        });
        await resourceLoader.reload();
        const { session, extensionsResult } = await createAgentSession({
          cwd,
          agentDir: directory,
          modelRuntime: runtime,
          model: runtime.getModel("integration-test", "offline"),
          sessionManager: manager,
          settingsManager,
          resourceLoader,
          noTools: "builtin",
          thinkingLevel: "off",
        });
        sessions.add(session);
        assert.deepEqual(extensionsResult.errors, []);
        await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
        assert.ok(session.getActiveToolNames().includes("agent_spawn"));
        assert.ok(session.getAllTools().some((tool) => tool.name === "agent_steer"));
        return session;
      };
      const close = async (session: AgentSession) => {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
        sessions.delete(session);
      };
      const tool = async <T>(
        session: AgentSession,
        name: string,
        args: Record<string, unknown>,
      ): Promise<T> => {
        const definition = session.getToolDefinition(name);
        assert.ok(definition, `${name} registered by extension`);
        const id = `integration-${name}`;
        const result = await definition.execute(
          id,
          args,
          undefined,
          undefined,
          session.extensionRunner.createToolContext(id, undefined),
        );
        return result.details as T;
      };
      const root = SessionManager.create(cwd, path.join(directory, "parents"));
      // Materialize parent JSONL without calling its model; this also gives the child inherited context.
      root.appendMessage({
        role: "user",
        content: "Durable parent context",
        timestamp: Date.now(),
      });
      let session = await open(root);
      const paused = await tool<ThreadView>(session, "agent_spawn", {
        path: "worker",
        type: "offline",
        task: "Pause until more input",
      });
      assert.equal(paused.state, "paused");
      assert.equal(paused.output, undefined, "pause must not hand back an answer");
      assert.equal(requests.length, 1, "pause stops before another provider turn");
      const childFile = paused.sessionFile!;
      assert.ok(childFile.startsWith(path.join(directory, "subagents", root.getSessionId())));
      assert.ok((await readFile(childFile, "utf8")).includes('"toolCallId":"pause-1"'));
      assert.equal(registry(root).rootSessionId, root.getSessionId());
      assert.equal(registry(root).threads[0].view.state, "paused");
      const parentFile = root.getSessionFile()!;
      await close(session);

      const reopened = SessionManager.open(parentFile);
      session = await open(reopened);
      assert.equal(reopened.getSessionId(), root.getSessionId());
      const restored = await tool<ThreadView>(session, "agent_status", { path: "worker" });
      assert.equal(restored.state, "paused");
      assert.equal(restored.sessionFile, childFile);
      assert.equal(requests.length, 1, "binding/restoring does not invoke a model");
      await tool(session, "agent_steer", { path: "worker", message: "Resume paused child" });
      const completed = await tool<ThreadView>(session, "agent_wait", { path: "worker" });
      assert.equal(completed.state, "completed");
      assert.equal(completed.output, "child answer 2");
      assert.equal(completed.sessionFile, childFile);
      assert.ok(
        requests[1].messages.includes("pause-1"),
        "resume retains the previous tool result",
      );
      assert.ok(requests[1].messages.includes("Resume paused child"));
      await close(session);

      const again = SessionManager.open(parentFile);
      session = await open(again);
      assert.equal(
        (await tool<ThreadView>(session, "agent_status", { path: "worker" })).state,
        "completed",
      );
      await tool(session, "agent_steer", { path: "worker", message: "More work after completion" });
      const continued = await tool<ThreadView>(session, "agent_wait", { path: "worker" });
      assert.equal(continued.state, "completed");
      assert.equal(continued.output, "child answer 3");
      assert.equal(continued.sessionFile, childFile);
      assert.ok(requests[2].messages.includes("child answer 2"));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(requests.length, 3, "notifications never auto-trigger the parent model");
      assert.equal(unexpectedCalls, 0);
      assert.equal(registry(again).threads[0].view.sessionFile, childFile);
      await close(session);
      const durable = SessionManager.open(parentFile);
      const notifications = durable
        .buildSessionContext()
        .messages.filter(
          (message) => message.role === "custom" && message.customType === "pi-subagent:update",
        );
      assert.equal(
        notifications.length,
        3,
        "pause and both completions are durable parent messages",
      );
      assert.ok(JSON.stringify(notifications).includes("Need parent input"));
      assert.ok(JSON.stringify(notifications).includes("child answer 3"));

      // A fork inherits registry entries, but must not acquire the original parent's writable child.
      const fork = SessionManager.forkFrom(parentFile, cwd, path.join(directory, "forks"));
      assert.notEqual(fork.getSessionId(), root.getSessionId());
      assert.equal(
        registry(fork).rootSessionId,
        root.getSessionId(),
        "fork initially copied the old registry",
      );
      session = await open(fork);
      assert.deepEqual(await tool(session, "agent_status", {}), []);
      assert.equal(registry(fork).rootSessionId, fork.getSessionId());
      assert.deepEqual(registry(fork).threads, []);
      assert.equal(
        registry(SessionManager.open(parentFile)).threads[0].view.sessionFile,
        childFile,
      );
      assert.equal(requests.length, 3);
      assert.deepEqual(errors, []);
    } finally {
      for (const session of sessions) {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        session.dispose();
      }
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      await rm(directory, { recursive: true, force: true });
    }
  },
);
