import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { dialogHeight, type DialogHost } from "../src/ui/dialog.ts";
import {
  buildStatusTree,
  showAgentStatus,
  showAgentTree,
  StatusDialog,
} from "../src/ui/status-ui.ts";
import type { ThreadService, ThreadView } from "../src/types.ts";

const theme = { fg: (_token: string, text: string) => text } as Theme;
const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const HOME = "\x1b[H";
const END = "\x1b[F";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const ENTER = "\r";
const ESC = "\x1b";

function thread(path: string, patch: Partial<ThreadView> = {}): ThreadView {
  const slash = path.lastIndexOf("/");
  return {
    parent: slash > 0 ? path.slice(0, slash) : null,
    owner: "/root",
    type: "worker",
    state: "running",
    task: "Investigate",
    status: "Working",
    createdAt: 1,
    updatedAt: 2,
    elapsedMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    ...patch,
    path,
  };
}

function host(rows = 24, onRender?: () => void): DialogHost {
  return { requestRender: () => onRender?.(), terminal: { rows } };
}

function service(list: () => ThreadView[]): ThreadService {
  return {
    list,
    get(path: string) {
      const found = list().find((item) => item.path === path);
      if (!found) throw new Error(`No thread ${path}`);
      return found;
    },
  } as ThreadService;
}

function plain(lines: string[]): string {
  return lines.map((line) => stripTerminalSequences(line)).join("\n");
}

function selectedLine(lines: string[]): string {
  return (
    plain(lines)
      .split("\n")
      .find((line) => line.includes("›")) ?? ""
  );
}

function showsPath(line: string, path: string): boolean {
  return line.includes(`${path}  `);
}

function moveTo(dialog: StatusDialog, path: string): void {
  dialog.handleInput(HOME);
  for (let step = 0; step < 80 && !showsPath(selectedLine(dialog.render(120)), path); step++)
    dialog.handleInput(DOWN);
  assert.ok(showsPath(selectedLine(dialog.render(120)), path), path);
}

function trackIntervals() {
  const timers = new Set<ReturnType<typeof setInterval>>();
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  let refresh = () => {};
  let delay = 0;
  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    refresh = fn;
    delay = ms ?? 0;
    const timer = originalSet(fn, ms);
    timers.add(timer);
    return timer;
  }) as typeof setInterval;
  globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => {
    timers.delete(timer);
    return originalClear(timer);
  }) as typeof clearInterval;
  return {
    timers,
    get delay() {
      return delay;
    },
    refresh: () => refresh(),
    restore() {
      globalThis.setInterval = originalSet;
      globalThis.clearInterval = originalClear;
      for (const timer of timers) originalClear(timer);
      timers.clear();
    },
  };
}

function uiContext(ui: Record<string, unknown>, mode = "tui"): ExtensionCommandContext {
  return { hasUI: true, mode, ui: { notify() {}, ...ui } } as unknown as ExtensionCommandContext;
}

async function until<T>(read: () => T | undefined, label: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() - start > 2000) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function treeTitle(lines: string[]) {
  const title = stripTerminalSequences(lines[0] ?? "");
  const match = title.match(/Agents tree\s+(\d+) agents?\s+(\d+)-(\d+)\/(\d+)/);
  assert.ok(match, title);
  return {
    agents: Number(match[1]),
    start: Number(match[2]),
    end: Number(match[3]),
    total: Number(match[4]),
  };
}

/** Drives showAgentTree through a fake DialogSession host, recording each mounted StatusDialog. */
function launchTree(list: () => ThreadView[], selectedPath?: string, rows = 16) {
  const mounted: StatusDialog[] = [];
  const selectTitles: string[] = [];
  let opens = 0;
  let renders = 0;
  let releaseSelect = (_value: string | undefined) => {};
  let markSelected = () => {};
  const selectReady = new Promise<void>((resolve) => {
    markSelected = resolve;
  });
  let session: { getComponent(): unknown } | undefined;
  const ctx = uiContext({
    select(title: string) {
      selectTitles.push(title);
      markSelected();
      return new Promise<string | undefined>((resolve) => {
        releaseSelect = resolve;
      });
    },
    custom(factory: Function, options: { overlay: boolean; overlayOptions: { anchor: string } }) {
      opens++;
      assert.equal(options.overlay, true);
      assert.equal(options.overlayOptions.anchor, "center");
      return new Promise<void>((resolve) => {
        session = factory(
          {
            requestRender() {
              renders++;
              const next = session?.getComponent();
              if (next && next !== mounted.at(-1)) mounted.push(next as StatusDialog);
            },
            setFocus() {},
            terminal: { rows },
          },
          theme,
          {},
          resolve,
        ) as { getComponent(): unknown };
      });
    },
  });
  const done = showAgentTree(ctx, service(list), selectedPath);
  return {
    mounted,
    selectTitles,
    selectReady,
    done,
    releaseSelect: (value: string | undefined) => releaseSelect(value),
    get opens() {
      return opens;
    },
    get renders() {
      return renders;
    },
    async close() {
      releaseSelect("Back");
      mounted.at(-1)?.handleInput(ESC);
      await done.catch(() => {});
    },
  };
}

