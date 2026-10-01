import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import piSubagent from "../src/index.ts";
import { loadManagerSettings } from "../src/settings.ts";

async function withCommands(
  body: (fixture: {
    command: any;
    ctx: ExtensionCommandContext;
    hooks: Map<string, Function>;
    renders: string[][];
    replies: (string | undefined)[];
    cwd: string;
    notifications: string[];
  }) => Promise<void>,
) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-agents-command-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = cwd;
  const sessionManager = SessionManager.inMemory(cwd);
  const hooks = new Map<string, Function>();
  const renders: string[][] = [];
  const replies: (string | undefined)[] = [];
  const notifications: string[] = [];
  let command: any;
  const pi = {
    registerTool() {},
    registerCommand: (name: string, definition: any) => {
      assert.equal(name, "agents");
      command = definition;
    },
    on: (name: string, handler: Function) => hooks.set(name, handler),
    appendEntry: (type: string, data: unknown) =>
      sessionManager.appendCustomEntry(type, data),
    sendMessage() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    sessionManager,
    hasUI: true,
    mode: "tui",
    isProjectTrusted: () => false,
    ui: {
      setWidget() {},
      notify: (text: string) => notifications.push(text),
      custom: async (factory: Function, options: any) => {
        assert.equal(options.overlay, true);
        return new Promise((resolve) => {
          const component = factory(
            { requestRender() {}, terminal: { rows: 24 } },
            { fg: (_token: string, text: string) => text },
            {},
            resolve,
          );
          renders.push(component.render(100));
          resolve(replies.shift());
        });
      },
    },
  } as unknown as ExtensionCommandContext;
  try {
    piSubagent(pi);
    await hooks.get("session_start")!({}, ctx);
    await body({ command, ctx, hooks, renders, replies, cwd, notifications });
  } finally {
    await hooks.get("session_shutdown")?.({}, ctx);
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("agents command defaults to settings and saved limits reach the system prompt", async () => {
  await withCommands(async ({ command, ctx, hooks, renders, replies, cwd }) => {
    replies.push("maxLevels", "5", "save");
    await command.handler("", ctx);
    assert.match(renders[0]!.join("\n"), /Agents settings/);
    assert.equal(
      loadManagerSettings({ cwd, agentDir: cwd, includeProject: false })
        .settings.maxLevels,
      5,
    );
    const result = await hooks.get("before_agent_start")!(
      { systemPrompt: "Main" },
      ctx,
    );
    assert.match(result.systemPrompt, /maximum is 5 levels/);
  });
});

test("agents status opens a tree overlay and is discoverable in completions/help", async () => {
  await withCommands(async ({ command, ctx, renders, notifications }) => {
    assert.deepEqual(command.getArgumentCompletions("sta"), [
      { value: "status", label: "status" },
    ]);
    await command.handler("status", ctx);
    assert.match(renders[0]!.join("\n"), /Agents status/);
    assert.match(renders[0]!.join("\n"), /\/root/);
    await command.handler("unknown", ctx);
    assert.match(notifications.at(-1)!, /status/);
  });
});

test("settings and status decline RPC custom dialogs", async () => {
  await withCommands(async ({ command, ctx, renders, notifications }) => {
    (ctx as { mode: string }).mode = "rpc";
    await command.handler("", ctx);
    await command.handler("status", ctx);
    assert.equal(renders.length, 0);
    assert.equal(
      notifications.filter((text) => text.includes("TUI mode")).length,
      2,
    );
  });
});
