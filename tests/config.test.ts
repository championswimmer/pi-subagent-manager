import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  AGENT_COLORS,
  ConfigStore,
  parseAgentType,
  selectTools,
  serializeAgentType,
} from "../src/prefs/config.js";
import { THINKING_LEVELS, type AgentType } from "../src/types.js";

const definition: AgentType = {
  name: "example",
  description: "Example agent",
  systemPrompt: "# Instructions\n\nBe helpful.\n",
};
const markdown = (extra = "", name = "example") =>
  `---\nname: ${name}\ndescription: Example agent\n${extra}---\nBody\n`;
const write = (directory: string, file: string, type: Partial<AgentType>) =>
  writeFileSync(join(directory, file), serializeAgentType({ ...definition, ...type }));

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const agentDir = join(root, "user");
  const dirs = {
    bundledDir: join(root, "bundled"),
    projectLegacy: join(cwd, ".pi", "agents"),
    project: join(cwd, ".pi", "agent", "subagent-manager", "agents"),
    userLegacy: join(agentDir, "agents"),
    user: join(agentDir, "subagent-manager", "agents"),
  };
  for (const directory of Object.values(dirs)) mkdirSync(directory, { recursive: true });
  return { cwd, agentDir, ...dirs };
}

test("parse/serialize round-trips fields, canonicalizes legacy model, and drops provenance", () => {
  const type: AgentType = {
    ...definition,
    description: "colon: # yes\nmultiline",
    models: ["provider/model/id", "provider/fallback"],
    modelSuggestions: ["Claude Opus", "GPT"],
    thinkingLevel: "high",
    color: "accent",
    tools: { allow: [], block: ["bash"] },
  };
  assert.deepEqual(parseAgentType(serializeAgentType(type)), type);
  assert.equal(parseAgentType(markdown(), "example.md").filePath, "example.md");
  assert.equal(parseAgentType(markdown().replaceAll("\n", "\r\n")).systemPrompt, "Body\r\n");
  assert.equal(parseAgentType("---\nname: empty\ndescription: Empty\n---").systemPrompt, "");

  assert.deepEqual(parseAgentType(markdown("model: provider/model/with/slashes\n")).models, [
    "provider/model/with/slashes",
  ]);
  const serialized = serializeAgentType({
    ...definition,
    model: "provider/model",
    source: "user",
    filePath: "/private/example.md",
  } as AgentType);
  assert.doesNotMatch(serialized, /source:|filePath:|\nmodel:/);
  assert.deepEqual(parseAgentType(serialized), { ...definition, models: ["provider/model"] });
});

test("parser rejects malformed frontmatter and invalid field values", () => {
  for (const content of [
    "No frontmatter",
    markdown("name: duplicate\n"),
    markdown("tools: [\n"),
    markdown("permissionMode: bypassPermissions\n"),
    markdown("tools:\n  allow: []\n  allow: [bash]\n"),
    markdown("tools:\n  deny: [bash]\n"),
  ])
    assert.throws(() => parseAgentType(content, "bad.md"), /bad\.md:/);
  assert.throws(
    () => parseAgentType(markdown("unknown: true\n")),
    /Unknown frontmatter field: unknown/,
  );
  assert.throws(() => parseAgentType(markdown("model: &m provider/id\ncolor: *m\n")), /alias/i);
  assert.throws(() => parseAgentType("---\nname: valid\ndescription: ''\n---\n"), /description/);
  for (const name of ["../escape", "a/b", '""', "null", "123", "a.b"])
    assert.throws(() => parseAgentType(markdown("", name)), /name/);
  for (const extra of [
    "model: model-only\n",
    "models: provider/model\n",
    "models: []\n",
    "models:\n  - provider/model\n  - provider/model\n",
    "model: provider/legacy\nmodels:\n  - provider/model\n",
    "thinkingLevel: extreme\n",
    "color: red\n",
    "tools: bash\n",
    "tools:\n  allow: null\n",
    "tools:\n  block: [bash*]\n",
    "tools:\n  allow: [read, read]\n",
  ])
    assert.throws(() => parseAgentType(markdown(extra)), extra);
  for (const extra of [
    "modelSuggestions: Claude Opus\n",
    "modelSuggestions:\n  - 1\n",
    "modelSuggestions:\n  - '   '\n",
    "modelSuggestions:\n  - Claude Opus\n  - ' Claude Opus '\n",
  ])
    assert.throws(() => parseAgentType(markdown(extra)), /modelSuggestions/);
  for (const color of AGENT_COLORS)
    assert.equal(parseAgentType(markdown(`color: ${color}\n`)).color, color);
  for (const level of THINKING_LEVELS)
    assert.equal(parseAgentType(markdown(`thinkingLevel: ${level}\n`)).thinkingLevel, level);
});

