import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getModelPreferences,
  modelIdentity,
  selectPreferredModel,
} from "../src/models.js";

test("getModelPreferences supports omitted, legacy and canonical forms", () => {
  assert.equal(getModelPreferences({}), undefined);
  assert.deepEqual(getModelPreferences({ model: "provider/model/with/slashes" }), [
    "provider/model/with/slashes",
  ]);
  assert.deepEqual(
    getModelPreferences({
      models: ["provider/first", "provider/model/with/slashes"],
    }),
    ["provider/first", "provider/model/with/slashes"],
  );
});

test("getModelPreferences rejects ambiguous or malformed values", () => {
  for (const type of [
    { model: "provider/legacy", models: ["provider/current"] },
    { model: "provider/model", models: null },
    { models: null },
    { models: "provider/model" },
    { models: [] },
    { models: ["provider/model", "provider/model"] },
    { models: ["bad"] },
  ]) {
    assert.throws(() => getModelPreferences(type));
  }
});

test("getModelPreferences returns a defensive copy without mutating input", () => {
  const input = { models: ["provider/primary", "provider/fallback"] };
  const preferences = getModelPreferences(input)!;
  assert.notEqual(preferences, input.models);
  preferences.reverse();
  assert.deepEqual(input.models, ["provider/primary", "provider/fallback"]);
});

test("modelIdentity preserves provider plus full id", () => {
  assert.equal(
    modelIdentity({ provider: "provider", id: "model/with/slashes" }),
    "provider/model/with/slashes",
  );
});

test("selectPreferredModel honors preference order rather than scoped order", () => {
  assert.equal(
    selectPreferredModel(
      {
        name: "researcher",
        models: ["provider/second", "provider/first"],
      },
      [
        { model: { provider: "provider", id: "first" } },
        { model: { provider: "provider", id: "second" } },
      ],
    ),
    "provider/second",
  );
});

test("unmatched model suggestions do not change preference selection or inheritance", () => {
  const suggested = {
    name: "worker",
    models: undefined,
    modelSuggestions: ["Missing Display Name", "not-a-provider"],
  };
  assert.equal(getModelPreferences(suggested), undefined);
  assert.equal(
    selectPreferredModel(suggested, [{ model: { provider: "provider", id: "first" } }]),
    undefined,
  );
  assert.equal(selectPreferredModel(suggested, [], false), undefined);
  const pinned = {
    name: "worker",
    models: ["provider/second", "provider/first"],
    modelSuggestions: ["Missing Display Name", "provider/not-selected"],
  };
  assert.deepEqual(getModelPreferences(pinned), ["provider/second", "provider/first"]);
  assert.equal(
    selectPreferredModel(pinned, [
      { model: { provider: "provider", id: "first" } },
      { model: { provider: "provider", id: "second" } },
    ]),
    "provider/second",
  );
});

test("selectPreferredModel returns undefined when preferences are omitted", () => {
  assert.equal(
    selectPreferredModel({ name: "worker" }, [{ model: { provider: "provider", id: "first" } }]),
    undefined,
  );
  assert.equal(selectPreferredModel({ name: "worker" }, [], false), undefined);
});

test("selectPreferredModel ordered unscoped available fallback ignores scope labeling", () => {
  assert.equal(
    selectPreferredModel(
      {
        name: "researcher",
        models: ["provider/missing", "provider/unscoped", "provider/scoped"],
      },
      [
        { model: { provider: "provider", id: "scoped" } },
        { model: { provider: "provider", id: "unscoped" } },
      ],
      false,
    ),
    "provider/unscoped",
  );
});

test("selectPreferredModel labels unavailable matches as available models when filtering is off", () => {
  assert.throws(
    () =>
      selectPreferredModel(
        {
          name: "researcher",
          models: ["provider/preferred", "provider/fallback"],
        },
        [{ model: { provider: "provider", id: "available" } }],
        false,
      ),
    (error: unknown) => {
      assert.match(String(error), /available models/i);
      assert.match(
        String(error),
        /researcher[\s\S]*provider\/preferred[\s\S]*provider\/fallback[\s\S]*provider\/available/,
      );
      assert.doesNotMatch(String(error), /\/scoped-models/);
      assert.doesNotMatch(String(error), /scoped/);
      return true;
    },
  );
  assert.throws(
    () => selectPreferredModel({ name: "researcher", models: ["provider/preferred"] }, [], false),
    (error: unknown) => {
      assert.match(String(error), /available models/i);
      assert.match(String(error), /\(none\)/);
      assert.doesNotMatch(String(error), /\/scoped-models/);
      return true;
    },
  );
});

test("selectPreferredModel throws actionable errors for missing scoped matches", () => {
  assert.throws(
    () =>
      selectPreferredModel(
        {
          name: "researcher",
          models: ["provider/preferred", "provider/fallback"],
        },
        [
          { model: { provider: "provider", id: "available" } },
          { model: { provider: "other", id: "choice" } },
        ],
      ),
    /researcher[\s\S]*provider\/preferred[\s\S]*provider\/fallback[\s\S]*provider\/available[\s\S]*other\/choice[\s\S]*\/scoped-models/,
  );
  assert.throws(
    () =>
      selectPreferredModel(
        { name: "researcher", models: ["provider/preferred"] },
        [],
      ),
    /researcher[\s\S]*provider\/preferred[\s\S]*\(none\)[\s\S]*\/scoped-models/,
  );
});
