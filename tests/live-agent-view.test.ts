import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getMarkdownTheme, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  Markdown,
  visibleWidth,
  stripTerminalSequences,
} from "@earendil-works/pi-tui";
import { LiveAgentView, type AgentViewportState } from "../src/ui/live-agent-view.ts";
import type {
  ThreadService,
  TranscriptListener,
  TranscriptObservation,
  TranscriptSnapshot,
} from "../src/types.ts";

// The live UI uses pi's active Markdown theme, just like the main transcript.
initTheme("dark");
const theme = {
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
} as unknown as Theme;
const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
const message = (content: string): AgentMessage => ({ role: "user", content, timestamp: 0 });
function snapshot(patch: Partial<TranscriptSnapshot> = {}): TranscriptSnapshot {
  return {
    revision: 0,
    generation: 1,
    messages: [],
    assistant: null,
    tools: [],
    inheritedCount: 0,
    thread: {
      path: "/root/a",
      parent: "/root",
      owner: "/root",
      type: "worker",
      state: "running",
      task: "Investigate",
      status: "Working",
      createdAt: 0,
      updatedAt: 0,
    },
    ...patch,
  };
}
function launch(
  initial: TranscriptSnapshot = snapshot(),
  rows = 10,
  viewport: AgentViewportState = { scrollTop: 0, follow: true },
  options: { path?: string; steer?: ThreadService["steer"]; theme?: Theme } = {},
) {
  let listener: TranscriptListener = () => {};
  let unsubscribed = 0;
  let renders = 0;
  const done: string[] = [];
  const steers: Array<{ path: string; message: string }> = [];
  const service = {
    async observeTranscript(_path: string, receive: TranscriptListener) {
      listener = receive;
      return {
        snapshot: initial,
        unsubscribe() {
          unsubscribed++;
        },
      };
    },
    async steer(path: string, message: string) {
      steers.push({ path, message });
      return options.steer ? options.steer(path, message) : initial.thread;
    },
    stop() {
      throw new Error("watch must not stop");
    },
    spawn() {
      throw new Error("watch must not spawn");
    },
  } as unknown as ThreadService;
  const view = new LiveAgentView(
    {
      requestRender() {
        renders++;
      },
      terminal: { rows },
    },
    options.theme ?? theme,
    service,
    options.path ?? "/root/a",
    viewport,
    (value) => done.push(value),
  );
  return {
    view,
    viewport,
    done,
    steers,
    emit: (next: TranscriptSnapshot) => listener(next),
    get renders() {
      return renders;
    },
    get unsubscribed() {
      return unsubscribed;
    },
  };
}

test("live viewer shows assistant/tool streams and browsing never sends input", async () => {
  const live = launch(
    snapshot({ messages: [message("parent context"), message("child task")], inheritedCount: 1 }),
    24,
  );
  await tick();
  let content = live.view.render(120).join("\n");
  assert.match(content, /Watching — main continues/);
  assert.match(content, /inherited messages collapsed/);
  assert.match(content, /child task/);
  assert.doesNotMatch(content, /parent context/);
  live.emit(
    snapshot({
      revision: 1,
      messages: [message("child task")],
      assistant: {
        role: "assistant",
        content: [
          { type: "text", text: "partial assistant" },
          {
            type: "thinking",
            thinking:
              "- private thinking 0\n- private thinking 1\n- private thinking 2\n- private thinking 3",
          },
        ],
      } as AgentMessage,
      tools: [
        {
          toolCallId: "t1",
          toolName: "bash",
          args: { command: "build" },
          state: "running",
          result: { content: [{ type: "text", text: "partial tool output" }] },
        },
      ],
    }),
  );
  content = live.view.render(120).join("\n");
  assert.match(content, /partial assistant/);
  assert.match(content, /\$ build — running/);
  assert.match(content, /partial tool output/);
  // Preview detail shows the first three rendered thinking rows.
  assert.match(content, /private thinking 0/);
  assert.match(content, /private thinking 2/);
  assert.doesNotMatch(content, /private thinking 3/);
  live.view.handleInput("\t"); // Focus transcript controls.
  live.view.handleInput("t"); // Compact detail hides thinking entirely.
  assert.doesNotMatch(live.view.render(120).join("\n"), /private thinking/);
  live.view.handleInput("t"); // Full detail shows every thinking row.
  assert.match(live.view.render(120).join("\n"), /private thinking 3/);
  live.view.handleInput("some text");
  live.view.handleInput("\r");
  assert.deepEqual(live.done, []);
  assert.deepEqual(live.steers, []);
  live.view.handleInput("\x1b");
  assert.deepEqual(live.done, ["back"]);
  live.view.dispose();
  live.view.dispose();
  assert.equal(live.unsubscribed, 1);
});

