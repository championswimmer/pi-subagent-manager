import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { quote } from "shell-quote";
import {
  colorToRgb,
  foregroundAnsi,
  rgbColor,
  stripTerminalSequences,
  styleText,
  visibleWidth,
  type Color,
} from "@earendil-works/pi-tui";
import {
  Theme,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { ThreadView } from "../src/types.ts";
import { AGENT_COLORS, ConfigStore, parseAgentType, serializeAgentType } from "../src/config.ts";
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
function testTheme(
  appearance: "dark" | "light",
  mode: "truecolor" | "256color" = "truecolor",
): Theme {
  // Deterministic fixtures use the public API, independent of terminal color detection.
  const foreground = appearance === "dark" ? "#eeeeee" : "#111111";
  const background = appearance === "dark" ? "#111111" : "#eeeeee";
  const colors = {
    ...Object.fromEntries(AGENT_COLORS.map((token) => [token, foreground])),
    accent: appearance === "dark" ? "#60a5fa" : "#1e40af",
    success: appearance === "dark" ? "#166534" : "#b7e4c7",
    warning: "#facc15",
    error: "#b91c1c",
  } as ConstructorParameters<typeof Theme>[0];
  const backgrounds = Object.fromEntries(
    [
      "selectedBg",
      "searchMatchBg",
      "userMessageBg",
      "customMessageBg",
      "toolPendingBg",
      "toolSuccessBg",
      "toolErrorBg",
    ].map((token) => [token, background]),
  ) as ConstructorParameters<typeof Theme>[1];
  return new Theme(colors, backgrounds, mode, { appearance });
}

const darkTheme = testTheme("dark");
const lightTheme = testTheme("light");

/** Black text above the WCAG black/white crossover (~0.179), otherwise white. */
function contrastChannel(color: Color): 0 | 255 {
  const { r, g, b } = colorToRgb(color);
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  return luminance > Math.sqrt(0.0525) - 0.05 ? 0 : 255;
}

function badgeToken(color: string | undefined): ThemeColor {
  return AGENT_COLORS.includes(color as (typeof AGENT_COLORS)[number])
    ? (color as ThemeColor)
    : "accent";
}

function expectedBadge(theme: Theme, name: string, color: string | undefined): string {
  const background = theme.colors[badgeToken(color)];
  const channel = contrastChannel(background);
  return styleText(
    ` ${sanitizeText(name)} `,
    { bg: background, fg: rgbColor(channel, channel, channel), bold: true },
    theme.getColorMode(),
  );
}

function expectedTypeBadge(theme: Theme, type: string, color: string | undefined): string {
  return expectedBadge(theme, `[${type}]`, color);
}

function expectedPath(theme: Theme, path: string, color: string | undefined): string {
  return theme.fg(badgeToken(color), sanitizeText(path));
}

function stateToken(state: ThreadView["state"]): "error" | "warning" | "accent" {
  return state === "failed" ? "error" : state === "paused" ? "warning" : "accent";
}

/** Zero-metric fixtures only. Counters are the literal unset label, padded, not truncated. */
function expectedThreadLine(theme: Theme, view: ThreadView, width = 80): string {
  const badge = expectedTypeBadge(theme, view.type, view.color);
  const path = expectedPath(theme, view.path, view.color);
  const state = theme.fg(stateToken(view.state), `[${sanitizeText(view.state)}]`);
  const left = `${badge} ${path} ${state} ${sanitizeText(view.status || view.task)}`;
  const right = theme.fg("muted", "0s ↑0 ↓0");
  return left + " ".repeat(width - visibleWidth(left) - visibleWidth(right)) + right;
}

/** Visible text inside each background-color span. Resets are not part of the span. */
function backgroundCoveredText(line: string): string[] {
  const spans: string[] = [];
  const pattern = /\x1b\[48;(?:2(?:;\d+){3}|5;\d+)m/g;
  for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
    const close = line.indexOf("\x1b[49m", match.index);
    assert.ok(close > match.index, "background SGR must reset");
    spans.push(stripTerminalSequences(line.slice(match.index, close)));
    pattern.lastIndex = close + "\x1b[49m".length;
  }
  return spans;
}

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
  const lines = renderThreads(threads, 80, darkTheme);
  assert.equal(lines.length, 8);
  assert.ok(!lines.some((line) => line.includes("/root")));
  assert.match(lines[0]!, /\/starting/);
  assert.match(lines[1]!, /\/working/);
  assert.match(lines[2]!, /\/paused/);
  assert.match(lines[3]!, /\/worker9/);
  assert.match(lines.at(-1)!, /\+6 more threads/);
  assert.equal(renderThreads(threads.slice(1, 9), 80, darkTheme).length, 8);
});

test("widget sanitizes untrusted text and fits narrow Unicode terminal widths", () => {
  const threads = [
    thread("/作業", {
      status: "\x1b[31mred\x1b[0m\x1b]0;owned\x07\n\x00界界界",
    }),
  ];
  for (const width of [0, 1, 5, 20, 80]) {
    const lines = renderThreads(threads, width, darkTheme);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(lines.every((line) => !/[\x00-\x1f\x7f-\x9f]/.test(stripTerminalSequences(line))));
  }
  assert.equal(sanitizeText("\x1b]0;owned\x07hello\r\nthere"), "hello  there");
});

