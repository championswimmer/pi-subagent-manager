import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { canonicalPath, inheritContext, isDescendant, parentPath } from "../src/paths.ts";

test("canonical ancestry is structural, not prefix matching or URL normalization", () => {
  assert.equal(
    canonicalPath("coding-researcher", "/root/worker"),
    "/root/worker/coding-researcher",
  );
  assert.equal(parentPath("/a/b/c"), "/a/b");
  assert.equal(parentPath("/k"), null);
  assert.equal(isDescendant("/root/ab", "/root/a"), false);
  for (const path of [
    "",
    "/root/../worker",
    "/root//worker",
    "/root/worker/",
    "/root/%61",
    " /root/a",
    "/root/a?b",
    "/root/a\\b",
  ])
    assert.throws(() => canonicalPath(path));
});

test("context snapshots strip unfinished/orphaned tool exchanges and clone messages", () => {
  const assistant = (
    content: any[],
    stopReason: "toolUse" | "error" = "toolUse",
  ): AgentMessage => ({
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 1,
  });
  const messages: AgentMessage[] = [
    { role: "system", content: "parent prompt", timestamp: 1 },
    { role: "user", content: "parent context", timestamp: 1 },
    {
      role: "custom",
      customType: "parent-note",
      content: "keep custom context",
      display: false,
      timestamp: 1,
    } as unknown as AgentMessage,
    {
      role: "bashExecution",
      command: "echo inherited",
      output: "keep shell context",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: 1,
    } as unknown as AgentMessage,
    assistant([
      { type: "text", text: "Checking" },
      { type: "toolCall", id: "repeat", name: "read", arguments: { path: "first" } },
      { type: "toolCall", id: "pending", name: "agent_spawn", arguments: {} },
    ]),
    {
      role: "toolResult",
      toolCallId: "repeat",
      toolName: "read",
      content: [{ type: "text", text: "first result" }],
      isError: false,
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolCallId: "repeat",
      toolName: "read",
      content: [{ type: "text", text: "duplicate orphan result" }],
      isError: false,
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolCallId: "orphan",
      toolName: "read",
      content: [],
      isError: false,
      timestamp: 1,
    },
    assistant([
      { type: "text", text: "Retrying" },
      { type: "toolCall", id: "repeat", name: "read", arguments: { path: "second" } },
    ]),
    {
      role: "toolResult",
      toolCallId: "repeat",
      toolName: "read",
      content: [{ type: "text", text: "second result" }],
      isError: false,
      timestamp: 1,
    },
    assistant([
      { type: "text", text: "Still waiting" },
      { type: "toolCall", id: "repeat", name: "read", arguments: { path: "third" } },
    ]),
    assistant(
      [
        { type: "text", text: "Broken" },
        { type: "toolCall", id: "ignored", name: "read", arguments: { path: "broken" } },
      ],
      "error",
    ),
    {
      role: "toolResult",
      toolCallId: "ignored",
      toolName: "read",
      content: [{ type: "text", text: "ignored result" }],
      isError: false,
      timestamp: 1,
    },
  ];
  const inherited = inheritContext(messages);
  assert.deepEqual(
    inherited.map((message) => message.role),
    [
      "user",
      "custom",
      "bashExecution",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
      "assistant",
    ],
  );
  assert.deepEqual(
    (inherited[3] as any).content.map((block: any) => block.id ?? block.text),
    ["Checking", "repeat"],
  );
  assert.equal((inherited[3] as any).stopReason, "toolUse");
  assert.equal(((inherited[4] as any).content[0] as any).text, "first result");
  assert.deepEqual(
    (inherited[5] as any).content.map((block: any) => block.id ?? block.text),
    ["Retrying", "repeat"],
  );
  assert.equal(((inherited[6] as any).content[0] as any).text, "second result");
  assert.deepEqual(
    (inherited[7] as any).content.map((block: any) => block.id ?? block.text),
    ["Still waiting"],
  );
  assert.equal((inherited[7] as any).stopReason, "stop");
  assert.deepEqual(
    inherited.flatMap((message: any) =>
      message.role === "assistant"
        ? message.content
            .filter((block: any) => block.type === "toolCall")
            .map((block: any) => block.id)
        : [],
    ),
    ["repeat", "repeat"],
  );
  (inherited[1] as any).content = "child mutation";
  assert.equal((messages[2] as any).content, "keep custom context");
  ((inherited[3] as any).content[0] as any).text = "changed";
  assert.equal(((messages[4] as any).content[0] as any).text, "Checking");
});
