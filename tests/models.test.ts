import assert from "node:assert/strict";
import { test } from "node:test";
import { getModelPreferences, selectPreferredModel } from "../src/prefs/models.ts";
import { agentTools } from "../src/orch/tools.ts";
import type { AgentType } from "../src/types.ts";

const eligible = (...ids: string[]) =>
  ids.map((identity) => {
    const [provider, ...rest] = identity.split("/");
    return { model: { provider: provider!, id: rest.join("/") } };
  });

test("getModelPreferences accepts omitted, legacy and canonical forms and copies input", () => {
  assert.equal(getModelPreferences({}), undefined);
  assert.deepEqual(getModelPreferences({ model: "p/model/with/slashes" }), [
    "p/model/with/slashes",
  ]);
  const input = { models: ["p/first", "p/second"] };
  const preferences = getModelPreferences(input)!;
  assert.deepEqual(preferences, ["p/first", "p/second"]);
  preferences.reverse();
  assert.deepEqual(input.models, ["p/first", "p/second"]);
});

test("getModelPreferences rejects ambiguous or malformed values", () => {
  for (const type of [
    { model: "p/legacy", models: ["p/current"] },
    { models: null },
    { models: "p/model" },
    { models: [] },
    { models: ["p/model", "p/model"] },
    { models: ["bad"] },
  ]) {
    assert.throws(() => getModelPreferences(type), JSON.stringify(type));
  }
});

test("selectPreferredModel uses preference order and returns undefined without preferences", () => {
  const type = {
    name: "r",
    models: ["p/missing", "p/second", "p/first"],
    modelSuggestions: ["p/first"],
  };
  assert.equal(selectPreferredModel(type, eligible("p/first", "p/second")), "p/second");
  assert.equal(selectPreferredModel(type, eligible("p/first", "p/second"), false), "p/second");
  assert.equal(selectPreferredModel({ name: "w" }, eligible("p/first")), undefined);
  assert.equal(selectPreferredModel({ name: "w" }, [], false), undefined);
});

test("selectPreferredModel errors name the agent, preferences and available models per filtering mode", () => {
  const type = { name: "researcher", models: ["p/preferred", "p/fallback"] };
  assert.throws(
    () => selectPreferredModel(type, eligible("p/available", "o/choice")),
    /researcher[\s\S]*p\/preferred[\s\S]*p\/fallback[\s\S]*p\/available[\s\S]*o\/choice[\s\S]*\/scoped-models/,
  );
  assert.throws(() => selectPreferredModel(type, []), /\(none\)[\s\S]*\/scoped-models/);
  assert.throws(
    () => selectPreferredModel(type, eligible("p/available"), false),
    (error: unknown) => {
      assert.match(String(error), /Available models: \[p\/available\]/);
      assert.doesNotMatch(String(error), /scoped/);
      return true;
    },
  );
});

test("agent_types normalizes model pins, keeps suggestions separate, and does not mutate definitions", async () => {
  const definition = (fields: Partial<AgentType>): AgentType => ({
    name: "worker",
    description: "Worker",
    systemPrompt: "Work",
    ...fields,
  });
  const types = [
    definition({ models: ["p/second", "p/first"], modelSuggestions: ["Sonnet"] }),
    definition({ name: "legacy", model: "p/legacy" }),
    definition({ name: "suggested", modelSuggestions: ["Claude Opus"] }),
  ];
  const tool = agentTools(
    () => {
      throw new Error("Listing types must not require a running manager");
    },
    "/root",
    () => types,
  ).find((entry) => entry.name === "agent_types")!;
  const output = await tool.execute("list-types", {}, undefined, undefined, {} as never);
  const entries = output.details as { models?: string[]; modelSuggestions?: string[] }[];
  assert.deepEqual(
    entries.map(({ models, modelSuggestions }) => ({ models, modelSuggestions })),
    [
      { models: ["p/second", "p/first"], modelSuggestions: ["Sonnet"] },
      { models: ["p/legacy"], modelSuggestions: undefined },
      { models: undefined, modelSuggestions: ["Claude Opus"] },
    ],
  );
  assert.ok(entries.every((entry) => !("model" in entry)));
  entries[2]?.modelSuggestions?.push("mutated");
  assert.deepEqual(types[2]?.modelSuggestions, ["Claude Opus"]);
  assert.equal(types[1]?.model, "p/legacy");
});