test("bottom input sends Enter to the inspected descendant through the steering service", async () => {
  for (const state of ["running", "paused", "completed", "stopped", "failed"] as const) {
    const path = "/root/team/worker";
    const initial = snapshot();
    initial.thread = { ...initial.thread!, path, parent: "/root/team", state };
    const live = launch(initial, 10, undefined, { path });
    await tick();
    try {
      live.view.handleInput("\r");
      live.view.handleInput("   ");
      live.view.handleInput("\r");
      assert.deepEqual(live.steers, [], "empty and whitespace-only input do not steer");
      live.view.handleInput("\x15"); // Ctrl+U clears whitespace.
      for (const key of ["c", "t", "l", "r"]) live.view.handleInput(key);
      live.view.handleInput(" focus on tests 界🙂");
      const bottom = stripTerminalSequences(live.view.render(100).at(-1)!).trimEnd();
      assert.equal(
        bottom,
        " Steer > ctlr focus on tests 界🙂",
        "input keeps one column of left padding",
      );
      assert.equal(live.viewport.showInherited, undefined);
      assert.equal(live.viewport.detail, undefined);
      assert.equal(live.viewport.follow, true);
      assert.deepEqual(live.steers, [], "typing alone does not send");
      live.view.handleInput("\r");
      await tick();
      assert.deepEqual(live.steers, [{ path, message: "ctlr focus on tests 界🙂" }]);
      assert.equal(stripTerminalSequences(live.view.render(100).at(-1)!).trimEnd(), " Steer >");
      assert.match(live.view.render(100).join("\n"), /Steering sent/);
      assert.deepEqual(live.done, [], "sending leaves the viewer open");
      live.view.handleInput("unsent draft");
      live.view.handleInput("\x1b");
      assert.deepEqual(live.done, ["back"]);
      assert.equal(live.steers.length, 1, "leaving does not send the draft");
    } finally {
      live.view.dispose();
    }
  }
});

test("input cursor editing and Tab browsing preserve the draft and forward focus", async () => {
  const live = launch(snapshot({ messages: [message("parent context")], inheritedCount: 1 }));
  await tick();
  try {
    live.view.handleInput("cart");
    live.view.handleInput("\x1b[D");
    live.view.handleInput("\x7f"); // Delete r.
    live.view.handleInput("\x1b[H");
    live.view.handleInput("a ");
    live.view.handleInput("\x1b[F");
    live.view.handleInput("!");
    assert.equal(live.viewport.follow, true, "Home/End edit instead of scrolling");
    live.view.focused = false;
    assert.ok(!live.view.render(100).at(-1)!.includes(CURSOR_MARKER));
    live.view.focused = true;
    assert.ok(live.view.render(100).at(-1)!.includes(CURSOR_MARKER));
    live.view.handleInput("\t");
    assert.ok(!live.view.render(100).at(-1)!.includes(CURSOR_MARKER));
    live.view.handleInput("c");
    live.view.handleInput("t");
    live.view.handleInput("\r");
    assert.equal(live.viewport.showInherited, true);
    assert.equal(live.viewport.detail, "compact");
    assert.deepEqual(live.steers, []);
    live.view.handleInput("\t");
    assert.ok(live.view.render(100).at(-1)!.includes(CURSOR_MARKER));
    live.view.handleInput("\r");
    await tick();
    assert.deepEqual(live.steers, [{ path: "/root/a", message: "a cat!" }]);
  } finally {
    live.view.dispose();
  }
});

