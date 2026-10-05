import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { ConfigStore } from "../src/prefs/config.ts";
import { dialogHeight, type DialogRow } from "../src/ui/dialog.ts";
import { configureAgents } from "../src/ui/settings-ui.ts";
import {
  DEFAULT_MANAGER_SETTINGS,
  loadManagerSettings,
  type ManagerSettings,
} from "../src/prefs/settings.ts";
import { createDialogDriver } from "./helpers/dialogDriver.ts";

const theme = { fg: (_color: string, text: string) => text } as Theme;
type Menu = { title: string; rows: DialogRow[] };

/** Runs configureAgents with scripted menu/input choices and reports what reached disk. */
async function run(
  t: TestContext,
  actions: (string | undefined)[],
  { settings = DEFAULT_MANAGER_SETTINGS, trusted = false, width = 80, root: existingRoot, agentDir: existingAgentDir } = {} as {
    settings?: ManagerSettings;
    trusted?: boolean;
    width?: number;
    root?: string;
    agentDir?: string;
  },
) {
  const root = existingRoot ?? mkdtempSync(join(tmpdir(), "pi-settings-ui-"));
  if (!existingRoot) t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = existingAgentDir ?? root;
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
    store: new ConfigStore({ cwd: root, agentDir, includeProject: false }),
    agentDir,
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
    root,
    applied,
    notifications,
    menus,
    renders: driver.renders,
    value,
    loaded: loadManagerSettings({ cwd: root, agentDir, includeProject: true }),
    userFile: join(agentDir, "subagent-manager", "settings.json"),
    projectFile: join(root, ".pi", "agent", "subagent-manager", "settings.json"),
  };
}

test("[labs] Nerd Font setting toggles, persists, and cancels without saving", async (t) => {
  const enabled = await run(t, ["nerdFontIcons", "save"]);
  const field = enabled.menus[0]!.rows.find((row) => row.id === "nerdFontIcons")!;
  assert.equal(field.label, "[labs] Nerd Font icons");
  assert.equal(field.value, "Off");
  assert.match(field.help!, /terminal/);
  assert.equal(enabled.loaded.settings.nerdFontIcons, true);
  assert.equal(enabled.applied, 1);
  const disabled = await run(t, ["nerdFontIcons", "save"], {
    settings: { ...DEFAULT_MANAGER_SETTINGS, nerdFontIcons: true },
  });
  assert.equal(disabled.loaded.settings.nerdFontIcons, false);
  const cancelled = await run(t, ["nerdFontIcons", "cancel"]);
  assert.equal(cancelled.applied, 0);
  assert.equal(existsSync(cancelled.userFile), false);
});

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
    assert.match(field.help ?? "", /^Off: no subagent tools or prompt guidance/m);
    assert.match(
      field.help ?? "",
      /^Opportunistic: delegate only parallelizable or very large tasks/m,
    );
    assert.match(field.help ?? "", /^Orchestration: \/root delegates all execution/m);
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

