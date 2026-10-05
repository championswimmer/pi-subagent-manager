import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { Theme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AGENT_COLORS } from "../src/prefs/config.ts";
import { buildStatusTree, type StatusRow } from "../src/ui/status-ui.ts";
import { renderAgentSummary, renderAgentTree, updateWidget } from "../src/ui/ui.ts";
import type { ThreadView } from "../src/types.ts";

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
    color: "accent",
    ...patch,
    path,
  };
}

function testTheme(appearance: "dark" | "light" = "dark"): Theme {
  const foreground = appearance === "dark" ? "#eeeeee" : "#111111";
  const background = appearance === "dark" ? "#111111" : "#eeeeee";
  const colors = {
    ...Object.fromEntries(AGENT_COLORS.map((token) => [token, foreground])),
    accent: appearance === "dark" ? "#60a5fa" : "#1e40af",
    success: "#166534",
    warning: "#facc15",
    error: "#b91c1c",
    muted: appearance === "dark" ? "#9ca3af" : "#374151",
  } as ConstructorParameters<typeof Theme>[0];
  const backgrounds = Object.fromEntries(
    [
      "selectedBg",
      "searchMatchBg",
      "userMessageBg",
      "customMessageBg",
      "toolPendingBg",
      "toolSuccessBg",
      "toolErrorBg",
    ].map((token) => [token, background]),
  ) as ConstructorParameters<typeof Theme>[1];
  return new Theme(colors, backgrounds, "truecolor", { appearance });
}

const theme = testTheme();

function plain(lines: string[]): string[] {
  return lines.map((line) => stripTerminalSequences(line));
}

function lineOf(lines: string[], text: string): string {
  const found = plain(lines).find((line) => line.includes(text));
  assert.ok(found, text);
  return found;
}

function indexOf(lines: string[], text: string): number {
  const index = plain(lines).findIndex((line) => line.includes(text));
  assert.ok(index >= 0, text);
  return index;
}

test("overflow previews select the most recent agents within a state", () => {
  const threads = Array.from({ length: 9 }, (_, index) =>
    thread(`/root/job-${index}`, { createdAt: index, task: `TASK_${index}` }),
  );
  const lines = plain(renderAgentTree(threads, 120, theme));
  for (let index = 4; index < 9; index++)
    assert.ok(lines.some((line) => line.includes(`TASK_${index}`)));
  for (let index = 0; index < 4; index++)
    assert.ok(!lines.some((line) => line.includes(`TASK_${index}`)));
  assert.match(lines.at(-1)!, /9 running.*\+4 more agents.*Press ←/);
});

test("status tree honors a sibling comparator but cycle repair stays lexical", () => {
  const reverse = (a: string, b: string) => (a < b ? 1 : a > b ? -1 : 0);
  const siblings = [thread("/root/b"), thread("/root/a")];
  const paths = (rows: StatusRow[]) => rows.map((row) => row.path);
  assert.deepEqual(paths(buildStatusTree(siblings, new Set())), ["/root", "/root/a", "/root/b"]);
  assert.deepEqual(paths(buildStatusTree(siblings, new Set(), reverse)), [
    "/root",
    "/root/b",
    "/root/a",
  ]);
  const cycle = buildStatusTree(
    [
      thread("/root/a", { parent: "/root/b" }),
      thread("/root/b", { parent: "/root/a", state: "paused" }),
    ],
    new Set(),
    reverse,
  );
  assert.equal(cycle.find((row) => row.path === "/root/a")?.prefix, "");
  assert.equal(cycle.find((row) => row.path === "/root/b")?.prefix, "└─ ");
});