test("modelSuggestions are trimmed, keep an explicit empty list, and are omitted when absent", () => {
  assert.deepEqual(
    parseAgentType(markdown("modelSuggestions:\n  - '  Claude Opus  '\n  - GPT\n"))
      .modelSuggestions,
    ["Claude Opus", "GPT"],
  );
  const empty = parseAgentType(markdown("modelSuggestions: []\n"));
  assert.deepEqual(empty.modelSuggestions, []);
  assert.deepEqual(parseAgentType(serializeAgentType(empty)).modelSuggestions, []);
  assert.equal(parseAgentType(markdown()).modelSuggestions, undefined);
  assert.doesNotMatch(serializeAgentType(definition), /modelSuggestions/);
});

test("selectTools has exact names, empty allow, block wins and stable available order", () => {
  const available = ["read", "bash", "agent_update"];
  assert.deepEqual(selectTools(undefined, available), available);
  assert.deepEqual(selectTools({ allow: [] }, available), []);
  assert.deepEqual(selectTools({ allow: ["bash", "read"], block: ["bash"] }, available), ["read"]);
  assert.deepEqual(selectTools({ block: ["bash"] }, available), ["read", "agent_update"]);
  for (const policy of [{ allow: ["Read"] }, { block: ["missing"] }, { allow: ["*"] }])
    assert.throws(() => selectTools(policy, available));
});

test("precedence, source, filePath, trust switch and defensive copies", (t) => {
  const f = fixture(t);
  for (const [directory, description] of [
    [f.bundledDir, "bundled"],
    [f.user, "user"],
    [f.project, "project"],
  ])
    write(directory, "example.md", { description });
  const store = new ConfigStore({ ...f, includeProject: true });
  assert.equal(store.get("example").description, "project");
  assert.equal(store.get("example").source, "project");
  assert.equal(store.get("example").filePath, join(f.project, "example.md"));
  store.get("example").description = "changed";
  store.list()[0].description = "changed";
  assert.equal(store.get("example").description, "project");
  assert.equal(new ConfigStore({ ...f, includeProject: false }).get("example").source, "user");
  assert.throws(() => store.get("missing"), /Unknown or invalid/);

  // Duplicate names within one layer fail closed; a higher layer still wins.
  writeFileSync(join(f.bundledDir, "worker.md"), markdown("", "worker"));
  for (const file of ["worker-a.md", "worker-b.md"])
    writeFileSync(join(f.user, file), markdown("", "worker"));
  store.reload();
  assert.throws(() => store.get("worker"), /Unknown or invalid/);
  assert.equal(store.diagnostics.length, 1);
  assert.match(store.diagnostics[0], /Duplicate agent name.*worker/);
  writeFileSync(join(f.project, "worker.md"), markdown("", "worker"));
  store.reload();
  assert.equal(store.get("worker").source, "project");
  assert.throws(
    () => new ConfigStore({ ...f, includeProject: false }).get("worker"),
    /Unknown or invalid/,
  );
});

test("malformed overrides block both filename and declared name while other files load", (t) => {
  const f = fixture(t);
  write(f.bundledDir, "example.md", {});
  write(f.bundledDir, "other.md", { name: "other" });
  writeFileSync(join(f.project, "example.md"), markdown("unsupported: true\n", "other"));
  writeFileSync(join(f.project, "good.md"), markdown("", "good"));
  const store = new ConfigStore({ ...f, includeProject: true });
  assert.throws(() => store.get("example"));
  assert.throws(() => store.get("other"));
  assert.equal(store.get("good").source, "project");
  assert.equal(store.diagnostics.length, 1);
  assert.match(store.diagnostics[0], /Unknown frontmatter field/);
  rmSync(join(f.project, "example.md"));
  store.reload();
  assert.equal(store.get("example").source, "bundled");
  assert.deepEqual(store.diagnostics, []);

  // A malformed file with duplicate declared names cannot resurrect lower layers.
  for (const name of ["example", "other"])
    writeFileSync(join(f.user, `${name}.md`), markdown("", name));
  writeFileSync(join(f.project, "broken.md"), markdown("name: other\n"));
  store.reload();
  assert.throws(() => store.get("example"));
  assert.throws(() => store.get("other"));
  assert.match(store.diagnostics.join("\n"), /unique|duplicate/i);
});

