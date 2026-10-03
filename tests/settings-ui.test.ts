import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { ConfigStore } from "../src/config.ts";
import { dialogHeight, type DialogRow } from "../src/dialog.ts";
import { configureAgents } from "../src/settings-ui.ts";
import {
  DEFAULT_MANAGER_SETTINGS,
  loadManagerSettings,
  type ManagerSettings,
} from "../src/settings.ts";
import { createDialogDriver } from "./helpers/dialogDriver.ts";

const theme = { fg: (_color: string, text: string) => text } as Theme;
type Menu = { title: string; rows: DialogRow[] };

/** Runs configureAgents with scripted menu/input choices and reports what reached disk. */
async function run(
  t: TestContext,
  actions: (string | undefined)[],
  { settings = DEFAULT_MANAGER_SETTINGS, trusted = false, width = 80 } = {} as {
    settings?: ManagerSettings;
    trusted?: boolean;
    width?: number;
  },
) {
  const root = mkdtempSync(join(tmpdir(), "pi-settings-ui-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const notifications: string[] = [];
  const menus: Menu[] = [];
  const driver = createDialogDriver({
    theme,
    width,
    choices: actions,
    unified: true,
    assertBorder: true,
    onOpen: (options) => assert.equal((options as { overlay?: boolean }).overlay, true),
    onMenu: (menu) =>
      menus.push({
        title: menu.title,
        rows: menu.rows.map((row) => ({ ...row })),
      }),
  });
  const ctx = {
    cwd: root,
    hasUI: true,
    mode: "tui",
    isProjectTrusted: () => trusted,
    ui: { notify: (message: string) => notifications.push(message), custom: driver.custom },
  } as unknown as ExtensionCommandContext;
  let applied = 0;
  await configureAgents(ctx, {
    store: new ConfigStore({ cwd: root, agentDir: root, includeProject: false }),
    agentDir: root,
    settings: { ...settings },
    apply: () => applied++,
  });
  // Every settings flow stays inside one outer overlay with a fixed frame height.
  assert.equal(driver.stats.outerOpens, 1);
  assert.equal(driver.stats.outerCompletions, 1);
  assert.equal(driver.stats.forcedRenders, 0);
  const height = dialogHeight({ requestRender() {}, terminal: { rows: 24 } });
  assert.ok(driver.stats.frameHeights.every((frame) => frame === height));
  const value = (menu: number, id: string) => menus[menu]?.rows.find((row) => row.id === id)?.value;
  return {
    applied,
    notifications,
    menus,
    renders: driver.renders,
    value,
    loaded: loadManagerSettings({ cwd: root, agentDir: root, includeProject: true }),
    userFile: join(root, "subagent-manager", "settings.json"),
    projectFile: join(root, ".pi", "agent", "subagent-manager", "settings.json"),
  };
}

test("invalid numbers are rejected in place and valid edits save once to the user scope", async (t) => {
  const result = await run(t, ["maxLevels", "33", "maxLevels", "0", "maxLevels", "5", "save"]);
  assert.equal(result.applied, 1);
  assert.equal(result.loaded.settings.maxLevels, 5);
  assert.equal(result.notifications.filter((message) => message.includes("at most 32")).length, 2);
  assert.ok(result.notifications.some((message) => message.includes(result.userFile)));
  assert.equal(existsSync(result.projectFile), false);
});

test("mode settings explain all choices and selecting each mode saves it", async (t) => {
  for (const [mode, label] of [
    ["off", "Off"],
    ["opportunistic", "Opportunistic"],
    ["orchestration", "Orchestration"],
  ]) {
    const result = await run(t, ["subagentMode", mode, "save"]);
    const field = result.menus[0]!.rows.find((row) => row.id === "subagentMode")!;
    assert.equal(field.label, "Subagent Mode");
    assert.equal(field.value, "Opportunistic");
    assert.match(field.help ?? "", /Off: no subagent tools or prompt guidance/);
    assert.match(field.help ?? "", /Opportunistic: delegate only parallelizable or very large tasks/);
    assert.match(field.help ?? "", /Orchestration: \/root delegates all execution/);
    const chooser = result.menus[1]!;
    assert.equal(chooser.title, "Subagent Mode");
    assert.deepEqual(chooser.rows.map((row) => row.id), ["off", "opportunistic", "orchestration"]);
    assert.ok(chooser.rows.every((row) => row.value && row.help));
    assert.match(chooser.rows[2]!.help ?? "", /not inherited by workers/);
    assert.equal(result.value(2, "subagentMode"), label);
    assert.equal(result.applied, 1);
    assert.equal(result.loaded.settings.subagentMode, mode);
    assert.equal(result.loaded.diagnostics.length, 0);
    assert.equal(JSON.parse(readFileSync(result.userFile, "utf8")).subagentMode, mode);
  }
});

test("mode selection and chooser cancellation remain draft-only", async (t) => {
  const canceled = await run(t, ["subagentMode", "off", "cancel"]);
  assert.equal(canceled.value(2, "subagentMode"), "Off");
  assert.match(canceled.menus[2]!.title, /unsaved/);
  assert.equal(canceled.applied, 0);
  assert.equal(existsSync(canceled.userFile), false);
  assert.deepEqual(canceled.loaded.settings, DEFAULT_MANAGER_SETTINGS);

  const escaped = await run(t, ["subagentMode", undefined, "save"]);
  assert.equal(escaped.value(2, "subagentMode"), "Opportunistic");
  assert.doesNotMatch(escaped.menus[2]!.title, /unsaved/);
  assert.equal(escaped.loaded.settings.subagentMode, "opportunistic");
});

for (const width of [32, 80]) {
  test(`mode screen and chooser render bordered frames at width ${width}`, async (t) => {
    const result = await run(t, ["subagentMode", "orchestration", "cancel"], { width });
    assert.ok(result.renders.every((lines) =>
      lines[0]!.includes("Subagent Mode") || lines[0]!.includes("Agents settings"),
    ));
    // The shared two-column menu clips labels at narrow widths; the selected
    // mode's full name remains visible in its help and in the settings value.
    assert.ok(result.renders[1]!.join("\n").includes(width === 32 ? "Orchestra" : "Orchestration"));
    assert.ok(result.renders[1]!.join("\n").includes("Opportunistic:"));
    assert.ok(result.renders[2]!.join("\n").includes("Orchestration"));
    assert.ok(result.renders[0]!.join("\n").includes("Off:"));
    assert.ok(result.renders[0]!.join("\n").includes("Opportunistic:"));
    assert.ok(result.renders[0]!.join("\n").includes("Orchestration:"));
  });
}

test("filtering toggle and other edits are draft-only until save", async (t) => {
  const canceled = await run(t, ["scopedModelFiltering", "maxLevels", "4", "cancel"]);
  assert.equal(canceled.applied, 0);
  assert.equal(existsSync(canceled.userFile), false);
  assert.deepEqual(canceled.loaded.settings, DEFAULT_MANAGER_SETTINGS);
  assert.equal(canceled.value(0, "scopedModelFiltering"), "on");
  assert.equal(canceled.value(1, "scopedModelFiltering"), "off");
  assert.match(canceled.menus[1]?.title ?? "", /unsaved/);
  assert.equal(canceled.value(2, "maxLevels"), "4");

  const escaped = await run(t, ["scopedModelFiltering", undefined]);
  assert.equal(escaped.applied, 0);
  assert.equal(existsSync(escaped.userFile), false);

  const saved = await run(t, ["scopedModelFiltering", "save"]);
  assert.equal(saved.applied, 1);
  assert.equal(saved.loaded.settings.scopedModelFiltering, false);
  assert.equal(saved.loaded.diagnostics.length, 0);
  assert.match(readFileSync(saved.userFile, "utf8"), /"scopedModelFiltering": false/);
});

test("save shows a warning-colored changes prefix only while the draft is dirty", async (t) => {
  const result = await run(t, [
    "scopedModelFiltering", "scopedModelFiltering", "maxLevels", "5", "defaults", "cancel",
  ]);
  const prefix = (index: number) => result.menus[index]?.rows.find((row) => row.id === "save")?.labelPrefix;
  assert.equal(prefix(0), undefined);
  assert.deepEqual(prefix(1), { text: "(changes)", color: "warning" });
  assert.equal(prefix(2), undefined, "reverting a toggle clears the indicator");
  assert.deepEqual(prefix(3), { text: "(changes)", color: "warning" });
  assert.equal(prefix(4), undefined, "restoring the original defaults clears the indicator");
});

test("scope help explains the destination and precedence without changing the draft", async (t) => {
  const result = await run(t, ["maxLevels", "5", "scope", "scope", "cancel"], { trusted: true });
  const scope = (index: number) => result.menus[index]?.rows.find((row) => row.id === "scope");
  assert.match(scope(0)?.help ?? "", /this project only, overriding your global defaults/);
  assert.match(scope(2)?.help ?? "", /defaults for every project/);
  assert.match(scope(2)?.help ?? "", /trusted-project settings still override/);
  for (const index of [1, 2, 3]) {
    assert.match(scope(index)?.help ?? "", /only changes where you save, not the values shown/);
    assert.equal(result.value(index, "maxLevels"), "5");
  }
});

test("restore defaults resets the whole draft before save", async (t) => {
  const result = await run(t, ["defaults", "save"], {
    settings: {
      ...DEFAULT_MANAGER_SETTINGS,
      subagentMode: "orchestration",
      scopedModelFiltering: false,
      maxLevels: 9,
    },
  });
  assert.equal(result.applied, 1);
  assert.equal(result.value(1, "scopedModelFiltering"), "on");
  assert.equal(result.value(1, "subagentMode"), "Opportunistic");
  assert.deepEqual(result.loaded.settings, DEFAULT_MANAGER_SETTINGS);
  assert.match(readFileSync(result.userFile, "utf8"), /"scopedModelFiltering": true/);
});

test("project scope requires trust; trusted projects save to the project file", async (t) => {
  const untrusted = await run(t, ["scope", "maxThreads", "2", undefined]);
  assert.equal(untrusted.applied, 0);
  assert.ok(untrusted.notifications.some((message) => message.includes("trusted project")));
  assert.deepEqual(untrusted.loaded.settings, DEFAULT_MANAGER_SETTINGS);

  const trusted = await run(t, ["subagentMode", "off", "maxThreads", "9", "save"], { trusted: true });
  assert.equal(trusted.applied, 1);
  assert.equal(trusted.loaded.settings.maxThreads, 9);
  assert.equal(trusted.loaded.settings.subagentMode, "off");
  assert.equal(existsSync(trusted.projectFile), true);
  assert.equal(existsSync(trusted.userFile), false);

  const toggled = await run(t, ["scope", "save"], { trusted: true });
  assert.equal(toggled.value(0, "scope"), "Trusted project");
  assert.equal(toggled.value(1, "scope"), "Global");
  assert.equal(existsSync(toggled.userFile), true);
  assert.equal(existsSync(toggled.projectFile), false);
});