test("agent tree heading, hierarchy, declared parents, and root exclusion", () => {
  const nested = renderAgentTree(
    [
      thread("/root", { type: "main", task: "MAIN_SENTINEL", status: "main" }),
      thread("/root/a", { parent: "/root", state: "running", task: "Parent" }),
      thread("/root/a/b", {
        parent: "/root/a",
        state: "paused",
        task: "Child",
      }),
      thread("/root/a/b/c", {
        parent: "/root/a/b",
        state: "stopped",
        task: "Grand",
        status: "idle",
      }),
      thread("/root/z", { parent: "/root", state: "paused", task: "Sibling" }),
    ],
    120,
    theme,
  );
  const text = plain(nested);
  assert.match(text[0]!, /Agents/);
  assert.match(text[0]!, /1 live · 2 paused$/);
  assert.ok(!text.some((line) => line.includes("MAIN_SENTINEL")));
  assert.ok(indexOf(nested, "Parent") < indexOf(nested, "Child"));
  assert.ok(indexOf(nested, "Child") < indexOf(nested, "Grand"));
  assert.ok(indexOf(nested, "Grand") < indexOf(nested, "Sibling"));
  assert.match(lineOf(nested, "Child"), /^│  └─ /);
  assert.match(lineOf(nested, "Grand"), /^│     └─ /);
  const parentActivity = text[text.indexOf(lineOf(nested, "Parent")) + 1]!;
  assert.match(parentActivity, /^│/);

  const declared = renderAgentTree(
    [
      thread("/team", { parent: null, state: "running", task: "Lead" }),
      thread("/other/place", {
        parent: "/team",
        state: "paused",
        task: "Delegate",
        status: "waiting",
      }),
      thread("/team/not-child", {
        parent: "/elsewhere",
        state: "completed",
        task: "Away",
        status: "done",
      }),
    ],
    120,
    theme,
  );
  const declaredText = plain(declared);
  assert.ok(indexOf(declared, "Lead") < indexOf(declared, "Delegate"));
  const elsewhere = declaredText.findIndex(
    (line) => line.includes("/elsewhere") && line.includes("missing parent"),
  );
  assert.ok(elsewhere >= 0);
  assert.ok(indexOf(declared, "Away") > elsewhere);
  assert.ok(!declaredText.some((line) => /\/other\s+missing parent/.test(line)));

  const indie = renderAgentTree(
    [
      thread("/k", { parent: null, state: "paused", task: "Indie" }),
      thread("/k/child", {
        parent: "/k",
        state: "failed",
        task: "Nested",
        status: "boom",
      }),
    ],
    100,
    theme,
  );
  assert.ok(indexOf(indie, "Indie") < indexOf(indie, "Nested"));
  assert.match(lineOf(indie, "Nested"), /^└─ /);
  assert.doesNotMatch(lineOf(indie, "Indie"), /^[├└]─ /);

  const missing = renderAgentTree(
    [
      thread("/root/gone/child", {
        parent: "/root/gone",
        state: "stopped",
        task: "Hold",
        status: "halted",
      }),
    ],
    100,
    theme,
  );
  const missingText = plain(missing);
  const gone = missingText.findIndex(
    (line) => line.includes("/root/gone") && line.includes("missing parent"),
  );
  assert.ok(gone >= 0);
  assert.ok(indexOf(missing, "Hold") > gone);
  assert.match(lineOf(missing, "Hold"), /└─ /);
});

