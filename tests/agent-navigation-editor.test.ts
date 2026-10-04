import assert from "node:assert/strict";
import test from "node:test";
// Pi exports this constructor only as a type; exercise its installed public
// implementation directly in tests (production receives it from the factory).
import { KeybindingsManager } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import {
  setKeybindings,
  TuiMainScreen,
  type EditorTheme,
  type KeybindingsConfig,
  type Terminal,
} from "@earendil-works/pi-tui";
import {
  AgentNavigationEditor,
  type AgentNavigationEditorOptions,
} from "../src/ui/agent-navigation-editor.ts";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const LEFT = "\x1b[D";
const END = "\x1b[F";
const theme: EditorTheme = {
  borderColor: (text) => text,
  selectList: {
    selectedPrefix: (text) => text,
    selectedText: (text) => text,
    description: (text) => text,
    scrollInfo: (text) => text,
    noMatch: (text) => text,
  },
};
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
function setup(
  bindings: KeybindingsConfig = {},
  options: Partial<AgentNavigationEditorOptions> = {},
) {
  const keys = new KeybindingsManager(bindings);
  setKeybindings(keys);
  let opens = 0;
  const editor = new AgentNavigationEditor(new TuiMainScreen(new FakeTerminal()), theme, keys, {
    openTree: () => {
      opens++;
    },
    canOpen: () => true,
    generation: () => 1,
    ...options,
  });
  editor.focused = true;
  editor.render(80);
  return { editor, keys, opens: () => opens };
}

test("empty/no-history and nonempty already-at-end drafts open only after dispatch", async () => {
  for (const draft of ["", "keep this draft", "one\ntwo"]) {
    const { editor, opens } = setup();
    editor.setText(draft);
    const cursor = editor.getCursor();
    editor.handleInput(DOWN);
    assert.equal(opens(), 0);
    await settle();
    assert.equal(opens(), 1);
    assert.equal(editor.getText(), draft);
    assert.deepEqual(editor.getCursor(), cursor);
  }
});

test("ordinary Up/Down history and identical-text draft restoration never open", async () => {
  for (const draft of ["", "newest", "draft"]) {
    const { editor, opens } = setup();
    editor.addToHistory("oldest");
    editor.addToHistory("newest");
    editor.setText(draft);
    // Nonempty draft at end: first Up moves caret to start, then browses.
    if (draft) editor.handleInput(UP);
    editor.handleInput(UP);
    assert.equal(editor.getText(), "newest");
    editor.handleInput(UP);
    assert.equal(editor.getText(), "oldest");
    editor.handleInput(DOWN);
    assert.equal(editor.getText(), "newest");
    editor.handleInput(DOWN);
    assert.equal(editor.getText(), draft);
    await settle();
    assert.equal(opens(), 0);
    if (draft) {
      editor.handleInput(DOWN); // restored nonempty draft still has stock caret movement
      await settle();
      assert.equal(opens(), 0);
    }
    editor.handleInput(DOWN);
    await settle();
    assert.equal(opens(), 1);
  }
});

test("nonempty restored draft caret movement wins before the boundary", async () => {
  const { editor, opens } = setup();
  editor.addToHistory("history");
  editor.setText("draft");
  editor.handleInput(UP); // draft cursor at start
  editor.handleInput(UP); // history
  editor.handleInput(DOWN); // restore at start
  assert.deepEqual(editor.getCursor(), { line: 0, col: 0 });
  editor.handleInput(DOWN); // stock movement to line end
  await settle();
  assert.equal(opens(), 0);
  assert.deepEqual(editor.getCursor(), { line: 0, col: 5 });
  editor.handleInput(DOWN);
  await settle();
  assert.equal(opens(), 1);
});

test("multiline and wrapped-line Down moves the stock caret without navigation", async () => {
  for (const draft of ["one\nsecond line", "a long line that wraps onto several visual rows"]) {
    const { editor, opens } = setup();
    editor.setText(draft);
    editor.render(12);
    for (let i = 0; i < draft.length + 3; i++) editor.handleInput(LEFT);
    const before = editor.getCursor();
    editor.handleInput(DOWN);
    assert.notDeepEqual(editor.getCursor(), before);
    await settle();
    assert.equal(opens(), 0);
    // Only the final logical/visual endpoint can trigger the workflow.
    editor.setText(draft);
    editor.render(12);
    editor.handleInput(DOWN);
    await settle();
    assert.equal(opens(), 1);
  }
});

