import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { DIALOG_OPTIONS, dialogHeight, type DialogHost } from "../src/dialog.ts";
import { ImportPicker, selectImportAgents, type ImportPickerItem } from "../src/import-picker.ts";

const theme = { fg: (_color: string, text: string) => text } as Theme;

function host(rows = 24): DialogHost & { terminal: { rows: number } } {
  return { requestRender() {}, terminal: { rows } };
}

function agents(count: number): ImportPickerItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `agent-${i}`,
    label: `Agent-${String(i).padStart(2, "0")}`,
    detail: `/external/agents/agent-${i}/SKILL.md`,
  }));
}

function plain(lines: string[]): string {
  return lines.map(stripTerminalSequences).join("\n");
}

test("import picker starts empty and submits a subset in source order", () => {
  let chosen: string[] | undefined = ["unset"];
  const items = agents(4);
  const picker = new ImportPicker(host(), theme, items, (ids) => {
    chosen = ids;
  });
  assert.deepEqual(picker.getSelectedIds(), []);
  assert.equal(picker.getCursorIndex(), 0);
  let text = plain(picker.render(80));
  assert.match(text, /0 selected · 1\/4/);
  assert.match(text, /›\[ \] Agent-00/);
  assert.equal(text.includes("[x]"), false);
  assert.match(text, /\/external\/agents\/agent-0\/SKILL.md/);

  picker.handleInput("\x1b[B");
  picker.handleInput("\x1b[B");
  picker.handleInput(" ");
  picker.handleInput("\x1b[A");
  picker.handleInput("\x1b[A");
  picker.handleInput(" ");
  picker.handleInput(" ");
  picker.handleInput(" ");
  text = plain(picker.render(80));
  assert.match(text, /›\[x\] Agent-00/);
  assert.match(text, / \[x\] Agent-02/);
  assert.match(text, / \[ \] Agent-01/);
  assert.match(text, /2 selected/);
  picker.handleInput("\r");
  assert.deepEqual(chosen, ["agent-0", "agent-2"]);
});

test("import picker submits [] to skip and escape cancels", () => {
  const items = agents(2);
  let skipped: string[] | undefined = ["unset"];
  const skip = new ImportPicker(host(), theme, items, (ids) => {
    skipped = ids;
  });
  skip.handleInput("x");
  skip.handleInput("\r");
  assert.deepEqual(skipped, []);

  let cancelled: string[] | undefined = ["unset"];
  const cancel = new ImportPicker(host(), theme, items, (ids) => {
    cancelled = ids;
  });
  cancel.handleInput(" ");
  cancel.handleInput("\x1b");
  assert.equal(cancelled, undefined);
  assert.deepEqual(cancel.getSelectedIds(), ["agent-0"]);

  let empty: string[] | undefined = ["unset"];
  const none = new ImportPicker(host(), theme, [], (ids) => {
    empty = ids;
  });
  none.handleInput(" ");
  none.handleInput("\x01");
  none.handleInput("\x1b[B");
  none.handleInput("\x1b[F");
  assert.match(plain(none.render(80)), /0 selected · 0\/0/);
  assert.match(plain(none.render(80)), /No external agents to import/);
  none.handleInput("\r");
  assert.deepEqual(empty, []);
});

test("import picker ctrl+a toggles every agent on and back off", () => {
  const items = agents(5);
  let chosen: string[] | undefined;
  const picker = new ImportPicker(host(), theme, items, (ids) => {
    chosen = ids;
  });
  picker.handleInput("\x1b[B");
  picker.handleInput(" ");
  picker.handleInput("\x01");
  assert.deepEqual(
    picker.getSelectedIds(),
    items.map((item) => item.id),
  );
  assert.match(plain(picker.render(80)), /5 selected/);
  assert.equal(plain(picker.render(80)).includes("[ ]"), false);
  picker.handleInput("\x01");
  assert.deepEqual(picker.getSelectedIds(), []);
  assert.match(plain(picker.render(80)), /0 selected/);
  assert.equal(plain(picker.render(80)).includes("[x]"), false);
  picker.handleInput("\x01");
  picker.handleInput("\r");
  assert.deepEqual(
    chosen,
    items.map((item) => item.id),
  );
});

