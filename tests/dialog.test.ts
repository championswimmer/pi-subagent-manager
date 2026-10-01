import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type {
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { ConfigStore } from "../src/config.ts";
import {
  DialogEditor,
  DialogMenu,
  dialogHeight,
  frameDialog,
} from "../src/dialog.ts";
import { configureAgents } from "../src/settings-ui.ts";
import {
  DEFAULT_MANAGER_SETTINGS,
  loadManagerSettings,
} from "../src/settings.ts";
import {
  bindDialogDriver,
  createDialogDriver,
} from "./helpers/dialogDriver.ts";

const theme = { fg: (_color: string, text: string) => text } as Theme;

test("dialog frame has full borders, title and footer within terminal budgets", () => {
  for (const width of [0, 1, 3, 4, 20, 80]) {
    for (const height of [1, 4, 10]) {
      const lines = frameDialog(
        theme,
        width,
        height,
        "Agents 界\x1b]0;bad\x07",
        Array(30).fill("界".repeat(100)),
        "Esc close",
      );
      assert.ok(lines.length <= height);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.ok(!lines.join("").includes("\x1b]0;bad"));
      if (width >= 4 && height >= 4) {
        const plain = lines.map(stripTerminalSequences);
        assert.match(plain[0]!, /^╭.*╮$/);
        assert.match(plain.at(-1)!, /^╰.*╯$/);
        assert.ok(
          plain.slice(1, -2).every((line) => /^│.*│$|^├.*┤$/.test(line)),
        );
      }
    }
  }
  assert.equal(
    dialogHeight({ requestRender() {}, terminal: { rows: 24 } }),
    21,
  );
});

test("two-column menu scrolls, restores selection, supports keyboard and preserves footer", () => {
  let selected: string | undefined;
  const rows = Array.from({ length: 30 }, (_, i) => ({
    id: String(i),
    label: `Field ${i}`,
    value: `Value 界 ${i}`,
    help: "Help",
  }));
  const host = { requestRender() {}, terminal: { rows: 12 } };
  const menu = new DialogMenu(
    host,
    theme,
    "Settings",
    rows,
    (id) => {
      selected = id;
    },
    "20",
    "Enter edit · Esc close",
    "save",
  );
  assert.equal(menu.getSelectedId(), "20");
  let lines = menu.render(80);
  assert.ok(lines.join("\n").includes("Field 20"));
  assert.ok(lines.join("\n").includes("│ Value"));
  assert.ok(lines.join("\n").includes("Esc close"));
  menu.handleInput("\x1b[B");
  assert.equal(menu.getSelectedId(), "21");
  menu.handleInput("\r");
  assert.equal(selected, "21");
  menu.handleInput("\x13");
  assert.equal(selected, "save");
  menu.handleInput("\x1b");
  assert.equal(selected, undefined);
  for (const width of [1, 10, 40, 100]) {
    lines = menu.render(width);
    assert.ok(lines.length <= dialogHeight(host));
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
});

test("multiline dialog forwards focus, keeps cursor visible, applies with Ctrl+S and cancels", () => {
  const host = { requestRender() {}, terminal: { rows: 12 } };
  let applied: string | undefined;
  const initial =
    "first\nsecond\nthird\nfourth\nfifth\nsixth\nseventh\neighth\nninth\ntenth";
  const component = new DialogEditor(
    host,
    theme,
    "System prompt",
    initial,
    (value) => {
      applied = value;
    },
  );
  component.focused = true;
  assert.equal(component.getEditor().focused, true);
  component.handleInput("\x1b[B");
  component.handleInput("\r");
  assert.equal(
    applied,
    undefined,
    "Enter inserts a newline rather than submitting",
  );
  component.handleInput("\x1b[F");
  for (const width of [1, 3, 10, 40, 100]) {
    const lines = component.render(width);
    assert.ok(lines.length <= dialogHeight(host));
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    if (width >= 40) {
      assert.match(stripTerminalSequences(lines.at(-1)!), /^╰.*╯$/);
      assert.match(lines.join("\n"), /Ctrl\+S apply/);
      assert.ok(
        lines.some((line) => line.includes(CURSOR_MARKER)),
        "visible cursor survives cropping and framing",
      );
    }
  }
  component.handleInput("\x13");
  assert.equal(applied, component.getEditor().getText());
  component.handleInput("\x1b");
  assert.equal(applied, undefined);
});

test("multiline dialog strips control sequences before render and preserves unchanged prefill", () => {
  const host = { requestRender() {}, terminal: { rows: 24 } };
  let value: string | undefined;
  const initial = "hello\tworld\r\n\x1b]0;injected\x07second\x00line";
  const component = new DialogEditor(
    host,
    theme,
    "Prompt",
    initial,
    (result) => {
      value = result;
    },
  );
  assert.ok(!component.getEditor().getText().includes("\x1b"));
  assert.ok(!component.render(80).join("\n").includes("injected"));
  component.handleInput("\x13");
  assert.equal(value, initial);
});

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-dialog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new ConfigStore({
    cwd: root,
    agentDir: root,
    includeProject: false,
  });
  return { root, store };
}

function context(
  root: string,
  actions: (string | undefined)[],
  trusted = false,
) {
  const notifications: string[] = [];
  const titles: string[] = [];
  const driver = createDialogDriver({
    theme,
    width: 80,
    choices: actions,
    unified: true,
    assertBorder: true,
    onOpen(options) {
      assert.equal(
        (options as { overlay?: boolean } | undefined)?.overlay,
        true,
      );
    },
    onFrame(_component, lines) {
      titles.push(lines[0] ?? "");
    },
  });
  const ctx = {
    cwd: root,
    hasUI: true,
    mode: "tui",
    isProjectTrusted: () => trusted,
    ui: {
      notify: (message: string) => notifications.push(message),
      custom: driver.custom,
    },
  } as unknown as ExtensionCommandContext;
  bindDialogDriver(ctx, driver);
  return { ctx, notifications, titles, driver };
}

test("settings save applies once, validates numbers and writes to selected scope", async (t) => {
  const { root, store } = fixture(t);
  const { ctx, notifications } = context(root, [
    "maxLevels",
    "33",
    "maxLevels",
    "5",
    "save",
  ]);
  let applied = 0;
  await configureAgents(ctx, {
    store,
    agentDir: root,
    settings: { ...DEFAULT_MANAGER_SETTINGS },
    apply: () => {
      applied++;
    },
  });
  assert.equal(applied, 1);
  assert.equal(
    loadManagerSettings({ cwd: root, agentDir: root, includeProject: false })
      .settings.maxLevels,
    5,
  );
  assert.ok(notifications.some((message) => message.includes("at most 32")));
});

test("settings cancel discards draft and project scope requires trust", async (t) => {
  const { root, store } = fixture(t);
  const { ctx, notifications } = context(root, [
    "scope",
    "maxThreads",
    "2",
    undefined,
  ]);
  let applied = 0;
  await configureAgents(ctx, {
    store,
    agentDir: root,
    settings: { ...DEFAULT_MANAGER_SETTINGS },
    apply: () => {
      applied++;
    },
  });
  assert.equal(applied, 0);
  assert.deepEqual(
    loadManagerSettings({ cwd: root, agentDir: root, includeProject: true })
      .settings,
    DEFAULT_MANAGER_SETTINGS,
  );
  assert.ok(
    notifications.some((message) => message.includes("trusted project")),
  );
});

function assertOneOverlay(
  driver: {
    stats: {
      outerOpens: number;
      outerCompletions: number;
      forcedRenders: number;
    };
  },
  label: string,
) {
  assert.equal(
    driver.stats.outerOpens,
    1,
    `${label} opened ${driver.stats.outerOpens} custom overlays`,
  );
  assert.equal(
    driver.stats.outerCompletions,
    1,
    `${label} completed ${driver.stats.outerCompletions} custom overlays`,
  );
  assert.equal(
    driver.stats.forcedRenders,
    0,
    `${label} issued ${driver.stats.forcedRenders} forced render requests`,
  );
}

test("frameDialog pads every bounded view to the same height", () => {
  const height = dialogHeight({
    requestRender() {},
    terminal: { rows: 24 },
  });
  const short = frameDialog(theme, 80, height, "Title", ["only"], "Esc");
  const tall = frameDialog(
    theme,
    80,
    height,
    "Title",
    Array.from({ length: 40 }, () => "row"),
    "Esc",
  );
  assert.equal(short.length, height);
  assert.equal(tall.length, height);
  assert.match(short.at(-1) ?? "", /^╰.*╯$/);
  assert.equal(short.at(-1), tall.at(-1));
});

test("manager numeric edits use one outer custom overlay", async (t) => {
  const { root, store } = fixture(t);
  const { ctx, driver } = context(root, ["maxLevels", "4", "save"]);
  let applied = 0;
  await configureAgents(ctx, {
    store,
    agentDir: root,
    settings: { ...DEFAULT_MANAGER_SETTINGS },
    apply: () => {
      applied++;
    },
  });
  assert.equal(applied, 1);
  assert.equal(
    loadManagerSettings({ cwd: root, agentDir: root, includeProject: false })
      .settings.maxLevels,
    4,
  );
  assertOneOverlay(driver, "numeric edits");
  assert.ok(driver.stats.frameHeights.length >= 2);
});

test("invalid then valid manager edits stay inside one overlay", async (t) => {
  const { root, store } = fixture(t);
  const { ctx, notifications, driver } = context(root, [
    "maxLevels",
    "33",
    "maxLevels",
    "5",
    "save",
  ]);
  await configureAgents(ctx, {
    store,
    agentDir: root,
    settings: { ...DEFAULT_MANAGER_SETTINGS },
    apply: () => {},
  });
  assert.ok(notifications.some((message) => message.includes("at most 32")));
  assert.equal(
    loadManagerSettings({ cwd: root, agentDir: root, includeProject: false })
      .settings.maxLevels,
    5,
  );
  assertOneOverlay(driver, "invalid then valid");
});

test("scope, defaults, and cancel stay inside one overlay", async (t) => {
  const { root, store } = fixture(t);
  const { ctx, notifications, driver } = context(
    root,
    ["scope", "defaults", "maxThreads", "9", undefined],
    true,
  );
  let applied = 0;
  await configureAgents(ctx, {
    store,
    agentDir: root,
    settings: { ...DEFAULT_MANAGER_SETTINGS, maxThreads: 4 },
    apply: () => {
      applied++;
    },
  });
  assert.equal(applied, 0);
  assert.equal(
    loadManagerSettings({ cwd: root, agentDir: root, includeProject: true })
      .settings.maxThreads,
    DEFAULT_MANAGER_SETTINGS.maxThreads,
  );
  assert.equal(
    notifications.some((message) => message.includes("trusted project")),
    false,
  );
  assertOneOverlay(driver, "scope, defaults, and cancel");
});

test("settings views keep one fixed frame height", async (t) => {
  const { root, store } = fixture(t);
  const { ctx, driver } = context(root, [
    "maxLevels",
    "6",
    "maxConcurrent",
    "2",
    "cancel",
  ]);
  await configureAgents(ctx, {
    store,
    agentDir: root,
    settings: { ...DEFAULT_MANAGER_SETTINGS },
    apply: () => {},
  });
  const height = dialogHeight({
    requestRender() {},
    terminal: { rows: 24 },
  });
  assert.ok(driver.stats.frameHeights.length >= 3);
  assert.deepEqual(
    driver.stats.frameHeights,
    driver.stats.frameHeights.map(() => height),
  );
});
