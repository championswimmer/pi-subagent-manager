import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { ConfigStore, parseAgentType, selectTools, serializeAgentType } from "../src/config.ts";
import { selectPreferredModel } from "../src/models.ts";
import { agentTools } from "../src/tools.ts";
import type { AgentType, ThinkingLevel } from "../src/types.ts";

const BUNDLED_DIR = fileURLToPath(new URL("../agents/", import.meta.url));
const READ = ["read", "grep", "find", "ls"];
const LIFECYCLE = ["agent_update", "agent_pause"];
const DELEGATION = [
  "agent_types",
  "agent_spawn",
  "agent_wait",
  "agent_status",
  "agent_output",
  "agent_steer",
  "agent_stop",
];
const IMPLEMENT = [...READ, "bash", "edit", "write", ...LIFECYCLE];
const CONTRACTS: Record<string, { thinking: ThinkingLevel; tools: string[] }> = {
  architect: { thinking: "high", tools: [...READ, "bash", ...LIFECYCLE, ...DELEGATION] },
  coder: { thinking: "high", tools: IMPLEMENT },
  reviewer: { thinking: "high", tools: [...READ, "bash", ...LIFECYCLE] },
  tasker: { thinking: "low", tools: IMPLEMENT },
  writer: { thinking: "medium", tools: [...READ, "edit", "write", ...LIFECYCLE] },
};
const SUGGESTIONS: Record<string, readonly string[]> = {
  architect: ["opus-5.5", "gpt-6-astra", "gpt-6.1-sol"],
  coder: ["sonnet-5.5", "gpt-6.1-sol", "muse-spark-1.3"],
  reviewer: ["gpt-6.1-sol", "gpt-6-astra"],
  tasker: ["gpt-6-luna", "deepseek-4.1-flash"],
  writer: ["opus-5.5", "gemini-4-argon", "gpt-6-astra"],
};
const REMOVED = ["designer", "explorer", "researcher"] as const;
const NAMES = Object.keys(CONTRACTS).sort();
const sorted = (names: readonly string[]) => [...names].sort();

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-bundled-agents-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { cwd: join(root, "project"), agentDir: join(root, "user"), includeProject: false };
}

function availableTools(): string[] {
  const cwd = process.cwd();
  const builtins = [
    createReadToolDefinition,
    createBashToolDefinition,
    createPowerShellToolDefinition,
    createEditToolDefinition,
    createWriteToolDefinition,
    createGrepToolDefinition,
    createFindToolDefinition,
    createLsToolDefinition,
  ].map((create) => create(cwd).name);
  const controls = agentTools(
    () => {
      throw new Error("Tool enumeration must not start a manager");
    },
    "/root",
    () => [],
  ).map((tool) => tool.name);
  return [...builtins, ...controls];
}

function suggestionsOf(type: AgentType): string[] {
  const suggestions = type.modelSuggestions;
  assert.ok(Array.isArray(suggestions), `${type.name} modelSuggestions must be a list`);
  return suggestions;
}

function assertNoSelectionEffect(type: AgentType, suggestions: readonly string[]) {
  assert.equal(Object.hasOwn(type, "model"), false);
  assert.equal(Object.hasOwn(type, "models"), false);
  const eligible = suggestions.map((id) => ({ model: { provider: "advisory", id } }));
  assert.equal(selectPreferredModel(type, []), undefined);
  assert.equal(selectPreferredModel(type, eligible), undefined);
  assert.equal(selectPreferredModel(type, eligible, true), undefined);
  assert.equal(selectPreferredModel(type, eligible, false), undefined);
}