test("Model Picking explains and saves all three modes", async (t) => {
  for (const [mode, label] of [
    ["pick-first-available", "Pick First (available)"],
    ["pick-first-scoped", "Pick First (scoped)"],
    ["use-current", "Use Current"],
  ]) {
    const result = await run(t, ["modelSelection", mode, "save"]);
    const field = result.menus[0]!.rows.find((row) => row.id === "modelSelection")!;
    assert.equal(field.label, "Model Picking");
    assert.equal(field.value, "Pick First (scoped)");
    assert.match(field.help ?? "", /enabled, authenticated provider/);
    assert.match(field.help ?? "", /current session's \/scoped-models/);
    assert.match(field.help ?? "", /main session's current model; keep the agent's thinking level/);
    assert.match(field.help ?? "", /modelSuggestions are search hints/);
    assert.equal(result.menus[0]!.rows.some((row) => row.id === "scopedModelFiltering"), false);
    const chooser = result.menus[1]!;
    assert.equal(chooser.title, "Model Picking");
    assert.deepEqual(chooser.rows.map((row) => row.id), [
      "pick-first-available", "pick-first-scoped", "use-current",
    ]);
    assert.deepEqual(chooser.rows.map((row) => row.label), [
      "Pick First (available)", "Pick First (scoped)", "Use Current",
    ]);
    assert.ok(chooser.rows.every((row) => row.value && row.help));
    assert.match(chooser.rows[0]!.help ?? "", /models list available in Pi/);
    assert.match(chooser.rows[0]!.help ?? "", /providers without credentials; try the next preference/);
    assert.match(chooser.rows[1]!.help ?? "", /also selected in the current session's \/scoped-models/);
    assert.match(chooser.rows[2]!.help ?? "", /Ignore the agent's models list/);
    assert.match(chooser.rows[2]!.help ?? "", /each agent's configured thinking level/);
    assert.equal(result.value(2, "modelSelection"), label);
    assert.equal(result.applied, 1);
    assert.equal(result.loaded.settings.modelSelection, mode);
    assert.equal(result.loaded.diagnostics.length, 0);
    const stored = JSON.parse(readFileSync(result.userFile, "utf8"));
    assert.equal(stored.modelSelection, mode);
    assert.equal(Object.hasOwn(stored, "scopedModelFiltering"), false);
  }
});

test("Model Picking and other edits stay draft-only until save; chooser cancellation keeps the value", async (t) => {
  const canceled = await run(t, ["modelSelection", "pick-first-available", "maxLevels", "4", "cancel"]);
  assert.equal(canceled.applied, 0);
  assert.equal(existsSync(canceled.userFile), false);
  assert.deepEqual(canceled.loaded.settings, DEFAULT_MANAGER_SETTINGS);
  assert.equal(canceled.value(0, "modelSelection"), "Pick First (scoped)");
  assert.equal(canceled.value(2, "modelSelection"), "Pick First (available)");
  assert.match(canceled.menus[2]?.title ?? "", /unsaved/);
  assert.equal(canceled.value(3, "maxLevels"), "4");

  const escaped = await run(t, ["modelSelection", undefined, "save"]);
  assert.equal(escaped.value(2, "modelSelection"), "Pick First (scoped)");
  assert.doesNotMatch(escaped.menus[2]!.title, /unsaved/);
  assert.equal(escaped.loaded.settings.modelSelection, "pick-first-scoped");
});

test("Model Picking saves to a trusted project", async (t) => {
  const saved = await run(t, ["modelSelection", "use-current", "save"], { trusted: true });
  assert.equal(saved.applied, 1);
  assert.equal(saved.loaded.settings.modelSelection, "use-current");
  assert.equal(JSON.parse(readFileSync(saved.projectFile, "utf8")).modelSelection, "use-current");
  assert.equal(existsSync(saved.userFile), false);
});

test("save shows a warning-colored changes value only while the draft is dirty", async (t) => {
  const result = await run(t, [
    "modelSelection", "pick-first-available", "modelSelection", "pick-first-scoped",
    "maxLevels", "5", "defaults", "cancel",
  ]);
  const settingsMenus = result.menus.filter((menu) => menu.title.startsWith("Agents settings"));
  const save = (index: number) => settingsMenus[index]!.rows.find((row) => row.id === "save")!;
  for (const index of [0, 2, 4]) {
    assert.equal(save(index).value, undefined, "unchanged or reverted drafts clear the indicator");
    assert.equal(save(index).valueColor, undefined);
  }
  for (const index of [1, 3]) {
    assert.equal(save(index).label, "Save and apply");
    assert.equal(save(index).value, "(changes)");
    assert.equal(save(index).valueColor, "warning");
  }
});

for (const width of [32, 80]) {
  test(`Model Picking screen and chooser render bordered frames at width ${width}`, async (t) => {
    const result = await run(t, ["modelSelection", "use-current", "cancel"], { width });
    assert.ok(result.renders.every((lines) =>
      lines[0]!.includes("Model Picking") || lines[0]!.includes("Agents settings"),
    ));
    // The chooser opens on the scoped default. Narrow layouts clip labels,
    // but preserve the selected choice's help and the updated settings value.
    assert.ok(result.renders[1]!.join("\n").includes("Pick First (scoped):"));
    assert.equal(result.value(2, "modelSelection"), "Use Current");
    assert.ok(result.renders[2]!.join("\n").includes("Use Current"));
  });
}

test("scope help explains the destination and precedence without changing the draft", async (t) => {
  const result = await run(t, ["maxLevels", "5", "scope", "scope", "cancel"], { trusted: true });
  const scope = (index: number) => result.menus[index]?.rows.find((row) => row.id === "scope");
  assert.match(scope(0)?.help ?? "", /this project only, overriding your global defaults/);
  assert.match(scope(2)?.help ?? "", /defaults for every project/);
  assert.match(scope(2)?.help ?? "", /project settings still override/);
  for (const index of [0, 1, 2, 3]) {
    assert.match(scope(index)?.help ?? "", /^Global: /m);
    assert.match(scope(index)?.help ?? "", /^Current Project: /m);
  }
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
      toolFiltering: "all",
      modelSelection: "use-current",
      maxLevels: 9,
    },
  });
  assert.equal(result.applied, 1);
  assert.equal(result.value(1, "modelSelection"), "Pick First (scoped)");
  assert.equal(result.value(1, "subagentMode"), "Opportunistic");
  assert.equal(result.value(1, "toolFiltering"), "Allowed (except blocked)");
  assert.deepEqual(result.loaded.settings, DEFAULT_MANAGER_SETTINGS);
  assert.match(readFileSync(result.userFile, "utf8"), /"modelSelection": "pick-first-scoped"/);
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
  assert.equal(toggled.value(0, "scope"), "Current Project");
  assert.equal(toggled.value(1, "scope"), "Global");
  assert.equal(existsSync(toggled.userFile), true);
  assert.equal(existsSync(toggled.projectFile), false);
});

test("Global save scope sticks across reopenings and projects without changing precedence", async (t) => {
  const initial = await run(t, ["save"], {
    trusted: true,
    settings: { ...DEFAULT_MANAGER_SETTINGS, maxLevels: 7 },
  });
  const global = await run(t, ["scope", "maxLevels", "5", "save"], {
    trusted: true,
    root: initial.root,
  });
  assert.equal(global.value(1, "scope"), "Global");
  assert.equal(JSON.parse(readFileSync(global.userFile, "utf8")).maxLevels, 5);
  assert.equal(global.loaded.settings.maxLevels, 7); // Project override still wins.
  assert.deepEqual(global.loaded.diagnostics, []);

  const reopened = await run(t, ["cancel"], { trusted: true, root: initial.root });
  assert.equal(reopened.value(0, "scope"), "Global");
  const otherProject = await run(t, ["save"], { trusted: true, agentDir: initial.root });
  assert.equal(otherProject.value(0, "scope"), "Global");
  assert.equal(existsSync(otherProject.projectFile), false);
});

test("scope selection persists even on cancel; untrusted fallback does not overwrite it", async (t) => {
  const global = await run(t, ["scope", "cancel"], { trusted: true });
  assert.equal(existsSync(global.userFile), false);
  assert.equal(existsSync(global.projectFile), false);
  const project = await run(t, ["scope", "cancel"], { trusted: true, root: global.root });
  assert.equal(project.value(0, "scope"), "Global");
  assert.equal(project.value(1, "scope"), "Current Project");
  const untrusted = await run(t, ["scope", "save"], { root: global.root });
  assert.equal(untrusted.value(0, "scope"), "Global");
  assert.ok(untrusted.notifications.some((message) => message.includes("trusted project")));
  assert.equal(existsSync(untrusted.projectFile), false);
  const trustedAgain = await run(t, ["cancel"], { trusted: true, root: global.root });
  assert.equal(trustedAgain.value(0, "scope"), "Current Project");
});

test("Tool Filtering explains and saves every mode", async (t) => {
  for (const [mode, label] of [
    ["allowed", "Allowed (except blocked)"],
    ["all-except-blocked", "All except blocked"],
    ["all", "All"],
  ]) {
    const result = await run(t, ["toolFiltering", mode, "save"]);
    const field = result.menus[0]!.rows.find((row) => row.id === "toolFiltering")!;
    assert.equal(field.label, "Tool Filtering");
    assert.equal(field.value, "Allowed (except blocked)");
    assert.match(field.help ?? "", /only allow-listed tools, minus blocked tools/);
    assert.match(field.help ?? "", /missing or empty allow list means no tools/);
    assert.match(field.help ?? "", /ignore the allow list; block-listed tools remain blocked/);
    assert.match(field.help ?? "", /All: ignore both lists/);
    const chooser = result.menus[1]!;
    assert.equal(chooser.title, "Tool Filtering");
    assert.deepEqual(
      chooser.rows.map((row) => row.id),
      ["allowed", "all-except-blocked", "all"],
    );
    assert.deepEqual(
      chooser.rows.map((row) => row.label),
      ["Allowed (except blocked)", "All except blocked", "All"],
    );
    assert.ok(chooser.rows.every((row) => row.value && row.help));
    assert.match(chooser.rows[0]!.help ?? "", /Blocked tools take precedence/);
    assert.match(chooser.rows[1]!.help ?? "", /allow list is completely ignored/);
    assert.match(chooser.rows[2]!.help ?? "", /allow and block lists are completely ignored/);
    assert.equal(result.value(2, "toolFiltering"), label);
    assert.equal(result.applied, 1);
    assert.equal(result.loaded.settings.toolFiltering, mode);
    assert.equal(result.loaded.diagnostics.length, 0);
    assert.equal(JSON.parse(readFileSync(result.userFile, "utf8")).toolFiltering, mode);
  }
});

test("Tool Filtering selection and chooser cancellation remain draft-only", async (t) => {
  const canceled = await run(t, ["toolFiltering", "all", "cancel"]);
  assert.equal(canceled.value(2, "toolFiltering"), "All");
  assert.match(canceled.menus[2]!.title, /unsaved/);
  assert.equal(canceled.applied, 0);
  assert.equal(existsSync(canceled.userFile), false);
  assert.deepEqual(canceled.loaded.settings, DEFAULT_MANAGER_SETTINGS);

  const escaped = await run(t, ["toolFiltering", undefined, "save"]);
  assert.equal(escaped.value(2, "toolFiltering"), "Allowed (except blocked)");
  assert.doesNotMatch(escaped.menus[2]!.title, /unsaved/);
  assert.equal(escaped.loaded.settings.toolFiltering, "allowed");
});

test("Tool Filtering saves to a trusted project and restores defaults without saving on cancel", async (t) => {
  const saved = await run(t, ["toolFiltering", "all-except-blocked", "save"], { trusted: true });
  assert.equal(saved.applied, 1);
  assert.equal(saved.loaded.settings.toolFiltering, "all-except-blocked");
  assert.equal(
    JSON.parse(readFileSync(saved.projectFile, "utf8")).toolFiltering,
    "all-except-blocked",
  );
  assert.equal(existsSync(saved.userFile), false);

  const restored = await run(t, ["toolFiltering", "all", "defaults", "cancel"]);
  assert.equal(restored.value(2, "toolFiltering"), "All");
  assert.equal(restored.value(3, "toolFiltering"), "Allowed (except blocked)");
  assert.doesNotMatch(restored.menus[3]!.title, /unsaved/);
  assert.equal(restored.applied, 0);
  assert.equal(existsSync(restored.userFile), false);
});

for (const width of [32, 80]) {
  test(`Tool Filtering screen and chooser render bordered frames at width ${width}`, async (t) => {
    const result = await run(t, ["toolFiltering", "all", "cancel"], { width });
    assert.ok(
      result.renders.every(
        (lines) => lines[0]!.includes("Tool Filtering") || lines[0]!.includes("Agents settings"),
      ),
    );
    assert.ok(result.renders[1]!.join("\n").includes("All"));
    assert.equal(result.value(2, "toolFiltering"), "All");
  });
}

test("Status Widget explains both choices and saves each mode", async (t) => {
  for (const [mode, label] of [["full", "Full"], ["minimal", "Minimal"]]) {
    const result = await run(t, ["widgetMode", mode, "save"]);
    const field = result.menus[0]!.rows.find((row) => row.id === "widgetMode")!;
    assert.equal(field.label, "Status Widget");
    assert.equal(field.value, "Full");
    assert.match(field.help ?? "", /above the input box/);
    assert.match(field.help ?? "", /one-line status counts/);
    assert.match(field.help ?? "", /cumulative input\/output tokens for active \(starting\/running\) agents/);
    assert.match(field.help ?? "", /update the widget immediately/);
    const chooser = result.menus[1]!;
    assert.equal(chooser.title, "Status Widget");
    assert.deepEqual(chooser.rows.map((row) => row.id), ["full", "minimal"]);
    assert.deepEqual(chooser.rows.map((row) => row.label), ["Full", "Minimal"]);
    assert.ok(chooser.rows.every((row) => row.value && row.help));
    assert.equal(result.value(2, "widgetMode"), label);
    assert.equal(result.applied, 1);
    assert.equal(result.loaded.settings.widgetMode, mode);
    assert.equal(result.loaded.diagnostics.length, 0);
    assert.equal(JSON.parse(readFileSync(result.userFile, "utf8")).widgetMode, mode);
  }
});

test("Status Widget cancellation leaves settings unchanged and defaults restore Full", async (t) => {
  const canceled = await run(t, ["widgetMode", "minimal", "cancel"]);
  assert.equal(canceled.value(2, "widgetMode"), "Minimal");
  assert.match(canceled.menus[2]!.title, /unsaved/);
  assert.equal(canceled.applied, 0);
  assert.equal(existsSync(canceled.userFile), false);
  assert.deepEqual(canceled.loaded.settings, DEFAULT_MANAGER_SETTINGS);

  const escaped = await run(t, ["widgetMode", undefined, "save"]);
  assert.equal(escaped.value(2, "widgetMode"), "Full");
  assert.doesNotMatch(escaped.menus[2]!.title, /unsaved/);
  assert.equal(escaped.loaded.settings.widgetMode, "full");

  const restored = await run(t, ["defaults", "save"], {
    settings: { ...DEFAULT_MANAGER_SETTINGS, widgetMode: "minimal" },
  });
  assert.equal(restored.value(1, "widgetMode"), "Full");
  assert.equal(restored.loaded.settings.widgetMode, "full");
});

test("Status Widget saves to a trusted project", async (t) => {
  const result = await run(t, ["widgetMode", "minimal", "save"], { trusted: true });
  assert.equal(result.applied, 1);
  assert.equal(JSON.parse(readFileSync(result.projectFile, "utf8")).widgetMode, "minimal");
  assert.equal(existsSync(result.userFile), false);
});

for (const width of [32, 80]) {
  test(`Status Widget screen and chooser render bordered frames at width ${width}`, async (t) => {
    const result = await run(t, ["widgetMode", "minimal", "cancel"], { width });
    assert.ok(result.renders.every((lines) =>
      lines[0]!.includes("Status Widget") || lines[0]!.includes("Agents settings"),
    ));
    assert.ok(result.renders[1]!.join("\n").includes("Full"));
    assert.ok(result.renders[1]!.join("\n").includes("Minimal"));
    assert.equal(result.value(2, "widgetMode"), "Minimal");
  });
}
