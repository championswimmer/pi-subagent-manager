import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { type AssistantMessage, type JsonObject } from "@earendil-works/pi-ai";
import { buildSessionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentType, SavedThread, ThreadView } from "../src/types.ts";
import { REGISTRY_ENTRY, registry, withOfflineHarness } from "./helpers/integrationHarness.ts";

const ROOT_MAILBOX_ENTRY = "pi-subagent:root-mailbox:v1";
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
const toolUse = (id: string, name: string, args: JsonObject): AssistantMessage => ({
  ...answer(""),
  content: [{ type: "toolCall", id, name, arguments: args }],
  stopReason: "toolUse",
});
const offlineAgent = (body = "ONLY OFFLINE CHILD") =>
  `---\nname: offline\ndescription: Offline lifecycle worker\ntools:\n  allow: [agent_pause]\n---\n${body}\n`;
const nestedAgent = (body = "ONLY OFFLINE CHILD") =>
  `---\nname: nested\ndescription: Nested offline lifecycle worker\nmodel: integration-test/offline-alt\nthinkingLevel: high\ntools:\n  allow: [agent_pause]\n---\n${body}\n`;
const orderedAgent = (models: string[], body = "ONLY OFFLINE CHILD") =>
  `---\nname: ordered\ndescription: Ordered offline lifecycle worker\nmodels:\n${models
    .map((model) => `  - ${model}`)
    .join("\n")}\ntools:\n  allow: [agent_pause]\n---\n${body}\n`;
const contextText = (manager: SessionManager, leafId?: string) =>
  JSON.stringify(buildSessionContext(manager.getEntries(), leafId).messages);
const rootNotifications = (manager: SessionManager) =>
  manager
    .buildSessionContext()
    .messages.filter(
      (message) => message.role === "custom" && message.customType === "pi-subagent:update",
    );
const notificationCount = (manager: SessionManager, mailboxId: string) =>
  rootNotifications(manager).filter(
    (message) =>
      (((message as { details?: { mailboxId?: unknown } }).details ?? {}).mailboxId ?? null) ===
      mailboxId,
  ).length;
const assertMarkers = (text: string, present: string[], absent: string[] = []) => {
  for (const marker of present) assert.ok(text.includes(marker), `expected marker ${marker}`);
  for (const marker of absent) assert.ok(!text.includes(marker), `unexpected marker ${marker}`);
};
const createTranscript = (options: {
  cwd: string;
  sessionDir: string;
  markers: string[];
  modelId?: string;
  thinkingLevel?: string;
}) => {
  const [firstMarker, ...restMarkers] = options.markers;
  assert.ok(firstMarker, "seed transcripts require at least one marker");
  const manager = SessionManager.create(options.cwd, options.sessionDir);
  manager.appendMessage({ role: "user", content: firstMarker, timestamp: Date.now() });
  if (options.modelId) manager.appendModelChange("integration-test", options.modelId);
  if (options.thinkingLevel) manager.appendThinkingLevelChange(options.thinkingLevel);
  for (const marker of restMarkers) {
    manager.appendMessage({ role: "user", content: marker, timestamp: Date.now() });
  }
  assert.ok(manager.getSessionFile(), "seed transcript is persisted");
  return manager;
};
const sessionLeafId = (thread: SavedThread) => {
  assert.ok(typeof thread.view.sessionLeafId === "string");
  return thread.view.sessionLeafId;
};