test("status tree sorts siblings, draws branch prefixes, and collapses descendants", () => {
  const threads = [
    ...["running", "completed", "failed", "starting"].map((name) =>
      thread(`/root/${name}`, { parent: "/root" }),
    ),
    thread("/root/running/paused-child", { parent: "/root/running", state: "paused" }),
    thread("/root/b", { parent: "/root" }),
    thread("/root/a", { parent: "/root" }),
  ];
  const rows = buildStatusTree(threads, new Set());
  assert.deepEqual(
    rows.map((row) => row.path),
    [
      "/root",
      "/root/a",
      "/root/b",
      "/root/completed",
      "/root/failed",
      "/root/running",
      "/root/running/paused-child",
      "/root/starting",
    ],
  );
  assert.equal(rows.find((row) => row.path === "/root/a")?.prefix, "├─ ");
  assert.equal(rows.at(-1)?.prefix, "└─ ");
  assert.match(
    rows.find((row) => row.path === "/root/running/paused-child")?.prefix ?? "",
    /│  └─ /,
  );
  assert.equal(
    rows.find((row) => row.path === "/root/running/paused-child")?.thread?.state,
    "paused",
  );

  const folded = buildStatusTree(threads, new Set(["/root/running"]));
  assert.equal(folded.find((row) => row.path === "/root/running")?.hasChildren, true);
  assert.equal(
    folded.some((row) => row.path === "/root/running/paused-child"),
    false,
  );
});

test("status tree shows independent roots, missing-parent placeholders, and depth 32", () => {
  const segments = Array.from({ length: 32 }, (_, index) => `n${index}`);
  const deep = `/${segments.join("/")}`;
  const rows = buildStatusTree(
    [
      thread("/k", { parent: null, state: "completed" }),
      thread("/k/child", { parent: "/k", state: "failed" }),
      thread("/root/gone/child", { parent: "/root/gone", state: "paused" }),
      thread("/missing/leaf", { parent: "/missing", state: "stopped" }),
      thread("/elsewhere", { parent: "/root/missing/node", state: "starting" }),
      thread(deep, { parent: `/${segments.slice(0, -1).join("/")}` }),
    ],
    new Set(),
  );
  const row = (path: string) => rows.find((item) => item.path === path);
  const paths = rows.map((item) => item.path);
  assert.ok(paths.indexOf("/k") < paths.indexOf("/root"));
  assert.equal(row("/k")?.prefix, "");
  assert.equal(row("/k/child")?.prefix, "└─ ");
  for (const placeholder of ["/root/gone", "/missing", "/root/missing"]) {
    assert.equal(row(placeholder)?.thread, undefined, placeholder);
    assert.equal(row(placeholder)?.hasChildren, true, placeholder);
  }
  for (const real of ["/root/gone/child", "/missing/leaf", "/elsewhere", deep])
    assert.ok(row(real)?.thread, real);
  for (let depth = 1; depth <= 32; depth++)
    assert.ok(row(`/${segments.slice(0, depth).join("/")}`), `depth ${depth}`);
});

