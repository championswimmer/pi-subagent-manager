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
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import piSubagent from "../src/index.ts";
import { loadManagerSettings } from "../src/settings.ts";
import { IMPORT_REQUEST_PREFIX, importWasOffered, markImportOffered } from "../src/agent-import.ts";
import { createDialogDriver } from "./helpers/dialogDriver.ts";

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
  markImportOffered(cwd); // Command tests do not scan the developer's external agent directories.
  const sessionManager = SessionManager.inMemory(cwd);
  const hooks = new Map<string, Function>();
  const renders: string[][] = [];
  const replies: (string | undefined)[] = [];
  const notifications: string[] = [];
  const driver = createDialogDriver({
    theme: { fg: (_token: string, text: string) => text } as Theme,
    width: 100,
    choices: replies,
    unified: true,
    onOpen(options) {
      assert.equal((options as { overlay?: boolean } | undefined)?.overlay, true);
    },
    onFrame(_component, lines) {
      renders.push(lines);
    },
  });
  let command: any;
  const pi = {
    registerTool() {},
    registerCommand: (name: string, definition: any) => {
      assert.equal(name, "agents");
      command = definition;
    },
    on: (name: string, handler: Function) => hooks.set(name, handler),
    appendEntry: (type: string, data: unknown) => sessionManager.appendCustomEntry(type, data),
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
      custom: driver.custom,
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
      loadManagerSettings({ cwd, agentDir: cwd, includeProject: false }).settings.maxLevels,
      5,
    );
    const result = await hooks.get("before_agent_start")!(
      { prompt: "User request", systemPrompt: "Main" },
      ctx,
    );
    assert.match(result.systemPrompt, /maximum is 5 levels/);
  });
});

test("agents command saves the scoped model filtering toggle", async () => {
  await withCommands(async ({ command, ctx, renders, replies, cwd }) => {
    replies.push("scopedModelFiltering", "save");
    await command.handler("", ctx);
    assert.match(renders[0]!.join("\n"), /Scoped model filtering/);
    assert.equal(
      loadManagerSettings({ cwd, agentDir: cwd, includeProject: false }).settings.scopedModelFiltering,
      false,
    );
  });
});

test("agents status opens a tree overlay and is discoverable in completions/help", async () => {
  await withCommands(async ({ command, ctx, renders, notifications }) => {
    assert.deepEqual(command.getArgumentCompletions("sta"), [{ value: "status", label: "status" }]);
    await command.handler("status", ctx);
    assert.match(renders[0]!.join("\n"), /Agents status/);
    assert.match(renders[0]!.join("\n"), /\/root/);
    await command.handler("unknown", ctx);
    assert.match(notifications.at(-1)!, /status/);
  });
});

test("import command is discoverable and declines RPC without opening a dialog", async () => {
  await withCommands(async ({ command, ctx, renders, notifications }) => {
    assert.deepEqual(command.getArgumentCompletions("imp"), [{ value: "import", label: "import" }]);
    (ctx as { mode: string }).mode = "rpc";
    await command.handler("import", ctx);
    assert.equal(renders.length, 0);
    assert.match(notifications.at(-1)!, /Agent import requires TUI mode/);
  });
});

test("only an accepted migration turn acknowledges first-run onboarding", async () => {
  await withCommands(async ({ hooks, ctx, cwd }) => {
    rmSync(join(cwd, "subagent-manager", ".import-offered"));
    await hooks.get("before_agent_start")!(
      { prompt: "Ordinary request", systemPrompt: "Main" },
      ctx,
    );
    assert.equal(importWasOffered(cwd), false);
    await hooks.get("before_agent_start")!(
      {
        prompt: `${IMPORT_REQUEST_PREFIX}\nMigration data`,
        systemPrompt: "Main",
      },
      ctx,
    );
    assert.equal(importWasOffered(cwd), true);
  });
});

test("settings and status decline RPC custom dialogs", async () => {
  await withCommands(async ({ command, ctx, renders, notifications }) => {
    (ctx as { mode: string }).mode = "rpc";
    await command.handler("", ctx);
    await command.handler("status", ctx);
    assert.equal(renders.length, 0);
    assert.equal(notifications.filter((text) => text.includes("TUI mode")).length, 2);
  });
});

const SUBCOMMANDS = ["tree", "status", "settings", "types", "import", "reload"].map(
  (value) => ({ value, label: value }),
);

function savedThread(path: string) {
  const slash = path.lastIndexOf("/");
  return {
    view: {
      path,
      parent: slash > 0 ? path.slice(0, slash) : null,
      owner: path,
      type: "worker",
      state: "completed",
      task: "task",
      status: "done",
      createdAt: 1,
    },
    definition: { name: "worker", description: "test", systemPrompt: "child prompt" },
    inherited: [],
  };
}

test("agents completions are fuzzy and do not suggest thread or trailing arguments", async () => {
  await withCommands(async ({ command, ctx, notifications }) => {
    const complete = (prefix: string) => command.getArgumentCompletions(prefix);
    assert.deepEqual(complete(""), SUBCOMMANDS);
    assert.deepEqual(complete("   "), SUBCOMMANDS);
    assert.deepEqual(complete("rel"), [{ value: "reload", label: "reload" }]);
    assert.deepEqual(complete("TyPeS"), [{ value: "types", label: "types" }]);
    assert.deepEqual(complete("tpe"), [{ value: "types", label: "types" }]);
    assert.deepEqual(complete("   tpe"), [{ value: "types", label: "types" }]);
    assert.equal(complete("thread"), null);
    assert.equal(complete("thr"), null);
    assert.equal(complete("status extra"), null);
    assert.equal(complete("status "), null);
    assert.equal(complete("types foo"), null);
    assert.equal(complete("import now"), null);
    assert.equal(complete("reload now"), null);
    assert.equal(complete("settings 5"), null);
    assert.equal(complete("tree /missing"), null);
    assert.match(command.description, /live tree/);
    await command.handler("nope", ctx);
    assert.match(notifications.at(-1)!, /tree/);
    assert.match(notifications.at(-1)!, /settings/);
    assert.doesNotMatch(notifications.at(-1)!, /thread/);
    await command.handler("thread /root/alpha", ctx);
    assert.match(notifications.at(-1)!, /Usage:.*tree/);
  });
});

