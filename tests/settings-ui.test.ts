import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { ConfigStore } from "../src/config.ts";
import { configureAgents } from "../src/settings-ui.ts";
import {
  DEFAULT_MANAGER_SETTINGS,
  loadManagerSettings,
  type ManagerSettings,
} from "../src/settings.ts";
import { createDialogDriver } from "./helpers/dialogDriver.ts";

const theme = { fg: (_color: string, text: string) => text } as Theme;

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-settings-ui-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new ConfigStore({
    cwd: root,
    agentDir: root,
    includeProject: false,
  });
  return { root, store };
}

function context(root: string, actions: (string | undefined)[]) {
  const notifications: string[] = [];
  const menus: {
    title: string;
    rows: { id: string; label: string; value?: string }[];
  }[] = [];
  const driver = createDialogDriver({
    theme,
    width: 80,
    choices: actions,
    unified: true,
    onMenu(menu) {
      menus.push({
        title: menu.title,
        rows: menu.rows.map((row) => ({
          id: row.id,
          label: row.label,
          value: row.value,
        })),
      });
    },
  });
  const ctx = {
    cwd: root,
    hasUI: true,
    mode: "tui",
    isProjectTrusted: () => false,
    ui: {
      notify: (message: string) => notifications.push(message),
      custom: driver.custom,
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notifications, menus };
}

function filteringRow(
  menus: { rows: { id: string; label: string; value?: string }[] }[],
  index: number,
) {
  const row = menus[index]?.rows.find((entry) => entry.id === "scopedModelFiltering");
  assert.ok(row, `menu ${index} missing scopedModelFiltering`);
  return row;
}

async function open(
  t: TestContext,
  actions: (string | undefined)[],
  settings: ManagerSettings = { ...DEFAULT_MANAGER_SETTINGS },
) {
  const { root, store } = fixture(t);
  const { ctx, notifications, menus } = context(root, actions);
  let applied = 0;
  await configureAgents(ctx, {
    store,
    agentDir: root,
    settings,
    apply: () => {
      applied++;
    },
  });
  const loaded = loadManagerSettings({
    cwd: root,
    agentDir: root,
    includeProject: false,
  });
  return {
    root,
    applied,
    notifications,
    menus,
    loaded,
    file: join(root, "subagent-manager", "settings.json"),
  };
}

test("scoped model filtering is a separate on/off draft toggle", async (t) => {
  const result = await open(t, ["scopedModelFiltering", "maxLevels", "4", "cancel"]);
  assert.equal(result.applied, 0);
  assert.equal(existsSync(result.file), false);
  assert.deepEqual(result.loaded.settings, DEFAULT_MANAGER_SETTINGS);
  assert.deepEqual(
    result.notifications.filter((message) => /positive|integer|at most/i.test(message)),
    [],
  );
  assert.equal(filteringRow(result.menus, 0).label, "Scoped model filtering");
  assert.equal(filteringRow(result.menus, 0).value, "on");
  assert.equal(filteringRow(result.menus, 1).value, "off");
  assert.match(result.menus[1]?.title ?? "", /unsaved/);
  assert.equal(
    result.menus[1]?.rows.find((row) => row.id === "maxLevels")?.value,
    String(DEFAULT_MANAGER_SETTINGS.maxLevels),
  );
  assert.equal(result.menus[2]?.rows.find((row) => row.id === "maxLevels")?.value, "4");
  assert.equal(filteringRow(result.menus, 2).value, "off");
});

test("toggle saves through the existing callback and persists false", async (t) => {
  const result = await open(t, ["scopedModelFiltering", "save"]);
  assert.equal(result.applied, 1);
  assert.equal(result.loaded.settings.scopedModelFiltering, false);
  assert.equal(result.loaded.settings.maxLevels, DEFAULT_MANAGER_SETTINGS.maxLevels);
  assert.equal(result.loaded.diagnostics.length, 0);
  assert.match(readFileSync(result.file, "utf8"), /"scopedModelFiltering": false/);
  assert.equal(
    result.notifications.some((message) => message.includes(result.file)),
    true,
  );
});

test("a second toggle and restore defaults reset the draft to true", async (t) => {
  const toggled = await open(t, ["scopedModelFiltering", "scopedModelFiltering", "save"]);
  assert.equal(toggled.applied, 1);
  assert.equal(toggled.loaded.settings.scopedModelFiltering, true);

  const restored = await open(t, ["defaults", "save"], {
    ...DEFAULT_MANAGER_SETTINGS,
    scopedModelFiltering: false,
    maxLevels: 9,
  });
  assert.equal(restored.applied, 1);
  assert.deepEqual(restored.loaded.settings, DEFAULT_MANAGER_SETTINGS);
  assert.equal(restored.loaded.settings.scopedModelFiltering, true);
  assert.equal(filteringRow(restored.menus, 0).value, "off");
  assert.equal(filteringRow(restored.menus, 1).value, "on");
});

test("cancel discards a filtering toggle and save writes the complete default draft", async (t) => {
  const canceled = await open(t, ["scopedModelFiltering", undefined]);
  assert.equal(canceled.applied, 0);
  assert.equal(existsSync(canceled.file), false);
  assert.equal(canceled.loaded.settings.scopedModelFiltering, true);

  const saved = await open(t, ["save"]);
  assert.equal(saved.applied, 1);
  assert.deepEqual(saved.loaded.settings, DEFAULT_MANAGER_SETTINGS);
  assert.match(readFileSync(saved.file, "utf8"), /"scopedModelFiltering": true/);
});