test("status dialog renders live, sanitized hierarchy and keeps the selected path", () => {
  let threads = [
    thread("/k", { parent: null, state: "completed", type: "reviewer" }),
    thread("/root/run", { parent: "/root", status: "Digging" }),
    thread("/root/run/pause", {
      parent: "/root/run",
      state: "paused",
      status: "Waiting on review",
      task: "Read the diff",
      elapsedMs: 65_000,
      inputTokens: 1234,
      outputTokens: 34,
    }),
    thread("/root/gone/child", {
      parent: "/root/gone",
      state: "failed",
      status: "bad\x1b[31mred\x00",
    }),
  ];
  let calls = 0;
  let renders = 0;
  const dialog = new StatusDialog(
    host(24, () => renders++),
    theme,
    service(() => {
      calls++;
      return threads;
    }),
    () => {},
  );
  const first = plain(dialog.render(100));
  assert.match(first, /Agents status/);
  assert.match(selectedLine(dialog.render(100)), /\/root/);
  assert.match(first, /missing parent/);
  assert.equal(first.includes("\x1b") || first.includes("\x00"), false);
  assert.match(first, /badred/);
  const beforeKeys = calls;
  dialog.handleInput(DOWN);
  assert.ok(calls > beforeKeys, "input re-reads the live thread list");

  moveTo(dialog, "/root/run/pause");
  threads = threads.map((item) =>
    item.path === "/root/run/pause" ? { ...item, status: "Still waiting" } : item,
  );
  threads.push(thread("/root/aaa", { parent: "/root", state: "starting" }));
  const updated = dialog.render(100);
  const selected = selectedLine(updated);
  assert.ok(showsPath(selected, "/root/run/pause"), "selection follows path, not index");
  assert.match(selected, /Still waiting/);
  assert.match(plain(updated), /\/root\/aaa/);
  assert.match(plain(updated), /Read the diff/);
  assert.match(plain(updated), /1m5s ↑1\.2k ↓34/);
  const beforeRefresh = renders;
  dialog.handleInput("r");
  assert.equal(renders, beforeRefresh + 1);
});

test("status dialog folds, pages, and confirms only real threads", () => {
  const threads = [
    thread("/root/run", { parent: "/root" }),
    thread("/root/run/pause", { parent: "/root/run", state: "paused" }),
    thread("/root/gone/child", { parent: "/root/gone", state: "stopped" }),
    ...Array.from({ length: 40 }, (_, index) =>
      thread(`/root/item-${String(index + 1).padStart(2, "0")}`, {
        parent: "/root",
        state: "completed",
      }),
    ),
  ];
  const chosen: Array<string | undefined> = [];
  const dialog = new StatusDialog(
    host(),
    theme,
    service(() => threads),
    (path) => chosen.push(path),
  );
  const selected = () => selectedLine(dialog.render(100));
  dialog.handleInput(ENTER);
  assert.deepEqual(chosen, [], "the main session row is not inspectable");
  moveTo(dialog, "/root/run");
  dialog.handleInput(LEFT);
  assert.equal(plain(dialog.render(100)).includes("/root/run/pause"), false);
  assert.match(selected(), /▸/);
  dialog.handleInput(RIGHT);
  assert.match(selected(), /▾/);
  assert.ok(showsPath(selected(), "/root/run"));
  dialog.handleInput(RIGHT);
  assert.ok(showsPath(selected(), "/root/run/pause"), "right on an open node enters it");
  dialog.handleInput(LEFT);
  assert.ok(showsPath(selected(), "/root/run"), "left on a leaf returns to its parent");
  dialog.handleInput(ENTER);
  assert.deepEqual(chosen, ["/root/run"]);
  dialog.handleInput(END);
  const jumped = selected();
  assert.ok(showsPath(jumped, "/root/run/pause"));
  assert.doesNotMatch(plain(dialog.render(100)), /\/root\/item-01/);
  dialog.handleInput(PAGE_UP);
  assert.notEqual(selected(), jumped);
  dialog.handleInput(HOME);
  assert.match(selected(), /\/root  main/);
  dialog.handleInput(PAGE_DOWN);
  assert.match(selected(), /item-/);
  moveTo(dialog, "/root/gone");
  dialog.handleInput(ENTER);
  assert.deepEqual(chosen, ["/root/run"], "missing-parent placeholders are not inspectable");
  dialog.handleInput(DOWN);
  dialog.handleInput(ENTER);
  dialog.handleInput(ESC);
  assert.deepEqual(chosen, ["/root/run", "/root/gone/child", undefined]);
});