test("agents settings matches empty args and tree completions replace the whole argument", async () => {
  await withCommands(async ({ command, ctx, hooks, renders, notifications }) => {
    (ctx.sessionManager as SessionManager).appendCustomEntry("pi-subagent:registry:v1", {
      version: 1,
      rootSessionId: ctx.sessionManager.getSessionId(),
      threads: [savedThread("/root/alpha"), savedThread("/root/zeta")],
    });
    await hooks.get("session_tree")!({}, ctx);

    assert.deepEqual(command.getArgumentCompletions("tree "), [
      { value: "tree /root/alpha", label: "/root/alpha" },
      { value: "tree /root/zeta", label: "/root/zeta" },
    ]);
    assert.deepEqual(command.getArgumentCompletions("  TREE /root/al"), [
      { value: "tree /root/alpha", label: "/root/alpha" },
    ]);
    assert.deepEqual(command.getArgumentCompletions("tree alpha"), [
      { value: "tree /root/alpha", label: "/root/alpha" },
    ]);
    const paths = command.getArgumentCompletions("tree /root");
    assert.ok(paths);
    assert.equal(
      paths.some(
        (item: { value: string; label: string; description?: string }) =>
          item.value === "/root" ||
          item.label === "root" ||
          item.description === "inspect" ||
          item.value === "status",
      ),
      false,
    );
    assert.deepEqual(command.getArgumentCompletions("tree"), [{ value: "tree", label: "tree" }]);

    const before = renders.length;
    await command.handler("settings", ctx);
    assert.match(renders.at(-1)!.join("\n"), /Agents settings/);
    await command.handler("tree", ctx);
    assert.ok(renders.length > before);
    assert.match(renders.at(-1)!.join("\n"), /Agents tree/);
    await command.handler("tree /root/zeta", ctx);
    assert.ok(renders.at(-1)!.some((line) => /›.*\/root\/zeta/.test(line)));
    assert.doesNotMatch(notifications.at(-1) ?? "", /Usage:/);
  });
});

test("agents settings, tree, and status decline RPC dialogs", async () => {
  await withCommands(async ({ command, ctx, renders, notifications }) => {
    (ctx as { mode: string }).mode = "rpc";
    await command.handler("settings", ctx);
    await command.handler("tree", ctx);
    await command.handler("status", ctx);
    assert.equal(renders.length, 0);
    assert.equal(notifications.filter((text) => text.includes("TUI mode")).length, 3);
  });
});

test("CombinedAutocompleteProvider completes /agents then its subcommands", async () => {
  await withCommands(async ({ command, ctx, hooks, cwd }) => {
    (ctx.sessionManager as SessionManager).appendCustomEntry("pi-subagent:registry:v1", {
      version: 1,
      rootSessionId: ctx.sessionManager.getSessionId(),
      threads: [savedThread("/root/alpha")],
    });
    await hooks.get("session_tree")!({}, ctx);
    const provider = new CombinedAutocompleteProvider(
      [
        {
          name: "agents",
          description: command.description,
          getArgumentCompletions: (prefix: string) => command.getArgumentCompletions(prefix),
        },
      ],
      cwd,
      null,
    );
    const signal = new AbortController().signal;
    const suggest = (line: string) => provider.getSuggestions([line], 0, line.length, { signal });
    const apply = async (line: string, value: string) => {
      const suggestions = await suggest(line);
      assert.ok(suggestions);
      const item = suggestions.items.find((entry) => entry.value === value);
      assert.ok(item, `missing completion ${value} for ${JSON.stringify(line)}`);
      return provider.applyCompletion([line], 0, line.length, item, suggestions.prefix);
    };

    const root = await suggest("/ag");
    assert.ok(root?.items.some((item) => item.value === "agents"));
    const rooted = provider.applyCompletion(
      ["/ag"],
      0,
      3,
      root!.items.find((item) => item.value === "agents")!,
      root!.prefix,
    );
    assert.equal(rooted.lines[0], "/agents ");
    const subcommands = await provider.getSuggestions(
      rooted.lines,
      rooted.cursorLine,
      rooted.cursorCol,
      { signal },
    );
    assert.deepEqual(
      subcommands?.items.map((item) => item.value),
      SUBCOMMANDS.map((item) => item.value),
    );

    assert.equal((await apply("/agents ", "tree")).lines[0], "/agents tree");
    assert.equal((await apply("/agents tr", "tree")).lines[0], "/agents tree");
    assert.equal((await apply("/agents  tr", "tree")).lines[0], "/agents tree");
    assert.equal((await apply("/agents   tre", "tree")).lines[0], "/agents tree");
    assert.equal(
      (await apply("/agents tree /root/al", "tree /root/alpha")).lines[0],
      "/agents tree /root/alpha",
    );
    assert.equal(
      (await apply("/agents  tree /root/al", "tree /root/alpha")).lines[0],
      "/agents tree /root/alpha",
    );
  });
});