test("active branches sort before paused before settled, including promoted ancestors", () => {
  const promoted = renderAgentTree(
    [
      thread("/root/a-paused", { state: "paused", task: "Pause" }),
      thread("/root/m-done", { state: "completed", task: "Old" }),
      thread("/root/m-done/live", {
        parent: "/root/m-done",
        state: "running",
        task: "Live",
      }),
      thread("/root/z-run", { state: "running", task: "Run" }),
    ],
    100,
    theme,
  );
  assert.ok(indexOf(promoted, "Old") < indexOf(promoted, "Live"));
  assert.ok(indexOf(promoted, "Live") < indexOf(promoted, "Pause"));
  assert.ok(indexOf(promoted, "Run") < indexOf(promoted, "Pause"));

  const ranked = renderAgentTree(
    [
      thread("/root/stop", { state: "stopped", task: "Halt" }),
      thread("/root/fail", { state: "failed", task: "Boom" }),
      thread("/root/done", { state: "completed", task: "Done" }),
      thread("/root/pause", { state: "paused", task: "Wait" }),
    ],
    100,
    theme,
  );
  assert.ok(indexOf(ranked, "Wait") < indexOf(ranked, "Done"));
  assert.ok(indexOf(ranked, "Wait") < indexOf(ranked, "Boom"));
  assert.ok(indexOf(ranked, "Wait") < indexOf(ranked, "Halt"));

  const roots = renderAgentTree(
    [
      thread("/k", { parent: null, state: "paused", task: "Indie" }),
      thread("/root/run", { parent: "/root", state: "starting", task: "Boot" }),
    ],
    80,
    theme,
  );
  assert.ok(indexOf(roots, "Boot") < indexOf(roots, "Indie"));
});

test("shows task, elapsed tokens, and indented latest activity", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
  try {
    const lines = renderAgentTree(
      [
        thread("/root/job", {
          type: "researcher",
          state: "running",
          task: "Investigate",
          status: "Reading src/ui.ts",
          startedAt: 995_000,
          elapsedMs: 2_000,
          inputTokens: 1_200,
          outputTokens: 34,
        }),
        thread("/root/hold", {
          state: "paused",
          task: "Wait",
          status: "",
          startedAt: 1,
          elapsedMs: 9_000,
          inputTokens: 10,
          outputTokens: 3,
        }),
      ],
      80,
      theme,
    );
    const text = plain(lines);
    assert.match(text[0]!, /1 live · 1 paused$/);
    const job = lineOf(lines, "/root/job");
    assert.match(job, /Investigate/);
    assert.equal(job.includes("Reading"), false);
    assert.ok(job.endsWith("7s ↑1.2k ↓34"), job);
    const activity = text[text.indexOf(job) + 1]!;
    assert.match(activity, /Reading src\/ui\.ts/);
    assert.ok(activity.startsWith("│  ") || activity.startsWith("   "));
    const hold = lineOf(lines, "/root/hold");
    assert.match(hold, /Wait/);
    assert.ok(hold.endsWith("9s ↑10 ↓3"), hold);
    assert.match(text[text.indexOf(hold) + 1]!, /Wait/);
  } finally {
    t.mock.timers.reset();
  }
});

test("sanitizes controls and clips unicode without dropping right counters", () => {
  const hostile = "\x1b[31mred\x1b[0m\x1b]0;owned\x07\n\x00" + "界".repeat(8);
  const segments = ["n0", "n1", "n2", "n3", "n4", "n5", "n6"];
  const leaf = `/root/${segments.join("/")}`;
  const threads = [
    thread(leaf, {
      parent: `/root/${segments.slice(0, -1).join("/")}`,
      type: "bad\x1b[2J",
      task: hostile,
      status: hostile,
      state: "failed",
      color: "\x1b[31mnot-a-token",
    }),
  ];
  const counters = "0s ↑0 ↓0";
  for (const width of [0, 1, 2, 20, 80, 160]) {
    const lines = renderAgentTree(threads, width, theme);
    assert.ok(lines.length <= 12, String(width));
    assert.ok(
      lines.every((line) => visibleWidth(line) <= width),
      String(width),
    );
    assert.ok(
      lines.every((line) => !/[\x00-\x1f\x7f-\x9f]/.test(stripTerminalSequences(line))),
      String(width),
    );
    if (width >= visibleWidth(theme.fg("muted", counters))) {
      const agent = lines.find((line) => line.endsWith(theme.fg("muted", counters)));
      assert.ok(agent, String(width));
      assert.equal(visibleWidth(agent), width);
    }
  }
  const wide = plain(renderAgentTree(threads, 160, theme));
  assert.match(wide.find((line) => line.includes("n6")) ?? "", /界/);
  assert.match(wide.join("\n"), /missing parent/);
});