test("legacy agent directories (including symlinked ones) are ignored", (t) => {
  const f = fixture(t);
  write(f.bundledDir, "example.md", { description: "bundled" });
  writeFileSync(join(f.userLegacy, "example.md"), "not frontmatter");
  write(f.userLegacy, "legacy-only.md", { name: "legacy-only" });
  write(f.projectLegacy, "example.md", { description: "Legacy project" });
  writeFileSync(join(f.projectLegacy, "broken.md"), ":\n  [");
  const store = new ConfigStore({ ...f, includeProject: true });
  assert.equal(store.get("example").filePath, join(f.bundledDir, "example.md"));
  assert.throws(() => store.get("legacy-only"), /Unknown or invalid/);
  assert.deepEqual(store.diagnostics, []);

  const outside = join(f.agentDir, "outside-package");
  mkdirSync(outside);
  write(outside, "hijack.md", { name: "hijack" });
  for (const legacy of [f.userLegacy, f.projectLegacy]) {
    rmSync(legacy, { recursive: true });
    symlinkSync(outside, legacy);
  }
  store.reload();
  assert.throws(() => store.get("hijack"), /Unknown or invalid/);
  assert.equal(store.get("example").source, "bundled");
  assert.deepEqual(store.diagnostics, []);
});

test("saves write canonical storage, keep existing filenames, and never touch bundled files", (t) => {
  const f = fixture(t);
  write(f.bundledDir, "bundled-only.md", { name: "bundled-only", description: "Bundled only" });
  write(f.user, "custom.md", { name: "custom-file" });
  const store = new ConfigStore({ ...f, includeProject: true });

  const bundled = store.get("bundled-only");
  const override = store.save({ ...bundled, description: "Override" }, "user", bundled);
  assert.equal(override.filePath, join(f.user, "bundled-only.md"));
  assert.equal(override.source, "user");
  assert.equal(store.get("bundled-only").description, "Override");
  assert.equal(
    parseAgentType(readFileSync(join(f.bundledDir, "bundled-only.md"), "utf8")).description,
    "Bundled only",
  );

  const custom = store.get("custom-file");
  const updated = store.save({ ...custom, description: "Updated" }, "user", custom);
  assert.equal(updated.filePath, join(f.user, "custom.md"));
  assert.equal(store.get("custom-file").description, "Updated");

  const saved = store.save(
    { ...definition, tools: { allow: [] }, modelSuggestions: ["GPT"] },
    "user",
  );
  assert.deepEqual(parseAgentType(readFileSync(saved.filePath!, "utf8")).tools, { allow: [] });
  saved.modelSuggestions!.push("mutated");
  assert.deepEqual(store.get("example").modelSuggestions, ["GPT"]);
  store.save({ ...definition, description: "Project" }, "project");
  assert.equal(store.get("example").description, "Project");
  assert.deepEqual(readdirSync(f.user).sort(), ["bundled-only.md", "custom.md", "example.md"]);
  assert.deepEqual(readdirSync(f.project), ["example.md"]);
  assert.deepEqual(readdirSync(f.userLegacy), []);
  assert.deepEqual(readdirSync(f.projectLegacy), []);

  assert.throws(() => store.save({ ...definition, name: "../escape" }, "user"));
  assert.throws(() => store.save({ ...definition, color: "red" } as AgentType, "user"));
  assert.throws(
    () => new ConfigStore({ ...f, includeProject: false }).save(definition, "project"),
    /not enabled\/trusted/,
  );
});

test("symlink definitions fail closed and symlink save destinations are rejected", (t) => {
  const f = fixture(t);
  write(f.bundledDir, "example.md", {});
  symlinkSync(join(f.bundledDir, "example.md"), join(f.user, "example.md"));
  const store = new ConfigStore({ ...f, includeProject: false });
  assert.throws(() => store.get("example"));
  assert.throws(() => store.save(definition, "user"), /Unsafe symlink path/);

  rmSync(join(f.user, "example.md"));
  symlinkSync(join(f.user, "missing.md"), join(f.user, "worker.md"));
  assert.throws(() => store.save({ ...definition, name: "worker" }, "user"), /Unsafe symlink path/);

  rmSync(f.user, { recursive: true });
  symlinkSync(join(f.agentDir, "missing-agents"), f.user);
  store.reload();
  assert.throws(() => store.get("example"));
  assert.match(store.diagnostics.join("\n"), /Unsafe symlink path/);
  assert.throws(() => store.save(definition, "user"), /Unsafe symlink path/);

  rmSync(f.user);
  mkdirSync(f.user);
  rmSync(f.project, { recursive: true });
  symlinkSync(f.bundledDir, f.project);
  const trusted = new ConfigStore({ ...f, includeProject: true });
  assert.throws(() => trusted.get("example"));
  assert.match(trusted.diagnostics.join("\n"), /Unsafe symlink path/);
  assert.throws(() => trusted.save(definition, "project"), /Unsafe symlink path/);
});