test("widget clears when empty and resolves theme dynamically at render", () => {
  let content: unknown;
  let options: unknown;
  let marker = "first";
  const fgCalls: { marker: string; color: string; text: string }[] = [];
  const styleCalls: { marker: string; text: string; bold?: boolean; bg: string; fg: string }[] = [];
  const tokenColor = (name: string) =>
    rgbColor(AGENT_COLORS.indexOf(name as (typeof AGENT_COLORS)[number]) + 1, 8, 9);
  const ctx = {
    hasUI: true,
    ui: {
      get theme() {
        const current = marker;
        return {
          fg: (color: string, text: string) => {
            fgCalls.push({ marker: current, color, text });
            return `${current}<fg:${color}>${text}</fg>`;
          },
          colors: Object.fromEntries(AGENT_COLORS.map((name) => [name, tokenColor(name)])),
          style: (text: string, style: { bold?: boolean; bg?: Color; fg?: Color }) => {
            const bg = style.bg ? colorToRgb(style.bg) : { r: -1, g: -1, b: -1 };
            const fg = style.fg ? colorToRgb(style.fg) : { r: -1, g: -1, b: -1 };
            styleCalls.push({
              marker: current,
              text,
              bold: style.bold,
              bg: `${bg.r},${bg.g},${bg.b}`,
              fg: `${fg.r},${fg.g},${fg.b}`,
            });
            return `${current}<bg:${bg.r}>${text}</bg>`;
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
    thread("/worker", { type: "worker", color: "success", status: "Working" }),
    thread("/fallback", { type: "fallback", color: "\x1b[31m", status: "Working" }),
  ]);
  assert.deepEqual(options, { placement: "belowEditor" });
  const tui = { requestRender() {} };
  const widget = (
    content as (injected: typeof tui) => { render(width: number): string[]; dispose(): void }
  )(tui);
  const first = widget.render(200);
  assert.match(first[0]!, /^first<bg:/);
  assert.match(first[0]!, /first<fg:success>\/worker<\/fg>/);
  assert.match(first[0]!, /first<fg:accent>\[running\]<\/fg> Working/);
  assert.match(first[0]!, /first<fg:muted>0s ↑0 ↓0<\/fg>$/);
  marker = "second";
  const second = widget.render(200);
  assert.match(second[0]!, /^second<bg:/);
  assert.match(
    second[1]!,
    /second<bg:1> \[fallback\] <\/bg> second<fg:accent>\/fallback<\/fg> second<fg:accent>\[running\]<\/fg> Working/,
  );
  assert.match(second[1]!, /second<fg:muted>0s ↑0 ↓0<\/fg>$/);
  assert.deepEqual(
    styleCalls.map((call) => call.text),
    [" [worker] ", " [fallback] ", " [worker] ", " [fallback] "],
  );
  assert.deepEqual(
    styleCalls.map((call) => call.marker),
    ["first", "first", "second", "second"],
  );
  assert.ok(styleCalls.every((call) => call.bold === true));
  const successBg = `${tokenColor("success").r},8,9`;
  const accentBg = `${tokenColor("accent").r},8,9`;
  assert.deepEqual(
    styleCalls.map((call) => call.bg),
    [successBg, accentBg, successBg, accentBg],
  );
  assert.deepEqual(
    styleCalls.map((call) => call.fg),
    styleCalls.map((call) => {
      const [r, g, b] = call.bg.split(",").map(Number);
      const channel = contrastChannel(rgbColor(r!, g!, b!));
      return `${channel},${channel},${channel}`;
    }),
  );
  assert.deepEqual(
    fgCalls.map((call) => ({ color: call.color, text: call.text })),
    [
      { color: "success", text: "/worker" },
      { color: "accent", text: "[running]" },
      { color: "muted", text: "0s ↑0 ↓0" },
      { color: "accent", text: "/fallback" },
      { color: "accent", text: "[running]" },
      { color: "muted", text: "0s ↑0 ↓0" },
      { color: "success", text: "/worker" },
      { color: "accent", text: "[running]" },
      { color: "muted", text: "0s ↑0 ↓0" },
      { color: "accent", text: "/fallback" },
      { color: "accent", text: "[running]" },
      { color: "muted", text: "0s ↑0 ↓0" },
    ],
  );
  widget.dispose();
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

async function configFixture(fileName = "worker.md") {
  const root = await mkdtemp(join(tmpdir(), "pi-subagent-ui-test-"));
  const agentDir = join(root, "global");
  const bundledDir = join(root, "bundled");
  await mkdir(join(agentDir, "agents"), { recursive: true });
  const body = "# Instructions\n\nKeep **Markdown** and whitespace.\n\n";
  await writeFile(
    join(agentDir, "agents", fileName),
    serializeAgentType({
      name: "worker",
      description: "Worker",
      systemPrompt: body,
    }),
  );
  const store = new ConfigStore({
    cwd: root,
    agentDir,
    bundledDir,
    includeProject: false,
  });
  return { root, agentDir, store, body };
}

const EDIT_FIELD_ACTIONS = new Set([
  "name",
  "description",
  "models",
  "thinkingLevel",
  "tools.allow",
  "tools.block",
  "color",
]);

/** Map scripted bare field actions to decorated labels only in the main unsaved edit menu. */
function scriptedEditChoice(title: string, options: string[], choice: string): string {
  if (!/^Edit .+ \(unsaved\)$/.test(title) || !EDIT_FIELD_ACTIONS.has(choice)) return choice;
  const label = options.find((option) => option.startsWith(`${choice}: `));
  assert.ok(label, `Missing decorated field label for ${choice}`);
  return label;
}

function editorContext(
  root: string,
  choices: (string | undefined)[],
  inputs: (string | undefined)[] = [],
  options: {
    mode?: "tui" | "rpc" | "json" | "print";
    availableModels?: { provider: string; id: string; name: string }[];
    scopedModels?: string[];
  } = {},
) {
  const diagnostics: string[] = [];
  const scopes: string[][] = [];
  const menus: { title: string; options: string[] }[] = [];
  const editors: { title: string; prefill?: string }[] = [];
  const colorPickerTheme = darkTheme;
  const availableModels = options.availableModels ?? [];
  const scopedModels = (options.scopedModels ?? []).map((identity) => {
    const [provider, ...rest] = identity.split("/");
    const id = rest.join("/");
    const model =
      availableModels.find((entry) => entry.provider === provider && entry.id === id) ??
      ({ provider, id, name: id } as const);
    return { model };
  });
  const ctx = {
    hasUI: true,
    mode: options.mode ?? "tui",
    cwd: root,
    modelRegistry: { getAvailable: () => availableModels },
    scopedModels,
    ui: {
      select: async (title: string, options: string[]) => {
        menus.push({ title, options: [...options] });
        if (title === "Save scope") scopes.push(options);
        const choice = choices.shift();
        if (choice === undefined) return choice;
        const resolved = scriptedEditChoice(title, options, choice);
        assert.ok(options.includes(resolved), `Missing dialog option: ${choice}`);
        return resolved;
      },
      custom: async (factory: Function) => {
        return new Promise<any>((resolve, reject) => {
          Promise.resolve(
            factory({ requestRender: () => {} }, colorPickerTheme, {}, (result: unknown) =>
              resolve(result),
            ),
          )
            .then((component: any) => {
              const items = component.getItems?.();
              assert.ok(items, "expected color picker items");
              const choice = choices.shift();
              if (choice === undefined) {
                component.getSelectList?.().onCancel?.();
                return;
              }
              const item = items.find((entry: { value: string }) => entry.value === choice);
              assert.ok(item, `Missing color picker option: ${choice}`);
              component.getSelectList?.().onSelectionChange?.(item);
              component.getSelectList?.().onSelect?.(item);
            })
            .catch(reject);
        });
      },
      input: async () => {
        throw new Error("ui.input is placeholder-only; field edits must use ui.editor");
      },
      editor: async (title: string, prefill?: string) => {
        editors.push({ title, prefill });
        return inputs.shift();
      },
      notify: (message: string) => diagnostics.push(message),
      confirm: async () => false,
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, diagnostics, scopes, menus, editors };
}

test("type field editor handles YAML fields without changing Markdown", async () => {
  const { root, store, body } = await configFixture();
  try {
    const { ctx } = editorContext(
      root,
      [
        "worker",
        "name",
        "description",
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
      ["renamed", "New description", "bash, read"],
    );
    await editAgentTypes(ctx, store);
    const saved = store.get("renamed");
    assert.equal(saved.description, "New description");
    assert.equal(saved.model, undefined);
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

test("legacy scalar model opens the ordered picker and cancel keeps the saved definition", async () => {
  const { root, store, agentDir, body } = await configFixture();
  try {
    const legacyScalarDefinition = `---\nname: worker\ndescription: Worker\nmodel: openai/gpt-4.1\n---\n${body}`;
    await writeFile(join(agentDir, "agents", "worker.md"), legacyScalarDefinition);
    store.reload();
    const { ctx } = editorContext(root, ["worker", "models", "Cancel", undefined], [], {
      availableModels: [
        { provider: "openai", id: "gpt-4.1", name: "GPT-4.1" },
        { provider: "anthropic", id: "claude-3.7-sonnet", name: "Claude 3.7 Sonnet" },
      ],
      scopedModels: ["openai/gpt-4.1"],
    });
    const observed = { mode: "", label: "", description: "" };
    const theme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
    } as unknown as Theme;
    ctx.ui.custom = (async (factory: Function) => {
      return new Promise<any>((resolve, reject) => {
        Promise.resolve(
          factory({ requestRender: () => {} }, theme, {}, (result: unknown) => resolve(result)),
        )
          .then((component: any) => {
            observed.mode = component.getMode();
            observed.label = component.getCurrentItems()[0]?.label ?? "";
            observed.description = component.getCurrentItems()[0]?.description ?? "";
            component.handleInput("\u001B");
          })
          .catch(reject);
      });
    }) as typeof ctx.ui.custom;
    await editAgentTypes(ctx, store);
    assert.equal(observed.mode, "menu");
    assert.equal(observed.label, "1. openai/gpt-4.1");
    assert.match(observed.description, /scoped in this session/);
    assert.deepEqual((store.get("worker") as { models?: string[] }).models, ["openai/gpt-4.1"]);
    assert.equal(store.get("worker").systemPrompt, body);
    assert.equal(
      await readFile(join(agentDir, "agents", "worker.md"), "utf8"),
      legacyScalarDefinition,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("saving model preferences stores canonical ordered models after add and reorder", async () => {
  const { root, store, body } = await configFixture();
  try {
    const { ctx } = editorContext(root, ["worker", "models", "Save", "Global", undefined], [], {
      availableModels: [
        { provider: "openai", id: "gpt-4.1", name: "GPT-4.1" },
        {
          provider: "anthropic",
          id: "claude-3.7-sonnet",
          name: "Claude 3.7 Sonnet",
        },
        { provider: "google", id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
      ],
      scopedModels: ["openai/gpt-4.1", "anthropic/claude-3.7-sonnet"],
    });
    ctx.ui.custom = (async (factory: Function) => {
      return new Promise<any>((resolve, reject) => {
        Promise.resolve(
          factory(
            { requestRender: () => {} },
            { fg: (_color: string, text: string) => text },
            {},
            (result: unknown) => resolve(result),
          ),
        )
          .then((component: any) => {
            const selectValue = (value: string) => {
              const item = component
                .getCurrentItems()
                .find((entry: { value: string }) => entry.value === value);
              assert.ok(item, `Missing model picker option: ${value}`);
              component.getSelectList().onSelect?.(item);
            };
            selectValue("openai/gpt-4.1");
            selectValue("action:add");
            selectValue("anthropic/claude-3.7-sonnet");
            selectValue("entry:1");
            selectValue("action:earlier");
            selectValue("action:done");
          })
          .catch(reject);
      });
    }) as typeof ctx.ui.custom;
    await editAgentTypes(ctx, store);
    const saved = store.get("worker");
    assert.deepEqual(saved.models, ["anthropic/claude-3.7-sonnet", "openai/gpt-4.1"]);
    assert.equal(saved.model, undefined);
    assert.equal(saved.systemPrompt, body);
    const persisted = await readFile(saved.filePath!, "utf8");
    assert.match(persisted, /models:\n  - anthropic\/claude-3\.7-sonnet\n  - openai\/gpt-4\.1/);
    assert.doesNotMatch(persisted, /\nmodel:/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function workerWithSuccess() {
  const fixture = await configFixture();
  await writeFile(
    join(fixture.agentDir, "agents", "worker.md"),
    serializeAgentType({
      name: "worker",
      description: "Worker",
      systemPrompt: fixture.body,
      color: "success",
    }),
  );
  fixture.store.reload();
  assert.equal(fixture.store.get("worker").color, "success");
  return fixture;
}

function driveColorPicker(
  ctx: ExtensionCommandContext,
  theme: Theme,
  drive: (component: any) => void,
) {
  let pickerError: unknown;
  ctx.ui.custom = (async (factory: Function) => {
    return new Promise((resolve, reject) => {
      Promise.resolve(factory({ requestRender: () => {} }, theme, {}, resolve))
        .then((component) => {
          try {
            drive(component);
          } catch (error) {
            pickerError = error;
            component.getSelectList?.().onCancel?.();
            resolve(undefined as never);
          }
        })
        .catch(reject);
    });
  }) as typeof ctx.ui.custom;
  return () => {
    if (pickerError) throw pickerError;
  };
}

function previewText(component: { getPreview(): { render(width: number): string[] } }): string {
  return component.getPreview().render(160).join("\n");
}

function assertColorPreview(
  preview: string,
  theme: Theme,
  agentName: string,
  color: string | undefined,
) {
  // Preview paints the type pill and a sample task path, matching the widget — not a path pill.
  const taskPath = "/root/example-task";
  const view = thread(taskPath, { type: agentName, color, state: "running", status: "Working" });
  const widget = renderThreads([view], 160, theme)[0]!;
  const badge = expectedTypeBadge(theme, agentName, color);
  const path = expectedPath(theme, taskPath, color);
  const head = `${badge} ${path} ${theme.fg("accent", "[running]")} Working`;
  assert.ok(widget.startsWith(head));
  assert.ok(preview.includes(`Preview: ${head}`));
  assert.deepEqual(backgroundCoveredText(preview), [` [${agentName}] `]);
  assert.ok(preview.includes(path));
  assert.doesNotMatch(path, /\x1b\[48;/);
}

test("thread type pills and paths use the selected color independently of state", () => {
  const channels = new Set<0 | 255>();
  for (const theme of [
    darkTheme,
    lightTheme,
    testTheme("dark", "256color"),
    testTheme("light", "256color"),
  ]) {
    for (const color of ["accent", "success", "warning", "text", "error"] as const) {
      const view = thread("/root/controller-security-research", {
        type: "researcher",
        color,
        state: "running",
        status: "Working",
      });
      const line = renderThreads([view], 120, theme)[0]!;
      const badge = expectedTypeBadge(theme, view.type, color);
      const path = expectedPath(theme, view.path, color);
      const channel = contrastChannel(theme.colors[color]);
      channels.add(channel);
      assert.equal(line, expectedThreadLine(theme, view, 120));
      assert.deepEqual(backgroundCoveredText(line), [" [researcher] "]);
      assert.ok(line.includes(path));
      assert.doesNotMatch(path, /\x1b\[48;/);
      assert.notEqual(badge, path);
      assert.match(badge, /\x1b\[1m/);
      assert.ok(
        badge.includes(foregroundAnsi(rgbColor(channel, channel, channel), theme.getColorMode())),
      );
      assert.doesNotMatch(line.slice(badge.length), /\x1b\[48;/);
      assert.doesNotMatch(line.slice(badge.length), /\x1b\[1m/);
      if (theme.getColorMode() === "256color") assert.match(path, /\x1b\[38;5;/);
      else assert.match(path, /\x1b\[38;2;/);
    }
  }
  assert.ok(channels.has(0), "a light background must use black text");
  assert.ok(channels.has(255), "a dark background must use white text");

  for (const [state, token] of [
    ["failed", "error"],
    ["paused", "warning"],
    ["starting", "accent"],
    ["completed", "accent"],
    ["stopped", "accent"],
  ] as const) {
    const view = thread("/worker", {
      type: "researcher",
      state,
      color: "success",
      status: "Busy",
      task: "Ignored",
    });
    const line = renderThreads([view], 80, darkTheme)[0]!;
    assert.equal(line, expectedThreadLine(darkTheme, view));
    assert.ok(line.includes(darkTheme.fg(token, `[${state}]`)));
    assert.ok(line.includes(darkTheme.fg("success", "/worker")));
    assert.match(stripTerminalSequences(line), / Busy +/);
    assert.deepEqual(backgroundCoveredText(line), [" [researcher] "]);
  }

  const invalid = thread("/owned\x1b[31m", {
    type: "bad\x1b[31m",
    color: "\x1b[31mnot-a-token",
    state: "failed",
    status: "",
    task: "Recover",
  });
  const fallback = renderThreads([invalid], 100, darkTheme)[0]!;
  assert.equal(fallback, expectedThreadLine(darkTheme, invalid, 100));
  assert.equal(
    expectedTypeBadge(darkTheme, invalid.type, invalid.color),
    expectedTypeBadge(darkTheme, invalid.type, "accent"),
  );
  assert.equal(
    expectedPath(darkTheme, invalid.path, invalid.color),
    expectedPath(darkTheme, invalid.path, "accent"),
  );
  assert.deepEqual(backgroundCoveredText(fallback), [` [${sanitizeText(invalid.type)}] `]);
  assert.ok(stripTerminalSequences(fallback).includes("Recover"));
  assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(stripTerminalSequences(fallback)));
});

test("widget keeps counters right-aligned when the left side is long or hostile", () => {
  const hostile = "\x1b[31mred\x1b[0m\x1b]0;owned\x07\n\x00" + "界".repeat(30);
  const view = thread("/root/" + "p".repeat(180), {
    type: "researcher" + hostile,
    status: hostile,
    task: hostile,
    color: "success",
    elapsedMs: 65_000,
    inputTokens: 1_200,
    outputTokens: 34,
  });
  const counters = "1m5s ↑1.2k ↓34";
  const styled = darkTheme.fg("muted", counters);
  for (const width of [0, 1, 4, 8, 16, 40, 80]) {
    const line = renderThreads([view], width, darkTheme)[0]!;
    assert.ok(visibleWidth(line) <= width);
    assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(stripTerminalSequences(line)));
    if (width >= visibleWidth(styled)) {
      assert.ok(line.endsWith(styled));
      assert.equal(visibleWidth(line), width);
      assert.ok(!stripTerminalSequences(line).includes("p".repeat(40)));
    }
  }
  const short = renderThreads([thread("/a", { type: "worker", status: "ok" })], 60, darkTheme)[0]!;
  const plain = stripTerminalSequences(short);
  const countersAt = plain.lastIndexOf("0s ↑0 ↓0");
  assert.equal(visibleWidth(short), 60);
  assert.ok(short.endsWith(darkTheme.fg("muted", "0s ↑0 ↓0")));
  assert.ok(countersAt > 0);
  assert.equal(plain[countersAt - 1], " ");
});

test("widget counter literals cover duration steps and count boundaries", () => {
  const cases = [
    { elapsedMs: 65_000, inputTokens: 999, outputTokens: 1_000, counters: "1m5s ↑999 ↓1k" },
    {
      elapsedMs: 3_600_000,
      inputTokens: 1_200,
      outputTokens: 999_999,
      counters: "1h0m ↑1.2k ↓1m",
    },
    {
      elapsedMs: 86_400_000,
      inputTokens: 1_000_000,
      outputTokens: 1_500_000,
      counters: "1d0h ↑1m ↓1.5m",
    },
    { elapsedMs: -5, inputTokens: Number.NaN, outputTokens: -1, counters: "0s ↑0 ↓0" },
  ];
  for (const { counters, ...metrics } of cases) {
    const line = stripTerminalSequences(
      renderThreads([thread("/job", { state: "completed", ...metrics })], 80, darkTheme)[0]!,
    );
    assert.ok(line.endsWith(` ${counters}`), line);
  }
});

test("widget timer rerenders live elapsed and does not run when settled or headless", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
  const intervals = globalThis.setInterval;
  let unrefs = 0;
  globalThis.setInterval = ((fn: TimerHandler, ms?: number, ...args: unknown[]) => {
    const timer = intervals(fn, ms as number, ...args) as unknown as NodeJS.Timeout;
    const unref = timer.unref.bind(timer);
    timer.unref = () => {
      unrefs += 1;
      return unref();
    };
    return timer;
  }) as unknown as typeof setInterval;
  try {
    let renders = 0;
    let component: { render(width: number): string[]; dispose(): void } | undefined;
    const tui = {
      requestRender: () => {
        renders += 1;
      },
    };
    const ctx = {
      hasUI: true,
      ui: {
        theme: darkTheme,
        setWidget: (_key: string, factory: unknown) => {
          component?.dispose();
          component =
            typeof factory === "function"
              ? (factory(tui) as { render(width: number): string[]; dispose(): void })
              : undefined;
        },
      },
    } as unknown as ExtensionContext;
    const line = () => stripTerminalSequences(component!.render(100)[0]!);

    updateWidget(ctx, [
      thread("/root/job", {
        type: "researcher",
        state: "running",
        startedAt: 995_000,
        elapsedMs: 2_000,
        inputTokens: 10,
        outputTokens: 3,
      }),
    ]);
    assert.equal(unrefs, 1);
    assert.match(line(), /7s ↑10 ↓3$/);
    t.mock.timers.tick(1000);
    assert.equal(renders, 1);
    assert.match(line(), /8s ↑10 ↓3$/);

    renders = 0;
    const previous = component!;
    updateWidget(ctx, [
      thread("/root/job", {
        type: "researcher",
        state: "running",
        startedAt: Date.now(),
        elapsedMs: 65_000,
        inputTokens: 1_200,
        outputTokens: 34,
      }),
    ]);
    assert.notEqual(component, previous);
    assert.equal(unrefs, 2);
    assert.match(line(), /1m5s ↑1.2k ↓34$/);
    t.mock.timers.tick(1000);
    assert.equal(renders, 1, "replacing a live widget must dispose the previous timer");
    assert.match(line(), /1m6s ↑1.2k ↓34$/);

    renders = 0;
    updateWidget(ctx, [
      thread("/done", {
        state: "completed",
        startedAt: 1,
        elapsedMs: 9_000,
        inputTokens: 1_500_000,
      }),
    ]);
    assert.match(line(), /9s ↑1.5m ↓0$/);
    t.mock.timers.tick(5000);
    assert.equal(renders, 0);
    assert.equal(unrefs, 2);

    updateWidget(
      {
        hasUI: false,
        ui: {
          setWidget() {
            throw new Error("no ui");
          },
        },
      } as unknown as ExtensionContext,
      [thread("/hidden", { state: "running", startedAt: 1_000_000 })],
    );
    t.mock.timers.tick(2000);
    assert.equal(renders, 0);
  } finally {
    globalThis.setInterval = intervals;
    t.mock.timers.reset();
  }
});

test("color picker badges are backgrounds, preview the example task path, and cancel keeps success", async () => {
  const { root, store, agentDir } = await workerWithSuccess();
  const theme = darkTheme;
  try {
    const original = await readFile(join(agentDir, "agents", "worker.md"), "utf8");
    assert.match(original, /color: success/);
    const { ctx } = editorContext(root, ["worker", "name", "color", undefined], ["scout"]);
    const pickerError = driveColorPicker(ctx, theme, (component) => {
      const items = component.getItems();
      const fallback = items.find((item: { value: string }) => item.value === "__default__");
      assert.ok(fallback);
      assert.equal(fallback.label, "Default (inherit)");
      assert.equal(fallback.description, "Use the default accent background for the type pill");
      assert.doesNotMatch(fallback.description, /foreground/i);
      for (const color of AGENT_COLORS) {
        const item = items.find((entry: { value: string }) => entry.value === color);
        assert.ok(item, color);
        assert.equal(item.label, expectedBadge(theme, color, color));
        assert.equal(stripTerminalSequences(item.label), ` ${color} `);
        assert.match(item.label, /\x1b\[1m/);
        assert.equal(item.description, `Type pill background: ${color}`);
        assert.doesNotMatch(item.description, /foreground/i);
        assert.doesNotMatch(item.label, /●/);
      }
      const selected = component.getSelectList().getSelectedItem();
      assert.equal(selected?.value, "success");
      assertColorPreview(previewText(component), theme, "scout", "success");
      assert.doesNotMatch(previewText(component), /\/worker/);

      component.handleInput("\x1b[B");
      assert.equal(component.getSelectList().getSelectedItem()?.value, "error");
      assertColorPreview(previewText(component), theme, "scout", "error");

      component.handleInput("\x1b[A");
      assert.equal(component.getSelectList().getSelectedItem()?.value, "success");
      for (
        let step = 0;
        step < AGENT_COLORS.length &&
        component.getSelectList().getSelectedItem()?.value !== "__default__";
        step++
      ) {
        component.handleInput("\x1b[A");
      }
      assert.equal(component.getSelectList().getSelectedItem()?.value, "__default__");
      assertColorPreview(previewText(component), theme, "scout", undefined);
      component.handleInput("\x1b");
    });
    await editAgentTypes(ctx, store);
    pickerError();
    assert.equal(store.get("worker").color, "success");
    assert.equal(store.get("worker").name, "worker");
    assert.equal(await readFile(join(agentDir, "agents", "worker.md"), "utf8"), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("color picker default unsets a configured success color", async () => {
  const { root, store, agentDir } = await workerWithSuccess();
  const theme = lightTheme;
  try {
    assert.equal(store.get("worker").color, "success");
    const { ctx } = editorContext(root, ["worker", "color", "Save", "Global", undefined]);
    const pickerError = driveColorPicker(ctx, theme, (component) => {
      assert.equal(component.getSelectList().getSelectedItem()?.value, "success");
      assertColorPreview(previewText(component), theme, "worker", "success");
      for (
        let step = 0;
        step < AGENT_COLORS.length &&
        component.getSelectList().getSelectedItem()?.value !== "__default__";
        step++
      ) {
        component.handleInput("\x1b[A");
      }
      assert.equal(component.getSelectList().getSelectedItem()?.value, "__default__");
      assertColorPreview(previewText(component), theme, "worker", undefined);
      const accent = contrastChannel(theme.colors.accent);
      assert.ok(
        previewText(component).includes(
          foregroundAnsi(rgbColor(accent, accent, accent), theme.getColorMode()),
        ),
      );
      component.handleInput("\r");
    });
    const original = await readFile(join(agentDir, "agents", "worker.md"), "utf8");
    assert.match(original, /color: success/);
    await editAgentTypes(ctx, store);
    pickerError();
    const saved = store.get("worker");
    assert.equal(saved.color, undefined);
    assert.ok(saved.filePath);
    assert.doesNotMatch(await readFile(saved.filePath, "utf8"), /^color:/m);
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
        "tools.allow",
        "Enter exact tool names",
        "Save",
        undefined,
        "Cancel",
        undefined,
      ],
      ["../escape", "read, read"],
    );
    await editAgentTypes(ctx, store);
    assert.equal(store.get("worker").systemPrompt, body);
    assert.equal(store.get("worker").model, undefined);
    assert.equal(store.get("worker").tools, undefined);
    assert.equal(diagnostics.length, 2);
    assert.deepEqual(scopes, [["Global"]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("editing a noncanonical filename copies into preferred storage and keeps the original file", async () => {
  const { root, store, agentDir, body } = await configFixture("custom.md");
  try {
    const { ctx } = editorContext(
      root,
      ["worker", "description", "Save", "Global", undefined],
      ["Revised"],
    );
    await editAgentTypes(ctx, store);
    assert.deepEqual(await readdir(join(agentDir, "agents")), ["custom.md"]);
    assert.deepEqual(await readdir(join(agentDir, "subagent-manager", "agents")), ["worker.md"]);
    const saved = store.get("worker");
    assert.equal(saved.description, "Revised");
    assert.equal(saved.filePath, join(agentDir, "subagent-manager", "agents", "worker.md"));
    assert.equal(saved.systemPrompt, body);
    assert.match(await readFile(saved.filePath!, "utf8"), /description: Revised/);
    assert.match(
      await readFile(join(agentDir, "agents", "custom.md"), "utf8"),
      /description: Worker/,
    );
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

const EDIT_ACTIONS = [
  "Edit frontmatter YAML",
  "External editor (entire Markdown)",
  "Save",
  "Cancel",
] as const;

function unsavedMenus(menus: { title: string; options: string[] }[]) {
  return menus.filter((menu) => /^Edit .+ \(unsaved\)$/.test(menu.title));
}

test("edit menu shows current values, ordered models, legacy scalars, and tool policy states", async () => {
  const { root, store, agentDir, body } = await configFixture();
  try {
    const hostile = "Worker\x1b[31mred\x1b[0m\x1b]0;owned\x07\r\nnext";
    await writeFile(
      join(agentDir, "agents", "worker.md"),
      serializeAgentType({
        name: "worker",
        description: hostile,
        systemPrompt: body,
        models: ["openai/gpt-4.1", "anthropic/claude-3.7-sonnet"],
        thinkingLevel: "high",
        color: "success",
        tools: { allow: ["bash", "read"], block: ["edit"] },
      }),
    );
    await writeFile(
      join(agentDir, "agents", "legacy.md"),
      `---\nname: legacy\ndescription: Legacy scalar\nmodel: google/gemini-2.5-pro\n---\n${body}`,
    );
    await writeFile(
      join(agentDir, "agents", "empty.md"),
      serializeAgentType({
        name: "empty",
        description: "Explicit empty tools",
        systemPrompt: body,
        tools: { allow: [], block: [] },
      }),
    );
    store.reload();
    const { ctx, menus } = editorContext(root, [
      "worker",
      "Cancel",
      "legacy",
      "Cancel",
      "empty",
      "Cancel",
      undefined,
    ]);
    await editAgentTypes(ctx, store);
    const editMenus = unsavedMenus(menus);
    assert.equal(editMenus.length, 3);
    assert.equal(editMenus[0]!.title, "Edit worker (unsaved)");
    assert.deepEqual(editMenus[0]!.options, [
      "name: worker",
      `description: ${sanitizeText(hostile)}`,
      "models: openai/gpt-4.1, anthropic/claude-3.7-sonnet",
      "thinkingLevel: high",
      "tools.allow: bash, read",
      "tools.block: edit",
      "color: success",
      ...EDIT_ACTIONS,
    ]);
    assert.notEqual(sanitizeText(hostile), hostile);
    assert.ok(editMenus[0]!.options.every((option) => !/[\x00-\x1f\x7f-\x9f]/.test(option)));
    assert.equal(editMenus[1]!.title, "Edit legacy (unsaved)");
    assert.deepEqual(editMenus[1]!.options, [
      "name: legacy",
      "description: Legacy scalar",
      "models: google/gemini-2.5-pro",
      "thinkingLevel: Default (inherit)",
      "tools.allow: Unset (use default policy)",
      "tools.block: Unset (use default policy)",
      "color: Default (inherit)",
      ...EDIT_ACTIONS,
    ]);
    assert.ok(
      editMenus[1]!.options
        .filter((option) => option.startsWith("tools."))
        .every((option) => !/inherit/.test(option)),
    );
    assert.equal(editMenus[2]!.title, "Edit empty (unsaved)");
    assert.deepEqual(editMenus[2]!.options, [
      "name: empty",
      "description: Explicit empty tools",
      "models: Default (inherit)",
      "thinkingLevel: Default (inherit)",
      "tools.allow: Empty list",
      "tools.block: Empty list",
      "color: Default (inherit)",
      ...EDIT_ACTIONS,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("field editor prefills current values and cancelled or invalid edits keep the visible draft", async () => {
  const { root, store, agentDir, body } = await configFixture();
  try {
    await writeFile(
      join(agentDir, "agents", "worker.md"),
      serializeAgentType({
        name: "worker",
        description: "Worker",
        systemPrompt: body,
        tools: { allow: ["read"], block: ["bash"] },
      }),
    );
    store.reload();
    const { ctx, menus, editors, diagnostics } = editorContext(
      root,
      [
        "worker",
        "name",
        "name",
        "description",
        "tools.allow",
        "Enter exact tool names",
        "tools.block",
        "Enter exact tool names",
        "tools.allow",
        "Enter exact tool names",
        "name",
        "Cancel",
        undefined,
      ],
      ["renamed", undefined, "", "bash, edit", undefined, "read, read", "../escape"],
    );
    await editAgentTypes(ctx, store);
    const editMenus = unsavedMenus(menus);
    assert.equal(editMenus[0]!.title, "Edit worker (unsaved)");
    assert.deepEqual(editMenus[0]!.options, [
      "name: worker",
      "description: Worker",
      "models: Default (inherit)",
      "thinkingLevel: Default (inherit)",
      "tools.allow: read",
      "tools.block: bash",
      "color: Default (inherit)",
      ...EDIT_ACTIONS,
    ]);
    assert.equal(editMenus[1]!.title, "Edit renamed (unsaved)");
    assert.deepEqual(editMenus[1]!.options, [
      "name: renamed",
      "description: Worker",
      "models: Default (inherit)",
      "thinkingLevel: Default (inherit)",
      "tools.allow: read",
      "tools.block: bash",
      "color: Default (inherit)",
      ...EDIT_ACTIONS,
    ]);
    assert.deepEqual(editMenus[2]!.options, editMenus[1]!.options);
    assert.deepEqual(editMenus[3]!.options, editMenus[1]!.options);
    assert.equal(editMenus[4]!.title, "Edit renamed (unsaved)");
    assert.deepEqual(editMenus[4]!.options, [
      "name: renamed",
      "description: Worker",
      "models: Default (inherit)",
      "thinkingLevel: Default (inherit)",
      "tools.allow: bash, edit",
      "tools.block: bash",
      "color: Default (inherit)",
      ...EDIT_ACTIONS,
    ]);
    assert.deepEqual(editMenus[5]!.options, editMenus[4]!.options);
    assert.deepEqual(editMenus[6]!.options, editMenus[4]!.options);
    assert.deepEqual(editMenus[7]!.options, editMenus[4]!.options);
    assert.equal(editMenus.length, 8);
    assert.deepEqual(editors, [
      { title: "Agent name", prefill: "worker" },
      { title: "Agent name", prefill: "renamed" },
      { title: "Agent description", prefill: "Worker" },
      { title: "tools.allow: comma-separated exact names", prefill: "read" },
      { title: "tools.block: comma-separated exact names", prefill: "bash" },
      { title: "tools.allow: comma-separated exact names", prefill: "bash, edit" },
      { title: "Agent name", prefill: "renamed" },
    ]);
    assert.equal(diagnostics.length, 3);
    assert.equal(store.get("worker").name, "worker");
    assert.deepEqual(store.get("worker").tools, { allow: ["read"], block: ["bash"] });
    assert.equal(store.get("worker").systemPrompt, body);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("description editor prefills safe text and unchanged submits keep the original", async () => {
  const { root, store, agentDir, body } = await configFixture();
  try {
    const hostile = "  keep\x1b[31mred\x1b[0m\x1b]0;owned\x07\r\n\tline\rrest\ntab\there  ";
    const prefill = hostile
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .map(sanitizeText)
      .join("\n");
    await writeFile(
      join(agentDir, "agents", "worker.md"),
      serializeAgentType({
        name: "worker",
        description: hostile,
        systemPrompt: body,
      }),
    );
    await writeFile(
      join(agentDir, "agents", "empty.md"),
      serializeAgentType({
        name: "empty",
        description: "Explicit empty tools",
        systemPrompt: body,
        tools: { allow: [], block: [] },
      }),
    );
    store.reload();
    const unchanged = editorContext(
      root,
      [
        "worker",
        "description",
        "description",
        "description",
        "tools.allow",
        undefined,
        "tools.block",
        undefined,
        "Save",
        "Global",
        "empty",
        "tools.allow",
        undefined,
        "tools.block",
        undefined,
        "Cancel",
        undefined,
      ],
      [undefined, prefill, prefill.trim()],
    );
    await editAgentTypes(unchanged.ctx, store);
    const descriptionLabel = `description: ${sanitizeText(hostile)}`;
    const workerMenus = unsavedMenus(unchanged.menus).filter((menu) =>
      menu.title.startsWith("Edit worker"),
    );
    assert.equal(workerMenus.length, 6);
    assert.ok(workerMenus.every((menu) => menu.options.includes(descriptionLabel)));
    assert.deepEqual(
      unchanged.editors.map((call) => call.prefill),
      [prefill, prefill, prefill],
    );
    for (const call of unchanged.editors) {
      assert.equal(call.title, "Agent description");
      assert.notEqual(call.prefill, hostile);
      assert.match(call.prefill ?? "", /\n/);
      assert.ok(!/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(call.prefill ?? ""));
      assert.ok(!call.prefill?.includes("\x1b"));
    }
    const saved = store.get("worker");
    assert.equal(saved.description, hostile);
    assert.equal(parseAgentType(await readFile(saved.filePath!, "utf8")).description, hostile);
    assert.equal(saved.systemPrompt, body);
    const toolTitles = unchanged.menus
      .filter((menu) => menu.title.startsWith("tools."))
      .map((menu) => menu.title);
    assert.deepEqual(toolTitles, [
      "tools.allow (Unset (use default policy))",
      "tools.block (Unset (use default policy))",
      "tools.allow (Empty list)",
      "tools.block (Empty list)",
    ]);
    assert.ok(
      unchanged.menus
        .filter((menu) => menu.title.startsWith("tools."))
        .every(
          (menu) =>
            !/[\x00-\x1f\x7f-\x9f]/.test(menu.title) &&
            menu.options.includes("Unset (use default policy)") &&
            menu.options.includes("Empty list"),
        ),
    );

    const changed = editorContext(
      root,
      ["worker", "description", "Save", "Global", undefined],
      ["Revised notes"],
    );
    await editAgentTypes(changed.ctx, store);
    const changedMenus = unsavedMenus(changed.menus);
    assert.equal(changed.editors[0]?.prefill, prefill);
    assert.ok(changedMenus[1]!.options.includes("description: Revised notes"));
    assert.equal(store.get("worker").description, "Revised notes");
    assert.equal(store.get("worker").systemPrompt, body);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