test("ends below agent activity with running count and browser entry", () => {
  for (const state of ["running", "completed"] as const) {
    const lines = plain(renderAgentTree([thread("/root/job", { state })], 80, theme));
    assert.equal(lines.length, 4);
    assert.equal(lines.at(-1), `${state === "running" ? 1 : 0} running · Press ← to open subagent browser`);
    assert.match(lines.at(-2)!, /Working/);
    assert.doesNotMatch(lines.join("\n"), /Esc:|abort main|more agents/);
  }
});

test("bounds the widget to twelve lines and counts every omitted real agent", () => {
  const many = Array.from({ length: 6 }, (_, index) =>
    thread(`/root/m${index}`, {
      parent: "/root",
      state: "completed",
      task: `Job ${index}`,
      status: `status ${index}`,
    }),
  );
  // Five two-line previews fit between the heading and reserved status strip.
  const five = renderAgentTree(many.slice(0, 5), 80, theme);
  assert.equal(five.length, 12);
  assert.equal(
    plain(five).some((line) => line.includes("more agents")),
    false,
  );
  const six = renderAgentTree(many, 80, theme);
  assert.equal(six.length, 12);
  assert.equal(plain(six).at(-1), "0 running · +1 more agents · Press ← to open subagent browser");
  assert.equal(
    plain(six).some((line) => line.includes("Job 5")),
    false,
  );
  const four = renderAgentTree(many.slice(0, 4), 80, theme);
  assert.equal(four.length, 10);
  assert.equal(
    plain(four).some((line) => line.includes("more agents")),
    false,
  );

  const nested = [
    thread("/root/p", { parent: "/root", state: "running", task: "Parent" }),
    ...Array.from({ length: 6 }, (_, index) =>
      thread(`/root/p/c${index}`, {
        parent: "/root/p",
        state: "running",
        task: `Child ${index}`,
      }),
    ),
  ];
  const packed = renderAgentTree(nested, 90, theme);
  assert.equal(packed.length, 12);
  assert.match(plain(packed)[0]!, /7 live · 0 paused$/);
  assert.equal(plain(packed).at(-1), "7 running · +2 more agents · Press ← to open subagent browser");
  assert.ok(indexOf(packed, "Parent") < indexOf(packed, "Child 0"));
  assert.match(plain(packed).join("\n"), /Child 3/);
  assert.equal(
    plain(packed).some((line) => line.includes("Child 4")),
    false,
  );
});

test("live branches cannot be hidden by settled descendants", () => {
  const lines = renderAgentTree(
    [
      thread("/root/a", { task: "Active parent" }),
      ...Array.from({ length: 4 }, (_, index) =>
        thread(`/root/a/done${index}`, {
          state: "completed",
          task: `Settled child ${index}`,
        }),
      ),
      thread("/root/z", { task: "Other active branch" }),
    ],
    100,
    theme,
  );
  assert.equal(lines.length, 12);
  assert.match(plain(lines)[0]!, /2 live · 0 paused$/);
  assert.ok(indexOf(lines, "Active parent") < indexOf(lines, "Settled child 0"));
  assert.ok(indexOf(lines, "Other active branch") >= 0);
  assert.equal(plain(lines).at(-1), "2 running · +1 more agents · Press ← to open subagent browser");
});