// One lifecycle scenario using real SDK sessions, JSONL storage, and extension binding; no driver mocks.
test(
  "offline extension retains paused/completed child across parent reopen and isolates a fork",
  { timeout: 30000 },
  async () => {
    let unexpectedCalls = 0;
    await withOfflineHarness(
      {
        agentFiles: { offline: offlineAgent() },
        onRequest(request) {
          const isChild =
            request.path === "/root/worker" && request.system.includes("ONLY OFFLINE CHILD");
          if (!isChild) unexpectedCalls++;
          return isChild && request.pathCall === 1
            ? toolUse("pause-1", "agent_pause", { reason: "Need parent input" })
            : answer(`child answer ${request.pathCall}`);
        },
      },
      async ({ directory, cwd, errors, requests, open, close, tool }) => {
        const root = SessionManager.create(cwd, path.join(directory, "parents"));
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
          requests[1].messagesText.includes("pause-1"),
          "resume retains the previous tool result",
        );
        assert.ok(requests[1].messagesText.includes("Resume paused child"));
        await close(session);

        const again = SessionManager.open(parentFile);
        session = await open(again);
        assert.equal(
          (await tool<ThreadView>(session, "agent_status", { path: "worker" })).state,
          "completed",
        );
        await tool(session, "agent_steer", {
          path: "worker",
          message: "More work after completion",
        });
        const continued = await tool<ThreadView>(session, "agent_wait", { path: "worker" });
        assert.equal(continued.state, "completed");
        assert.equal(continued.output, "child answer 3");
        assert.equal(continued.sessionFile, childFile);
        assert.ok(requests[2].messagesText.includes("child answer 2"));
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(requests.length, 3, "notifications never auto-trigger the parent model");
        assert.equal(unexpectedCalls, 0);
        assert.equal(registry(again).threads[0].view.sessionFile, childFile);
        await close(session);
        const durable = SessionManager.open(parentFile);
        const notifications = rootNotifications(durable);
        assert.equal(
          notifications.length,
          3,
          "pause and both completions are durable parent messages",
        );
        assert.ok(JSON.stringify(notifications).includes("Need parent input"));
        assert.ok(JSON.stringify(notifications).includes("child answer 3"));

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
      },
    );
  },
);

