import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { dialogHeight, type DialogHost } from "../src/dialog.ts";
import {
  buildStatusTree,
  showAgentStatus,
  StatusDialog,
} from "../src/status-ui.ts";
import type { ThreadService, ThreadState, ThreadView } from "../src/types.ts";

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
  return {
    requestRender() {
      onRender?.();
    },
    terminal: { rows },
  };
}

function service(list: () => ThreadView[]): ThreadService {
  return { list } as ThreadService;
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
  for (
    let step = 0;
    step < 80 && !showsPath(selectedLine(dialog.render(120)), path);
    step++
  )
    dialog.handleInput(DOWN);
  assert.ok(showsPath(selectedLine(dialog.render(120)), path), path);
}

test("status tree keeps every state, nests paused work, and sorts siblings", () => {
  const states: ThreadState[] = [
    "starting",
    "running",
    "paused",
    "completed",
    "failed",
    "stopped",
  ];
  const threads = [
    ...states.map((state) =>
      thread(`/root/${state}`, { parent: "/root", state, status: state }),
    ),
    thread("/root/running/paused-child", {
      parent: "/root/running",
      state: "paused",
      status: "Waiting on review",
    }),
    thread("/root/b", { parent: "/root", state: "failed" }),
    thread("/root/a", { parent: "/root", state: "completed" }),
  ];
  const rows = buildStatusTree(threads, new Set());
  for (const state of states) {
    assert.equal(
      rows.find((row) => row.path === `/root/${state}`)?.thread?.state,
      state,
    );
  }
  const child = rows.find((row) => row.path === "/root/running/paused-child");
  assert.equal(child?.thread?.state, "paused");
  assert.match(child?.prefix ?? "", /└─ /);
  assert.match(
    rows.find((row) => row.path === "/root/running")?.prefix ?? "",
    /├─ |└─ /,
  );
  const rootIndex = rows.findIndex((row) => row.path === "/root");
  const childPaths = rows.slice(rootIndex + 1).map((row) => row.path);
  assert.deepEqual(
    childPaths.filter((path) => path.split("/").length === 3),
    [
      "/root/a",
      "/root/b",
      "/root/completed",
      "/root/failed",
      "/root/paused",
      "/root/running",
      "/root/starting",
      "/root/stopped",
    ],
  );
  assert.equal(rows.find((row) => row.path === "/root/a")?.prefix, "├─ ");
  assert.equal(rows.at(-1)?.prefix.endsWith("└─ "), true);
  const nested = rows.find((row) => row.path === "/root/running/paused-child");
  assert.match(nested?.prefix ?? "", /│  └─ |   └─ /);
});

test("status tree shows independent roots, missing parents, and depth 32", () => {
  const segments = Array.from({ length: 32 }, (_, index) => `n${index}`);
  const deep = `/${segments.join("/")}`;
  const rows = buildStatusTree(
    [
      thread("/k", { parent: null, state: "completed", status: "done" }),
      thread("/k/child", { parent: "/k", state: "failed", status: "boom" }),
      thread("/root/gone/child", {
        parent: "/root/gone",
        state: "paused",
        status: "held",
      }),
      thread("/missing/leaf", {
        parent: "/missing",
        state: "stopped",
        status: "halted",
      }),
      thread("/elsewhere", { parent: "/root/missing/node", state: "starting" }),
      thread(deep, {
        parent: `/${segments.slice(0, -1).join("/")}`,
        state: "stopped",
      }),
    ],
    new Set(),
  );
  const paths = rows.map((row) => row.path);
  assert.ok(paths.indexOf("/k") < paths.indexOf("/root"));
  assert.equal(rows.find((row) => row.path === "/k")?.prefix, "");
  assert.equal(rows.find((row) => row.path === "/k/child")?.prefix, "└─ ");
  assert.equal(
    rows.find((row) => row.path === "/k/child")?.thread?.state,
    "failed",
  );
  const placeholder = rows.find((row) => row.path === "/root/gone");
  assert.equal(placeholder?.thread, undefined);
  assert.equal(placeholder?.hasChildren, true);
  assert.equal(
    rows.find((row) => row.path === "/root/gone/child")?.thread?.state,
    "paused",
  );
  assert.equal(rows.find((row) => row.path === "/missing")?.thread, undefined);
  assert.equal(
    rows.find((row) => row.path === "/missing/leaf")?.thread?.state,
    "stopped",
  );
  assert.equal(
    rows.find((row) => row.path === "/root/missing")?.thread,
    undefined,
  );
  assert.equal(
    rows.find((row) => row.path === "/elsewhere")?.thread?.state,
    "starting",
  );
  for (let depth = 1; depth <= 32; depth++) {
    const ancestor = `/${segments.slice(0, depth).join("/")}`;
    assert.ok(
      rows.some((row) => row.path === ancestor),
      ancestor,
    );
  }
  assert.equal(rows.find((row) => row.path === deep)?.thread?.state, "stopped");
  assert.ok(rows.some((row) => row.path === "/root"));
});