test("browser strip counts unique real starting/running agents and clips safely", () => {
  const threads = [
    thread("/root"),
    thread("/root/a", { state: "starting" }),
    thread("/root/a", { state: "running" }),
    thread("/root/missing/b"),
    thread("/root/paused", { state: "paused" }),
    thread("/root/stopped", { state: "stopped" }),
    thread("/root/failed", { state: "failed" }),
    thread("/root/completed", { state: "completed" }),
  ];
  const before = structuredClone(threads);
  for (const width of [0, 1, 2, 8, 20, 40, 80, 120]) {
    const lines = renderAgentTree(threads, width, theme);
    assert.ok(lines.length <= 12);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), String(width));
    if (width >= 80) {
      const footer = lines.at(-1)!;
      assert.equal(stripTerminalSequences(footer), "2 running · +2 more agents · Press ← to open subagent browser");
      assert.ok(footer.includes(theme.fg("accent", "2 running")));
      assert.ok(footer.includes(theme.fg("muted", " · +2 more agents · Press ← to open subagent browser")));
    }
  }
  assert.deepEqual(threads, before);
});

test("cycle rendering stays finite and keeps both agents with their parent row", () => {
  const threads = [
    thread("/root/a", { parent: "/root/b", state: "running", task: "Alpha" }),
    thread("/root/b", { parent: "/root/a", state: "paused", task: "Beta" }),
  ];
  const snapshot = structuredClone(threads);
  const lines = renderAgentTree(threads, 80, theme);
  assert.deepEqual(threads, snapshot);
  assert.ok(lines.length <= 12);
  assert.ok(indexOf(lines, "Alpha") < indexOf(lines, "Beta"));
  assert.match(lineOf(lines, "Beta"), /└─ |├─ /);
  assert.equal(renderAgentTree([], 80, theme).length, 0);
  assert.deepEqual(renderAgentTree([thread("/root", { task: "MAIN_SENTINEL" })], 80, theme), []);
});

test("updateWidget pins the tree above the editor, clears when empty, and uses strings in RPC", () => {
  const calls: { content: unknown; options: unknown }[] = [];
  const context = (mode?: string, hasUI = true) =>
    ({
      hasUI,
      mode,
      ui: {
        theme,
        setWidget: (_key: string, content: unknown, options: unknown) => {
          calls.push({ content, options });
        },
      },
    }) as unknown as ExtensionContext;
  const ctx = context();
  updateWidget(ctx, [thread("/root/job", { state: "completed", task: "Done" })]);
  const widget = (
    calls[0]!.content as (tui: { requestRender(): void }) => {
      render(width: number): string[];
      dispose(): void;
    }
  )({ requestRender() {} });
  assert.match(plain(widget.render(80)).join("\n"), /Agents[\s\S]*Done/);
  assert.equal(plain(widget.render(80)).at(-1), "0 running · Press ← to open subagent browser");
  widget.dispose();

  updateWidget(ctx, []);
  updateWidget(ctx, [thread("/root")]);
  assert.deepEqual(
    calls.slice(1).map((call) => call.content),
    [undefined, undefined],
  );
  assert.ok(
    calls.every((call) => (call.options as { placement: string }).placement === "aboveEditor"),
  );

  calls.length = 0;
  updateWidget(context("rpc"), [thread("/root/job", { status: "Digging", startedAt: Date.now() })]);
  const rpcLines = calls[0]!.content as string[];
  assert.ok(Array.isArray(rpcLines) && rpcLines.length <= 12);
  assert.ok(rpcLines.every((line) => visibleWidth(line) <= 80));
  assert.match(plain(rpcLines).join("\n"), /Agents[\s\S]*Digging/);
  assert.equal(plain(rpcLines).at(-1), "1 running");
  assert.doesNotMatch(plain(rpcLines).join("\n"), /Press ←/);

  calls.length = 0;
  updateWidget(context("rpc", false), [thread("/hidden")]);
  assert.equal(calls.length, 0);
});