test(
  "offline extension restores nested root-scoped transcripts and spawns under an unopened lexical parent",
  { timeout: 30000 },
  async () => {
    const ROOT_MARKER = "marker:root:ancestor";
    const ROOT_LATER_MARKER = "marker:root:later-only";
    const TEAM_MARKER = "marker:team";
    const REVIEWER_MARKER = "marker:reviewer";
    const CHECKER_MARKER = "marker:checker";
    const SIBLING_MARKER = "marker:sibling";
    const CHILD_PATH = "/root/team/reviewer/drafter";
    const CHILD_OUTPUT = "nested child answer";
    const offline: AgentType = {
      name: "offline",
      description: "Offline lifecycle worker",
      tools: { allow: ["agent_pause"] },
      systemPrompt: "ONLY OFFLINE CHILD",
    };
    const nestedOffline: AgentType = {
      ...offline,
      name: "nested",
      description: "Nested offline lifecycle worker",
      model: "integration-test/offline-alt",
      thinkingLevel: "high",
    };

    await withOfflineHarness(
      {
        agentFiles: { offline: offlineAgent(), nested: nestedAgent() },
        onRequest(request) {
          assert.equal(request.path, CHILD_PATH);
          return { ...answer(CHILD_OUTPUT), model: request.modelId };
        },
      },
      async ({ directory, cwd, errors, requests, open, close, tool }) => {
        let createdAt = Date.now();
        const nextCreatedAt = () => ++createdAt;
        const root = SessionManager.create(cwd, path.join(directory, "parents"));
        root.appendMessage({ role: "user", content: ROOT_MARKER, timestamp: nextCreatedAt() });
        const rootId = root.getSessionId();
        const rootScopedDir = path.join(directory, "subagents", rootId);
        await mkdir(rootScopedDir, { recursive: true });

        const teamSession = createTranscript({
          cwd,
          sessionDir: rootScopedDir,
          markers: [ROOT_MARKER, TEAM_MARKER],
          modelId: "offline-alt",
          thinkingLevel: "high",
        });
        const reviewerSession = createTranscript({
          cwd,
          sessionDir: rootScopedDir,
          markers: [ROOT_MARKER, TEAM_MARKER, REVIEWER_MARKER],
          modelId: "offline-alt",
          thinkingLevel: "high",
        });
        const checkerSession = createTranscript({
          cwd,
          sessionDir: rootScopedDir,
          markers: [ROOT_MARKER, TEAM_MARKER, REVIEWER_MARKER, CHECKER_MARKER],
          modelId: "offline-alt",
          thinkingLevel: "high",
        });
        const siblingSession = createTranscript({
          cwd,
          sessionDir: rootScopedDir,
          markers: [ROOT_MARKER, SIBLING_MARKER],
        });
        const teamFile = teamSession.getSessionFile()!;
        const reviewerFile = reviewerSession.getSessionFile()!;
        const checkerFile = checkerSession.getSessionFile()!;
        const siblingFile = siblingSession.getSessionFile()!;
        for (const file of [teamFile, reviewerFile, checkerFile, siblingFile]) {
          assert.ok(file.startsWith(rootScopedDir), `root-scoped transcript ${file}`);
        }
        assert.equal(teamSession.buildSessionContext().model?.modelId, "offline-alt");
        assert.equal(teamSession.buildSessionContext().thinkingLevel, "high");
        assert.equal(reviewerSession.buildSessionContext().model?.modelId, "offline-alt");
        assert.equal(reviewerSession.buildSessionContext().thinkingLevel, "high");
        assertMarkers(
          contextText(teamSession),
          [ROOT_MARKER, TEAM_MARKER],
          [REVIEWER_MARKER, CHECKER_MARKER, SIBLING_MARKER, ROOT_LATER_MARKER],
        );
        assertMarkers(
          contextText(reviewerSession),
          [ROOT_MARKER, TEAM_MARKER, REVIEWER_MARKER],
          [CHECKER_MARKER, SIBLING_MARKER, ROOT_LATER_MARKER],
        );
        assertMarkers(
          contextText(checkerSession),
          [ROOT_MARKER, TEAM_MARKER, REVIEWER_MARKER, CHECKER_MARKER],
          [SIBLING_MARKER, ROOT_LATER_MARKER],
        );
        assertMarkers(
          contextText(siblingSession),
          [ROOT_MARKER, SIBLING_MARKER],
          [TEAM_MARKER, REVIEWER_MARKER, CHECKER_MARKER, ROOT_LATER_MARKER],
        );

        root.appendMessage({
          role: "user",
          content: ROOT_LATER_MARKER,
          timestamp: nextCreatedAt(),
        });
        const saved: SavedThread[] = [
          {
            view: {
              path: "/root/team",
              parent: "/root",
              owner: "/root",
              type: "nested",
              state: "running",
              task: "Coordinate the team",
              status: "Working before reload",
              createdAt: nextCreatedAt(),
              sessionFile: teamFile,
            },
            definition: nestedOffline,
          },
          {
            view: {
              path: "/root/team/reviewer",
              parent: "/root/team",
              owner: "/root/team",
              type: "nested",
              state: "starting",
              task: "Review incoming work",
              status: "Starting before reload",
              createdAt: nextCreatedAt(),
              sessionFile: reviewerFile,
            },
            definition: nestedOffline,
          },
          {
            view: {
              path: "/root/team/reviewer/checker",
              parent: "/root/team/reviewer",
              owner: "/root/team/reviewer",
              type: "nested",
              state: "completed",
              task: "Checked the previous draft",
              status: "Completed; session retained",
              output: "checked",
              createdAt: nextCreatedAt(),
              sessionFile: checkerFile,
            },
            definition: nestedOffline,
          },
          {
            view: {
              path: "/root/sibling",
              parent: "/root",
              owner: "/root",
              type: "offline",
              state: "paused",
              task: "Wait for separate work",
              status: "Need sibling input",
              createdAt: nextCreatedAt(),
              sessionFile: siblingFile,
            },
            definition: offline,
          },
        ];
        root.appendCustomEntry(REGISTRY_ENTRY, {
          version: 1,
          rootSessionId: rootId,
          threads: saved,
        });
        const parentFile = root.getSessionFile()!;

        let session = await open(root);
        assert.equal(requests.length, 0, "restore must not call the provider");
        const restored = await tool<ThreadView[]>(session, "agent_status", {});
        const restoredByPath = new Map(restored.map((thread) => [thread.path, thread]));
        assert.deepEqual(
          restored.map((thread) => thread.path).sort(),
          [
            "/root/sibling",
            "/root/team",
            "/root/team/reviewer",
            "/root/team/reviewer/checker",
          ].sort(),
        );
        assert.equal(restoredByPath.get("/root/team")?.state, "paused");
        assert.equal(
          restoredByPath.get("/root/team")?.status,
          "Interrupted by reload; send input to resume",
        );
        assert.equal(restoredByPath.get("/root/team/reviewer")?.state, "paused");
        assert.equal(
          restoredByPath.get("/root/team/reviewer")?.status,
          "Interrupted by reload; send input to resume",
        );
        assert.equal(restoredByPath.get("/root/team/reviewer/checker")?.state, "completed");
        assert.equal(restoredByPath.get("/root/team/reviewer/checker")?.output, "checked");
        assert.equal(restoredByPath.get("/root/sibling")?.state, "paused");
        assert.equal(restoredByPath.get("/root/sibling")?.status, "Need sibling input");
        assert.equal(requests.length, 0, "status reads do not restore through the model");

        const spawned = await tool<ThreadView>(session, "agent_spawn", {
          path: CHILD_PATH,
          type: "offline",
          task: "Draft a nested follow-up",
        });
        assert.equal(spawned.state, "completed");
        assert.equal(spawned.output, CHILD_OUTPUT);
        assert.ok(spawned.sessionFile?.startsWith(rootScopedDir));
        assert.equal(requests.length, 1, "only the new child prompt uses the provider");
        assert.equal(requests[0].path, CHILD_PATH);
        assert.equal(requests[0].lexicalParent, "/root/team/reviewer");
        assert.equal(requests[0].modelId, "offline-alt");
        assert.ok(
          requests[0].system.includes("Your lexical parent is /root/team/reviewer"),
          "child request names the lexical parent",
        );
        assertMarkers(
          requests[0].messagesText,
          [ROOT_MARKER, TEAM_MARKER, REVIEWER_MARKER],
          [ROOT_LATER_MARKER, SIBLING_MARKER, CHECKER_MARKER],
        );
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(requests.length, 1, "delivery into the parent transcript stays offline");
        await close(session);

        const reopened = SessionManager.open(parentFile);
        session = await open(reopened);
        assert.equal(requests.length, 1, "reopening the root remains offline");
        const visibleAgain = await tool<ThreadView[]>(session, "agent_status", {});
        assert.deepEqual(
          visibleAgain.map((thread) => thread.path).sort(),
          [
            "/root/sibling",
            "/root/team",
            "/root/team/reviewer",
            "/root/team/reviewer/checker",
            CHILD_PATH,
          ].sort(),
        );
        const restoredChild = await tool<ThreadView>(session, "agent_status", { path: CHILD_PATH });
        assert.equal(restoredChild.state, "completed");
        assert.equal(restoredChild.output, CHILD_OUTPUT);
        assert.equal(requests.length, 1, "restoring the new child stays offline");
        await close(session);

        const durableRoot = SessionManager.open(parentFile);
        const durableRegistry = registry(durableRoot);
        const durableByPath = new Map(
          durableRegistry.threads.map((thread) => [thread.view.path, thread.view]),
        );
        assert.equal(durableRegistry.rootSessionId, rootId);
        assert.deepEqual(
          durableRegistry.threads.map((thread) => thread.view.path).sort(),
          [
            "/root/sibling",
            "/root/team",
            "/root/team/reviewer",
            "/root/team/reviewer/checker",
            CHILD_PATH,
          ].sort(),
        );
        assert.equal(durableByPath.get("/root/team")?.state, "paused");
        assert.equal(durableByPath.get("/root/team/reviewer")?.state, "paused");
        assert.equal(durableByPath.get(CHILD_PATH)?.state, "completed");
        assert.equal(durableByPath.get(CHILD_PATH)?.output, CHILD_OUTPUT);
        assert.ok(durableByPath.get(CHILD_PATH)?.sessionFile?.startsWith(rootScopedDir));

        const durableParent = SessionManager.open(reviewerFile);
        const mailboxEntries = durableParent
          .getBranch()
          .filter(
            (entry) => entry.type === "custom_message" && entry.customType === "subagent-update",
          );
        assert.equal(
          mailboxEntries.length,
          1,
          "actual parent transcript receives one mailbox update",
        );
        assert.ok(
          JSON.stringify(mailboxEntries).includes(`Agent ${CHILD_PATH} completed. Final answer:`),
        );
        assert.ok(JSON.stringify(mailboxEntries).includes(CHILD_OUTPUT));

        const durableChild = SessionManager.open(spawned.sessionFile!);
        const childContext = durableChild.buildSessionContext();
        assert.equal(childContext.model?.provider, "integration-test");
        assert.equal(childContext.model?.modelId, "offline-alt");
        assert.equal(childContext.thinkingLevel, "high");
        assert.ok(JSON.stringify(childContext.messages).includes(CHILD_OUTPUT));
        assert.deepEqual(errors, []);
      },
    );
  },
);

