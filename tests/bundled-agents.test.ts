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
  designer: { thinking: "medium", tools: IMPLEMENT },
  explorer: { thinking: "low", tools: [...READ, ...LIFECYCLE] },
  researcher: { thinking: "high", tools: [...READ, "bash", ...LIFECYCLE] },
  reviewer: { thinking: "high", tools: [...READ, "bash", ...LIFECYCLE] },
  tasker: { thinking: "low", tools: IMPLEMENT },
  writer: { thinking: "medium", tools: [...READ, "edit", "write", ...LIFECYCLE] },
};
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

function assertContract(type: AgentType) {
  const contract = CONTRACTS[type.name];
  assert.ok(contract, `Unexpected bundled role ${type.name}`);
  assert.equal(type.source, "bundled");
  assert.equal(type.filePath, join(BUNDLED_DIR, `${type.name}.md`));
  assert.equal(type.thinkingLevel, contract.thinking);
  assert.equal(Object.hasOwn(type, "model"), false);
  assert.equal(Object.hasOwn(type, "models"), false);
  assert.equal(selectPreferredModel(type, []), undefined, "No scope is required to inherit");
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

test("bundled defaults have distinct prompts, exact role contracts and no vendor pins", (t) => {
  const store = new ConfigStore(fixture(t));
  assert.deepEqual(store.diagnostics, []);
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
  assert.throws(() => store.get("worker"), /Unknown or invalid/);
  const types = store.list();
  for (const type of types) assertContract(type);
  assert.equal(new Set(types.map((type) => type.description)).size, types.length);
  assert.equal(new Set(types.map((type) => type.systemPrompt)).size, types.length);
});

test("a saved same-name user override replaces only that bundled role", (t) => {
  const options = fixture(t);
  const store = new ConfigStore(options);
  const bundled = store.get("researcher");
  const override = store.save(
    {
      ...bundled,
      description: "My source synthesis specialist",
      systemPrompt: "Use the supplied evidence only.\n",
      thinkingLevel: "low",
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
  assert.deepEqual(reloaded.get("researcher"), override);
  assert.equal(override.source, "user");
  for (const type of reloaded.list().filter((type) => type.name !== "researcher"))
    assertContract(type);
  assert.equal(
    parseAgentType(readFileSync(bundled.filePath!, "utf8")).description,
    bundled.description,
  );
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
  for (const name of [...NAMES, "worker"])
    assert.throws(() => disabled.get(name), /Unknown or invalid/);
});
