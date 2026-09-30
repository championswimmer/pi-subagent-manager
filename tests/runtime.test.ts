import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  Type,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import {
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  BOOTSTRAP_MESSAGE,
  DurableMailbox,
  LEGACY_QUEUE_TYPE,
  MAILBOX_FIELD,
} from "../src/mailbox.ts";
import { createDriverFactory } from "../src/runtime.ts";
import type { DriverOptions, AgentDriver } from "../src/types.ts";

const answer = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  provider: "runtime-test",
  model: "model/with/slashes",
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

const messageText = (message: unknown): string => {
  if (!message || typeof message !== "object" || !("content" in message)) return "";
  const { content } = message as { content: unknown };
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: string; text?: string } => !!block && typeof block === "object",
    )
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("");
};

const countMessages = (messages: unknown[], role: string, text: string): number =>
  messages.filter(
    (message) =>
      !!message &&
      typeof message === "object" &&
      (message as { role?: string }).role === role &&
      messageText(message) === text,
  ).length;

const countTextMessages = (messages: unknown[], text: string): number =>
  messages.filter((message) => messageText(message) === text).length;

test("isolated real SDK driver without credentials", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-runtime-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  const drivers: AgentDriver[] = [];
  try {
    const cwd = path.join(directory, "workspace");
    await mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi", "extensions", "bad.ts"),
      'throw new Error("External extension loaded")',
    );
    await writeFile(path.join(cwd, "AGENTS.md"), "PARENT CONTEXT MUST NOT LOAD");
    await writeFile(path.join(directory, "APPEND_SYSTEM.md"), "PARENT APPEND MUST NOT LOAD");
    const runtime = await ModelRuntime.create({
      authPath: path.join(directory, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(runtime);
    let calls = 0;
    let next = answer("child answer");
    let beforeDone: Promise<void> | undefined;
    const requests: { system: string; model: Model<any>; messages: unknown[]; apiKey?: string }[] =
      [];
    registry.registerProvider("runtime-test", {
      api: "openai-completions",
      baseUrl: "http://invalid.local",
      models: [
        {
          id: "model/with/slashes",
          name: "Fake",
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100000,
          maxTokens: 1000,
        },
      ],
      streamSimple(model, context, streamOptions) {
        calls++;
        requests.push({
          system: JSON.stringify(context.messages.filter((msg) => msg.role === "system")),
          model,
          messages: context.messages,
          apiKey: streamOptions?.apiKey,
        });
        const stream = createAssistantMessageEventStream();
        const reply = structuredClone(next);
        void (async () => {
          await Promise.resolve();
          stream.push({ type: "start", partial: reply });
          if (beforeDone) await beforeDone;
          if (reply.stopReason === "error" || reply.stopReason === "aborted")
            stream.push({ type: "error", reason: reply.stopReason, error: reply });
          else
            stream.push({
              type: "done",
              reason: reply.stopReason as "stop" | "length" | "toolUse",
              message: reply,
            });
          stream.end(reply);
        })();
        return stream;
      },
    });
    await runtime.setRuntimeApiKey("runtime-test", "fake-runtime-only-key");
    assert.equal(registry.getProviderAuthStatus("runtime-test").source, "runtime");
    const root = SessionManager.create(cwd, path.join(directory, "root"));
    const ctx = {
      cwd,
      sessionManager: root,
      modelRegistry: registry,
      model: registry.find("runtime-test", "model/with/slashes"),
      thinkingLevel: "low",
    } as unknown as ExtensionContext;
    const factory = createDriverFactory(() => ctx);
    const events: { kind: string; text: string }[] = [];
    let pause = false;
    const options = (overrides: Partial<DriverOptions> = {}): DriverOptions => ({
      path: "/root/child",
      parentPath: "/root",
      type: {
        name: "worker",
        description: "Test",
        systemPrompt: "ONLY CHILD PROMPT",
        tools: { allow: [] },
      },
      inherited: [answer("inherited answer")],
      tools: [],
      onEvent: (event) => events.push(event),
      shouldPause: () => pause,
      signal: new AbortController().signal,
      ...overrides,
    });
    const create = async (opts: DriverOptions) => {
      const driver = await factory(opts);
      drivers.push(driver);
      return driver;
    };

    await t.test(
      "system/history isolation, first-slash model parsing, output baseline and mailbox",
      async () => {
        const driver = await create(
          options({
            type: { ...options().type, model: "runtime-test/model/with/slashes" },
            inherited: [
              answer("inherited answer"),
              {
                role: "custom",
                customType: "parent-note",
                content: "Inherited extension context",
                display: false,
                timestamp: Date.now(),
              },
              {
                role: "bashExecution",
                command: "echo inherited",
                output: "Inherited shell context",
                exitCode: 0,
                cancelled: false,
                truncated: false,
                timestamp: Date.now(),
              },
            ],
          }),
        );
        assert.equal(driver.output(), "");
        assert.ok(
          driver.sessionFile?.startsWith(path.join(directory, "subagents", root.getSessionId())),
        );
        assert.equal(driver.snapshot().filter((msg) => msg.role === "assistant").length, 1);
        const clone = driver.snapshot();
        clone.length = 0;
        assert.ok(driver.snapshot().length);
        await driver.prompt("task");
        assert.equal(driver.output(), "child answer");
        assert.ok(
          driver.sessionFile?.startsWith(path.join(directory, "subagents", root.getSessionId())),
        );
        assert.equal(requests.at(-1)?.model.id, "model/with/slashes");
        assert.equal(requests.at(-1)?.apiKey, "fake-runtime-only-key");
        assert.ok(requests.at(-1)?.system.includes("ONLY CHILD PROMPT"));
        assert.ok(requests.at(-1)?.system.includes("Your thread path is /root/child"));
        assert.ok(requests.at(-1)?.system.includes("Your lexical parent is /root"));
        assert.ok(requests.at(-1)?.system.includes("agent_pause"));
        assert.ok(
          driver
            .snapshot()
            .some((msg) => msg.role === "custom" && msg.content === "Inherited extension context"),
        );
        assert.ok(
          driver
            .snapshot()
            .some(
              (msg) => msg.role === "bashExecution" && msg.output === "Inherited shell context",
            ),
        );
        assert.ok(!requests.at(-1)?.system.includes("PARENT CONTEXT"));
        assert.ok(!requests.at(-1)?.system.includes("PARENT APPEND"));
        const count = calls;
        await driver.sendUpdate("mailbox update");
        assert.equal(calls, count);
        next = answer("second run");
        await driver.prompt("again");
        assert.ok(
          driver
            .snapshot()
            .some((msg) => msg.role === "custom" && msg.content === "mailbox update"),
        );
        assert.equal(driver.output(), "second run");
        const file = driver.sessionFile!;
        driver.dispose();
        driver.dispose();
        const reopened = await create(options({ sessionFile: file }));
        assert.equal(reopened.sessionFile, file);
        assert.equal(reopened.snapshot().filter((msg) => msg.role === "assistant").length, 3);
        assert.equal(reopened.output(), "");
        await reopened.prompt("resume");
        assert.equal(reopened.output(), "second run");
        const freshSteer = await create(
          options({ path: "/independent-steer", parentPath: null, inherited: [] }),
        );
        assert.equal(typeof freshSteer.sessionFile, "undefined");
        const steerCalls = calls;
        await freshSteer.steer("queued before prompt");
        assert.equal(calls, steerCalls);
        assert.ok(freshSteer.sessionFile);
        const steerFile = freshSteer.sessionFile!;
        const steerLeaf = freshSteer.sessionLeafId;
        assert.ok(steerLeaf);
        freshSteer.dispose();
        const reopenedSteer = await create(
          options({
            path: "/independent-steer",
            parentPath: null,
            inherited: [],
            sessionFile: steerFile,
            sessionLeafId: steerLeaf,
          }),
        );
        assert.equal(countMessages(reopenedSteer.snapshot(), "user", "queued before prompt"), 0);
        next = answer("steer resumed");
        const steerRequests = requests.length;
        await reopenedSteer.prompt("independent task");
        assert.equal(reopenedSteer.output(), "steer resumed");
        assert.equal(
          countMessages(
            requests.slice(steerRequests).at(-1)!.messages,
            "user",
            "queued before prompt",
          ),
          1,
        );
        assert.equal(countMessages(reopenedSteer.snapshot(), "user", "queued before prompt"), 1);
        const independent = await create(
          options({ path: "/independent", parentPath: null, inherited: [] }),
        );
        assert.equal(typeof independent.sessionFile, "undefined");
        const independentCalls = calls;
        await independent.sendUpdate("independent mailbox");
        assert.equal(calls, independentCalls);
        assert.ok(independent.sessionFile);
        assert.ok(
          independent
            .snapshot()
            .some((msg) => msg.role === "user" && messageText(msg) === BOOTSTRAP_MESSAGE),
        );
        assert.ok(
          independent
            .snapshot()
            .some((msg) => msg.role === "custom" && messageText(msg) === "independent mailbox"),
        );
        await independent.prompt("independent task");
        const independentFile = independent.sessionFile;
        assert.ok(
          independentFile?.startsWith(path.join(directory, "subagents", root.getSessionId())),
        );
      },
    );

    await t.test("pause settles after tools, then dispose/reopen same JSONL resumes", async () => {
      pause = false;
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tool: ToolDefinition = {
        name: "agent_pause",
        label: "Pause",
        description: "Pause",
        parameters: Type.Object({}),
        async execute() {
          entered();
          await gate;
          pause = true;
          return { content: [{ type: "text", text: "paused" }], details: undefined };
        },
      };
      next = {
        ...answer("pausing"),
        content: [{ type: "toolCall", id: "pause-1", name: "agent_pause", arguments: {} }],
        stopReason: "toolUse",
      };
      const pauseOptions = options({
        path: "/root/pause",
        tools: [tool],
        type: { ...options().type, tools: { allow: ["agent_pause"] } },
      });
      const driver = await create(pauseOptions);
      await driver.sendUpdate("queued mailbox");
      const count = calls;
      const run = driver.prompt("pause task");
      await started;
      await driver.steer("queued refinement");
      release();
      await run;
      assert.equal(calls, count + 1);
      assert.equal(driver.output(), "");
      assert.ok(
        driver.snapshot().some((msg) => msg.role === "toolResult" && msg.toolCallId === "pause-1"),
      );
      await driver.sendUpdate("paused mailbox");
      assert.equal(calls, count + 1);
      assert.ok(
        driver.snapshot().some((msg) => msg.role === "custom" && msg.content === "paused mailbox"),
      );
      const file = driver.sessionFile!;
      driver.dispose();
      const reopened = await create({ ...pauseOptions, sessionFile: file });
      assert.equal(reopened.sessionFile, file);
      assert.ok(
        reopened
          .snapshot()
          .some((msg) => msg.role === "toolResult" && msg.toolCallId === "pause-1"),
      );
      assert.ok(
        reopened
          .snapshot()
          .some((msg) => msg.role === "custom" && msg.content === "queued mailbox"),
      );
      assert.ok(
        reopened
          .snapshot()
          .some((msg) => msg.role === "custom" && msg.content === "paused mailbox"),
      );
      const resumeRequests = requests.length;
      pause = false;
      next = answer("resumed");
      await reopened.prompt("resume");
      assert.equal(reopened.output(), "resumed");
      assert.ok(
        requests
          .slice(resumeRequests)
          .some((request) => JSON.stringify(request.messages).includes("queued refinement")),
      );
    });

    await t.test(
      "durable queued steering and running updates replay once after reopen before boundary",
      async () => {
        let releaseDone!: () => void;
        beforeDone = new Promise<void>((resolve) => {
          releaseDone = resolve;
        });
        next = answer("delayed original");
        const driver = await create(options({ path: "/root/durable" }));
        const run = driver.prompt("initial task");
        await new Promise((resolve) => setImmediate(resolve));
        assert.ok(driver.sessionFile);
        await driver.steer("same steer");
        await driver.steer("same steer");
        await driver.sendUpdate("running progress");
        const file = driver.sessionFile!;
        const pendingLeaf = driver.sessionLeafId;
        driver.dispose();
        releaseDone();
        await run.catch(() => undefined);
        beforeDone = undefined;
        SessionManager.open(file).appendCustomMessageEntry(
          "branch-probe",
          "future-only history",
          false,
        );
        const reopenCalls = calls;
        const reopened = await create(
          options({ path: "/root/durable", sessionFile: file, sessionLeafId: pendingLeaf }),
        );
        assert.equal(calls, reopenCalls);
        assert.equal(countMessages(reopened.snapshot(), "custom", "future-only history"), 0);
        assert.equal(countMessages(reopened.snapshot(), "user", "same steer"), 0);
        assert.equal(countMessages(reopened.snapshot(), "custom", "running progress"), 0);
        next = answer("after resume");
        const requestCount = requests.length;
        await reopened.prompt("resume after crash");
        assert.equal(reopened.output(), "after resume");
        const resumedRequests = requests.slice(requestCount);
        assert.ok(
          resumedRequests.some(
            (request) => countMessages(request.messages, "user", "same steer") >= 1,
          ),
        );
        assert.ok(
          resumedRequests.some(
            (request) => countTextMessages(request.messages, "running progress") >= 1,
          ),
        );
        assert.equal(countMessages(reopened.snapshot(), "user", "same steer"), 2);
        assert.equal(countMessages(reopened.snapshot(), "custom", "running progress"), 1);
      },
    );

    await t.test(
      "selected session leaf restores only that branch and invalid leaves fail closed",
      async () => {
        next = answer("first answer");
        const driver = await create(options({ path: "/root/branch" }));
        await driver.prompt("first prompt");
        assert.ok(driver.sessionLeafId);
        const firstLeaf = driver.sessionLeafId!;
        next = answer("second answer");
        await driver.prompt("second prompt");
        const file = driver.sessionFile!;
        const reopenCalls = calls;
        const reopened = await create(
          options({ path: "/root/branch", sessionFile: file, sessionLeafId: firstLeaf }),
        );
        assert.equal(calls, reopenCalls);
        next = answer("branched answer");
        await reopened.prompt("branch prompt");
        const branchRequest = requests.at(-1)!;
        const serialized = JSON.stringify(branchRequest.messages);
        assert.ok(serialized.includes("first prompt"));
        assert.ok(serialized.includes("first answer"));
        assert.ok(!serialized.includes("second prompt"));
        assert.ok(!serialized.includes("second answer"));
        await assert.rejects(
          create(
            options({ path: "/root/branch-bad", sessionFile: file, sessionLeafId: "missing" }),
          ),
          /not found/,
        );
      },
    );

    await t.test(
      "transcript UUIDs reconcile missing consumed markers without duplicating updates",
      async () => {
        const driver = await create(options({ path: "/root/reconcile" }));
        await driver.sendUpdate("checkpointed update");
        const file = driver.sessionFile!;
        const branch = SessionManager.open(
          file,
          path.join(directory, "subagents", root.getSessionId()),
          cwd,
        )
          .getBranch()
          .find(
            (entry) =>
              entry.type === "custom_message" &&
              messageText({ content: entry.content }) === "checkpointed update" &&
              !!(entry.details as Record<string, unknown> | undefined)?.[MAILBOX_FIELD],
          );
        assert.ok(branch && branch.type === "custom_message");
        const reopenCalls = calls;
        const reopened = await create(
          options({ path: "/root/reconcile", sessionFile: file, sessionLeafId: branch.id }),
        );
        assert.equal(calls, reopenCalls);
        next = answer("reconciled");
        await reopened.prompt("continue");
        const request = requests.at(-1)!;
        assert.equal(countTextMessages(request.messages, "checkpointed update"), 1);
        assert.equal(countMessages(reopened.snapshot(), "custom", "checkpointed update"), 1);
      },
    );

    await t.test("partial legacy queue migration preserves each occurrence across reopen", () => {
      const legacy = SessionManager.create(cwd, path.join(directory, "legacy"));
      legacy.appendMessage(answer("legacy history"));
      legacy.appendCustomEntry(LEGACY_QUEUE_TYPE, {
        steering: ["same", "same"],
        followUp: ["later"],
      });
      const first = new DurableMailbox(legacy).pending();
      const interrupted = legacy
        .getBranch()
        .find(
          (entry) =>
            entry.type === "custom" &&
            (entry.data as { id?: string } | undefined)?.id === first[0].id,
        );
      assert.ok(interrupted);
      const reopened = SessionManager.open(legacy.getSessionFile()!);
      reopened.branch(interrupted.id); // Simulate exit after only the first acceptance persisted.
      const recovered = new DurableMailbox(reopened).pending();
      assert.deepEqual(
        recovered.map((entry) => entry.content),
        ["same", "same", "later"],
      );
      assert.equal(new Set(recovered.map((entry) => entry.id)).size, 3);
      assert.deepEqual(
        recovered.map((entry) => entry.id),
        first.map((entry) => entry.id),
      );
      assert.deepEqual(new DurableMailbox(reopened).pending(), recovered);
    });

    await t.test("lexical parent's resolved thinking defaults", async () => {
      next = answer("nested");
      const parent = await create(
        options({ path: "/root/settings", type: { ...options().type, thinkingLevel: "high" } }),
      );
      const child = await create(
        options({ path: "/root/settings/child", parentPath: "/root/settings", inherited: [] }),
      );
      await child.prompt("nested task");
      const assistant = child
        .snapshot()
        .filter((msg) => msg.role === "assistant")
        .at(-1);
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
      assert.ok(events.some((event) => event.kind === "error"));
      assert.ok(events.every((event) => event.text.length <= 1000));
    });

    await t.test("abort interrupts an active tool without blocking cleanup", async () => {
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const tool: ToolDefinition = {
        name: "wait_signal",
        label: "Wait",
        description: "Wait",
        parameters: Type.Object({}),
        async execute(_id, _args, signal) {
          entered();
          await new Promise<void>((_resolve, reject) => {
            if (signal?.aborted) reject(new Error("cancelled"));
            else
              signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
                once: true,
              });
          });
          return { content: [], details: undefined };
        },
      };
      next = {
        ...answer(""),
        content: [{ type: "toolCall", id: "wait-1", name: "wait_signal", arguments: {} }],
        stopReason: "toolUse",
      };
      const driver = await create(
        options({
          path: "/root/abort",
          tools: [tool],
          type: { ...options().type, tools: { allow: ["wait_signal"] } },
        }),
      );
      const run = driver.prompt("wait");
      const rejected = assert.rejects(run, /aborted/);
      await started;
      await Promise.all([driver.abort(), driver.abort()]);
      await rejected;
      driver.dispose();
    });

    await t.test("startup cancellation rejects before allocation and during setup", async () => {
      const controller = new AbortController();
      controller.abort(new Error("startup cancelled"));
      const count = calls;
      await assert.rejects(factory(options({ signal: controller.signal })), /startup cancelled/);
      const duringSetup = new AbortController();
      const registeredIds = registry.getRegisteredProviderIds.bind(registry);
      registry.getRegisteredProviderIds = () => {
        duringSetup.abort(new Error("setup cancelled"));
        return registeredIds();
      };
      try {
        await assert.rejects(factory(options({ signal: duringSetup.signal })), /setup cancelled/);
      } finally {
        registry.getRegisteredProviderIds = registeredIds;
      }
      assert.equal(calls, count);
    });

    await t.test("invalid model/tool/storage policies fail closed", async () => {
      await assert.rejects(
        factory(options({ type: { ...options().type, model: "bad" } })),
        /provider\/model-id/,
      );
      await assert.rejects(
        factory(options({ type: { ...options().type, tools: { allow: ["missing"] } } })),
        /Unavailable tool/,
      );
      const outside = path.join(directory, "outside.jsonl");
      await writeFile(outside, "{}");
      await assert.rejects(factory(options({ sessionFile: outside })), /inside this root/);
      ctx.model = { ...ctx.model!, api: "pi-virtual", id: "virtual" };
      const find = registry.find.bind(registry);
      registry.find = (provider, id) => (id === "virtual" ? ctx.model : find(provider, id));
      await assert.rejects(factory(options()), /Virtual model.*physical/);
    });
  } finally {
    for (const driver of drivers) driver.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