test(
  "offline extension replays root mailbox once and restores per-branch child leaves when navigating",
  { timeout: 30000 },
  async () => {
    const ROOT_SEED = "root navigation seed";
    const SEEDED_MAILBOX_ID = "seeded-root-mailbox";
    const CHILD_PATH = "/root/worker";
    const replies = new Map([
      [1, "answer A"],
      [2, "answer B"],
      [3, "answer C"],
    ]);

    await withOfflineHarness(
      {
        agentFiles: { offline: offlineAgent() },
        onRequest(request) {
          assert.equal(request.path, CHILD_PATH);
          const text = replies.get(request.pathCall);
          assert.ok(text, `unexpected request call ${request.pathCall}`);
          return answer(text);
        },
      },
      async ({ directory, cwd, errors, requests, open, close, tool }) => {
        const root = SessionManager.create(cwd, path.join(directory, "parents"));
        root.appendMessage({ role: "user", content: ROOT_SEED, timestamp: Date.now() });
        root.appendCustomEntry(ROOT_MAILBOX_ENTRY, {
          rootSessionId: root.getSessionId(),
          content: "Seeded root mailbox replay",
          details: {
            mailboxId: SEEDED_MAILBOX_ID,
            path: "/root/seeded",
            state: "completed",
          },
        });
        const parentFile = root.getSessionFile()!;

        const fork = SessionManager.forkFrom(parentFile, cwd, path.join(directory, "forks"));
        assert.equal(notificationCount(fork, SEEDED_MAILBOX_ID), 0);
        let forkSession = await open(fork);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(notificationCount(fork, SEEDED_MAILBOX_ID), 0);
        assert.equal(requests.length, 0, "forked mailbox restore stays offline");
        await close(forkSession);

        let session = await open(root);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(notificationCount(root, SEEDED_MAILBOX_ID), 1);
        assert.equal(requests.length, 0, "mailbox replay does not invoke the provider");
        await close(session);

        const reopened = SessionManager.open(parentFile);
        session = await open(reopened);
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(notificationCount(reopened, SEEDED_MAILBOX_ID), 1);
        assert.equal(requests.length, 0, "reopening does not duplicate seeded mailbox delivery");

        const first = await tool<ThreadView>(session, "agent_spawn", {
          path: "worker",
          type: "offline",
          task: "Produce the first answer",
        });
        assert.equal(first.state, "completed");
        assert.equal(first.output, "answer A");
        const childFile = first.sessionFile!;
        const checkpointA = reopened.getLeafId()!;
        const savedA = registry(reopened, checkpointA).threads[0]!;
        const leafA = sessionLeafId(savedA);
        assertMarkers(
          contextText(SessionManager.open(childFile), leafA),
          [ROOT_SEED, "answer A"],
          ["answer B", "answer C"],
        );

        await tool(session, "agent_steer", { path: CHILD_PATH, message: "Continue to answer B" });
        const second = await tool<ThreadView>(session, "agent_wait", { path: CHILD_PATH });
        assert.equal(second.state, "completed");
        assert.equal(second.output, "answer B");
        const checkpointB = reopened.getLeafId()!;
        const savedB = registry(reopened, checkpointB).threads[0]!;
        const leafB = sessionLeafId(savedB);
        assert.notEqual(leafA, leafB);
        assertMarkers(
          contextText(SessionManager.open(childFile), leafB),
          [ROOT_SEED, "answer A", "answer B"],
          ["answer C"],
        );

        const navigatedA = await session.navigateTree(checkpointA, { summarize: false });
        assert.equal(navigatedA.cancelled, false);
        assert.equal(requests.length, 2, "restoring an older checkpoint stays offline");
        const restoredA = await tool<ThreadView>(session, "agent_status", { path: CHILD_PATH });
        assert.equal(restoredA.state, "completed");
        assert.equal(restoredA.output, "answer A");
        const restoredLeafA = sessionLeafId(registry(reopened).threads[0]!);
        assert.equal(restoredLeafA, leafA);
        assertMarkers(
          contextText(SessionManager.open(childFile), restoredLeafA),
          [ROOT_SEED, "answer A"],
          ["answer B", "answer C"],
        );

        await tool(session, "agent_steer", {
          path: CHILD_PATH,
          message: "Resume from checkpoint A with answer C",
        });
        const third = await tool<ThreadView>(session, "agent_wait", { path: CHILD_PATH });
        assert.equal(third.state, "completed");
        assert.equal(third.output, "answer C");
        assert.equal(requests.length, 3);
        assertMarkers(requests[2].messagesText, [ROOT_SEED, "answer A", "answer C"], ["answer B"]);

        const navigatedB = await session.navigateTree(checkpointB, { summarize: false });
        assert.equal(navigatedB.cancelled, false);
        assert.equal(requests.length, 3, "restoring the newer checkpoint also stays offline");
        const restoredB = await tool<ThreadView>(session, "agent_status", { path: CHILD_PATH });
        assert.equal(restoredB.state, "completed");
        assert.equal(restoredB.output, "answer B");
        const restoredLeafB = sessionLeafId(registry(reopened).threads[0]!);
        assert.equal(restoredLeafB, leafB);
        assertMarkers(
          contextText(SessionManager.open(childFile), restoredLeafB),
          [ROOT_SEED, "answer A", "answer B"],
          ["answer C"],
        );

        await close(session);
        assert.deepEqual(errors, []);
      },
    );
  },
);

