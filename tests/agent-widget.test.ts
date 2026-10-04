import assert from "node:assert/strict";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { Theme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AGENT_COLORS } from "../src/prefs/config.ts";
import { buildStatusTree, type StatusRow } from "../src/ui/status-ui.ts";
import { renderAgentTree, updateWidget } from "../src/ui/ui.ts";
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

function testTheme(): Theme {
  const foreground = "#eeeeee";
  const background = "#111111";
  const colors = {
    ...Object.fromEntries(AGENT_COLORS.map((token) => [token, foreground])),
    accent: "#60a5fa",
    success: "#166534",
    warning: "#facc15",
    error: "#b91c1c",
    muted: "#9ca3af",
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
  return new Theme(colors, backgrounds, "truecolor", { appearance: "dark" });
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
    assert.ok(lines.length <= 10, String(width));
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

test("bounds the widget to ten lines and counts every omitted real agent", () => {
  const many = Array.from({ length: 6 }, (_, index) =>
    thread(`/root/m${index}`, {
      parent: "/root",
      state: "completed",
      task: `Job ${index}`,
      status: `status ${index}`,
    }),
  );
  const five = renderAgentTree(many.slice(0, 5), 80, theme);
  assert.equal(five.length, 10);
  assert.match(plain(five).at(-1)!, /^\+1 more agents · \/agents tree$/);
  assert.equal(
    plain(five).some((line) => line.includes("Job 4")),
    false,
  );
  const six = renderAgentTree(many, 80, theme);
  assert.equal(six.length, 10);
  assert.match(plain(six).at(-1)!, /^\+2 more agents · \/agents tree$/);
  const four = renderAgentTree(many.slice(0, 4), 80, theme);
  assert.equal(four.length, 9);
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
  assert.equal(packed.length, 10);
  assert.match(plain(packed)[0]!, /7 live · 0 paused$/);
  assert.match(plain(packed).at(-1)!, /^\+3 more agents · \/agents tree$/);
  assert.ok(indexOf(packed, "Parent") < indexOf(packed, "Child 0"));
  assert.match(plain(packed).join("\n"), /Child 2/);
  assert.equal(
    plain(packed).some((line) => line.includes("Child 3")),
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
  assert.equal(lines.length, 10);
  assert.match(plain(lines)[0]!, /2 live · 0 paused$/);
  assert.ok(indexOf(lines, "Active parent") < indexOf(lines, "Settled child 0"));
  assert.ok(indexOf(lines, "Other active branch") >= 0);
  assert.match(plain(lines).at(-1)!, /^\+2 more agents/);
});

test("cycle rendering stays finite and keeps both agents with their parent row", () => {
  const threads = [
    thread("/root/a", { parent: "/root/b", state: "running", task: "Alpha" }),
    thread("/root/b", { parent: "/root/a", state: "paused", task: "Beta" }),
  ];
  const snapshot = structuredClone(threads);
  const lines = renderAgentTree(threads, 80, theme);
  assert.deepEqual(threads, snapshot);
  assert.ok(lines.length <= 10);
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
  assert.ok(Array.isArray(rpcLines) && rpcLines.length <= 10);
  assert.ok(rpcLines.every((line) => visibleWidth(line) <= 80));
  assert.match(plain(rpcLines).join("\n"), /Agents[\s\S]*Digging/);

  calls.length = 0;
  updateWidget(context("rpc", false), [thread("/hidden")]);
  assert.equal(calls.length, 0);
});