test("physical Down only: remaps, conflicts, dedicated history-next, and alternatives stay stock", async () => {
  for (const bindings of [
    { "tui.editor.cursorDown": "ctrl+n" },
    { "tui.editor.historyNext": "down" },
    { "tui.editor.deleteCharForward": "down" },
    { "tui.editor.jumpForward": "down" },
    { "app.clear": "down" },
    { "tui.altScreen.lineDown": "down" },
  ] satisfies KeybindingsConfig[]) {
    const { editor, opens } = setup(bindings);
    editor.handleInput(DOWN);
    await settle();
    assert.equal(opens(), 0, JSON.stringify(bindings));
  }
  const { editor, opens } = setup({
    "tui.editor.cursorDown": ["down", "ctrl+n"],
    "tui.editor.historyNext": "ctrl+j",
  });
  editor.handleInput("\x0e");
  editor.handleInput("\x0a");
  await settle();
  assert.equal(opens(), 0);
  editor.handleInput(DOWN);
  await settle();
  assert.equal(opens(), 1);
});

test("extension shortcuts and application actions retain precedence with no false boundary", async () => {
  const { editor, opens } = setup();
  let shortcuts = 0;
  const shortcut = (data: string) => {
    shortcuts++;
    return data === DOWN;
  };
  editor.onExtensionShortcut = shortcut;
  editor.handleInput(DOWN);
  assert.equal(shortcuts, 1); // never dispatch extension handler twice
  assert.equal(editor.onExtensionShortcut, shortcut);
  await settle();
  assert.equal(opens(), 0);
  const second = setup({ "app.model.select": "down" });
  let actions = 0;
  second.editor.onAction("app.model.select", () => {
    actions++;
  });
  second.editor.handleInput(DOWN);
  await settle();
  assert.equal(actions, 1);
  assert.equal(second.opens(), 0);
});

test("host change callback forwards identical restoration and is restored on errors", async () => {
  const { editor, opens } = setup();
  editor.addToHistory("same");
  editor.setText("same");
  let changes = 0;
  const change = () => {
    changes++;
  };
  editor.onChange = change;
  editor.handleInput(UP);
  editor.handleInput(UP);
  editor.handleInput(DOWN);
  assert.equal(changes, 2);
  assert.equal(editor.onChange, change);
  await settle();
  assert.equal(opens(), 0);
  const failingShortcut = () => {
    throw new Error("shortcut failure");
  };
  editor.onExtensionShortcut = failingShortcut;
  assert.throws(() => editor.handleInput(DOWN), /shortcut failure/);
  assert.equal(editor.onExtensionShortcut, failingShortcut);
  assert.equal(editor.onChange, change);
  assert.equal(opens(), 0);
});

test("pending jump suppresses a no-op Down without accessing private editor state", async () => {
  const { editor, opens } = setup();
  editor.handleInput("\x1d"); // ctrl+] awaits a character
  editor.handleInput(DOWN); // stock cancellation/no-op does not navigate
  await settle();
  assert.equal(opens(), 0);
  editor.handleInput(DOWN);
  await settle();
  assert.equal(opens(), 1);
});

test("bracketed paste, including recursively dispatched suffix Down, never navigates", async () => {
  const { editor, opens } = setup();
  editor.handleInput("\x1b[200~");
  editor.handleInput(DOWN);
  await settle();
  assert.equal(opens(), 0);
  editor.handleInput("\x1b[201~" + DOWN);
  await settle();
  assert.equal(opens(), 0);
  assert.equal(editor.getText(), "[B"); // stock paste sanitizer removes the ESC control byte
  editor.handleInput(DOWN);
  await settle();
  assert.equal(opens(), 1);
});

test("active autocomplete owns Down, even if selection has no visible change", async () => {
  const { editor, opens } = setup();
  editor.setAutocompleteProvider({
    async getSuggestions() {
      return {
        items: [
          { value: "one", label: "one" },
          { value: "two", label: "two" },
        ],
        prefix: "",
      };
    },
    applyCompletion(lines, cursorLine, cursorCol) {
      return { lines, cursorLine, cursorCol };
    },
  });
  editor.handleInput("\t");
  await settle();
  assert.equal(editor.isShowingAutocomplete(), true);
  editor.handleInput(DOWN);
  await settle();
  assert.equal(opens(), 0);
  editor.handleInput("\x1b");
});

