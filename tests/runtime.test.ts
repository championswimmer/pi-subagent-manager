import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type, createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, SessionManager, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createDriverFactory } from "../src/runtime.ts";
import type { DriverOptions, AgentDriver } from "../src/types.ts";

const answer = (text: string): AssistantMessage => ({
  role: "assistant", content: [{ type: "text", text }], provider: "runtime-test", model: "model/with/slashes",
  api: "openai-completions", stopReason: "stop", timestamp: Date.now(),
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

test("isolated real SDK driver without credentials", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-runtime-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  const drivers: AgentDriver[] = [];
  try {
    const cwd = path.join(directory, "workspace");
    await mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true });
    await writeFile(path.join(cwd, ".pi", "extensions", "bad.ts"), 'throw new Error("External extension loaded")');
    await writeFile(path.join(cwd, "AGENTS.md"), "PARENT CONTEXT MUST NOT LOAD");
    await writeFile(path.join(directory, "APPEND_SYSTEM.md"), "PARENT APPEND MUST NOT LOAD");
    const runtime = await ModelRuntime.create({ authPath: path.join(directory, "auth.json"), modelsPath: null, refreshOnCreate: false });
    const registry = new ModelRegistry(runtime);
    let calls = 0;
    let next = answer("child answer");
        const requests: { system: string; model: Model<any>; messages: unknown[] }[] = [];
    registry.registerProvider("runtime-test", {
      api: "openai-completions", apiKey: "fake-local-key", baseUrl: "http://invalid.local",
      models: [{ id: "model/with/slashes", name: "Fake", reasoning: true, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
      streamSimple(model, context) {
        calls++;
        requests.push({ system: JSON.stringify(context.messages.filter(msg => msg.role === "system")), model, messages: context.messages });
        const stream = createAssistantMessageEventStream();
        const reply = structuredClone(next);
        void (async () => {
          await Promise.resolve();
          stream.push({ type: "start", partial: reply });
          if (reply.stopReason === "error" || reply.stopReason === "aborted") stream.push({ type: "error", reason: reply.stopReason, error: reply });
          else stream.push({ type: "done", reason: reply.stopReason as "stop" | "length" | "toolUse", message: reply });
          stream.end(reply);
        })();
        return stream;
      },
    });
    const root = SessionManager.create(cwd, path.join(directory, "root"));
    const ctx = { cwd, sessionManager: root, modelRegistry: registry, model: registry.find("runtime-test", "model/with/slashes"), thinkingLevel: "low" } as unknown as ExtensionContext;
    const factory = createDriverFactory(() => ctx);
    const events: { kind: string; text: string }[] = [];
    let pause = false;
    const options = (overrides: Partial<DriverOptions> = {}): DriverOptions => ({
      path: "/root/child", parentPath: "/root", type: { name: "worker", description: "Test", systemPrompt: "ONLY CHILD PROMPT", tools: { allow: [] } },
      inherited: [answer("inherited answer")], tools: [], onEvent: event => events.push(event), shouldPause: () => pause,
      ...overrides,
    });
    const create = async (opts: DriverOptions) => { const driver = await factory(opts); drivers.push(driver); return driver; };

    await t.test("system/history isolation, first-slash model parsing, output baseline and mailbox", async () => {
      const driver = await create(options({ type: { ...options().type, model: "runtime-test/model/with/slashes" } }));
      assert.equal(driver.output(), "");
      assert.ok(driver.sessionFile?.startsWith(path.join(directory, "subagents", root.getSessionId())));
      assert.equal(driver.snapshot().filter(msg => msg.role === "assistant").length, 1);
      const clone = driver.snapshot();
      clone.length = 0;
      assert.ok(driver.snapshot().length);
      await driver.prompt("task");
      assert.equal(driver.output(), "child answer");
      assert.equal(requests.at(-1)?.model.id, "model/with/slashes");
      assert.ok(requests.at(-1)?.system.includes("ONLY CHILD PROMPT"));
      assert.ok(!requests.at(-1)?.system.includes("PARENT CONTEXT"));
      assert.ok(!requests.at(-1)?.system.includes("PARENT APPEND"));
      const count = calls;
      driver.sendUpdate("mailbox update");
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(calls, count);
      next = answer("second run");
      await driver.prompt("again");
      assert.ok(driver.snapshot().some(msg => msg.role === "custom" && msg.content === "mailbox update"));
      assert.equal(driver.output(), "second run");
      const file = driver.sessionFile!;
      driver.dispose();
      driver.dispose();
      const reopened = await create(options({ sessionFile: file }));
      assert.equal(reopened.sessionFile, file);
      assert.equal(reopened.snapshot().filter(msg => msg.role === "assistant").length, 3);
      assert.equal(reopened.output(), "");
      await reopened.prompt("resume");
      assert.equal(reopened.output(), "second run");
    });

    await t.test("pause ends after tools and does not deadlock or consume steering", async () => {
      pause = false;
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const tool: ToolDefinition = {
        name: "agent_pause", label: "Pause", description: "Pause", parameters: Type.Object({}),
        async execute() { entered(); await gate; pause = true; return { content: [{ type: "text", text: "paused" }], details: undefined }; },
      };
      next = { ...answer("pausing"), content: [{ type: "toolCall", id: "pause-1", name: "agent_pause", arguments: {} }], stopReason: "toolUse" };
      const driver = await create(options({ path: "/root/pause", tools: [tool], type: { ...options().type, tools: { allow: ["agent_pause"] } } }));
      const count = calls;
      const run = driver.prompt("pause task");
      await started;
      await driver.steer("queued refinement");
      driver.sendUpdate("queued mailbox");
      release();
      await run;
      assert.equal(calls, count + 1);
      assert.equal(driver.output(), "");
      assert.ok(driver.snapshot().some(msg => msg.role === "toolResult" && msg.toolCallId === "pause-1"));
      pause = false;
      next = answer("resumed");
      await driver.prompt("resume");
      assert.equal(driver.output(), "resumed");
      assert.ok(driver.snapshot().some(msg => msg.role === "custom" && msg.content === "queued mailbox"));
    });

    await t.test("lexical parent's resolved thinking defaults", async () => {
      next = answer("nested");
      const parent = await create(options({ path: "/root/settings", type: { ...options().type, thinkingLevel: "high" } }));
      const child = await create(options({ path: "/root/settings/child", parentPath: "/root/settings", inherited: [] }));
      await child.prompt("nested task");
      const assistant = child.snapshot().filter(msg => msg.role === "assistant").at(-1);
      assert.equal(assistant?.thinkingLevel, "high");
      parent.dispose();
    });

    await t.test("assistant errors and cancellation reject, cleanup is idempotent", async () => {
      next = { ...answer(""), stopReason: "error", errorMessage: "terminal fake failure" };
      const driver = await create(options({ path: "/root/error" }));
      await assert.rejects(driver.prompt("fail"), /terminal fake failure/);
      assert.equal(driver.output(), "");
      next = { ...answer(""), stopReason: "aborted" };
      await assert.rejects(driver.prompt("cancel"), /aborted/);
      await Promise.all([driver.abort(), driver.abort()]);
      driver.dispose();
      driver.dispose();
      await driver.abort();
      await assert.rejects(driver.prompt("closed"), /disposed/);
      assert.ok(events.some(event => event.kind === "error"));
      assert.ok(events.every(event => event.text.length <= 1000));
    });

    await t.test("abort interrupts an active tool without blocking cleanup", async () => {
      let entered!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const tool: ToolDefinition = {
        name: "wait_signal", label: "Wait", description: "Wait", parameters: Type.Object({}),
        async execute(_id, _args, signal) {
          entered();
          await new Promise<void>((_resolve, reject) => {
            if (signal?.aborted) reject(new Error("cancelled"));
            else signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
          });
          return { content: [], details: undefined };
        },
      };
      next = { ...answer(""), content: [{ type: "toolCall", id: "wait-1", name: "wait_signal", arguments: {} }], stopReason: "toolUse" };
      const driver = await create(options({ path: "/root/abort", tools: [tool], type: { ...options().type, tools: { allow: ["wait_signal"] } } }));
      const run = driver.prompt("wait");
      const rejected = assert.rejects(run, /aborted/);
      await started;
      await Promise.all([driver.abort(), driver.abort()]);
      await rejected;
      driver.dispose();
    });

    await t.test("invalid model/tool/storage policies fail closed", async () => {
      await assert.rejects(factory(options({ type: { ...options().type, model: "bad" } })), /provider\/model-id/);
      await assert.rejects(factory(options({ type: { ...options().type, tools: { allow: ["missing"] } } })), /Unavailable tool/);
      const outside = path.join(directory, "outside.jsonl");
      await writeFile(outside, "{}");
      await assert.rejects(factory(options({ sessionFile: outside })), /inside this root/);
      ctx.model = { ...ctx.model!, api: "pi-virtual", id: "virtual" };
      const find = registry.find.bind(registry);
      registry.find = (provider, id) => id === "virtual" ? ctx.model : find(provider, id);
      await assert.rejects(factory(options()), /Virtual model.*physical/);
    });
  } finally {
    for (const driver of drivers) driver.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
