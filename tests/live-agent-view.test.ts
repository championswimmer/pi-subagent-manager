import assert from "node:assert/strict";
import test from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getMarkdownTheme, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { LiveAgentView, type AgentViewportState } from "../src/ui/live-agent-view.ts";
import type {
  ThreadService,
  TranscriptListener,
  TranscriptObservation,
  TranscriptSnapshot,
} from "../src/types.ts";

// The live UI uses pi's active Markdown theme, just like the main transcript.
initTheme("dark");
const theme = { fg: (_token: string, text: string) => text } as Theme;
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
) {
  let listener: TranscriptListener = () => {};
  let unsubscribed = 0;
  let renders = 0;
  const done: string[] = [];
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
    steer() {
      throw new Error("watch must not steer");
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
    theme,
    service,
    "/root/a",
    viewport,
    (value) => done.push(value),
  );
  return {
    view,
    viewport,
    done,
    emit: (next: TranscriptSnapshot) => listener(next),
    get renders() {
      return renders;
    },
    get unsubscribed() {
      return unsubscribed;
    },
  };
}

test("live viewer shows assistant/tool streams, collapses inherited context, and never executes input", async () => {
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
          { type: "thinking", thinking: "private thinking" },
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
  assert.match(content, /Tool bash — running/);
  assert.match(content, /partial tool output/);
  assert.doesNotMatch(content, /private thinking/);
  live.view.handleInput("t");
  assert.match(live.view.render(120).join("\n"), /private thinking/);
  live.view.handleInput("some text");
  live.view.handleInput("\r");
  assert.deepEqual(live.done, []);
  live.view.handleInput("\x1b");
  assert.deepEqual(live.done, ["back"]);
  live.view.dispose();
  live.view.dispose();
  assert.equal(live.unsubscribed, 1);
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
      const expected = new Markdown(source, 0, 0, markdownTheme)
        .render(width)
        .map((line) => stripTerminalSequences(line).trimEnd())
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
    assert.doesNotMatch(content, /inherited bold|thinking bold|\*\*/);
    // Pi deliberately retains styled fence borders, even while a fence is incomplete.
    assert.ok(
      content.includes(getMarkdownTheme().highlightCode!("const partial =", "typescript")[0]!),
    );
    live.view.handleInput("c");
    live.view.handleInput("t");
    content = live.view.render(100).join("\n");
    assert.ok(content.includes(getMarkdownTheme().bold("inherited bold")));
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
  assert.match(content, /Tool call: read/);
  assert.match(content, /"path": "file.ts"/);
  assert.match(content, /Tool result: read/);
  assert.match(content, /Tool bash — completed \(error\) \(nested\)/);
  assert.match(content, /"command": "build"/);
  for (const prefix of ["output", "running output"]) {
    for (let index = 0; index < 3; index++) assert.ok(content.includes(`${prefix} ${index}`));
    assert.ok(!content.includes(`${prefix} 3`));
  }
  assert.doesNotMatch(content, /hiddenArgument|duplicate result/);
  assert.equal(content.split("\n").filter((line) => line.trim() === "...").length, 4);
  live.view.dispose();
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
  view.handleInput("r");
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
