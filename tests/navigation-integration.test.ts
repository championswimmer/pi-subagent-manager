import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { setKeybindings, TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";
import piSubagent from "../src/index.ts";
import { markImportOffered } from "../src/prefs/agent-import.ts";
import { ThreadManager } from "../src/orch/manager.ts";
import type { ThreadView } from "../src/types.ts";
import { AgentNavigationEditor } from "../src/ui/agent-navigation-editor.ts";
import { StatusDialog } from "../src/ui/status-ui.ts";
import { createDialogDriver } from "./helpers/dialogDriver.ts";

class FakeTerminal implements Terminal {
  columns = 80;
  rows = 24;
  kittyProtocolActive = false;
  start() {}
  stop() {}
  async drainInput() {}
  write() {}
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
const thread = (state: ThreadView["state"], path = "/root/worker"): ThreadView => ({
  path, parent: "/root", owner: "/root", type: "worker", state,
  task: "Work", status: state, createdAt: 1, updatedAt: 1,
});

async function fixture(
  run: (state: {
    editor(): AgentNavigationEditor | undefined;
    installations(): number;
    command: any;
    ctx: ExtensionContext;
    hooks: Map<string, Function>;
    driver: ReturnType<typeof createDialogDriver>;
  }) => Promise<void>,
  options: {
    mode?: "tui" | "rpc"; hasUI?: boolean; draft?: string;
    competingEditor?: boolean; reason?: "startup" | "resume";
    threads?: ThreadView[];
  } = {},
) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-agent-navigation-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = cwd;
  markImportOffered(cwd);
  const list = mock.method(ThreadManager.prototype, "list", () => options.threads ?? []);
  const hooks = new Map<string, Function>();
  const sessionManager = SessionManager.inMemory(cwd);
  sessionManager.appendMessage({ role: "user", content: "old prompt", timestamp: 1 });
  const keys = new KeybindingsManager();
  setKeybindings(keys);
  const host = new TuiMainScreen(new FakeTerminal());
  const theme = { fg: (_color: string, text: string) => text };
  const driver = createDialogDriver({ theme: theme as any, rows: 24 });
  driver.onChild = (component) => {
    assert.ok(component instanceof StatusDialog);
    component.handleInput("\x1b");
    return true;
  };
  let editor: AgentNavigationEditor | undefined;
  let installations = 0;
  let command: any;
  const pi = {
    on: (event: string, handler: Function) => hooks.set(event, handler),
    registerTool() {},
    registerCommand: (_name: string, definition: any) => { command = definition; },
    appendEntry: (type: string, data: unknown) => sessionManager.appendCustomEntry(type, data),
    sendMessage() {},
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd, sessionManager,
    hasUI: options.hasUI ?? true,
    mode: options.mode ?? "tui",
    isProjectTrusted: () => false,
    ui: {
      setWidget() {}, notify() {}, custom: driver.custom,
      getEditorText: () => options.draft ?? "",
      getEditorComponent: () => options.competingEditor ? (() => ({})) : undefined,
      setEditorComponent(factory: Function) {
        installations++;
        editor = factory(host, {
          borderColor: (text: string) => text,
          selectList: {
            selectedPrefix: (text: string) => text,
            selectedText: (text: string) => text,
            description: (text: string) => text,
            scrollInfo: (text: string) => text,
            noMatch: (text: string) => text,
          },
        }, keys);
        editor!.focused = true;
        editor!.render(80);
      },
    },
  } as unknown as ExtensionContext;
  try {
    piSubagent(pi);
    await hooks.get("session_start")!({ reason: options.reason ?? "resume" }, ctx);
    await run({ editor: () => editor, installations: () => installations, command, ctx, hooks, driver });
  } finally {
    await hooks.get("session_shutdown")?.({}, ctx);
    list.mock.restore();
    host.stop();
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("root installs the public editor and command/gesture use the same tree without changing draft", async () => {
  await fixture(async ({ editor, command, ctx, driver }) => {
    const main = editor()!;
    main.setText("unfinished\ndraft");
    main.handleInput("\x1b[A");
    main.handleInput("\x1b[H");
    const cursor = main.getCursor();
    main.handleInput("\x1b[D");
    await settle();
    assert.equal(driver.stats.outerOpens, 1);
    assert.equal(driver.stats.outerCompletions, 1);
    assert.equal(main.getText(), "unfinished\ndraft");
    assert.deepEqual(main.getCursor(), cursor);
    await command.handler("tree", ctx);
    assert.equal(driver.stats.outerOpens, 2);
    main.setText("");
    main.handleInput("\x1b[A");
    assert.equal(main.getText(), "old prompt", "resumed session history is hydrated");
  }, { threads: [thread("running")] });
});

test("startup lets the host hydrate prompt history exactly once", async () => {
  await fixture(async ({ editor }) => {
    const main = editor()!;
    main.handleInput("\x1b[A");
    assert.equal(main.getText(), "");
    main.addToHistory("old prompt"); // renderInitialMessages runs after session_start.
    main.handleInput("\x1b[A");
    assert.equal(main.getText(), "old prompt");
  }, { reason: "startup" });
});

test("session tree does not reinstall the editor and root shutdown cancels queued navigation", async () => {
  await fixture(async ({ editor, installations, hooks, ctx, driver }) => {
    const main = editor()!;
    main.setText("preserved draft");
    await hooks.get("session_tree")!({}, ctx);
    assert.equal(installations(), 1);
    assert.equal(editor(), main);
    assert.equal(main.getText(), "preserved draft");
    main.handleInput("\x1b[H");
    main.handleInput("\x1b[D");
    await hooks.get("session_shutdown")!({}, ctx);
    await settle();
    assert.equal(driver.stats.outerOpens, 0);
  }, { threads: [thread("running")] });
});

test("Left opens only for live subagents, while the tree command always remains available", async () => {
  const threads: ThreadView[] = [];
  await fixture(async ({ editor, command, ctx, driver }) => {
    const main = editor()!;
    for (const text of ["", "unfinished draft"]) {
      main.setText(text);
      main.handleInput("\x1b[H");
      const cursor = main.getCursor();
      const idleCases = [
        [], [thread("running", "/root")],
        ...(["paused", "completed", "failed", "stopped"] as const).map((state) => [thread(state)]),
      ];
      for (const idle of idleCases) {
        threads.splice(0, threads.length, ...idle);
        const opens = driver.stats.outerOpens;
        main.handleInput("\x1b[D");
        await settle();
        assert.equal(driver.stats.outerOpens, opens, JSON.stringify(idle));
        assert.equal(main.getText(), text);
        assert.deepEqual(main.getCursor(), cursor);
        await command.handler("tree", ctx);
        assert.equal(driver.stats.outerOpens, opens + 1, "explicit command ignores activity");
      }
      for (const state of ["starting", "running"] as const) {
        for (const path of ["/root/worker", "/root/parent/child", "/independent"]) {
          threads.splice(0, threads.length, thread("completed"), thread(state, path));
          const opens = driver.stats.outerOpens;
          main.handleInput("\x1b[D");
          await settle();
          assert.equal(driver.stats.outerOpens, opens + 1, `${path}: ${state}`);
          assert.equal(main.getText(), text);
          assert.deepEqual(main.getCursor(), cursor);
        }
      }
    }
    // A child can settle after dispatch but before the deferred open.
    threads.splice(0, threads.length, thread("running"));
    const opens = driver.stats.outerOpens;
    main.handleInput("\x1b[D");
    threads[0]!.state = "completed";
    await settle();
    assert.equal(driver.stats.outerOpens, opens);
  }, { threads });
});

test("non-TUI contexts and existing editors leave the custom-editor slot untouched", async () => {
  for (const options of [
    { mode: "rpc" as const }, { hasUI: false },
    { draft: "existing draft" }, { competingEditor: true },
  ]) {
    await fixture(async ({ installations, command, ctx, driver }) => {
      assert.equal(installations(), 0);
      if (options.mode === undefined && options.hasUI !== false) {
        await command.handler("tree", ctx);
        assert.equal(driver.stats.outerOpens, 1, "existing editors retain command navigation");
      }
    }, options);
  }
});