test("collapsed parents hide descendants without forgetting they have children", () => {
  const threads = [
    thread("/root/run", { parent: "/root", state: "running" }),
    thread("/root/run/pause", { parent: "/root/run", state: "paused" }),
  ];
  const open = buildStatusTree(threads, new Set());
  assert.equal(
    open.some((row) => row.path === "/root/run/pause"),
    true,
  );
  const folded = buildStatusTree(threads, new Set(["/root/run"]));
  assert.equal(
    folded.find((row) => row.path === "/root/run")?.hasChildren,
    true,
  );
  assert.equal(
    folded.some((row) => row.path === "/root/run/pause"),
    false,
  );
  assert.equal(
    folded.some((row) => row.path === "/root"),
    true,
  );
});

test("status dialog renders live hierarchy and keeps the selected path", () => {
  let threads = [
    thread("/k", {
      parent: null,
      state: "completed",
      type: "reviewer",
      status: "done",
    }),
    thread("/root/run", {
      parent: "/root",
      state: "running",
      type: "worker",
      status: "Digging",
      task: "Dig",
    }),
    thread("/root/run/pause", {
      parent: "/root/run",
      state: "paused",
      type: "worker",
      status: "Waiting on review",
      task: "Read the diff",
      elapsedMs: 65_000,
      inputTokens: 1234,
      outputTokens: 34,
    }),
    thread("/root/gone/child", {
      parent: "/root/gone",
      state: "failed",
      status: "bad\x1b[31mred",
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
  assert.match(first, /Esc close/);
  assert.match(selectedLine(dialog.render(100)), /\/root/);
  assert.match(first, /\/k/);
  assert.doesNotMatch(
    first.split("\n").find((line) => /\/k  /.test(line)) ?? "",
    /[├└]─ \/k/,
  );
  assert.match(first, /running/);
  assert.match(first, /paused/);
  assert.match(first, /missing parent/);
  assert.match(first, /├─ |└─ /);
  assert.match(first, /│|▾/);
  assert.equal(calls, 2);
  const beforeKeys = calls;
  dialog.handleInput(DOWN);
  assert.ok(calls > beforeKeys);
  moveTo(dialog, "/root/run/pause");
  threads = threads.map((item) =>
    item.path === "/root/run/pause"
      ? { ...item, state: "paused", status: "Still waiting" }
      : item,
  );
  threads.push(
    thread("/root/aaa", { parent: "/root", state: "starting", status: "boot" }),
  );
  const updated = dialog.render(100);
  const selected = selectedLine(updated);
  assert.ok(showsPath(selected, "/root/run/pause"));
  assert.match(selected, /paused/);
  assert.match(selected, /Still waiting/);
  assert.doesNotMatch(selected, /running/);
  assert.match(plain(updated), /starting/);
  assert.match(plain(updated), /Read the diff/);
  assert.match(plain(updated), /1m5s ↑1\.2k ↓34/);
  assert.doesNotMatch(plain(updated), /\x1b\[31m/);
  assert.match(plain(updated), /badred/);
  const beforeRefresh = renders;
  dialog.handleInput("r");
  assert.equal(renders, beforeRefresh + 1);
});

test("status dialog folds, pages, and confirms only real threads", () => {
  const threads = [
    thread("/root/run", { parent: "/root", state: "running" }),
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
  dialog.render(100);
  dialog.handleInput(ENTER);
  assert.deepEqual(chosen, []);
  moveTo(dialog, "/root/run");
  dialog.handleInput(LEFT);
  assert.equal(plain(dialog.render(100)).includes("/root/run/pause"), false);
  assert.match(selectedLine(dialog.render(100)), /▸/);
  dialog.handleInput(RIGHT);
  assert.match(selectedLine(dialog.render(100)), /▾/);
  assert.ok(showsPath(selectedLine(dialog.render(100)), "/root/run"));
  dialog.handleInput(RIGHT);
  assert.ok(showsPath(selectedLine(dialog.render(100)), "/root/run/pause"));
  dialog.handleInput(LEFT);
  assert.ok(showsPath(selectedLine(dialog.render(100)), "/root/run"));
  dialog.handleInput(ENTER);
  assert.deepEqual(chosen, ["/root/run"]);
  dialog.handleInput(END);
  const jumped = selectedLine(dialog.render(90));
  assert.ok(showsPath(jumped, "/root/run/pause"));
  assert.doesNotMatch(plain(dialog.render(90)), /\/root\/item-01/);
  assert.match(plain(dialog.render(90)), /Esc close/);
  dialog.handleInput(PAGE_UP);
  assert.notEqual(selectedLine(dialog.render(90)), jumped);
  dialog.handleInput(HOME);
  assert.match(selectedLine(dialog.render(90)), /\/root  main/);
  dialog.handleInput(PAGE_DOWN);
  assert.match(selectedLine(dialog.render(90)), /item-/);
  moveTo(dialog, "/root/gone");
  dialog.handleInput(ENTER);
  assert.deepEqual(chosen, ["/root/run"]);
  dialog.handleInput(DOWN);
  dialog.handleInput(ENTER);
  assert.deepEqual(chosen, ["/root/run", "/root/gone/child"]);
  dialog.handleInput(ESC);
  assert.deepEqual(chosen, ["/root/run", "/root/gone/child", undefined]);
});

test("status dialog stays inside short and narrow terminals", () => {
  const threads = [
    thread("/root/run", {
      parent: "/root",
      state: "running",
      status: "x".repeat(200),
    }),
    thread("/root/run/pause", { parent: "/root/run", state: "paused" }),
  ];
  for (const width of [0, 1, 3, 20, 40, 80]) {
    for (const rows of [1, 3, 4, 6, 8, 12, 24]) {
      const dialog = new StatusDialog(
        host(rows),
        theme,
        service(() => threads),
        () => {},
      );
      const lines = dialog.render(width);
      const height = dialogHeight(host(rows));
      assert.ok(
        lines.length <= height,
        `${width}x${rows} emitted ${lines.length} > ${height}`,
      );
      for (const line of lines)
        assert.ok(visibleWidth(line) <= width, `${width}x${rows} ${line}`);
      if (width >= 20 && height >= 4) {
        const text = lines.map((line) => stripTerminalSequences(line));
        assert.match(text[0]!, /^╭.*╮$/);
        assert.match(text.at(-1)!, /^╰.*╯$/);
        assert.match(text.at(-2)!, /Esc/);
        assert.ok(
          text
            .slice(1, -1)
            .every((line) => line.startsWith("│") || line.startsWith("├")),
        );
      }
    }
  }
});

test("showAgentStatus refreshes, reopens on the chosen thread, and clears its timer", async () => {
  const child = thread("/root/child", {
    parent: "/root",
    state: "paused",
    status: "hold",
  });
  const timers = new Set<ReturnType<typeof setInterval>>();
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  let refresh: (() => void) | undefined;
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
  let renders = 0;
  let opened = 0;
  const inspected: string[] = [];
  try {
    const ctx = {
      hasUI: true,
      mode: "tui",
      ui: {
        notify() {},
        custom: (factory: Function, options: { overlay: boolean }) => {
          assert.equal(options.overlay, true);
          return new Promise<string | undefined>((resolve) => {
            opened++;
            const component = factory(
              {
                requestRender() {
                  renders++;
                },
                terminal: { rows: 24 },
              },
              theme,
              {},
              resolve,
            );
            const text = plain(component.render(100));
            assert.match(text, /Agents status/);
            assert.match(text, /\/root/);
            if (opened === 1) {
              assert.equal(delay, 1000);
              refresh?.();
              assert.equal(renders, 1);
              component.handleInput(ENTER);
              assert.equal(opened, 1);
              component.handleInput(DOWN);
              component.handleInput(ENTER);
            } else {
              assert.ok(
                showsPath(selectedLine(component.render(100)), "/root/child"),
              );
              resolve(undefined);
            }
          });
        },
      },
    } as unknown as ExtensionCommandContext;
    await showAgentStatus(
      ctx,
      service(() => [child]),
      async (path) => {
        inspected.push(path);
        assert.equal(timers.size, 0);
      },
    );
    assert.deepEqual(inspected, ["/root/child"]);
    assert.equal(opened, 2);
    assert.equal(timers.size, 0);
  } finally {
    globalThis.setInterval = originalSet;
    globalThis.clearInterval = originalClear;
    for (const timer of timers) originalClear(timer);
  }
});

test("showAgentStatus clears the refresh timer when the dialog throws", async () => {
  const timers = new Set<ReturnType<typeof setInterval>>();
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  globalThis.setInterval = ((fn: () => void, ms?: number) => {
    const timer = originalSet(fn, ms);
    timers.add(timer);
    return timer;
  }) as typeof setInterval;
  globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => {
    timers.delete(timer);
    return originalClear(timer);
  }) as typeof clearInterval;
  try {
    const ctx = {
      hasUI: true,
      mode: "tui",
      ui: {
        notify() {},
        custom: (factory: Function) => {
          factory(
            { requestRender() {}, terminal: { rows: 24 } },
            theme,
            {},
            () => {},
          );
          throw new Error("closed");
        },
      },
    } as unknown as ExtensionCommandContext;
    await assert.rejects(
      () =>
        showAgentStatus(
          ctx,
          service(() => []),
        ),
      /closed/,
    );
    assert.equal(timers.size, 0);
  } finally {
    globalThis.setInterval = originalSet;
    globalThis.clearInterval = originalClear;
    for (const timer of timers) originalClear(timer);
  }
});

test("showAgentStatus falls back to thread inspection and declines non-TUI", async () => {
  const child = thread("/root/child", {
    parent: "/root",
    state: "running",
    status: "go",
  });
  const selects: string[] = [];
  const notifications: string[] = [];
  let opened = 0;
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      notify(text: string) {
        notifications.push(text);
      },
      select: async (title: string) => {
        selects.push(title);
        return "Back";
      },
      custom: (
        factory: Function,
        options: { overlay: boolean; overlayOptions: { anchor: string } },
      ) => {
        assert.equal(options.overlay, true);
        assert.equal(options.overlayOptions.anchor, "center");
        return new Promise<string | undefined>((resolve) => {
          opened++;
          const component = factory(host(), theme, {}, resolve);
          component.render(80);
          if (opened === 1) {
            component.handleInput(DOWN);
            component.handleInput(ENTER);
          } else resolve(undefined);
        });
      },
    },
  } as unknown as ExtensionCommandContext;
  await showAgentStatus(ctx, {
    list: () => [child],
    get: (path: string) => {
      assert.equal(path, "/root/child");
      return child;
    },
  } as ThreadService);
  assert.equal(opened, 2);
  assert.match(selects[0] ?? "", /\/root\/child/);
  ctx.mode = "rpc";
  await showAgentStatus(
    ctx,
    service(() => []),
  );
  assert.equal(opened, 2);
  assert.match(notifications.at(-1) ?? "", /TUI mode/);
  ctx.hasUI = false;
  await showAgentStatus(
    ctx,
    service(() => []),
  );
  assert.equal(opened, 2);
});