test("pending steering blocks duplicate submissions and preserves edits made while sending", async () => {
  let finish!: (value: NonNullable<TranscriptSnapshot["thread"]>) => void;
  const live = launch(undefined, 10, undefined, {
    steer: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await tick();
  try {
    live.view.handleInput("first");
    live.view.handleInput("\r");
    live.view.handleInput("\r");
    assert.equal(live.steers.length, 1);
    assert.match(live.view.render(100).join("\n"), /Sending steering/);
    live.view.handleInput("\x15");
    live.view.handleInput("next draft");
    finish(snapshot().thread!);
    await tick();
    assert.match(stripTerminalSequences(live.view.render(100).at(-1)!), /next draft/);
  } finally {
    live.view.dispose();
  }
});

test("failed steering keeps the draft for retry and sanitizes error feedback", async () => {
  let attempts = 0;
  const live = launch(undefined, 10, undefined, {
    async steer() {
      if (++attempts === 1) throw new Error("capacity \x1b[31mfull\x00");
      return snapshot().thread!;
    },
  });
  await tick();
  try {
    live.view.handleInput("try again");
    live.view.handleInput("\r");
    await tick();
    const lines = live.view.render(100);
    assert.match(lines.join("\n"), /Steering failed: capacity full/);
    assert.doesNotMatch(lines[1]!, /\x1b\[31m|\x00/);
    assert.match(stripTerminalSequences(lines.at(-1)!), /try again/);
    live.view.handleInput("\r");
    await tick();
    assert.equal(live.steers.length, 2);
    assert.match(live.view.render(100).join("\n"), /Steering sent/);
    assert.equal(stripTerminalSequences(live.view.render(100).at(-1)!).trimEnd(), " Steer >");
  } finally {
    live.view.dispose();
  }
});

test("bracketed paste cannot submit, navigate, or inject terminal controls", async () => {
  const live = launch();
  await tick();
  try {
    live.view.handleInput("\x1b[200~");
    live.view.handleInput("c");
    live.view.handleInput("\t");
    live.view.handleInput("t");
    live.view.handleInput("\r");
    live.view.handleInput("\x1b");
    live.view.handleInput("[31mred\x00\n界🙂");
    live.view.handleInput("\x1b[20");
    live.view.handleInput("1~");
    assert.deepEqual(live.done, []);
    assert.deepEqual(live.steers, []);
    assert.equal(live.viewport.showInherited, undefined);
    assert.equal(live.viewport.detail, undefined);
    const bottom = live.view.render(100).at(-1)!;
    assert.match(stripTerminalSequences(bottom), /c    tred 界🙂/);
    assert.doesNotMatch(bottom, /\x1b\[31m|\x00/);
    live.view.handleInput("\r");
    await tick();
    assert.deepEqual(live.steers, [{ path: "/root/a", message: "c    tred 界🙂" }]);
  } finally {
    live.view.dispose();
  }
});

test("late steering settlement never repaints a disposed viewer", async () => {
  for (const fail of [false, true]) {
    let settle!: () => void;
    const live = launch(undefined, 10, undefined, {
      steer: () =>
        new Promise((resolve, reject) => {
          settle = () => (fail ? reject(new Error("late failure")) : resolve(snapshot().thread!));
        }),
    });
    await tick();
    live.view.handleInput("follow up");
    live.view.handleInput("\r");
    live.view.dispose();
    const renders = live.renders;
    settle();
    await tick();
    assert.equal(live.renders, renders);
    live.view.handleInput("\r");
    assert.equal(live.steers.length, 1);
  }
});

test("message Markdown matches pi's renderer, including syntax highlighting and resize", async () => {
  const source = [
    "# Heading",
    "",
    "**bold** and *italic* with `inline code` and [a link](https://example.com)",
    "",
    "- first item",
    "- second item",
    "",
    "> quoted text",
    "",
    "| Name | Value |",
    "| --- | --- |",
    "| answer | 42 |",
    "",
    "```typescript",
    "const answer = 42;",
    "```",
  ].join("\n");
  const live = launch(
    snapshot({
      messages: [{ role: "assistant", content: [{ type: "text", text: source }] } as AgentMessage],
    }),
    100,
  );
  await tick();
  try {
    const markdownTheme = getMarkdownTheme();
    for (const width of [90, 38]) {
      const lines = live.view.render(width);
      const rendered = lines.map((line) => stripTerminalSequences(line).trimEnd()).join("\n");
      // Transcript rows have one column of padding on each side.
      const expected = new Markdown(source, 0, 0, markdownTheme)
        .render(width - 2)
        .map((line) => ` ${stripTerminalSequences(line)}`.trimEnd())
        .join("\n");
      assert.ok(rendered.includes(expected), `same Markdown layout at width ${width}`);
      assert.ok(lines.join("\n").includes(markdownTheme.bold("bold")));
      const highlighted = markdownTheme.highlightCode!("const answer = 42;", "typescript")[0]!;
      assert.notEqual(highlighted, "const answer = 42;", "code receives syntax colors");
      assert.ok(lines.join("\n").includes(highlighted), "uses pi's syntax highlighting");
      for (const line of lines) assert.equal(visibleWidth(line), width);
    }
  } finally {
    live.view.dispose();
  }
});

test("streaming, inherited, custom and visible thinking text use Markdown too", async () => {
  const live = launch(
    snapshot({
      inheritedCount: 1,
      messages: [
        message("**inherited bold**"),
        {
          role: "custom",
          customType: "subagent-update",
          content: "**update bold**",
          display: true,
          timestamp: 0,
        } as AgentMessage,
      ],
      assistant: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "**thinking bold**" },
          { type: "text", text: "**stream bold**\n\n```typescript\nconst partial =" },
        ],
      } as AgentMessage,
    }),
    50,
  );
  await tick();
  try {
    let content = live.view.render(100).join("\n");
    assert.ok(content.includes(getMarkdownTheme().bold("stream bold")));
    assert.ok(content.includes(getMarkdownTheme().bold("update bold")));
    assert.doesNotMatch(content, /inherited bold|\*\*/);
    // Preview detail renders thinking Markdown (short thinking fits within three rows).
    assert.match(stripTerminalSequences(content), /thinking bold/);
    assert.doesNotMatch(content, /\*\*/);
    // Pi deliberately retains styled fence borders, even while a fence is incomplete.
    assert.ok(
      content.includes(getMarkdownTheme().highlightCode!("const partial =", "typescript")[0]!),
    );
    live.view.handleInput("\t");
    live.view.handleInput("c");
    live.view.handleInput("t"); // Compact detail: inherited shown, thinking hidden.
    content = live.view.render(100).join("\n");
    assert.ok(content.includes(getMarkdownTheme().bold("inherited bold")));
    assert.doesNotMatch(stripTerminalSequences(content), /thinking bold/);
    live.view.handleInput("t"); // Full detail: thinking shown again.
    content = live.view.render(100).join("\n");
    assert.match(stripTerminalSequences(content), /thinking bold/);
    assert.doesNotMatch(content, /\*\*/);

    live.emit(
      snapshot({
        revision: 1,
        assistant: {
          role: "assistant",
          content: [
            { type: "text", text: "**finished bold**\n\n```typescript\nconst partial = 1;\n```" },
          ],
        } as AgentMessage,
      }),
    );
    content = live.view.render(100).join("\n");
    assert.ok(content.includes(getMarkdownTheme().bold("finished bold")));
    assert.doesNotMatch(content, /stream bold|\*\*/);
    live.view.invalidate();
    assert.equal(live.view.render(100).join("\n"), content);
  } finally {
    live.view.dispose();
  }
});

test("tool calls and results show only three preview rows while messages stay complete", async () => {
  const fullText = (prefix: string) =>
    Array.from({ length: 6 }, (_, index) => `${prefix} ${index}`).join("\n");
  const toolResult = {
    role: "toolResult",
    toolCallId: "t1",
    toolName: "read",
    content: [
      { type: "text", text: "output 0\noutput 1" },
      { type: "text", text: "output 2\noutput 3\noutput 4" },
    ],
    isError: false,
    timestamp: 0,
  } as AgentMessage;
  const live = launch(
    snapshot({
      messages: [
        message(fullText("steer")),
        {
          role: "assistant",
          content: [
            { type: "text", text: fullText("agent") },
            {
              type: "toolCall",
              id: "t1",
              name: "read",
              arguments: { path: "file.ts", offset: 1, limit: 100, hiddenArgument: "hidden" },
            },
          ],
        } as AgentMessage,
        toolResult,
        {
          role: "custom",
          customType: "subagent-update",
          content: fullText("update"),
          display: true,
          timestamp: 0,
        } as AgentMessage,
      ],
      assistant: {
        role: "assistant",
        content: [{ type: "text", text: fullText("stream") }],
      } as AgentMessage,
      tools: [
        {
          toolCallId: "t1",
          toolName: "read",
          args: {},
          state: "completed",
          result: "duplicate result",
        },
        {
          toolCallId: "t2",
          toolName: "bash",
          parentToolCallId: "outer",
          args: { command: "build", cwd: "/tmp", hiddenArgument: "hidden" },
          state: "completed",
          isError: true,
          result: { content: [{ type: "text", text: fullText("running output") }] },
        },
      ],
    }),
    100,
  );
  await tick();
  const content = live.view.render(120).join("\n");
  for (const prefix of ["steer", "agent", "update", "stream"])
    for (let index = 0; index < 6; index++) assert.ok(content.includes(`${prefix} ${index}`));
  assert.match(content, /read file\.ts:1-100/);
  assert.match(content, /Tool result: read/);
  assert.match(content, /\$ build — completed \(error\) \(nested\)/);
  for (const prefix of ["output", "running output"]) {
    for (let index = 0; index < 3; index++) assert.ok(content.includes(`${prefix} ${index}`));
    assert.ok(!content.includes(`${prefix} 3`));
  }
  assert.doesNotMatch(content, /hiddenArgument|duplicate result/);
  // Only the two result previews overflow three rows; pi-style call lines never print JSON.
  assert.equal(content.split("\n").filter((line) => line.trim() === "...").length, 2);
  live.view.dispose();
});

test("transcript has one column of side padding; tool calls and results use pi's tool backgrounds", async () => {
  const codes: Record<string, string> = {
    toolSuccessBg: "42",
    customMessageBg: "45",
    toolErrorBg: "41",
  };
  const tagged = {
    fg: (_token: string, text: string) => text,
    bg: (token: string, text: string) => `\x1b[${codes[token] ?? "40"}m${text}\x1b[49m`,
  } as unknown as Theme;
  const live = launch(
    snapshot({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "hello" },
            { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
          ],
        } as AgentMessage,
        {
          role: "toolResult",
          toolCallId: "t1",
          toolName: "bash",
          content: [{ type: "text", text: "listing" }],
          isError: false,
          timestamp: 0,
        } as AgentMessage,
        {
          role: "toolResult",
          toolCallId: "t2",
          toolName: "bash",
          content: [{ type: "text", text: "boom" }],
          isError: true,
          timestamp: 0,
        } as AgentMessage,
      ],
    }),
    30,
    undefined,
    { theme: tagged },
  );
  await tick();
  try {
    const raw = live.view.render(40);
    const find = (needle: string) =>
      raw.find((line) => stripTerminalSequences(line).includes(needle)) ?? "";
    assert.match(stripTerminalSequences(find("hello")), /^ hello/);
    // Bands span the full row, padding columns included, in pi's tool colors.
    for (const [needle, code] of [
      ["$ ls", "42"],
      ["listing", "45"],
      ["boom", "41"],
    ] as const) {
      const line = find(needle);
      assert.ok(line.startsWith(`\x1b[${code}m `), `${needle} uses band ${code}`);
      assert.ok(line.endsWith(" \x1b[49m"), `${needle} band reaches the right edge`);
      assert.equal(visibleWidth(line), 40);
    }
    for (const line of raw.map(stripTerminalSequences).filter((line) => line.trim()))
      assert.match(line, /^ \S/, `padded: ${JSON.stringify(line)}`);
  } finally {
    live.view.dispose();
  }
});