test("status dialog stays inside short and narrow terminals", () => {
  const threads = [
    thread("/root/run", { parent: "/root", status: "x".repeat(200) }),
    thread("/root/run/pause", { parent: "/root/run", state: "paused" }),
  ];
  for (const width of [0, 1, 3, 20, 80]) {
    for (const rows of [1, 3, 4, 8, 24]) {
      for (const title of [undefined, "Agents tree"]) {
        const lines = new StatusDialog(
          host(rows),
          theme,
          service(() => threads),
          () => {},
          "/root/run/pause",
          title,
        ).render(width);
        const height = dialogHeight(host(rows));
        assert.ok(lines.length <= height, `${width}x${rows} emitted ${lines.length} > ${height}`);
        for (const line of lines)
          assert.ok(visibleWidth(line) <= width, `${width}x${rows} ${line}`);
      }
    }
  }
});

test("showAgentStatus refreshes, reopens on the chosen thread, and clears its timer", async () => {
  const clock = trackIntervals();
  let renders = 0;
  let opened = 0;
  const inspected: string[] = [];
  try {
    const ctx = uiContext({
      custom: (factory: Function, options: { overlay: boolean }) => {
        assert.equal(options.overlay, true);
        return new Promise<string | undefined>((resolve) => {
          opened++;
          const component = factory(
            host(24, () => renders++),
            theme,
            {},
            resolve,
          );
          if (opened === 1) {
            assert.equal(clock.delay, 1000);
            clock.refresh();
            assert.equal(renders, 1);
            component.handleInput(ENTER);
            assert.equal(opened, 1);
            component.handleInput(DOWN);
            component.handleInput(ENTER);
          } else {
            assert.ok(showsPath(selectedLine(component.render(100)), "/root/child"));
            resolve(undefined);
          }
        });
      },
    });
    await showAgentStatus(
      ctx,
      service(() => [thread("/root/child", { parent: "/root", state: "paused" })]),
      async (path) => {
        inspected.push(path);
        assert.equal(clock.timers.size, 0, "timer stops while inspecting");
      },
    );
    assert.deepEqual(inspected, ["/root/child"]);
    assert.equal(opened, 2);
    assert.equal(clock.timers.size, 0);

    const failing = uiContext({
      custom: (factory: Function) => {
        factory(host(), theme, {}, () => {});
        throw new Error("closed");
      },
    });
    await assert.rejects(
      () =>
        showAgentStatus(
          failing,
          service(() => []),
        ),
      /closed/,
    );
    assert.equal(clock.timers.size, 0, "timer cleared when the dialog throws");
  } finally {
    clock.restore();
  }
});

test("showAgentStatus inspects through thread select by default; both dialogs decline non-TUI", async () => {
  const child = thread("/root/child", { parent: "/root" });
  const selects: string[] = [];
  let opened = 0;
  const ctx = uiContext({
    select: async (title: string) => {
      selects.push(title);
      return "Back";
    },
    custom: (factory: Function) =>
      new Promise<string | undefined>((resolve) => {
        opened++;
        const component = factory(host(), theme, {}, resolve);
        if (opened === 1) {
          component.handleInput(DOWN);
          component.handleInput(ENTER);
        } else resolve(undefined);
      }),
  });
  await showAgentStatus(
    ctx,
    service(() => [child]),
  );
  assert.equal(opened, 2);
  assert.match(selects[0] ?? "", /\/root\/child/);

  for (const show of [showAgentStatus, showAgentTree]) {
    const notifications: string[] = [];
    let opens = 0;
    const declined = {
      hasUI: true,
      mode: "rpc",
      ui: {
        notify: (text: string) => notifications.push(text),
        custom: () => {
          opens++;
          return Promise.resolve();
        },
      },
    } as unknown as ExtensionCommandContext;
    await show(
      declined,
      service(() => []),
    );
    assert.match(notifications.at(-1) ?? "", /TUI mode/);
    (declined as { hasUI: boolean }).hasUI = false;
    await show(
      declined,
      service(() => []),
    );
    assert.equal(opens, 0);
  }
});

