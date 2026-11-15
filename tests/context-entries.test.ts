import assert from "node:assert/strict";
import { test } from "node:test";
import { inheritedContextEntries } from "../src/orch/context-entries.ts";

test("copies only prune custom entries in branch order, without sharing data", () => {
  const branch = [
    { type: "custom", customType: "other", data: { value: 1 } },
    { type: "custom", customType: "context-prune-index", data: { toolCalls: ["one"] } },
    { type: "custom_message", customType: "context-prune-index", data: { ignored: true } },
    { type: "custom", customType: "context-prune-frontier", data: { last: "one" } },
    { type: "custom", customType: "context-prune-index", data: { toolCalls: ["two"] } },
  ];
  const result = inheritedContextEntries(branch);
  assert.deepEqual(
    result.map((entry) => entry.customType),
    ["context-prune-index", "context-prune-frontier", "context-prune-index"],
  );
  (result[0]!.data as { toolCalls: string[] }).toolCalls.push("child");
  assert.deepEqual(branch[1]!.data, { toolCalls: ["one"] });
  assert.deepEqual(inheritedContextEntries([{ type: "message" }]), []);
});