test("t cycles preview, compact and full detail for tool calls and thinking", async () => {
  const live = launch(
    snapshot({
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "- thought 0\n- thought 1\n- thought 2\n- thought 3" },
            {
              type: "toolCall",
              id: "t1",
              name: "bash",
              arguments: { command: "build\necho done\nnpm test\nfinal step", timeout: 30 },
            },
          ],
        } as AgentMessage,
      ],
    }),
    24,
  );
  await tick();
  try {
    // Default preview: three wrapped rows of the call and of the rendered thinking.
    let content = live.view.render(80).join("\n");
    assert.match(content, /\$ build/);
    assert.match(content, /npm test/);
    assert.doesNotMatch(content, /final step/);
    assert.match(content, /thought 0/);
    assert.doesNotMatch(content, /thought 3/);
    live.view.handleInput("\t");
    assert.match(live.view.render(80).join("\n"), /t view:preview/);
    live.view.handleInput("t"); // Compact: one call line, thinking fully hidden.
    content = live.view.render(80).join("\n");
    assert.match(content, /\$ build \(timeout 30s\)/);
    assert.doesNotMatch(content, /echo done|thought 0/);
    assert.match(content, /Thinking hidden/);
    assert.match(content, /t view:compact/);
    live.view.handleInput("t"); // Full: every command and thinking row.
    content = live.view.render(80).join("\n");
    assert.match(content, /final step/);
    assert.match(content, /thought 3/);
    assert.match(content, /t view:full/);
    live.view.handleInput("t"); // Cycle wraps back to preview.
    content = live.view.render(80).join("\n");
    assert.doesNotMatch(content, /final step|thought 3/);
    assert.match(content, /t view:preview/);
  } finally {
    live.view.dispose();
  }
});