test("minimal summary counts unique real agents with semantic colors and active-only token sums", () => {
  const threads = [
    thread("/root", { inputTokens: 999_999, outputTokens: 999_999 }),
    thread("/root/a", { inputTokens: 1_100, outputTokens: 12 }),
    thread("/root/missing/b", { inputTokens: 100, outputTokens: 13 }),
    thread("/independent", { state: "starting", inputTokens: 200, outputTokens: 14 }),
    thread("/root/stopped1", { state: "stopped", inputTokens: 50_000, outputTokens: 50_000 }),
    thread("/root/stopped2", { state: "stopped", inputTokens: 50_000, outputTokens: 50_000 }),
    thread("/root/failed", { state: "failed", inputTokens: 50_000, outputTokens: 50_000 }),
    thread("/root/paused", { state: "paused", inputTokens: 50_000, outputTokens: 50_000 }),
    thread("/root/completed", { state: "completed", inputTokens: 50_000, outputTokens: 50_000 }),
    // Match the full tree's first occurrence wins rule; neither duplicates nor missing parents count.
    thread("/root/a", { inputTokens: 999_999, outputTokens: 999_999 }),
  ];
  const before = structuredClone(threads);
  const lines = renderAgentSummary(threads, 100, theme);
  assert.equal(lines.length, 2);
  assert.equal(plain(lines)[1], "Press ← to open subagent browser");
  const line = lines[0]!;
  assert.match(plain(lines)[0]!, /^3 running, 2 stopped, 1 failed, 1 paused, 1 completed\s+↑1\.4k ↓39$/);
  for (const [color, text] of [
    ["accent", "3 running"],
    ["muted", "2 stopped"],
    ["error", "1 failed"],
    ["warning", "1 paused"],
    ["success", "1 completed"],
    ["muted", "↑1.4k ↓39"],
  ] as const) {
    assert.ok(line.includes(theme.fg(color, text)), `${color}: ${text}`);
  }
  assert.equal(visibleWidth(line), 100);
  assert.doesNotMatch(plain(lines)[0]!, /Agents|missing parent|\/root|Esc:|starting/);
  assert.deepEqual(threads, before);
});

test("minimal summary handles empty and settled agents, metrics boundaries, and narrow widths", () => {
  assert.deepEqual(renderAgentSummary([], 80, theme), []);
  assert.deepEqual(renderAgentSummary([thread("/root")], 80, theme), []);
  const settled = [
    thread("/root/completed", { state: "completed", inputTokens: 100, outputTokens: 200 }),
  ];
  assert.match(plain(renderAgentSummary(settled, 80, theme))[0]!, /^0 running, 1 completed\s+↑0 ↓0$/);

  const threads = [
    thread("/root/a", { inputTokens: 1_000_000, outputTokens: 1_500_000 }),
    thread("/root/b", { inputTokens: Number.NaN, outputTokens: -1 }),
    thread("/root/c", { inputTokens: Number.POSITIVE_INFINITY, outputTokens: 0.9 }),
    ...Array.from({ length: 20 }, (_, index) =>
      thread(`/root/paused${index}`, { state: "paused", inputTokens: 5_000, outputTokens: 6_000 }),
    ),
  ];
  assert.match(plain(renderAgentSummary(threads, 100, theme))[0]!, /^3 running, 20 paused\s+↑1m ↓1.5m$/);
  const counters = theme.fg("muted", "↑1m ↓1.5m");
  for (const width of [0, 1, 2, 4, 9, 10, 20, 40, 80, 100]) {
    const lines = renderAgentSummary(threads, width, theme);
    assert.equal(lines.length, 2);
    assert.ok(lines.every((line) => visibleWidth(line) <= width), String(width));
    const line = lines[0]!;
    assert.ok(visibleWidth(line) <= width, String(width));
    assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(stripTerminalSequences(line)));
    if (width >= visibleWidth(counters)) assert.ok(line.endsWith(counters), String(width));
  }
});

