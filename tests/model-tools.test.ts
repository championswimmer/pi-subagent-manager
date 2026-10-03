import assert from "node:assert/strict";
import { test } from "node:test";
import { agentTools } from "../src/tools.ts";
import type { AgentType } from "../src/types.ts";

const definition = (fields: Partial<AgentType>): AgentType => ({
  name: "worker",
  description: "Worker",
  systemPrompt: "Work",
  ...fields,
});

test("agent_types exposes ordered preferences and normalizes retained legacy definitions", async () => {
  const types = [
    definition({ models: ["provider/second", "provider/first"] }),
    definition({ name: "legacy", model: "provider/legacy" }),
    definition({ name: "inherited" }),
  ];
  const tool = agentTools(
    () => {
      throw new Error("Listing types must not require a running manager");
    },
    "/root",
    () => types,
  ).find((entry) => entry.name === "agent_types")!;
  const output = await tool.execute("list-types", {}, undefined, undefined, {} as never);
  const entries = output.details as { name: string; models?: string[]; model?: string }[];
  assert.deepEqual(entries[0]?.models, ["provider/second", "provider/first"]);
  assert.deepEqual(entries[1]?.models, ["provider/legacy"]);
  assert.equal(entries[2]?.models, undefined);
  assert.ok(entries.every((entry) => !("model" in entry)));
  assert.deepEqual(types[0]?.models, ["provider/second", "provider/first"]);
  assert.equal(types[1]?.model, "provider/legacy", "discovery must not mutate saved definitions");
});

test("agent_types lists modelSuggestions independently from model pins", async () => {
  const suggested = definition({ modelSuggestions: ["Claude Opus", "GPT"] });
  const both = definition({
    name: "both",
    models: ["provider/pinned"],
    modelSuggestions: ["Sonnet"],
  });
  const empty = definition({ name: "empty", modelSuggestions: [] });
  const inherited = definition({ name: "inherited" });
  const types = [suggested, both, empty, inherited];
  const tool = agentTools(
    () => {
      throw new Error("Listing types must not require a running manager");
    },
    "/root",
    () => types,
  ).find((entry) => entry.name === "agent_types")!;
  const output = await tool.execute("list-types", {}, undefined, undefined, {} as never);
  const entries = output.details as {
    name: string;
    models?: string[];
    modelSuggestions?: string[];
    model?: string;
  }[];
  assert.equal(entries[0]?.models, undefined);
  assert.deepEqual(entries[0]?.modelSuggestions, ["Claude Opus", "GPT"]);
  assert.deepEqual(entries[1]?.models, ["provider/pinned"]);
  assert.deepEqual(entries[1]?.modelSuggestions, ["Sonnet"]);
  assert.deepEqual(entries[2]?.modelSuggestions, []);
  assert.equal(entries[3]?.models, undefined);
  assert.equal(entries[3]?.modelSuggestions, undefined);
  assert.ok(entries.every((entry) => !("model" in entry)));
  entries[0]?.modelSuggestions?.push("mutated");
  assert.deepEqual(suggested.modelSuggestions, ["Claude Opus", "GPT"]);
  const text = output.content[0]?.type === "text" ? output.content[0].text : "";
  assert.match(text, /Claude Opus/);
  assert.doesNotMatch(text, /"model":/);
});
