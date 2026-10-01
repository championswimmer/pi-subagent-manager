import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type {
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ConfigStore } from "../src/config.ts";
import { DialogMenu, dialogHeight, frameDialog } from "../src/dialog.ts";
import { configureAgents } from "../src/settings-ui.ts";
import {
  DEFAULT_MANAGER_SETTINGS,
  loadManagerSettings,
} from "../src/settings.ts";

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
  const ctx = {
    cwd: root,
    hasUI: true,
    mode: "tui",
    isProjectTrusted: () => trusted,
    ui: {
      notify: (message: string) => notifications.push(message),
      custom: async (factory: Function, options: any) => {
        assert.equal(options.overlay, true);
        return new Promise((resolve) => {
          const component = factory(
            { requestRender() {}, terminal: { rows: 24 } },
            theme,
            {},
            resolve,
          );
          const rendered = component.render(80);
          assert.match(rendered.at(-1), /^╰.*╯$/);
          titles.push(rendered[0]);
          resolve(actions.shift());
        });
      },
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications, titles };
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