test("updateWidget retains full default and switches minimal/full in TUI and RPC", () => {
  const calls: { content: unknown; options: unknown }[] = [];
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      theme,
      setWidget: (_key: string, content: unknown, options: unknown) => {
        calls.push({ content, options });
      },
    },
  } as unknown as ExtensionContext;
  const threads = [thread("/root/job", { state: "completed", task: "Done" })];
  const renderLast = () => {
    const component = (calls.at(-1)!.content as (tui: { requestRender(): void }) => {
      render(width: number): string[];
      dispose(): void;
    })({ requestRender() {} });
    const lines = component.render(80);
    component.dispose();
    return lines;
  };
  updateWidget(ctx, threads);
  const full = renderLast();
  assert.deepEqual(full, renderAgentTree(threads, 80, theme));
  updateWidget(ctx, threads, "minimal");
  assert.deepEqual(renderLast(), renderAgentSummary(threads, 80, theme));
  updateWidget(ctx, threads, "full");
  assert.deepEqual(renderLast(), full);

  ctx.mode = "rpc";
  updateWidget(ctx, threads, "minimal");
  assert.deepEqual(calls.at(-1)!.content, renderAgentSummary(threads, 80, theme, { showBrowserHint: false }));
  assert.doesNotMatch(plain(calls.at(-1)!.content as string[]).join("\n"), /Press ←/);
  updateWidget(ctx, threads, "full");
  assert.deepEqual(calls.at(-1)!.content, renderAgentTree(threads, 80, theme, { showBrowserHint: false }));
  updateWidget(ctx, [], "minimal");
  assert.equal(calls.at(-1)!.content, undefined);
  updateWidget(ctx, [thread("/root")], "minimal");
  assert.equal(calls.at(-1)!.content, undefined);
  assert.ok(calls.every((call) => (call.options as { placement: string }).placement === "aboveEditor"));
});

test("full widget status strip resolves the current theme at render time", () => {
  let content: unknown;
  let current = theme;
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      get theme() { return current; },
      setWidget: (_key: string, value: unknown) => { content = value; },
    },
  } as unknown as ExtensionContext;
  updateWidget(ctx, [thread("/root/job", { state: "completed" })]);
  const component = (content as (tui: { requestRender(): void }) => {
    render(width: number): string[];
    invalidate(): void;
    dispose(): void;
  })({ requestRender() {} });
  const first = component.render(80);
  current = testTheme("light");
  component.invalidate();
  const second = component.render(80);
  assert.deepEqual(plain(second), plain(first));
  assert.notEqual(second.at(-1), first.at(-1));
  assert.equal(second.at(-1), current.fg("accent", "0 running") + current.fg("muted", " · Press ← to open subagent browser"));
  component.dispose();
});

test("minimal widget resolves live themes without allocating elapsed-time timers", (t) => {
  let content: unknown;
  let current = theme;
  const interval = t.mock.method(globalThis, "setInterval", () => {
    throw new Error("minimal mode has no elapsed time to repaint");
  });
  const ctx = {
    hasUI: true,
    mode: "tui",
    ui: {
      get theme() { return current; },
      setWidget: (_key: string, value: unknown) => { content = value; },
    },
  } as unknown as ExtensionContext;
  updateWidget(ctx, [thread("/root/job", { inputTokens: 12, outputTokens: 3 })], "minimal");
  const component = (content as (tui: { requestRender(): void }) => {
    render(width: number): string[];
    invalidate(): void;
    dispose(): void;
  })({ requestRender() {} });
  const first = component.render(80);
  assert.ok(first[0]!.includes(current.fg("accent", "1 running")));
  current = testTheme("light");
  component.invalidate();
  const second = component.render(80);
  assert.notDeepEqual(second, first);
  assert.deepEqual(plain(second), plain(first));
  assert.ok(second[0]!.includes(current.fg("accent", "1 running")));
  assert.ok(second[0]!.endsWith(current.fg("muted", "↑12 ↓3")));
  assert.equal(second[1], current.fg("muted", "Press ← to open subagent browser"));
  assert.equal(interval.mock.callCount(), 0);
  component.dispose();
});