test("queued transition coalesces repeated keys and remains owned until interaction finishes", async () => {
  let opens = 0;
  let close!: () => void;
  const open = new Promise<void>((resolve) => {
    close = resolve;
  });
  const { editor } = setup(
    {},
    {
      openTree: () => {
        opens++;
        return open;
      },
    },
  );
  editor.handleInput(DOWN);
  editor.handleInput(DOWN);
  editor.handleInput(DOWN);
  await settle();
  assert.equal(opens, 1);
  editor.handleInput(DOWN);
  await settle();
  assert.equal(opens, 1);
  close();
  await settle();
});

test("queued transitions revalidate generation, focus, ownership, draft/cursor, and disposal", async () => {
  for (const change of [
    "generation",
    "focus",
    "ownership",
    "draft",
    "cursor",
    "dispose",
    "input",
  ]) {
    let generation = 1;
    let allowed = true;
    const { editor, opens } = setup({}, { generation: () => generation, canOpen: () => allowed });
    editor.setText("draft");
    editor.handleInput(DOWN);
    if (change === "generation") generation++;
    if (change === "focus") editor.focused = false;
    if (change === "ownership") allowed = false;
    if (change === "draft") editor.setText("different");
    if (change === "cursor") editor.handleInput(LEFT);
    if (change === "dispose") editor.dispose();
    if (change === "input") editor.handleInput(END); // same cursor but different input invalidates queue
    await settle();
    assert.equal(opens(), 0, change);
  }
});

test("navigation failures are reported and release ownership", async () => {
  let errors = 0;
  let opens = 0;
  const { editor } = setup(
    {},
    {
      openTree: async () => {
        opens++;
        throw new Error("failed to mount");
      },
      onError: () => {
        errors++;
      },
    },
  );
  editor.handleInput(DOWN);
  await settle();
  assert.equal(errors, 1);
  editor.handleInput(DOWN);
  await settle();
  assert.equal(opens, 2);
});

test("startup uses host history hydration; reload and replacement use explicit public hydration", () => {
  for (const startup of [true, false]) {
    const { editor } = setup({}, startup ? {} : { initialHistory: ["oldest", "newest"] });
    if (startup) {
      editor.addToHistory("oldest");
      editor.addToHistory("newest");
    }
    editor.handleInput(UP);
    assert.equal(editor.getText(), "newest");
    editor.handleInput(UP);
    assert.equal(editor.getText(), "oldest");
    editor.handleInput(UP);
    assert.equal(editor.getText(), "oldest");
    editor.handleInput(DOWN);
    assert.equal(editor.getText(), "newest");
    editor.handleInput(DOWN);
    assert.equal(editor.getText(), "");
  }
});

test("openTree runs in the validated microtask, before subsequent ownership changes", async () => {
  let generation = 1;
  let openedGeneration: number | undefined;
  const { editor } = setup(
    {},
    {
      generation: () => generation,
      openTree: () => {
        openedGeneration = generation;
      },
    },
  );
  editor.handleInput(DOWN);
  queueMicrotask(() => {
    generation = 2;
  });
  await settle();
  assert.equal(openedGeneration, 1);
});

test("global TUI binding conflicts also disable the injected app manager gesture", async () => {
  const { editor, opens } = setup();
  const globalKeys = new KeybindingsManager({ "tui.editor.deleteCharForward": "down" });
  setKeybindings(globalKeys);
  editor.handleInput(DOWN);
  await settle();
  assert.equal(opens(), 0);
});

test("callbacks replaced by a host handler are retained rather than clobbered in finally", () => {
  const { editor } = setup();
  const replacement = () => {};
  editor.onChange = () => {
    editor.onChange = replacement;
  };
  editor.setText("draft");
  editor.onChange = () => {
    editor.onChange = replacement;
  };
  editor.handleInput("x");
  assert.equal(editor.onChange, replacement);
});

test("history hydration never suppresses intentional repeated prompts, even before first input", () => {
  const { editor } = setup({}, { initialHistory: ["oldest", "newest"] });
  editor.addToHistory("oldest");
  editor.setText("");
  editor.handleInput(UP);
  assert.equal(editor.getText(), "oldest");
});

test("jump hotkey recursively dispatched after paste remains guarded on the next Down", async () => {
  const { editor, opens } = setup();
  editor.handleInput("\x1b[200~text\x1b[201~\x1d");
  editor.handleInput(DOWN);
  await settle();
  assert.equal(opens(), 0);
  editor.handleInput(DOWN);
  await settle();
  assert.equal(opens(), 1);
});
