import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { quote } from "shell-quote";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type {
  ExtensionCommandContext,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { ThreadView } from "../src/types.ts";
import { ConfigStore, serializeAgentType } from "../src/config.ts";
import {
  editAgentTypes,
  editorArguments,
  renderThreads,
  sanitizeText,
  showThreads,
  updateWidget,
  type ThreadController,
} from "../src/ui.ts";

function thread(path: string, overrides: Partial<ThreadView> = {}): ThreadView {
  return {
    path,
    parent: "/root",
    owner: "/root",
    type: "worker",
    state: "running",
    task: "Task",
    status: "Working",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}
const plainTheme: Pick<Theme, "fg"> = { fg: (_color, text) => text };

test("widget is compact, excludes current root, and reports hidden threads", () => {
  const threads = [
    thread("/root"),
    ...Array.from({ length: 10 }, (_, i) =>
      thread(`/worker${i}`, { state: "completed", updatedAt: i }),
    ),
    thread("/working", { updatedAt: 10 }),
    thread("/paused", { state: "paused", updatedAt: 12 }),
    thread("/starting", { state: "starting", updatedAt: 11 }),
  ];
  const lines = renderThreads(threads, 80, plainTheme);
  assert.equal(lines.length, 8);
  assert.ok(!lines.some((line) => line.includes("/root")));
  assert.match(lines[0]!, /\/starting/);
  assert.match(lines[1]!, /\/working/);
  assert.match(lines[2]!, /\/paused/);
  assert.match(lines[3]!, /\/worker9/);
  assert.match(lines.at(-1)!, /\+6 more threads/);
  assert.equal(renderThreads(threads.slice(1, 9), 80, plainTheme).length, 8);
});

test("widget sanitizes untrusted text and fits narrow Unicode terminal widths", () => {
  const threads = [thread("/作業", { status: "\x1b[31mred\x1b[0m\x1b]0;owned\x07\n\x00界界界" })];
  for (const width of [0, 1, 5, 20, 80]) {
    const lines = renderThreads(threads, width, plainTheme);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(lines.every((line) => !/[\x00-\x1f\x7f-\x9f]/.test(stripTerminalSequences(line))));
  }
  assert.equal(sanitizeText("\x1b]0;owned\x07hello\r\nthere"), "hello  there");
});

test("widget clears when empty and resolves theme dynamically at render", () => {
  let content: unknown;
  let options: unknown;
  let marker = "first";
  const colors: string[] = [];
  const ctx = {
    hasUI: true,
    ui: {
      get theme() {
        return {
          fg: (color: string, text: string) => {
            colors.push(color);
            return `${marker}:${text}`;
          },
        };
      },
      setWidget: (key: string, value: unknown, placement: unknown) => {
        assert.equal(key, "pi-subagent");
        content = value;
        options = placement;
      },
    },
  } as unknown as ExtensionContext;
  updateWidget(ctx, [
    thread("/worker", { color: "success" }),
    thread("/fallback", { color: "\x1b[31m" }),
  ]);
  assert.deepEqual(options, { placement: "belowEditor" });
  const widget = (content as () => { render(width: number): string[] })();
  assert.match(widget.render(80)[0]!, /^first:/);
  marker = "second";
  assert.match(widget.render(80)[0]!, /^second:/);
  assert.deepEqual(colors, ["success", "accent", "success", "accent"]);
  updateWidget(ctx, []);
  assert.equal(content, undefined);
  updateWidget(ctx, [thread("/root")]);
  assert.equal(content, undefined);
});

test("editor command accepts quoted argv but rejects shell operators", () => {
  assert.deepEqual(editorArguments('"/Applications/My Editor/bin/editor" --wait "a b"'), [
    "/Applications/My Editor/bin/editor",
    "--wait",
    "a b",
  ]);
  for (const command of ["", "vim; touch /tmp/owned", "vim | sh", "vim && echo x", "vim *.md"]) {
    assert.throws(() => editorArguments(command), /VISUAL\/EDITOR/);
  }
});

test("thread dialogs exclude root, discard viewer edits, and resume through steer", async () => {
  const views = [thread("/root"), thread("/worker", { state: "completed" })];
  const calls: string[] = [];
  const choices = [
    "/worker [completed] Working",
    "View transcript",
    "Send input / resume",
    "Back",
    undefined,
  ];
  const controller: ThreadController = {
    list: () => views,
    get: (path) => views.find((view) => view.path === path)!,
    output: () => "output",
    transcript: async () => "original transcript",
    steer: async (path, message) => {
      calls.push(`${path}: ${message}`);
      return views[1]!;
    },
    stop: async () => {
      throw new Error("unexpected stop");
    },
  };
  const ctx = {
    hasUI: true,
    ui: {
      select: async (_title: string, options: string[]) => {
        assert.ok(!options.some((option) => option.startsWith("/root")));
        return choices.shift();
      },
      editor: async (title: string, text: string) => {
        if (title.includes("READ ONLY")) {
          assert.equal(text, "original transcript");
          return "ignored changes";
        }
        return "continue please";
      },
      notify: () => {
        throw new Error("unexpected notification");
      },
    },
  } as unknown as ExtensionCommandContext;
  await showThreads(ctx, controller);
  assert.deepEqual(calls, ["/worker: continue please"]);
});

async function configFixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-ui-test-"));
  const agentDir = join(root, "global");
  const bundledDir = join(root, "bundled");
  await mkdir(join(agentDir, "agents"), { recursive: true });
  const body = "# Instructions\n\nKeep **Markdown** and whitespace.\n\n";
  await writeFile(
    join(agentDir, "agents", "worker.md"),
    serializeAgentType({ name: "worker", description: "Worker", systemPrompt: body }),
  );
  const store = new ConfigStore({ cwd: root, agentDir, bundledDir, includeProject: false });
  return { root, agentDir, store, body };
}

function editorContext(
  root: string,
  choices: (string | undefined)[],
  inputs: (string | undefined)[] = [],
) {
  const diagnostics: string[] = [];
  const scopes: string[][] = [];
  const ctx = {
    hasUI: true,
    mode: "tui",
    cwd: root,
    ui: {
      select: async (_title: string, options: string[]) => {
        if (_title === "Save scope") scopes.push(options);
        const choice = choices.shift();
        if (choice !== undefined)
          assert.ok(options.includes(choice), `Missing dialog option: ${choice}`);
        return choice;
      },
      input: async () => inputs.shift(),
      notify: (message: string) => diagnostics.push(message),
      confirm: async () => false,
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, diagnostics, scopes };
}

test("type field editor handles all YAML fields without changing Markdown", async () => {
  const { root, store, body } = await configFixture();
  try {
    const { ctx } = editorContext(
      root,
      [
        "worker",
        "name",
        "description",
        "model",
        "thinkingLevel",
        "high",
        "tools.allow",
        "Empty list",
        "tools.block",
        "Enter exact tool names",
        "color",
        "success",
        "Save",
        "Global",
        undefined,
      ],
      ["renamed", "New description", "provider/model", "bash, read"],
    );
    await editAgentTypes(ctx, store);
    const saved = store.get("renamed");
    assert.equal(saved.description, "New description");
    assert.equal(saved.model, "provider/model");
    assert.equal(saved.thinkingLevel, "high");
    assert.equal(saved.color, "success");
    assert.deepEqual(saved.tools, { allow: [], block: ["bash", "read"] });
    assert.equal(saved.systemPrompt, body);
    assert.equal(
      store.get("worker").systemPrompt,
      body,
      "renaming must leave the original file intact",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid field edits and untrusted project saves leave configuration unchanged", async () => {
  const { root, store, body } = await configFixture();
  try {
    const { ctx, diagnostics, scopes } = editorContext(
      root,
      [
        "worker",
        "name",
        "model",
        "tools.allow",
        "Enter exact tool names",
        "Save",
        undefined,
        "Cancel",
        undefined,
      ],
      ["../escape", "missing-provider", "read, read"],
    );
    await editAgentTypes(ctx, store);
    assert.equal(store.get("worker").systemPrompt, body);
    assert.equal(store.get("worker").model, undefined);
    assert.equal(store.get("worker").tools, undefined);
    assert.equal(diagnostics.length, 3);
    assert.deepEqual(scopes, [["Global"]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renaming a type cannot overwrite an existing definition", async () => {
  const { root, store, agentDir } = await configFixture();
  try {
    const content = serializeAgentType({
      name: "other",
      description: "Other",
      systemPrompt: "Original",
    });
    const file = join(agentDir, "agents", "other.md");
    await writeFile(file, content);
    store.reload();
    const { ctx, diagnostics } = editorContext(
      root,
      ["worker", "name", "Save", "Global", "Cancel", undefined],
      ["other"],
    );
    await editAgentTypes(ctx, store);
    assert.match(diagnostics[0]!, /already exists/);
    assert.equal(await readFile(file, "utf8"), content);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("external invalid edit restores draft, reports diagnostics, and restarts TUI", async () => {
  const { root, store, agentDir } = await configFixture();
  const visual = process.env.VISUAL;
  const editor = process.env.EDITOR;
  try {
    process.env.VISUAL = quote([
      process.execPath,
      "-e",
      'require("node:fs").writeFileSync(process.argv[1], "---\\nname: bad\\ndescription: bad\\nmodel: invalid\\n---\\nchanged")',
    ]);
    const file = join(agentDir, "agents", "worker.md");
    const original = await readFile(file, "utf8");
    const { ctx, diagnostics } = editorContext(root, [
      "worker",
      "External editor (entire Markdown)",
      "Save",
      "Global",
      undefined,
    ]);
    const terminalEvents: string[] = [];
    ctx.ui.custom = (async (factory: Function) => {
      return new Promise((done, reject) => {
        try {
          factory(
            {
              stop: () => terminalEvents.push("stop"),
              start: () => terminalEvents.push("start"),
              requestRender: () => terminalEvents.push("render"),
            },
            {},
            {},
            done,
          );
        } catch (error) {
          reject(error);
        }
      });
    }) as typeof ctx.ui.custom;
    await editAgentTypes(ctx, store);
    assert.deepEqual(terminalEvents, ["stop", "start", "render"]);
    assert.match(diagnostics[0]!, /Edit not accepted.*model/);
    assert.equal(await readFile(file, "utf8"), original);
  } finally {
    if (visual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = visual;
    if (editor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = editor;
    await rm(root, { recursive: true, force: true });
  }
});

test("frontmatter editor retries invalid YAML and preserves Markdown on save", async () => {
  const { root, store, body } = await configFixture();
  try {
    const { ctx, diagnostics } = editorContext(root, [
      "worker",
      "Edit frontmatter YAML",
      "Save",
      "Global",
      undefined,
    ]);
    let edits = 0;
    ctx.ui.editor = async () =>
      ++edits === 1
        ? "name: worker\ndescription: Worker\nthinkingLevel: impossible"
        : "name: worker\ndescription: Revised\ncolor: muted";
    ctx.ui.confirm = async () => true;
    await editAgentTypes(ctx, store);
    assert.equal(edits, 2);
    assert.equal(store.get("worker").description, "Revised");
    assert.equal(store.get("worker").systemPrompt, body);
    assert.match(diagnostics[0]!, /Edit not accepted/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
