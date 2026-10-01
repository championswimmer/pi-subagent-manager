import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, type ScopedModel, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { OrderedModelEditorComponent } from "../src/model-picker.ts";

initTheme();

const DOWN = "\u001B[B";
const ENTER = "\r";
const ESC = "\u001B";

function availableModel(provider: string, id: string, name = id) {
  return { provider, id, name };
}

function createComponent(options?: {
  initialModels?: readonly string[];
  availableModels?: readonly ReturnType<typeof availableModel>[];
  scopedModels?: readonly string[];
}) {
  const done: string[][] = [];
  let cancelled = 0;
  let renders = 0;
  const models =
    options?.availableModels ??
    [
      availableModel("anthropic", "claude-3.7-sonnet", "Claude 3.7 Sonnet"),
      availableModel("google", "gemini-2.5-pro", "Gemini 2.5 Pro"),
      availableModel("local", "llama3.3", "Llama 3.3"),
      availableModel("openai", "gpt-4.1", "GPT-4.1"),
    ];
  const component = new OrderedModelEditorComponent({
    tui: { requestRender: () => renders++ },
    theme: { fg: (_color: string, text: string) => text } as unknown as Theme,
    availableModels: models,
    scopedModels: (options?.scopedModels ?? []).map((identity) => {
      const model = models.find((entry) => `${entry.provider}/${entry.id}` === identity);
      assert.ok(model, `Missing scoped model ${identity}`);
      return { model } as unknown as ScopedModel;
    }),
    initialModels: options?.initialModels,
    onDone: (value) => done.push([...value]),
    onCancel: () => {
      cancelled += 1;
    },
  });
  return { component, done, getCancelled: () => cancelled, getRenders: () => renders };
}

function press(component: OrderedModelEditorComponent, ...keys: string[]) {
  for (const key of keys) component.handleInput(key);
}

function typeText(component: OrderedModelEditorComponent, text: string) {
  for (const char of text) component.handleInput(char);
}

function moveSelectionToValue(component: OrderedModelEditorComponent, value: string) {
  const items = component.getCurrentItems();
  const targetIndex = items.findIndex((item) => item.value === value);
  assert.notEqual(targetIndex, -1, `Missing option: ${value}`);
  for (let remaining = items.length + 1; remaining > 0; remaining--) {
    if (component.getSelectList().getSelectedItem()?.value === value) return;
    press(component, DOWN);
  }
  assert.fail(`Could not focus option: ${value}`);
}

function activateValue(component: OrderedModelEditorComponent, value: string) {
  moveSelectionToValue(component, value);
  press(component, ENTER);
}

test("ordered model editor searches, annotates scope, and excludes duplicates when adding", () => {
  const { component, done, getRenders } = createComponent({
    initialModels: [],
    scopedModels: ["anthropic/claude-3.7-sonnet", "openai/gpt-4.1"],
  });

  component.focused = true;
  assert.equal(component.getMode(), "picker");
  assert.equal(component.getSearchInput()?.focused, true);

  typeText(component, "claude");
  assert.equal(component.getSelectList().getSelectedItem()?.value, "anthropic/claude-3.7-sonnet");
  press(component, ENTER);
  assert.deepEqual(component.getDraftModels(), ["anthropic/claude-3.7-sonnet"]);
  assert.equal(component.getMode(), "menu");

  activateValue(component, "action:add");
  const pickerItems = component.getCurrentItems();
  assert.ok(!pickerItems.some((item) => item.value === "anthropic/claude-3.7-sonnet"));
  assert.match(
    pickerItems.find((item) => item.value === "local/llama3.3")?.description ?? "",
    /portable preference/,
  );
  assert.match(
    pickerItems.find((item) => item.value === "openai/gpt-4.1")?.description ?? "",
    /scoped in this session/,
  );

  typeText(component, "llama");
  assert.equal(component.getSelectList().getSelectedItem()?.value, "local/llama3.3");
  press(component, ENTER);
  activateValue(component, "action:done");

  assert.deepEqual(done, [["anthropic/claude-3.7-sonnet", "local/llama3.3"]]);
  assert.ok(getRenders() > 0);
});