test("import picker scrolls, keeps selection, and stays bounded on resize", () => {
  const terminal = host(12);
  let renders = 0;
  terminal.requestRender = () => {
    renders++;
  };
  const items = agents(30);
  const picker = new ImportPicker(terminal, theme, items, () => {});
  picker.render(80);
  assert.equal(picker.getCursorIndex(), 0);
  picker.handleInput("\x1b[B");
  picker.handleInput("\x1b[A");
  picker.handleInput("\x1b[A");
  assert.equal(picker.getCursorIndex(), 0);
  picker.handleInput("\x1b[6~");
  assert.ok(picker.getCursorIndex() > 1);
  picker.handleInput("\x1b[5~");
  assert.equal(picker.getCursorIndex(), 0);
  picker.handleInput(" ");
  picker.handleInput("\x1b[F");
  assert.equal(picker.getCursorIndex(), items.length - 1);
  picker.handleInput("\x1b[6~");
  assert.equal(picker.getCursorIndex(), items.length - 1);
  let text = plain(picker.render(80));
  assert.match(text, /Agent-29/);
  assert.match(text, /\/external\/agents\/agent-29\/SKILL.md/);
  assert.equal(text.includes("Agent-00"), false);
  assert.ok(renders > 0);

  picker.handleInput("\x1b[H");
  assert.equal(picker.getCursorIndex(), 0);
  text = plain(picker.render(80));
  assert.match(text, /Agent-00/);
  assert.match(text, /\/external\/agents\/agent-0\/SKILL.md/);
  assert.equal(text.includes("Agent-29"), false);

  picker.handleInput("\x1b[F");
  terminal.terminal.rows = 10;
  for (const width of [0, 1, 3, 4, 10, 30, 40, 100]) {
    const lines = picker.render(width);
    assert.ok(lines.length <= dialogHeight(terminal));
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    if (width >= 40) {
      const framed = plain(lines);
      assert.match(framed, /Agent-29/);
      assert.match(framed, /agent-29\/SKILL.md/);
      assert.equal(framed.includes("Agent-00"), false);
    }
  }
  picker.handleInput("\x1b[5~");
  assert.ok(picker.getCursorIndex() < items.length - 1);
  const visible = items[picker.getCursorIndex()]!;
  assert.ok(plain(picker.render(80)).includes(visible.label));
  assert.deepEqual(picker.getSelectedIds(), ["agent-0"]);

  const wideFooter = plain(picker.render(80));
  assert.match(wideFooter, /Space toggle · Enter import \(empty skip\) · Esc cancel/);
  const narrowFooter = plain(picker.render(24))
    .split("\n")
    .find((line) => line.includes("Space") || line.includes("Home/End"));
  assert.match(narrowFooter ?? "", /Space toggle/);
  assert.equal((narrowFooter ?? "").includes("Home/End"), false);

  for (const rows of [1, 3, 4, 5, 6, 8, 10]) {
    terminal.terminal.rows = rows;
    for (const width of [0, 1, 3, 4, 10, 30, 80]) {
      const lines = picker.render(width);
      assert.ok(lines.length <= dialogHeight(terminal));
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
    }
  }
});

test("long details stay capped and scrolled lists show above/below markers", () => {
  const terminal = host(12);
  const items = Array.from({ length: 20 }, (_, i) => ({
    id: `id-${i}`,
    label: `Row-${String(i).padStart(2, "0")}`,
    detail: `path-${i}-` + "segment/".repeat(40) + "ENDTOKEN",
  }));
  const picker = new ImportPicker(terminal, theme, items, () => {});
  let text = plain(picker.render(80));
  assert.match(text, /Row-00/);
  assert.match(text, /Row-01/);
  assert.match(text, /▼/);
  assert.equal(text.includes("Row-19"), false);
  assert.match(text, /path-0-/);
  assert.equal(text.includes("ENDTOKEN"), false);
  picker.handleInput("\x1b[6~");
  assert.ok(picker.getCursorIndex() >= 2);
  picker.handleInput("\x1b[F");
  text = plain(picker.render(80));
  assert.match(text, /Row-19/);
  assert.match(text, /▲/);
  assert.equal(text.includes("Row-00"), false);
  const fitted = plain(new ImportPicker(host(), theme, agents(2), () => {}).render(80));
  assert.equal(fitted.includes("▲"), false);
  assert.equal(fitted.includes("▼"), false);
});

test("import picker sanitizes source text in labels and details", () => {
  const picker = new ImportPicker(
    host(),
    theme,
    [
      {
        id: "bad",
        label: `Agent\x1b]0;bad\x07界\x1b[31mRed${CURSOR_MARKER}`,
        detail: `/tmp/\x1b]0;injected\x07path\x00name.md\r\nnext${CURSOR_MARKER}`,
      },
    ],
    () => {},
  );
  for (const width of [1, 3, 10, 40, 80]) {
    const rendered = picker.render(width).join("\n");
    // Frame clipping may emit a trusted SGR reset; source escape sequences must not survive.
    assert.equal(stripTerminalSequences(rendered).includes("\x1b"), false);
    assert.equal(rendered.includes("\x00"), false);
    assert.equal(rendered.includes("injected"), false);
    assert.equal(rendered.includes("]0;bad"), false);
    assert.equal(rendered.includes(CURSOR_MARKER), false);
    assert.equal(rendered.includes("pi:c"), false);
    if (width >= 40) {
      const text = plain(picker.render(width));
      assert.match(text, /Agent界Red/);
      assert.match(text, /\/tmp\/path name\.md\s+next/);
    }
  }
});

test("import picker preserves trusted resets produced by frame clipping", () => {
  const coloredTheme = {
    fg: (_color: string, text: string) => `\x1b[2m${text}\x1b[22;39m`,
  } as Theme;
  const picker = new ImportPicker(host(), coloredTheme, agents(2), () => {});
  const rendered = picker.render(20);
  assert.ok(rendered.some((line) => line.includes("\x1b[0m")));
  assert.ok(rendered.every((line) => visibleWidth(line) <= 20));
});

test("selectImportAgents opens one checkbox overlay and returns its ids", async () => {
  let options: unknown;
  const ctx = {
    ui: {
      custom: async (
        factory: (
          host: DialogHost,
          theme: Theme,
          keys: unknown,
          done: (ids: string[] | undefined) => void,
        ) => ImportPicker,
        overlayOptions: unknown,
      ) => {
        options = overlayOptions;
        let result: string[] | undefined = ["unset"];
        const picker = factory(host(), theme, {}, (ids) => {
          result = ids;
        });
        assert.ok(picker instanceof ImportPicker);
        picker.handleInput("\x1b[B");
        picker.handleInput(" ");
        picker.handleInput("\r");
        return result;
      },
    },
  } as unknown as ExtensionContext;
  const chosen = await selectImportAgents(ctx, agents(3));
  assert.deepEqual(chosen, ["agent-1"]);
  assert.equal(options, DIALOG_OPTIONS);
});