test("showAgentTree uses one dialog session, shows live updates, and returns to the same selection", async () => {
  const clock = trackIntervals();
  let threads = [
    thread("/root/child", { parent: "/root", state: "paused", status: "hold" }),
    thread("/root/child/deep", { parent: "/root/child" }),
  ];
  const tree = launchTree(() => threads);
  try {
    const dialog = await until(() => tree.mounted[0], "tree");
    assert.equal(clock.delay, 1000);
    assert.equal(clock.timers.size, 1);
    assert.equal(treeTitle(dialog.render(100)).agents, 2);

    moveTo(dialog, "/root/child");
    dialog.handleInput(LEFT);
    threads = threads.map((item) =>
      item.path === "/root/child" ? { ...item, status: "updated-hold" } : item,
    );
    const before = tree.renders;
    clock.refresh();
    assert.equal(tree.renders, before + 1);
    const refreshed = plain(dialog.render(100));
    assert.match(refreshed, /updated-hold/);
    assert.equal(refreshed.includes("/root/child/deep"), false, "collapse survives refresh");

    dialog.handleInput(ENTER);
    await tree.selectReady;
    assert.equal(clock.timers.size, 0);
    assert.match(tree.selectTitles[0] ?? "", /\/root\/child/);
    tree.releaseSelect("Back");
    const restored = await until(() => tree.mounted[1], "restored tree");
    assert.ok(showsPath(selectedLine(restored.render(100)), "/root/child"));
    assert.equal(clock.timers.size, 1);
    restored.handleInput(ESC);
    await tree.done;
    assert.equal(clock.timers.size, 0);
    assert.equal(tree.opens, 1);
  } finally {
    await tree.close();
    clock.restore();
  }
});

test("showAgentTree opens on a requested path and scrolls every node with a row range", async () => {
  const leaf = "/root/zzz/a/b/leaf";
  const threads = [
    ...Array.from({ length: 18 }, (_, index) =>
      thread(`/root/item-${String(index + 1).padStart(2, "0")}`, {
        parent: "/root",
        state: "completed",
      }),
    ),
    thread(leaf, { parent: "/root/zzz/a/b", state: "paused", status: "deep\x1b[31m-hold" }),
  ];
  const expected = buildStatusTree(threads, new Set()).map((row) => row.path);
  const tree = launchTree(() => threads, leaf, 12);
  try {
    const dialog = await until(() => tree.mounted[0], "tree");
    assert.ok(showsPath(selectedLine(dialog.render(120)), leaf));
    const range = treeTitle(dialog.render(100));
    assert.equal(range.agents, 19);
    assert.equal(range.total, expected.length);
    assert.equal(range.end, range.total);
    assert.ok(range.start > 1);
    assert.match(plain(dialog.render(100)), /deep-hold/);

    const seen: string[] = [];
    const longestFirst = [...expected].sort((left, right) => right.length - left.length);
    dialog.handleInput(HOME);
    for (let step = 0; step < expected.length; step++) {
      const line = selectedLine(dialog.render(120));
      const path = longestFirst.find((item) => line.includes(item));
      assert.ok(path, line);
      seen.push(path);
      dialog.handleInput(DOWN);
    }
    assert.deepEqual(seen, expected);
    dialog.handleInput(ESC);
    await tree.done;
    assert.equal(tree.opens, 1);
  } finally {
    await tree.close();
  }
});

test("showAgentTree clears the refresh timer on dispose, close, and open failure", async () => {
  const clock = trackIntervals();
  const tree = launchTree(() => [thread("/root/child", { parent: "/root" })]);
  try {
    const dialog = await until(() => tree.mounted[0], "tree");
    assert.equal(clock.timers.size, 1);
    dialog.dispose();
    dialog.dispose();
    assert.equal(clock.timers.size, 0);
    clock.refresh();
    assert.equal(clock.timers.size, 0, "refresh after dispose does not restart");
    dialog.handleInput(ESC);
    await tree.done;
    assert.equal(clock.timers.size, 0);
  } finally {
    await tree.close();
    clock.restore();
  }

  const originalSet = globalThis.setInterval;
  globalThis.setInterval = (() => {
    throw new Error("interval failed");
  }) as typeof setInterval;
  try {
    const ctx = uiContext({
      custom: (factory: Function) =>
        new Promise((resolve) => {
          factory(
            { requestRender() {}, setFocus() {}, terminal: { rows: 24 } },
            theme,
            {},
            resolve,
          );
        }),
    });
    await assert.rejects(
      () =>
        showAgentTree(
          ctx,
          service(() => []),
        ),
      /interval failed/,
    );
  } finally {
    globalThis.setInterval = originalSet;
  }
});