test(
  "offline extension surfaces scoped model policy failures as failed thread status",
  { timeout: 30000 },
  async () => {
    await withOfflineHarness(
      {
        agentFiles: {
          ordered: orderedAgent(["integration-test/offline-alt"]),
        },
        scopedModels: ["integration-test/offline"],
        onRequest() {
          throw new Error("provider must not be called when scope rejects the agent model");
        },
      },
      async ({ directory, cwd, errors, requests, open, close, tool }) => {
        const root = SessionManager.create(cwd, path.join(directory, "parents"));
        const session = await open(root);
        const failed = await tool<ThreadView>(session, "agent_spawn", {
          path: "worker",
          type: "ordered",
          task: "Attempt disallowed scoped model",
        });
        assert.equal(failed.state, "failed");
        assert.match(failed.error ?? "", /integration-test\/offline-alt/);
        assert.match(failed.error ?? "", /\/scoped-models/);
        assert.match(failed.status, /\/scoped-models/);
        assert.equal(requests.length, 0);

        const visible = await tool<ThreadView>(session, "agent_status", { path: "worker" });
        assert.equal(visible.state, "failed");
        assert.equal(visible.error, failed.error);
        assert.equal(registry(root).threads[0]?.view.state, "failed");
        assert.equal(registry(root).threads[0]?.view.error, failed.error);
        await close(session);
        assert.deepEqual(errors, []);
      },
    );
  },
);
