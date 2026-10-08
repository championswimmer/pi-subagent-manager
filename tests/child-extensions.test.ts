import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AssistantMessage, JsonObject } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ThreadView } from "../src/types.ts";
import {
  withOfflineHarness,
  type LoggedRequest,
  type OfflineHarness,
} from "./helpers/integrationHarness.ts";

// A real extension file loaded by each child: blocks bash commands containing MARKER and
// records every tool call it sees, so tests can prove which children ran it.
const MARKER = "GUARD-MARKER";
const BLOCK_REASON = "example guard refused GUARD-MARKER";

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
const agent = (name: string, allow: string[]) =>
  `---\nname: ${name}\ndescription: ${name} worker\ntools:\n  allow: [${allow.join(", ")}]\n---\nONLY ${name.toUpperCase()} CHILD\n`;
const AGENTS = {
  guarded: agent("guarded", ["bash", "agent_pause"]),
  lead: agent("lead", ["agent_spawn", "agent_wait"]),
};
const threadPath = (request: LoggedRequest) =>
  request.system.match(/Your thread path is (\/[A-Za-z0-9_/-]+)\./)?.[1];
/** Command whose only effect is creating `<cwd>/<name>.txt`; MARKER rides in a comment. */
const markedCommand = (cwd: string, name: string) =>
  `touch ${JSON.stringify(path.join(cwd, `${name}.txt`))} # ${MARKER}`;

async function writeGuard(directory: string, name = "guard") {
  const extensionPath = path.join(directory, "extensions", `${name}.ts`);
  const logPath = path.join(directory, `${name}.log`);
  await mkdir(path.dirname(extensionPath), { recursive: true });
  await writeFile(
    extensionPath,
    `import { appendFileSync } from "node:fs";
export default function (pi: any) {
  pi.registerTool({
    name: "${name}_probe",
    label: "${name}_probe",
    description: "Probe registered by the example guard",
    parameters: { type: "object", properties: {} },
    async execute() {
      appendFileSync(${JSON.stringify(logPath)}, "probe executed\\n");
      return { content: [{ type: "text", text: "probe ran" }], details: {} };
    },
  });
  pi.on("session_start", () => {
    appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ event: "session_start" }) + "\\n");
  });
  pi.on("tool_call", (event: any) => {
    appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ event: "tool_call", tool: event.toolName, input: event.input }) + "\\n");
    if (event.toolName === "bash" && String(event.input.command).includes(${JSON.stringify(MARKER)}))
      return { block: true, reason: ${JSON.stringify(BLOCK_REASON)} };
  });
}
`,
  );
  return { extensionPath, logPath };
}

async function writeSettings(file: string, settings: Record<string, unknown>) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(settings));
}
const globalSettings = (harness: Pick<OfflineHarness, "directory">) =>
  path.join(harness.directory, "subagent-manager", "settings.json");
const projectSettings = (harness: Pick<OfflineHarness, "cwd">) =>
  path.join(harness.cwd, ".pi", "agent", "subagent-manager", "settings.json");