function assertContract(type: AgentType) {
  const contract = CONTRACTS[type.name];
  assert.ok(contract, `Unexpected bundled role ${type.name}`);
  assert.equal(type.source, "bundled");
  assert.equal(type.filePath, join(BUNDLED_DIR, `${type.name}.md`));
  assert.equal(type.thinkingLevel, contract.thinking);
  const suggestions = suggestionsOf(type);
  assert.ok(suggestions.length > 0, `${type.name} suggestions must be nonempty`);
  assert.equal(
    new Set(suggestions).size,
    suggestions.length,
    `${type.name} suggestions must be unique`,
  );
  assert.deepEqual(suggestions, SUGGESTIONS[type.name]);
  for (const alias of suggestions) {
    assert.equal(typeof alias, "string");
    assert.ok(alias.trim());
    assert.equal(
      alias.includes("/"),
      false,
      `${alias} is a display alias, not a provider/model-id pin`,
    );
  }
  assertNoSelectionEffect(type, suggestions);
  const raw = readFileSync(type.filePath!, "utf8");
  const yaml = raw.slice(raw.indexOf("---") + 3, raw.indexOf("\n---", 3));
  assert.doesNotMatch(yaml, /^models?:/m);
  assert.deepEqual(Object.keys(type.tools ?? {}), ["allow"]);
  const allow = type.tools?.allow ?? [];
  assert.equal(new Set(allow).size, allow.length, "No duplicate tool names");
  assert.deepEqual(sorted(allow), sorted(contract.tools));
  const available = availableTools();
  assert.deepEqual(sorted(selectTools(type.tools, available)), sorted(contract.tools));
  assert.deepEqual(sorted(selectTools(type.tools, available.reverse())), sorted(contract.tools));
  assert.deepEqual(
    sorted(allow.filter((name) => DELEGATION.includes(name))),
    type.name === "architect" ? sorted(DELEGATION) : [],
    "Only architect delegates",
  );
  assert.ok(type.description.trim());
  assert.ok(type.systemPrompt.trim());
  assert.notEqual(type.systemPrompt.trim(), type.description.trim());
  const parsed = parseAgentType(readFileSync(type.filePath!, "utf8"), type.filePath);
  const { source: _source, ...withoutSource } = type;
  assert.deepEqual(parsed, withoutSource);
  const { source: _savedSource, filePath: _filePath, ...portable } = type;
  assert.deepEqual(parseAgentType(serializeAgentType(type)), portable);
}

test("five bundled defaults have distinct prompts, exact contracts, and advisory suggestions only", (t) => {
  const store = new ConfigStore(fixture(t));
  assert.deepEqual(store.diagnostics, []);
  assert.equal(NAMES.length, 5);
  assert.deepEqual(
    store.list().map((type) => type.name),
    NAMES,
  );
  assert.deepEqual(
    readdirSync(BUNDLED_DIR)
      .filter((file) => file.endsWith(".md"))
      .sort(),
    NAMES.map((name) => `${name}.md`),
  );
  for (const name of [...REMOVED, "worker"])
    assert.throws(() => store.get(name), /Unknown or invalid/);
  const types = store.list();
  for (const type of types) assertContract(type);
  assert.equal(new Set(types.map((type) => type.description)).size, types.length);
  assert.equal(new Set(types.map((type) => type.systemPrompt)).size, types.length);
  assert.equal(
    new Set(types.map((type) => suggestionsOf(type).join("\0"))).size,
    types.length,
    "Each role has a distinct suggestion list",
  );
});

test("a saved same-name user override replaces only that bundled role", (t) => {
  const options = fixture(t);
  const store = new ConfigStore(options);
  const bundled = store.get("architect");
  const override = store.save(
    {
      ...bundled,
      description: "My planning specialist",
      systemPrompt: "Plan from the supplied evidence only.\n",
      thinkingLevel: "low",
      modelSuggestions: ["override-alias"],
      tools: { allow: [] },
    },
    "user",
    bundled,
  );
  const reloaded = new ConfigStore(options);
  assert.deepEqual(reloaded.diagnostics, []);
  assert.deepEqual(
    reloaded.list().map((type) => type.name),
    NAMES,
  );
  assert.deepEqual(reloaded.get("architect"), override);
  assert.equal(override.source, "user");
  assert.deepEqual(override.modelSuggestions, ["override-alias"]);
  assertNoSelectionEffect(override, ["override-alias"]);
  for (const type of reloaded.list().filter((type) => type.name !== "architect"))
    assertContract(type);
  assert.deepEqual(
    parseAgentType(readFileSync(bundled.filePath!, "utf8")).modelSuggestions,
    SUGGESTIONS.architect,
  );
});