test("previews count wrapped rows, keep short results intact, and sanitize tool output", async () => {
  const live = launch(
    snapshot({
      tools: [
        {
          toolCallId: "long",
          toolName: "read",
          args: {},
          state: "running",
          result: {
            content: [{ type: "text", text: "\x1b[31m" + "界".repeat(100000) + "hidden tail" }],
          },
        },
        {
          toolCallId: "short",
          toolName: "bash",
          args: {},
          state: "completed",
          result: { content: [{ type: "text", text: "short 0\nshort 1\nshort 2" }] },
        },
      ],
    }),
    30,
  );
  await tick();
  for (const width of [20, 40]) {
    const lines = live.view.render(width);
    assert.equal(lines.filter((line) => line.includes("界")).length, 3);
    assert.equal(lines.filter((line) => line.trim() === "...").length, 1);
    const content = lines.join("\n");
    assert.match(content, /short 0/);
    assert.match(content, /short 1/);
    assert.match(content, /short 2/);
    assert.doesNotMatch(content, /hidden tail|\x1b\[31m/);
    for (const line of lines) assert.equal(visibleWidth(line), width);
  }
  live.view.dispose();
});

test("long steer and agent messages are not subject to the old tool output size cap", async () => {
  for (const role of ["user", "assistant", "custom"] as const) {
    const content = "a".repeat(40000) + "\ncomplete message tail";
    const live = launch(
      snapshot({
        messages: [
          (role === "assistant"
            ? { role, content: [{ type: "text", text: content }] }
            : {
                role,
                content,
                customType: "subagent-update",
                display: true,
                timestamp: 0,
              }) as AgentMessage,
        ],
      }),
    );
    await tick();
    const rendered = live.view.render(120).join("\n");
    assert.match(rendered, /complete message tail/);
    assert.doesNotMatch(rendered, /Viewer truncated/);
    live.view.dispose();
  }
});

test("tail following pauses on scroll and per-agent state restores across remount", async () => {
  const messages = Array.from({ length: 40 }, (_, index) => message(`line ${index}`));
  const state = { scrollTop: 0, follow: true };
  const live = launch(snapshot({ messages }), 8, state);
  await tick();
  assert.match(live.view.render(60).join("\n"), /line 39/);
  live.view.handleInput("\x1b[A");
  assert.equal(state.follow, false);
  const savedTop = state.scrollTop;
  live.emit(snapshot({ revision: 1, messages: [...messages, message("new tail")] }));
  assert.doesNotMatch(live.view.render(60).join("\n"), /new tail/);
  assert.equal(state.scrollTop, savedTop);
  live.view.dispose();
  const restored = launch(snapshot({ messages: [...messages, message("new tail")] }), 8, state);
  await tick();
  restored.view.render(60);
  assert.equal(state.scrollTop, savedTop);
  assert.equal(state.follow, false);
  restored.view.handleInput("\t");
  restored.view.handleInput("\x1b[F");
  assert.match(restored.view.render(60).join("\n"), /new tail/);
  assert.equal(state.follow, true);
  restored.view.dispose();
});

test("viewer fits and covers tiny/large terminals and sanitizes all untrusted text", async () => {
  for (const rows of [1, 2, 3, 10, 30]) {
    const live = launch(
      snapshot({ messages: [message("wide 界🙂\x1b[31mred\x00\n".repeat(100))] }),
      rows,
    );
    await tick();
    for (const width of [0, 1, 3, 10, 100]) {
      const lines = live.view.render(width);
      assert.equal(lines.length, rows);
      for (const line of lines) {
        assert.equal(visibleWidth(line), width, `${width}x${rows}: ${line}`);
        assert.equal(/[\x00\x1b]/.test(stripTerminalSequences(line)), false);
        assert.equal(
          line.includes("\x1b[31m"),
          false,
          "untrusted styling is stripped; generated clipping resets are allowed",
        );
      }
    }
    live.view.dispose();
  }
});

test("burst updates coalesce renders and disposed/older subscriptions cannot repaint", async () => {
  const live = launch();
  await tick();
  const before = live.renders;
  for (let revision = 1; revision <= 100; revision++)
    live.emit(snapshot({ revision, messages: [message(`revision ${revision}`)] }));
  await tick();
  assert.equal(live.renders, before + 1);
  live.emit(snapshot({ revision: 99, messages: [message("old state")] }));
  assert.match(live.view.render(60).join("\n"), /revision 100/);
  live.view.dispose();
  const stopped = live.renders;
  live.emit(snapshot({ revision: 101 }));
  await tick();
  assert.equal(live.renders, stopped);
});

test("retry ignores old callbacks and close cleans up late async attachment", async () => {
  const callbacks: TranscriptListener[] = [];
  const pending: Array<{
    resolve(value: TranscriptObservation): void;
    reject(error: Error): void;
  }> = [];
  let unsubscribed = 0;
  const service = {
    observeTranscript(_path: string, callback: TranscriptListener) {
      callbacks.push(callback);
      return new Promise<TranscriptObservation>((resolve, reject) =>
        pending.push({ resolve, reject }),
      );
    },
  } as unknown as ThreadService;
  const view = new LiveAgentView(
    { requestRender() {}, terminal: { rows: 10 } },
    theme,
    service,
    "/root/a",
    { scrollTop: 0, follow: true },
    () => {},
  );
  pending[0]!.reject(new Error("attachment failed"));
  await tick();
  assert.match(view.render(100).join("\n"), /Attachment error: attachment failed/);
  view.handleInput("\x12"); // Ctrl+R retries without leaving the input.
  pending[1]!.resolve({
    snapshot: snapshot({ messages: [message("retried current")] }),
    unsubscribe() {
      unsubscribed++;
    },
  });
  await tick();
  callbacks[0]!(snapshot({ revision: 100, messages: [message("stale old stream")] }));
  assert.match(view.render(100).join("\n"), /retried current/);
  assert.doesNotMatch(view.render(100).join("\n"), /stale old stream/);
  callbacks[1]!(snapshot({ revision: 1, error: "retry again" }));
  view.handleInput("\t");
  view.handleInput("r");
  assert.equal(unsubscribed, 1);
  view.dispose();
  pending[2]!.resolve({
    snapshot: snapshot(),
    unsubscribe() {
      unsubscribed++;
    },
  });
  await tick();
  assert.equal(unsubscribed, 2);
});
