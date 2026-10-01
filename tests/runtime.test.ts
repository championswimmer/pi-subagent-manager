import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
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
import type { AgentDriver, DriverEvent, DriverOptions } from "../src/types.ts";

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
    let scripted:
      ((stream: ReturnType<typeof createAssistantMessageEventStream>) => void) | undefined;
    const requests: { system: string; model: Model<any>; messages: unknown[]; apiKey?: string }[] =
      [];
    const registerProvider = (provider: string, ids: string[]) =>
      registry.registerProvider(provider, {
        api: "openai-completions",
        baseUrl: "http://invalid.local",
        models: ids.map((id) => ({
          id,
          name: `${provider}/${id}`,
          reasoning: true,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100000,
          maxTokens: 1000,
        })),
        streamSimple(model, context, streamOptions) {
          calls++;
          requests.push({
            system: JSON.stringify(context.messages.filter((msg) => msg.role === "system")),
            model,
            messages: context.messages,
            apiKey: streamOptions?.apiKey,
          });
          const stream = createAssistantMessageEventStream();
          if (scripted) {
            const run = scripted;
            scripted = undefined;
            run(stream);
            return stream;
          }
          const reply = {
            ...structuredClone(next),
            provider: model.provider,
            model: model.id,
          };
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
    registerProvider("runtime-test", ["model/with/slashes", "fallback"]);
    registerProvider("runtime-other", ["backup"]);
    await runtime.setRuntimeApiKey("runtime-test", "fake-runtime-only-key");
    await runtime.setRuntimeApiKey("runtime-other", "other-runtime-only-key");
    assert.equal(registry.getProviderAuthStatus("runtime-test").source, "runtime");
    assert.equal(registry.getProviderAuthStatus("runtime-other").source, "runtime");
    const root = SessionManager.create(cwd, path.join(directory, "root"));
    let scopedModels = [
      { model: registry.find("runtime-test", "model/with/slashes")! },
      { model: registry.find("runtime-other", "backup")! },
    ];
    const ctx = {
      cwd,
      sessionManager: root,
      modelRegistry: registry,
      model: registry.find("runtime-test", "model/with/slashes"),
      get scopedModels() {
        return scopedModels;
      },
      thinkingLevel: "low",
    } as unknown as ExtensionContext;
    const setScopedModels = (...identities: string[]) => {
      scopedModels = identities.map((identity) => {
        const slash = identity.indexOf("/");
        return { model: registry.find(identity.slice(0, slash), identity.slice(slash + 1))! };
      });
    };
    const setRootModel = (identity: string) => {
      const slash = identity.indexOf("/");
      ctx.model = registry.find(identity.slice(0, slash), identity.slice(slash + 1))!;
    };
    const factory = createDriverFactory(() => ctx);
    const events: DriverEvent[] = [];
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
        assert.ok(driver.sessionFile);
        assert.equal(path.dirname(driver.sessionFile), root.getSessionDir());
        assert.equal(driver.snapshot().filter((msg) => msg.role === "assistant").length, 1);
        const clone = driver.snapshot();
        clone.length = 0;
        assert.ok(driver.snapshot().length);
        await driver.prompt("task");
        assert.equal(driver.output(), "child answer");
        assert.ok(driver.sessionFile);
        assert.equal(path.dirname(driver.sessionFile), root.getSessionDir());
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
        assert.ok(independentFile);
        assert.equal(path.dirname(independentFile), root.getSessionDir());
        assert.equal(
          SessionManager.open(independentFile).getHeader()?.parentSession,
          root.getSessionFile(),
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
      "queued steering continuation rechecks scoped preferences before the second provider call",
      async () => {
        setScopedModels("runtime-test/model/with/slashes");
        setRootModel("runtime-test/model/with/slashes");
        events.length = 0;
        let releaseDone!: () => void;
        beforeDone = new Promise<void>((resolve) => {
          releaseDone = resolve;
        });
        next = answer("first explicit turn");
        const driver = await create(
          options({
            path: "/root/queued-scope-revoked",
            type: {
              ...options().type,
              models: ["runtime-test/model/with/slashes"],
            },
          }),
        );
        const beforeCalls = calls;
        const run = assert.rejects(
          driver.prompt("start explicit run"),
          (error: unknown) => {
            assert.match(String(error), /\/scoped-models/);
            return true;
          },
        );
        await new Promise((resolve) => setImmediate(resolve));
        await driver.steer("queued after acceptance");
        assert.ok(driver.sessionFile);
        const sessionFile = driver.sessionFile!;
        setScopedModels();
        releaseDone();
        await run;
        beforeDone = undefined;
        assert.equal(calls, beforeCalls + 1);
        assert.ok(
          events.some((event) => event.kind === "error" && /\/scoped-models/.test(event.text)),
        );
        assert.equal(countMessages(driver.snapshot(), "user", "queued after acceptance"), 1);
        assert.deepEqual(new DurableMailbox(SessionManager.open(sessionFile)).pending(), []);
        setScopedModels("runtime-test/model/with/slashes", "runtime-other/backup");
      },
    );

    await t.test("scope-revoked steering is rejected before mailbox persistence", async () => {
      setScopedModels("runtime-test/model/with/slashes");
      setRootModel("runtime-test/model/with/slashes");
      const driver = await create(
        options({
          path: "/root/reject-steer-before-mailbox",
          type: {
            ...options().type,
            models: ["runtime-test/model/with/slashes"],
          },
        }),
      );
      const sessionFile = driver.sessionFile;
      setScopedModels();
      await assert.rejects(driver.steer("blocked before mailbox"), /\/scoped-models/);
      assert.equal(driver.sessionFile, sessionFile);
      assert.equal(countMessages(driver.snapshot(), "user", "blocked before mailbox"), 0);
      if (sessionFile)
        assert.deepEqual(
          new DurableMailbox(SessionManager.open(sessionFile))
            .pending()
            .filter((entry) => entry.content === "blocked before mailbox"),
          [],
        );
      setScopedModels("runtime-test/model/with/slashes", "runtime-other/backup");
    });

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
          create(options({ path: "/root/branch", sessionFile: file, sessionLeafId: "missing" })),
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
        const branch = SessionManager.open(file, root.getSessionDir(), cwd)
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

    await t.test(
      "ordered scoped preferences beat scope order, skip missing entries and preserve exact identities",
      async () => {
        setScopedModels("runtime-test/model/with/slashes", "runtime-other/backup");
        next = answer("ordered scoped");
        const driver = await create(
          options({
            path: "/root/ordered",
            type: {
              ...options().type,
              models: [
                "runtime-other/missing",
                "runtime-other/backup",
                "runtime-test/model/with/slashes",
              ],
            },
          }),
        );
        await driver.prompt("prefer ordered scoped model");
        assert.equal(requests.at(-1)?.model.provider, "runtime-other");
        assert.equal(requests.at(-1)?.model.id, "backup");
        assert.equal(requests.at(-1)?.apiKey, "other-runtime-only-key");
      },
    );

    await t.test(
      "explicit scoped preferences fail closed and cached drivers reselect after scope changes",
      async () => {
        const baselineCalls = calls;
        setScopedModels();
        await assert.rejects(
          create(
            options({
              path: "/root/no-scope",
              type: {
                ...options().type,
                name: "empty-scope",
                models: ["runtime-test/model/with/slashes"],
              },
            }),
          ),
          (error: unknown) => {
            assert.match(String(error), /empty-scope/);
            assert.match(String(error), /runtime-test\/model\/with\/slashes/);
            assert.match(String(error), /\/scoped-models/);
            assert.match(String(error), /\[\]/);
            return true;
          },
        );
        assert.equal(calls, baselineCalls);
        setScopedModels("runtime-other/backup");
        await assert.rejects(
          create(
            options({
              path: "/root/unmatched-scope",
              type: {
                ...options().type,
                name: "unmatched-scope",
                models: ["runtime-test/model/with/slashes"],
              },
            }),
          ),
          (error: unknown) => {
            assert.match(String(error), /unmatched-scope/);
            assert.match(String(error), /runtime-other\/backup/);
            assert.match(String(error), /\/scoped-models/);
            return true;
          },
        );
        assert.equal(calls, baselineCalls);

        setScopedModels("runtime-other/backup", "runtime-test/model/with/slashes");
        next = answer("saved backup model");
        const initial = await create(
          options({
            path: "/root/restored-policy",
            type: { ...options().type, models: ["runtime-other/backup"] },
          }),
        );
        await initial.prompt("save transcript on backup");
        const savedFile = initial.sessionFile!;
        const savedContext = SessionManager.open(savedFile).buildSessionContext();
        assert.equal(savedContext.model?.provider, "runtime-other");
        assert.equal(savedContext.model?.modelId, "backup");
        initial.dispose();

        next = answer("restored obeyed policy");
        const restoredDriver = await create(
          options({
            path: "/root/restored-policy",
            sessionFile: savedFile,
            type: { ...options().type, models: ["runtime-test/model/with/slashes"] },
          }),
        );
        await restoredDriver.prompt("resume with explicit policy");
        assert.equal(requests.at(-1)?.model.provider, "runtime-test");
        assert.equal(requests.at(-1)?.model.id, "model/with/slashes");
        assert.equal(requests.at(-1)?.apiKey, "fake-runtime-only-key");

        setScopedModels("runtime-other/backup");
        next = answer("cached backup");
        const cached = await create(
          options({
            path: "/root/cached-scope",
            type: {
              ...options().type,
              models: ["runtime-test/model/with/slashes", "runtime-other/backup"],
            },
          }),
        );
        await cached.prompt("first cached run");
        assert.equal(requests.at(-1)?.model.provider, "runtime-other");
        assert.equal(requests.at(-1)?.model.id, "backup");

        setScopedModels();
        const rejectedCalls = calls;
        await assert.rejects(cached.prompt("scope lost"), /\/scoped-models/);
        assert.equal(calls, rejectedCalls);

        setScopedModels("runtime-test/model/with/slashes");
        next = answer("cached switched");
        await cached.prompt("scope regained");
        assert.equal(requests.at(-1)?.model.provider, "runtime-test");
        assert.equal(requests.at(-1)?.model.id, "model/with/slashes");
        assert.equal(requests.at(-1)?.apiKey, "fake-runtime-only-key");
      },
    );

    await t.test(
      "tool continuation stops on scope drift until a resumed prompt reselects the preferred model",
      async () => {
        setScopedModels("runtime-test/model/with/slashes", "runtime-other/backup");
        setRootModel("runtime-test/model/with/slashes");
        let release!: () => void;
        let entered!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const tool: ToolDefinition = {
          name: "scope_gate",
          label: "Scope Gate",
          description: "Blocks until scope changes",
          parameters: Type.Object({}),
          async execute() {
            entered();
            await gate;
            return { content: [{ type: "text", text: "done" }], details: undefined };
          },
        };
        next = {
          ...answer(""),
          content: [{ type: "toolCall", id: "scope-gate-1", name: "scope_gate", arguments: {} }],
          stopReason: "toolUse",
        };
        const driver = await create(
          options({
            path: "/root/tool-scope-change",
            tools: [tool],
            type: {
              ...options().type,
              models: ["runtime-test/model/with/slashes", "runtime-other/backup"],
              tools: { allow: ["scope_gate"] },
            },
          }),
        );
        const beforeCalls = calls;
        const run = assert.rejects(
          driver.prompt("tool turn"),
          (error: unknown) => {
            assert.match(String(error), /scope changed/);
            assert.match(String(error), /preferred is runtime-other\/backup/);
            assert.match(String(error), /resume agent to use runtime-other\/backup/);
            return true;
          },
        );
        await started;
        setScopedModels("runtime-other/backup");
        setRootModel("runtime-other/backup");
        release();
        await run;
        assert.equal(calls, beforeCalls + 1);

        next = answer("resumed on backup");
        await driver.prompt("resume on backup");
        assert.equal(requests.at(-1)?.model.provider, "runtime-other");
        assert.equal(requests.at(-1)?.model.id, "backup");
        assert.equal(requests.at(-1)?.apiKey, "other-runtime-only-key");
        setScopedModels("runtime-test/model/with/slashes", "runtime-other/backup");
        setRootModel("runtime-test/model/with/slashes");
      },
    );

    await t.test(
      "omitted model drivers preserve cached and restored selections across scope changes",
      async () => {
        setScopedModels("runtime-test/model/with/slashes", "runtime-other/backup");
        setRootModel("runtime-test/model/with/slashes");
        next = answer("omitted initial");
        const driver = await create(options({ path: "/root/omitted-policy" }));
        await driver.prompt("first omitted run");
        assert.equal(requests.at(-1)?.model.provider, "runtime-test");
        assert.equal(requests.at(-1)?.model.id, "model/with/slashes");
        const savedFile = driver.sessionFile!;

        setScopedModels("runtime-other/backup", "runtime-test/model/with/slashes");
        setRootModel("runtime-other/backup");
        next = answer("omitted cached");
        await driver.prompt("second omitted run");
        assert.equal(requests.at(-1)?.model.provider, "runtime-test");
        assert.equal(requests.at(-1)?.model.id, "model/with/slashes");

        driver.dispose();
        next = answer("omitted restored");
        const restored = await create(
          options({
            path: "/root/omitted-policy",
            sessionFile: savedFile,
          }),
        );
        await restored.prompt("restored omitted run");
        assert.equal(requests.at(-1)?.model.provider, "runtime-test");
        assert.equal(requests.at(-1)?.model.id, "model/with/slashes");
        setScopedModels("runtime-test/model/with/slashes", "runtime-other/backup");
        setRootModel("runtime-test/model/with/slashes");
      },
    );

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
      assert.ok(
        events.every(
          (event) =>
            event.kind === "usage" || event.kind === "checkpoint" || event.text.length <= 1000,
        ),
      );
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

    await t.test("shared session directory enforces root and thread ownership", async () => {
      next = answer("owned answer");
      const driver = await create(options({ path: "/root/owned" }));
      await driver.prompt("owned task");
      const file = driver.sessionFile!;
      await assert.rejects(
        factory(options({ path: "/root/wrong-thread", sessionFile: file })),
        /inside this root|ownership|thread/i,
      );
      const otherRoot = SessionManager.create(cwd, root.getSessionDir());
      const otherFactory = createDriverFactory(() => ({ ...ctx, sessionManager: otherRoot }));
      await assert.rejects(
        otherFactory(options({ path: "/root/owned", sessionFile: file })),
        /inside this root|ownership|thread/i,
      );
      root.appendMessage(answer("root transcript"));
      await assert.rejects(
        factory(options({ sessionFile: root.getSessionFile()! })),
        /inside this root|ownership|thread/i,
      );
      const foreign = SessionManager.create(cwd, path.join(directory, "foreign"));
      foreign.appendMessage(answer("foreign transcript"));
      const linked = path.join(root.getSessionDir(), "foreign-link.jsonl");
      await symlink(foreign.getSessionFile()!, linked);
      await assert.rejects(factory(options({ sessionFile: linked })), /inside this root/i);
    });

    await t.test(
      "legacy root-scoped transcripts remain reopenable without ownership metadata",
      async () => {
        next = answer("legacy continued");
        const legacyDir = path.join(directory, "subagents", root.getSessionId());
        const legacy = SessionManager.create(cwd, legacyDir);
        legacy.appendMessage(answer("old child answer"));
        const driver = await create(options({ sessionFile: legacy.getSessionFile()! }));
        assert.equal(driver.sessionFile, legacy.getSessionFile());
        assert.equal(
          driver.snapshot().some((message) => messageText(message) === "old child answer"),
          true,
        );
        await driver.prompt("continue legacy child");
        assert.equal(driver.sessionFile, legacy.getSessionFile());
      },
    );

    await t.test("usage counts only this agent's assistant messages", async () => {
      const usage = (
        input: number,
        output: number,
        cacheRead = 0,
        cacheWrite = 0,
      ): AssistantMessage["usage"] => ({
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens: input + output + cacheRead + cacheWrite,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      });
      const assistant = (
        text: string,
        tokens: AssistantMessage["usage"],
        stopReason: AssistantMessage["stopReason"] = "stop",
      ): AssistantMessage => ({
        ...answer(text),
        stopReason,
        usage: tokens,
        errorMessage: stopReason === "error" ? "model failed" : undefined,
      });
      const usageEvents: Extract<DriverEvent, { kind: "usage" }>[] = [];
      const driver = await create(
        options({
          path: "/root/metrics",
          inherited: [assistant("inherited answer", usage(500, 500, 20, 20))],
          onEvent: (event) => {
            events.push(event);
            if (event.kind === "usage") usageEvents.push(event);
          },
        }),
      );
      const partial = assistant("partial", usage(4, 1, 1, 0), "pending");
      const grown = assistant("partial grown", usage(4, 2, 1, 2), "pending");
      const finalMessage = assistant("final", usage(6, 4, 2, 3));
      scripted = (stream) => {
        void (async () => {
          await Promise.resolve();
          stream.push({ type: "start", partial });
          stream.push({ type: "text_delta", contentIndex: 0, delta: "x", partial });
          stream.push({ type: "text_delta", contentIndex: 0, delta: "y", partial: grown });
          stream.push({ type: "done", reason: "stop", message: finalMessage });
          stream.end(finalMessage);
        })();
      };
      await driver.prompt("count me");
      assert.deepEqual(
        usageEvents.map((event) => [event.inputTokens, event.outputTokens, event.partial ?? false]),
        [
          [5, 1, true],
          [7, 2, true],
          [11, 4, false],
        ],
      );

      usageEvents.length = 0;
      const second = assistant("second", usage(1, 1));
      scripted = (stream) => {
        void (async () => {
          await Promise.resolve();
          stream.push({ type: "start", partial: { ...second, usage: usage(0, 0) } });
          stream.push({ type: "done", reason: "stop", message: second });
          stream.end(second);
        })();
      };
      await driver.prompt("again");
      assert.deepEqual(
        usageEvents.map((event) => [event.inputTokens, event.outputTokens, event.partial ?? false]),
        [[12, 5, false]],
      );

      usageEvents.length = 0;
      const failed = assistant("failed", usage(2, 1, 1, 0), "error");
      scripted = (stream) => {
        void (async () => {
          await Promise.resolve();
          stream.push({ type: "error", reason: "error", error: failed });
          stream.end(failed);
        })();
      };
      await assert.rejects(driver.prompt("fail"), /model failed/);
      assert.deepEqual(
        usageEvents.map((event) => [event.inputTokens, event.outputTokens, event.partial ?? false]),
        [[15, 6, false]],
      );

      const file = driver.sessionFile!;
      driver.dispose();
      usageEvents.length = 0;
      const reopened = await create(
        options({
          path: "/root/metrics",
          sessionFile: file,
          inherited: [],
          onEvent: (event) => {
            events.push(event);
            if (event.kind === "usage") usageEvents.push(event);
          },
        }),
      );
      const resumed = assistant("resumed", usage(3, 2));
      scripted = (stream) => {
        void (async () => {
          await Promise.resolve();
          stream.push({ type: "done", reason: "stop", message: resumed });
          stream.end(resumed);
        })();
      };
      await reopened.prompt("resume");
      assert.deepEqual(
        usageEvents.map((event) => [event.inputTokens, event.outputTokens, event.partial ?? false]),
        [[3, 2, false]],
      );
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