test("same-name user and project overrides preserve suggestions and precedence", (t) => {
  const options = { ...fixture(t), includeProject: true };
  const bundled = new ConfigStore(options).get("architect");
  const userStore = new ConfigStore(options);
  const user = userStore.save(
    {
      ...bundled,
      description: "User architect override",
      systemPrompt: "User architect prompt.\n",
      modelSuggestions: ["user-alias-a", "user-alias-b"],
    },
    "user",
    bundled,
  );
  assert.equal(user.source, "user");
  assert.deepEqual(user.modelSuggestions, ["user-alias-a", "user-alias-b"]);
  assertNoSelectionEffect(user, user.modelSuggestions ?? []);
  const afterUser = new ConfigStore(options);
  assert.deepEqual(afterUser.get("architect"), user);

  const project = afterUser.save(
    {
      name: "architect",
      description: "Project architect override",
      systemPrompt: "Project architect prompt.\n",
      thinkingLevel: bundled.thinkingLevel,
      color: bundled.color,
      modelSuggestions: ["project-alias"],
      tools: bundled.tools,
    },
    "project",
  );
  const trusted = new ConfigStore(options);
  assert.deepEqual(trusted.diagnostics, []);
  assert.equal(trusted.get("architect").source, "project");
  assert.deepEqual(trusted.get("architect"), project);
  assert.deepEqual(trusted.get("architect").modelSuggestions, ["project-alias"]);
  assertNoSelectionEffect(trusted.get("architect"), ["project-alias"]);
  for (const type of trusted.list().filter((type) => type.name !== "architect"))
    assertContract(type);

  const untrusted = new ConfigStore({ ...options, includeProject: false });
  assert.equal(untrusted.get("architect").source, "user");
  assert.deepEqual(untrusted.get("architect").modelSuggestions, ["user-alias-a", "user-alias-b"]);
  assert.deepEqual(
    parseAgentType(readFileSync(bundled.filePath!, "utf8")).modelSuggestions,
    SUGGESTIONS.architect,
  );
  for (const name of REMOVED) assert.throws(() => untrusted.get(name), /Unknown or invalid/);
});

test("removed bundled roles are not aliases, but custom user definitions are allowed", (t) => {
  const options = fixture(t);
  const store = new ConfigStore(options);
  for (const name of REMOVED) {
    assert.throws(() => store.get(name), /Unknown or invalid/);
    const saved = store.save(
      {
        name,
        description: `Custom ${name} role`,
        systemPrompt: `Custom ${name} instructions.\n`,
        thinkingLevel: "low",
        modelSuggestions: [`custom-${name}`],
        tools: { allow: ["read"] },
      },
      "user",
    );
    assert.equal(saved.source, "user");
    assert.deepEqual(saved.modelSuggestions, [`custom-${name}`]);
    assertNoSelectionEffect(saved, [`custom-${name}`]);
  }
  const reloaded = new ConfigStore(options);
  assert.deepEqual(reloaded.diagnostics, []);
  assert.deepEqual(
    reloaded.list().map((type) => type.name),
    [...NAMES, ...REMOVED].sort(),
  );
  for (const name of NAMES) assertContract(reloaded.get(name));
  assert.notEqual(reloaded.get("researcher").systemPrompt, reloaded.get("architect").systemPrompt);
  assert.notEqual(reloaded.get("designer").systemPrompt, reloaded.get("coder").systemPrompt);
  assert.notEqual(reloaded.get("explorer").systemPrompt, reloaded.get("tasker").systemPrompt);
  assert.deepEqual(reloaded.get("researcher").modelSuggestions, ["custom-researcher"]);
  assert.deepEqual(reloaded.get("designer").modelSuggestions, ["custom-designer"]);
  assert.deepEqual(reloaded.get("explorer").modelSuggestions, ["custom-explorer"]);
});

test("a custom bundled directory can disable packaged defaults without dropping user agents", (t) => {
  const options = fixture(t);
  const store = new ConfigStore(options);
  const custom = store.save(
    {
      name: "custom",
      description: "User-defined role",
      systemPrompt: "Follow the task.\n",
    },
    "user",
  );
  const disabled = new ConfigStore({
    ...options,
    bundledDir: join(options.cwd, "missing-bundled"),
  });
  assert.deepEqual(disabled.diagnostics, []);
  assert.deepEqual(
    disabled.list().map((type) => type.name),
    ["custom"],
  );
  assert.deepEqual(disabled.get("custom"), custom);
  for (const name of [...NAMES, ...REMOVED, "worker"])
    assert.throws(() => disabled.get(name), /Unknown or invalid/);
});