test("ordered model editor warns and annotates portable preferences when scope is empty", () => {
  const picker = createComponent({ initialModels: [], scopedModels: [] }).component;
  assert.match(
    picker.render(200).join("\n"),
    /No scoped models: explicit preferences cannot run\. Configure \/scoped-models\./,
  );
  assert.match(
    picker.getCurrentItems().find((item) => item.value === "openai/gpt-4.1")?.description ?? "",
    /portable preference · not scoped in this session/,
  );

  const menu = createComponent({
    initialModels: ["openai/gpt-4.1"],
    scopedModels: [],
  }).component;
  assert.match(
    menu.render(200).join("\n"),
    /No scoped models: explicit preferences cannot run\. Configure \/scoped-models\./,
  );
  assert.match(
    menu.getCurrentItems().find((item) => item.value === "entry:0")?.description ?? "",
    /portable preference · not scoped in this session/,
  );
});

test("ordered model editor keeps raw identities while sanitizing picker labels", () => {
  const provider = "openai\u0007";
  const id = "gpt-4.1\u0000beta";
  const rawIdentity = `${provider}/${id}`;
  const { component, done } = createComponent({
    initialModels: [],
    availableModels: [availableModel(provider, id, "Unsafe\u001b[31m Name")],
    scopedModels: [],
  });

  typeText(component, "openai");
  const item = component.getCurrentItems()[0];
  assert.equal(item?.value, rawIdentity);
  assert.ok(item);
  assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(item.label));
  press(component, ENTER);
  assert.deepEqual(component.getDraftModels(), [rawIdentity]);
  activateValue(component, "action:done");
  assert.deepEqual(done, [[rawIdentity]]);
});

test("ordered model editor replaces unavailable entries, reorders, removes, and clears", () => {
  const { component, done } = createComponent({
    initialModels: ["custom/missing", "openai/gpt-4.1", "anthropic/claude-3.7-sonnet"],
    scopedModels: ["anthropic/claude-3.7-sonnet", "openai/gpt-4.1"],
  });

  assert.match(
    component.getCurrentItems().find((item) => item.value === "entry:0")?.description ?? "",
    /unavailable in current model registry/,
  );

  activateValue(component, "entry:0");
  activateValue(component, "action:replace");
  typeText(component, "gemini");
  press(component, ENTER);
  assert.deepEqual(component.getDraftModels(), [
    "google/gemini-2.5-pro",
    "openai/gpt-4.1",
    "anthropic/claude-3.7-sonnet",
  ]);

  activateValue(component, "entry:2");
  activateValue(component, "action:earlier");
  assert.deepEqual(component.getDraftModels(), [
    "google/gemini-2.5-pro",
    "anthropic/claude-3.7-sonnet",
    "openai/gpt-4.1",
  ]);

  activateValue(component, "entry:0");
  activateValue(component, "action:later");
  assert.deepEqual(component.getDraftModels(), [
    "anthropic/claude-3.7-sonnet",
    "google/gemini-2.5-pro",
    "openai/gpt-4.1",
  ]);

  activateValue(component, "entry:2");
  activateValue(component, "action:remove");
  assert.deepEqual(component.getDraftModels(), ["anthropic/claude-3.7-sonnet", "google/gemini-2.5-pro"]);

  activateValue(component, "action:clear");
  assert.deepEqual(component.getDraftModels(), []);
  activateValue(component, "action:done");
  assert.deepEqual(done, [[]]);
});

test("ordered model editor cancellation preserves the draft across picker and action menus", () => {
  const { component, done, getCancelled } = createComponent({
    initialModels: ["openai/gpt-4.1"],
  });

  activateValue(component, "entry:0");
  assert.equal(component.getMode(), "actions");
  activateValue(component, "action:replace");
  assert.equal(component.getMode(), "picker");

  typeText(component, "gemini");
  press(component, ESC);
  assert.equal(component.getMode(), "actions");
  assert.deepEqual(component.getDraftModels(), ["openai/gpt-4.1"]);

  press(component, ESC);
  assert.equal(component.getMode(), "menu");
  assert.deepEqual(component.getDraftModels(), ["openai/gpt-4.1"]);

  press(component, ESC);
  assert.equal(getCancelled(), 1);
  assert.deepEqual(done, []);
});

test("ordered model editor render stays within narrow widths", () => {
  const { component } = createComponent({
    initialModels: ["openai/gpt-4.1", "local/llama3.3"],
    availableModels: [
      availableModel("openai", "gpt-4.1", "A very long model name for width checks"),
      availableModel("local", "llama3.3", "Another very long model name"),
    ],
  });

  for (const width of [18, 24, 40]) {
    const lines = component.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), `render overflowed width ${width}`);
  }
});