type GuardEvent = { event: string; tool?: string; input?: { command?: string } };
const guardEvents = async (logPath: string): Promise<GuardEvent[]> =>
  existsSync(logPath)
    ? (await readFile(logPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as GuardEvent)
    : [];
const loggedCommands = async (logPath: string) =>
  (await guardEvents(logPath))
    .filter((entry) => entry.tool === "bash")
    .map((entry) => entry.input?.command);
const sessionStarts = async (logPath: string) =>
  (await guardEvents(logPath)).filter((entry) => entry.event === "session_start").length;

/** Each guarded child runs MARKER bash once, then answers with the tool result it received. */
function guardedScript(cwd: string) {
  return (request: LoggedRequest): AssistantMessage => {
    const name = threadPath(request)!.split("/").at(-1)!;
    if (request.pathCall === 1)
      return toolUse(`bash-${name}`, "bash", { command: markedCommand(cwd, name) });
    return answer(`${name} finished`);
  };
}
/** The tool result text the child's model received for its bash call. */
const bashResult = (requests: LoggedRequest[], thread: string) => {
  const request = requests.find((entry) => threadPath(entry) === thread && entry.pathCall === 2);
  assert.ok(request, `${thread} made a second model request`);
  const messages = JSON.parse(request.messagesText) as {
    role: string;
    toolCallId?: string;
    content?: { type: string; text?: string }[];
  }[];
  const result = messages.find((message) => message.role === "toolResult");
  assert.ok(result, `${thread} received a tool result`);
  return (result.content ?? []).map((block) => block.text ?? "").join("");
};

test(
  "required child extension blocks a child's bash and the model receives the block reason",
  { timeout: 30000 },
  async () => {
    let script: ((request: LoggedRequest) => AssistantMessage) | undefined;
    await withOfflineHarness(
      { agentFiles: AGENTS, builtinTools: true, onRequest: (request) => script!(request) },
      async (harness) => {
        const { directory, cwd, requests, open, tool } = harness;
        script = guardedScript(cwd);
        const guard = await writeGuard(directory);
        await writeSettings(globalSettings(harness), {
          requiredChildExtensions: [guard.extensionPath],
        });
        const session = await open(SessionManager.create(cwd, path.join(directory, "parents")));
        const done = await tool<ThreadView>(session, "agent_spawn", {
          path: "worker",
          type: "guarded",
          task: "Run the command",
        });
        assert.equal(done.state, "completed");
        assert.equal(bashResult(requests, "/root/worker"), BLOCK_REASON);
        assert.equal(existsSync(path.join(cwd, "worker.txt")), false);
        assert.deepEqual(await loggedCommands(guard.logPath), [markedCommand(cwd, "worker")]);
      },
    );
  },
);

test(
  "without requiredChildExtensions a child's bash runs unguarded",
  { timeout: 30000 },
  async () => {
    let script: ((request: LoggedRequest) => AssistantMessage) | undefined;
    await withOfflineHarness(
      { agentFiles: AGENTS, builtinTools: true, onRequest: (request) => script!(request) },
      async ({ directory, cwd, requests, open, tool }) => {
        script = guardedScript(cwd);
        const guard = await writeGuard(directory);
        const session = await open(SessionManager.create(cwd, path.join(directory, "parents")));
        const done = await tool<ThreadView>(session, "agent_spawn", {
          path: "worker",
          type: "guarded",
          task: "Run the command",
        });
        assert.equal(done.state, "completed");
        assert.equal(bashResult(requests, "/root/worker"), "(no output)");
        assert.equal(existsSync(path.join(cwd, "worker.txt")), true);
        assert.equal(existsSync(guard.logPath), false);
      },
    );
  },
);

test("a nested (depth 2) child loads the required extension", { timeout: 30000 }, async () => {
  let cwdPath = "";
  await withOfflineHarness(
    {
      agentFiles: AGENTS,
      builtinTools: true,
      onRequest(request) {
        const thread = threadPath(request);
        if (thread === "/root/lead")
          return request.pathCall === 1
            ? toolUse("spawn-inner", "agent_spawn", {
                path: "inner",
                type: "guarded",
                task: "Run the command",
              })
            : answer("lead finished");
        return guardedScript(cwdPath)(request);
      },
    },
    async (harness) => {
      const { directory, cwd, requests, open, tool } = harness;
      cwdPath = cwd;
      const guard = await writeGuard(directory);
      await writeSettings(globalSettings(harness), {
        requiredChildExtensions: [guard.extensionPath],
      });
      const session = await open(SessionManager.create(cwd, path.join(directory, "parents")));
      const done = await tool<ThreadView>(session, "agent_spawn", {
        path: "lead",
        type: "lead",
        task: "Delegate the command",
      });
      assert.equal(done.state, "completed");
      assert.equal(bashResult(requests, "/root/lead/inner"), BLOCK_REASON);
      assert.equal(existsSync(path.join(cwd, "inner.txt")), false);
      assert.deepEqual(await loggedCommands(guard.logPath), [markedCommand(cwd, "inner")]);
    },
  );
});

test(
  "a child resumed after the parent session is reopened loads the required extension",
  { timeout: 30000 },
  async () => {
    let cwdPath = "";
    await withOfflineHarness(
      {
        agentFiles: AGENTS,
        builtinTools: true,
        onRequest(request) {
          if (request.pathCall === 1)
            return toolUse("pause-1", "agent_pause", { reason: "Wait for the parent" });
          if (request.pathCall === 2)
            return toolUse("bash-worker", "bash", { command: markedCommand(cwdPath, "worker") });
          return answer("worker finished");
        },
      },
      async (harness) => {
        const { directory, cwd, requests, open, close, tool } = harness;
        cwdPath = cwd;
        const guard = await writeGuard(directory);
        await writeSettings(globalSettings(harness), {
          requiredChildExtensions: [guard.extensionPath],
        });
        const root = SessionManager.create(cwd, path.join(directory, "parents"));
        // A parent session file is written once it holds an assistant message.
        root.appendMessage({ role: "user", content: "Parent context", timestamp: Date.now() });
        root.appendMessage(answer("Parent answer"));
        let session = await open(root);
        const paused = await tool<ThreadView>(session, "agent_spawn", {
          path: "worker",
          type: "guarded",
          task: "Pause first",
        });
        assert.equal(paused.state, "paused");
        await close(session);

        session = await open(SessionManager.open(root.getSessionFile()!));
        await tool(session, "agent_steer", { path: "worker", message: "Now run the command" });
        const done = await tool<ThreadView>(session, "agent_wait", { path: "worker" });
        assert.equal(done.state, "completed");
        const third = requests.find((entry) => entry.pathCall === 3);
        assert.ok(third, "resumed child made a third model request");
        const messages = JSON.parse(third.messagesText) as {
          role: string;
          toolCallId?: string;
          content?: { text?: string }[];
        }[];
        const result = messages.find(
          (message) => message.role === "toolResult" && message.toolCallId === "bash-worker",
        );
        assert.equal(result?.content?.map((block) => block.text).join(""), BLOCK_REASON);
        assert.equal(existsSync(path.join(cwd, "worker.txt")), false);
        assert.deepEqual(await loggedCommands(guard.logPath), [markedCommand(cwd, "worker")]);
        // One session_start for the first driver, one for the driver rebuilt on resume.
        assert.equal(await sessionStarts(guard.logPath), 2);
      },
    );
  },
);

test(
  "forked and independent children both load the required extension",
  { timeout: 30000 },
  async () => {
    let script: ((request: LoggedRequest) => AssistantMessage) | undefined;
    await withOfflineHarness(
      { agentFiles: AGENTS, builtinTools: true, onRequest: (request) => script!(request) },
      async (harness) => {
        const { directory, cwd, requests, open, tool } = harness;
        script = guardedScript(cwd);
        const guard = await writeGuard(directory);
        await writeSettings(globalSettings(harness), {
          requiredChildExtensions: [guard.extensionPath],
        });
        const root = SessionManager.create(cwd, path.join(directory, "parents"));
        root.appendMessage({ role: "user", content: "Parent context", timestamp: Date.now() });
        const session = await open(root);
        for (const target of ["forked", "/independent"]) {
          const done = await tool<ThreadView>(session, "agent_spawn", {
            path: target,
            type: "guarded",
            task: "Run the command",
          });
          assert.equal(done.state, "completed");
        }
        const forkedFirst = requests.find(
          (entry) => threadPath(entry) === "/root/forked" && entry.pathCall === 1,
        );
        const independentFirst = requests.find(
          (entry) => threadPath(entry) === "/independent" && entry.pathCall === 1,
        );
        assert.ok(forkedFirst?.messagesText.includes("Parent context"), "fork inherits history");
        assert.ok(
          !independentFirst?.messagesText.includes("Parent context"),
          "independent is fresh",
        );
        assert.equal(bashResult(requests, "/root/forked"), BLOCK_REASON);
        assert.equal(bashResult(requests, "/independent"), BLOCK_REASON);
        assert.equal(existsSync(path.join(cwd, "forked.txt")), false);
        assert.equal(existsSync(path.join(cwd, "independent.txt")), false);
        assert.deepEqual(await loggedCommands(guard.logPath), [
          markedCommand(cwd, "forked"),
          markedCommand(cwd, "independent"),
        ]);
      },
    );
  },
);

test(
  "a required extension path that does not exist refuses the spawn before any model turn",
  { timeout: 30000 },
  async () => {
    await withOfflineHarness(
      { agentFiles: AGENTS, builtinTools: true, onRequest: () => answer("must not run") },
      async (harness) => {
        const { directory, cwd, requests, open, tool } = harness;
        const missing = path.join(directory, "extensions", "missing-guard.ts");
        await writeSettings(globalSettings(harness), { requiredChildExtensions: [missing] });
        const session = await open(SessionManager.create(cwd, path.join(directory, "parents")));
        const failed = await tool<ThreadView>(session, "agent_spawn", {
          path: "worker",
          type: "guarded",
          task: "Run",
        });
        assert.equal(failed.state, "failed");
        assert.equal(
          failed.error,
          `Required child extension ${missing} failed to load: Extension path does not exist: ${missing}`,
        );
        assert.equal(requests.length, 0);
      },
    );
  },
);

test(
  "a required extension whose session_start throws refuses the spawn before the first request",
  { timeout: 30000 },
  async () => {
    await withOfflineHarness(
      { agentFiles: AGENTS, builtinTools: true, onRequest: () => answer("must not run") },
      async (harness) => {
        const { directory, cwd, requests, open, tool } = harness;
        const failing = path.join(directory, "extensions", "failing-start.ts");
        await mkdir(path.dirname(failing), { recursive: true });
        await writeFile(
          failing,
          `export default function (pi: any) {
  pi.on("session_start", () => {
    throw new Error("guard policy file unreadable");
  });
}
`,
        );
        await writeSettings(globalSettings(harness), { requiredChildExtensions: [failing] });
        const session = await open(SessionManager.create(cwd, path.join(directory, "parents")));
        const failed = await tool<ThreadView>(session, "agent_spawn", {
          path: "worker",
          type: "guarded",
          task: "Run",
        });
        assert.equal(failed.state, "failed");
        assert.equal(
          failed.error,
          `Required child extension ${failing} failed in session_start: guard policy file unreadable`,
        );
        assert.equal(requests.length, 0);
      },
    );
  },
);

test(
  "project requiredChildExtensions adds to the global list and cannot empty it",
  { timeout: 30000 },
  async () => {
    let script: ((request: LoggedRequest) => AssistantMessage) | undefined;
    await withOfflineHarness(
      { agentFiles: AGENTS, builtinTools: true, onRequest: (request) => script!(request) },
      async (harness) => {
        const { directory, cwd, requests, open, tool } = harness;
        script = guardedScript(cwd);
        const guard = await writeGuard(directory);
        const projectGuard = await writeGuard(directory, "project_guard");
        await writeSettings(globalSettings(harness), {
          requiredChildExtensions: [guard.extensionPath],
        });
        await writeSettings(projectSettings(harness), { requiredChildExtensions: [] });
        const session = await open(SessionManager.create(cwd, path.join(directory, "parents")));
        await tool(session, "agent_spawn", { path: "first", type: "guarded", task: "Run" });
        assert.equal(bashResult(requests, "/root/first"), BLOCK_REASON);
        assert.equal(existsSync(path.join(cwd, "first.txt")), false);

        // The project layer is read: its own entry joins the global one.
        await writeSettings(projectSettings(harness), {
          requiredChildExtensions: [projectGuard.extensionPath, guard.extensionPath],
        });
        await tool(session, "agent_spawn", { path: "second", type: "guarded", task: "Run" });
        assert.equal(bashResult(requests, "/root/second"), BLOCK_REASON);
        assert.equal(existsSync(path.join(cwd, "second.txt")), false);
        assert.deepEqual(await loggedCommands(guard.logPath), [
          markedCommand(cwd, "first"),
          markedCommand(cwd, "second"),
        ]);
        // The global guard blocks first, so the project guard proves itself through session_start;
        // the guard listed in both layers starts once per child.
        assert.equal(await sessionStarts(guard.logPath), 2);
        assert.equal(await sessionStarts(projectGuard.logPath), 1);
      },
    );
  },
);

for (const [label, value] of [
  ["a string", "~/guard.ts"],
  ["an empty entry", [""]],
] as const) {
  test(
    `requiredChildExtensions set to ${label} refuses spawns naming the file and key`,
    { timeout: 30000 },
    async () => {
      await withOfflineHarness(
        { agentFiles: AGENTS, builtinTools: true, onRequest: () => answer("must not run") },
        async (harness) => {
          const { directory, cwd, requests, open, tool } = harness;
          const file = projectSettings(harness);
          await writeSettings(file, { requiredChildExtensions: value });
          const session = await open(SessionManager.create(cwd, path.join(directory, "parents")));
          const failed = await tool<ThreadView>(session, "agent_spawn", {
            path: "worker",
            type: "guarded",
            task: "Run",
          });
          assert.equal(failed.state, "failed");
          assert.equal(
            failed.error,
            `Subagent /root/worker not started: ${file}: requiredChildExtensions must be an array of non-empty strings; subagents will not start until it is fixed`,
          );
          assert.equal(requests.length, 0);
        },
      );
    },
  );
}

test(
  "a tool registered by a required extension stays inactive when the child's policy does not allow it",
  { timeout: 30000 },
  async () => {
    await withOfflineHarness(
      {
        agentFiles: AGENTS,
        builtinTools: true,
        onRequest: (request) =>
          request.pathCall === 1 ? toolUse("probe-1", "guard_probe", {}) : answer("done"),
      },
      async (harness) => {
        const { directory, cwd, requests, open, tool } = harness;
        const guard = await writeGuard(directory);
        await writeSettings(globalSettings(harness), {
          requiredChildExtensions: [guard.extensionPath],
        });
        const session = await open(SessionManager.create(cwd, path.join(directory, "parents")));
        const done = await tool<ThreadView>(session, "agent_spawn", {
          path: "worker",
          type: "guarded",
          task: "Call the probe",
        });
        assert.equal(done.state, "completed");
        assert.deepEqual(requests[0].toolNames, ["bash", "agent_pause"]);
        assert.equal(bashResult(requests, "/root/worker"), "Tool guard_probe not found");
        const log = existsSync(guard.logPath) ? await readFile(guard.logPath, "utf8") : "";
        assert.ok(!log.includes("probe executed"), "probe tool never executed");
      },
    );
  },
);

test(
  "an invalid requiredChildExtensions value refuses resuming a child until it is fixed",
  { timeout: 30000 },
  async () => {
    let cwdPath = "";
    await withOfflineHarness(
      {
        agentFiles: AGENTS,
        builtinTools: true,
        onRequest(request) {
          if (request.pathCall === 1)
            return toolUse("pause-1", "agent_pause", { reason: "Wait for the parent" });
          if (request.pathCall === 2)
            return toolUse("bash-worker", "bash", { command: markedCommand(cwdPath, "worker") });
          return answer("worker finished");
        },
      },
      async (harness) => {
        const { directory, cwd, requests, open, close, tool } = harness;
        cwdPath = cwd;
        const guard = await writeGuard(directory);
        const file = globalSettings(harness);
        await writeSettings(file, { requiredChildExtensions: [guard.extensionPath] });
        const root = SessionManager.create(cwd, path.join(directory, "parents"));
        root.appendMessage({ role: "user", content: "Parent context", timestamp: Date.now() });
        root.appendMessage(answer("Parent answer"));
        let session = await open(root);
        const paused = await tool<ThreadView>(session, "agent_spawn", {
          path: "worker",
          type: "guarded",
          task: "Pause first",
        });
        assert.equal(paused.state, "paused");
        await close(session);

        await writeSettings(file, { requiredChildExtensions: [guard.extensionPath, 7] });
        session = await open(SessionManager.open(root.getSessionFile()!));
        await tool(session, "agent_steer", { path: "worker", message: "Now run the command" });
        const refused = await tool<ThreadView>(session, "agent_wait", { path: "worker" });
        assert.equal(refused.state, "failed");
        assert.equal(
          refused.error,
          `Subagent /root/worker not started: ${file}: requiredChildExtensions must be an array of non-empty strings; subagents will not start until it is fixed`,
        );
        assert.equal(requests.length, 1, "the refused resume made no model request");

        await writeSettings(file, { requiredChildExtensions: [guard.extensionPath] });
        await tool(session, "agent_steer", { path: "worker", message: "Now run the command" });
        const done = await tool<ThreadView>(session, "agent_wait", { path: "worker" });
        assert.equal(done.state, "completed");
        assert.equal(existsSync(path.join(cwd, "worker.txt")), false);
        assert.deepEqual(await loggedCommands(guard.logPath), [markedCommand(cwd, "worker")]);
      },
    );
  },
);

test(
  "a required directory fails closed when an entry point symlinked from outside it fails",
  { timeout: 30000 },
  async () => {
    await withOfflineHarness(
      { agentFiles: AGENTS, builtinTools: true, onRequest: () => answer("must not run") },
      async (harness) => {
        const { directory, cwd, requests, open, tool } = harness;
        const outside = path.join(directory, "shared", "failing-start.ts");
        await mkdir(path.dirname(outside), { recursive: true });
        await writeFile(
          outside,
          `export default function (pi: any) {
  pi.on("session_start", () => {
    throw new Error("linked guard failed");
  });
}
`,
        );
        const bundle = path.join(directory, "guard-bundle");
        await mkdir(bundle);
        await writeFile(path.join(bundle, "ok.ts"), "export default function () {}\n");
        await symlink(outside, path.join(bundle, "linked.ts"));
        await writeFile(
          path.join(bundle, "package.json"),
          JSON.stringify({ name: "guard-bundle", pi: { extensions: ["./ok.ts", "./linked.ts"] } }),
        );
        await writeSettings(globalSettings(harness), { requiredChildExtensions: [bundle] });
        const session = await open(SessionManager.create(cwd, path.join(directory, "parents")));
        const failed = await tool<ThreadView>(session, "agent_spawn", {
          path: "worker",
          type: "guarded",
          task: "Run",
        });
        assert.equal(failed.state, "failed");
        assert.equal(
          failed.error,
          `Required child extension ${bundle} failed in session_start: linked guard failed`,
        );
        assert.equal(requests.length, 0);
      },
    );
  },
);

test(
  "a live paused child is not resumed while the value is invalid or a new required extension is missing",
  { timeout: 30000 },
  async () => {
    let cwdPath = "";
    await withOfflineHarness(
      {
        agentFiles: AGENTS,
        builtinTools: true,
        onRequest(request) {
          if (request.pathCall === 1)
            return toolUse("pause-1", "agent_pause", { reason: "Wait for the parent" });
          if (request.pathCall === 2)
            return toolUse("bash-worker", "bash", { command: markedCommand(cwdPath, "worker") });
          return answer("worker finished");
        },
      },
      async (harness) => {
        const { directory, cwd, requests, open, close, tool } = harness;
        cwdPath = cwd;
        const guard = await writeGuard(directory);
        const file = globalSettings(harness);
        const root = SessionManager.create(cwd, path.join(directory, "parents"));
        root.appendMessage({ role: "user", content: "Parent context", timestamp: Date.now() });
        root.appendMessage(answer("Parent answer"));
        let session = await open(root);
        const paused = await tool<ThreadView>(session, "agent_spawn", {
          path: "worker",
          type: "guarded",
          task: "Pause first",
        });
        assert.equal(paused.state, "paused");

        await writeSettings(file, { requiredChildExtensions: "not-a-list" });
        await tool(session, "agent_steer", { path: "worker", message: "Now run the command" });
        const invalid = await tool<ThreadView>(session, "agent_wait", { path: "worker" });
        assert.equal(invalid.state, "failed");
        assert.equal(
          invalid.error,
          `Subagent /root/worker not resumed: ${file}: requiredChildExtensions must be an array of non-empty strings; subagents will not start until it is fixed`,
        );

        await writeSettings(file, { requiredChildExtensions: [guard.extensionPath] });
        await tool(session, "agent_steer", { path: "worker", message: "Now run the command" });
        const unguarded = await tool<ThreadView>(session, "agent_wait", { path: "worker" });
        assert.equal(unguarded.state, "failed");
        assert.equal(
          unguarded.error,
          `Subagent /root/worker was started without required child extension ${guard.extensionPath}; reload the session to resume it with that extension`,
        );
        assert.equal(requests.length, 1, "neither refused resume made a model request");
        assert.equal(existsSync(path.join(cwd, "worker.txt")), false);

        await close(session);
        session = await open(SessionManager.open(root.getSessionFile()!));
        await tool(session, "agent_steer", { path: "worker", message: "Now run the command" });
        const done = await tool<ThreadView>(session, "agent_wait", { path: "worker" });
        assert.equal(done.state, "completed");
        assert.equal(existsSync(path.join(cwd, "worker.txt")), false);
        assert.deepEqual(await loggedCommands(guard.logPath), [markedCommand(cwd, "worker")]);
      },
    );
  },
);

for (const [mode, allow] of [
  ["allowed", ["bash", "agent_pause", "guard_probe"]],
  ["all", ["bash"]],
] as const) {
  test(
    `a tool registered only by a required extension follows ${mode} tool filtering like any other`,
    { timeout: 30000 },
    async () => {
      await withOfflineHarness(
        {
          agentFiles: { prober: agent("prober", [...allow]) },
          builtinTools: true,
          onRequest: (request) =>
            request.pathCall === 1 ? toolUse("probe-1", "guard_probe", {}) : answer("done"),
        },
        async (harness) => {
          const { directory, cwd, requests, open, tool } = harness;
          const guard = await writeGuard(directory);
          await writeSettings(globalSettings(harness), {
            toolFiltering: mode,
            requiredChildExtensions: [guard.extensionPath],
          });
          const session = await open(SessionManager.create(cwd, path.join(directory, "parents")));
          const done = await tool<ThreadView>(session, "agent_spawn", {
            path: "worker",
            type: "prober",
            task: "Call the probe",
          });
          assert.equal(done.state, "completed");
          assert.ok(requests[0].toolNames.includes("guard_probe"), "probe is active");
          assert.equal(bashResult(requests, "/root/worker"), "probe ran");
          assert.equal(
            await readFile(guard.logPath, "utf8").then((log) => log.includes("probe executed")),
            true,
          );
        },
      );
    },
  );
}

test(
  "allowing a tool that neither the root nor a required extension provides still fails the spawn",
  { timeout: 30000 },
  async () => {
    await withOfflineHarness(
      {
        agentFiles: { prober: agent("prober", ["bash", "missing_tool"]) },
        builtinTools: true,
        onRequest: () => answer("must not run"),
      },
      async (harness) => {
        const { directory, cwd, requests, open, tool } = harness;
        const guard = await writeGuard(directory);
        await writeSettings(globalSettings(harness), {
          requiredChildExtensions: [guard.extensionPath],
        });
        const session = await open(SessionManager.create(cwd, path.join(directory, "parents")));
        const failed = await tool<ThreadView>(session, "agent_spawn", {
          path: "worker",
          type: "prober",
          task: "Run",
        });
        assert.equal(failed.state, "failed");
        assert.equal(failed.error, "Unavailable tool name: missing_tool");
        assert.equal(requests.length, 0);
      },
    );
  },
);

for (const [failure, source, message] of [
  [
    "session_start",
    `export default function (pi: any) {
  pi.on("session_start", () => {
    throw new Error("shared guard failed");
  });
}
`,
    "failed in session_start: shared guard failed",
  ],
  ["load", "export default 42;\n", "failed to load: "],
] as const) {
  test(
    `a required directory fails closed when its manifest entry outside the directory fails to ${failure}`,
    { timeout: 30000 },
    async () => {
      await withOfflineHarness(
        { agentFiles: AGENTS, builtinTools: true, onRequest: () => answer("must not run") },
        async (harness) => {
          const { directory, cwd, requests, open, tool } = harness;
          const shared = path.join(directory, "shared", "guard.ts");
          await mkdir(path.dirname(shared), { recursive: true });
          await writeFile(shared, source);
          const bundle = path.join(directory, "guard-bundle");
          await mkdir(bundle);
          await writeFile(path.join(bundle, "ok.ts"), "export default function () {}\n");
          await writeFile(
            path.join(bundle, "package.json"),
            JSON.stringify({
              name: "guard-bundle",
              pi: { extensions: ["./ok.ts", "../shared/guard.ts"] },
            }),
          );
          await writeSettings(globalSettings(harness), { requiredChildExtensions: [bundle] });
          const session = await open(SessionManager.create(cwd, path.join(directory, "parents")));
          const failed = await tool<ThreadView>(session, "agent_spawn", {
            path: "worker",
            type: "guarded",
            task: "Run",
          });
          assert.equal(failed.state, "failed");
          assert.ok(
            failed.error?.startsWith(`Required child extension ${bundle} ${message}`),
            failed.error,
          );
          assert.equal(requests.length, 0);
        },
      );
    },
  );
}

test(
  "a required directory whose manifest lists a missing entry point refuses the spawn",
  { timeout: 30000 },
  async () => {
    await withOfflineHarness(
      { agentFiles: AGENTS, builtinTools: true, onRequest: () => answer("must not run") },
      async (harness) => {
        const { directory, cwd, requests, open, tool } = harness;
        const bundle = path.join(directory, "guard-bundle");
        await mkdir(bundle);
        await writeFile(path.join(bundle, "ok.ts"), "export default function () {}\n");
        await writeFile(
          path.join(bundle, "package.json"),
          JSON.stringify({
            name: "guard-bundle",
            pi: { extensions: ["./ok.ts", "./guard.ts", "./more/*.ts", "!./ok.ts"] },
          }),
        );
        await writeSettings(globalSettings(harness), { requiredChildExtensions: [bundle] });
        const session = await open(SessionManager.create(cwd, path.join(directory, "parents")));
        const failed = await tool<ThreadView>(session, "agent_spawn", {
          path: "worker",
          type: "guarded",
          task: "Run",
        });
        assert.equal(failed.state, "failed");
        assert.equal(
          failed.error,
          `Required child extension ${bundle} failed to load: manifest entry ${path.join(bundle, "guard.ts")} does not exist`,
        );
        assert.equal(requests.length, 0);
      },
    );
  },
);

const UNPARSEABLE_REQUIRED =
  "could not be parsed as a JSON object and mentions requiredChildExtensions; subagents will not start until it is fixed";
async function writeRawSettings(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

for (const [layer, settingsFile] of [
  ["global", globalSettings],
  ["project", projectSettings],
] as const) {
  test(
    `an unparseable ${layer} settings file that mentions requiredChildExtensions refuses spawns`,
    { timeout: 30000 },
    async () => {
      await withOfflineHarness(
        { agentFiles: AGENTS, builtinTools: true, onRequest: () => answer("must not run") },
        async (harness) => {
          const { directory, cwd, requests, open, tool } = harness;
          const guard = await writeGuard(directory);
          const file = settingsFile(harness);
          await writeRawSettings(
            file,
            `{ "requiredChildExtensions": [${JSON.stringify(guard.extensionPath)}], `,
          );
          const session = await open(SessionManager.create(cwd, path.join(directory, "parents")));
          const failed = await tool<ThreadView>(session, "agent_spawn", {
            path: "worker",
            type: "guarded",
            task: "Run",
          });
          assert.equal(failed.state, "failed");
          assert.equal(
            failed.error,
            `Subagent /root/worker not started: ${file}: ${UNPARSEABLE_REQUIRED}`,
          );
          assert.equal(requests.length, 0);
        },
      );
    },
  );
}

test(
  "an unparseable settings file that does not mention requiredChildExtensions still allows spawns",
  { timeout: 30000 },
  async () => {
    await withOfflineHarness(
      { agentFiles: AGENTS, builtinTools: true, onRequest: () => answer("worker finished") },
      async (harness) => {
        const { directory, cwd, requests, open, tool } = harness;
        await writeRawSettings(globalSettings(harness), `{ "maxLevels": 3, `);
        const session = await open(SessionManager.create(cwd, path.join(directory, "parents")));
        const done = await tool<ThreadView>(session, "agent_spawn", {
          path: "worker",
          type: "guarded",
          task: "Run",
        });
        assert.equal(done.state, "completed");
        assert.equal(done.output, "worker finished");
        assert.equal(requests.length, 1);
      },
    );
  },
);

test(
  "a live paused child is not resumed while a settings file mentioning the key is unparseable",
  { timeout: 30000 },
  async () => {
    let cwdPath = "";
    await withOfflineHarness(
      {
        agentFiles: AGENTS,
        builtinTools: true,
        onRequest(request) {
          if (request.pathCall === 1)
            return toolUse("pause-1", "agent_pause", { reason: "Wait for the parent" });
          if (request.pathCall === 2)
            return toolUse("bash-worker", "bash", { command: markedCommand(cwdPath, "worker") });
          return answer("worker finished");
        },
      },
      async (harness) => {
        const { directory, cwd, requests, open, tool } = harness;
        cwdPath = cwd;
        const guard = await writeGuard(directory);
        const file = globalSettings(harness);
        await writeSettings(file, { requiredChildExtensions: [guard.extensionPath] });
        const session = await open(SessionManager.create(cwd, path.join(directory, "parents")));
        const paused = await tool<ThreadView>(session, "agent_spawn", {
          path: "worker",
          type: "guarded",
          task: "Pause first",
        });
        assert.equal(paused.state, "paused");

        await writeRawSettings(
          file,
          `{ "requiredChildExtensions": [${JSON.stringify(guard.extensionPath)}], `,
        );
        await tool(session, "agent_steer", { path: "worker", message: "Now run the command" });
        const refused = await tool<ThreadView>(session, "agent_wait", { path: "worker" });
        assert.equal(refused.state, "failed");
        assert.equal(
          refused.error,
          `Subagent /root/worker not resumed: ${file}: ${UNPARSEABLE_REQUIRED}`,
        );
        assert.equal(requests.length, 1, "the refused resume made no model request");
        assert.equal(existsSync(path.join(cwd, "worker.txt")), false);

        await writeSettings(file, { requiredChildExtensions: [guard.extensionPath] });
        await tool(session, "agent_steer", { path: "worker", message: "Now run the command" });
        const done = await tool<ThreadView>(session, "agent_wait", { path: "worker" });
        assert.equal(done.state, "completed");
        assert.equal(existsSync(path.join(cwd, "worker.txt")), false);
        assert.deepEqual(await loggedCommands(guard.logPath), [markedCommand(cwd, "worker")]);
      },
    );
  },
);
