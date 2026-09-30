import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { AGENT_COLORS, ConfigStore, parseAgentType, selectTools, serializeAgentType } from "../src/config.js";
import { THINKING_LEVELS, type AgentType } from "../src/types.js";

const definition: AgentType = { name: "example", description: "Example agent", systemPrompt: "# Instructions\n\nBe helpful.\n" };
const markdown = (extra = "", name = "example") => `---\nname: ${name}\ndescription: Example agent\n${extra}---\nBody\n`;

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const agentDir = join(root, "user");
  const bundledDir = join(root, "bundled");
  const project = join(cwd, ".pi", "agents");
  const user = join(agentDir, "agents");
  for (const directory of [project, user, bundledDir]) mkdirSync(directory, { recursive: true });
  return { cwd, agentDir, bundledDir, project, user };
}

test("parse and serialize round-trip all fields and exact Markdown body", () => {
  const type: AgentType = { ...definition, model: "provider/model/id", thinkingLevel: "high", color: "accent", tools: { allow: [], block: ["bash"] } };
  assert.deepEqual(parseAgentType(serializeAgentType(type)), type);
  assert.equal(parseAgentType(markdown(), "example.md").filePath, "example.md");
  const crlf = markdown().replaceAll("\n", "\r\n");
  assert.equal(parseAgentType(crlf).systemPrompt, "Body\r\n");
  assert.equal(parseAgentType("---\nname: empty\ndescription: Empty\n---").systemPrompt, "");
});

test("serializer excludes provenance and quotes YAML-sensitive strings", () => {
  const type = { ...definition, description: "colon: # yes\nmultiline", source: "user" as const, filePath: "/private/example.md" };
  const content = serializeAgentType(type);
  assert.doesNotMatch(content, /source:|filePath:/);
  assert.deepEqual(parseAgentType(content), { ...definition, description: type.description });
});

test("reject malformed YAML, duplicate keys, unknown fields and unsupported Claude fields", () => {
  for (const content of ["No frontmatter", markdown("name: duplicate\n"), markdown("tools: [\n"), markdown("permissionMode: bypassPermissions\n"), markdown("tools:\n  allow: []\n  allow: [bash]\n"), markdown("tools:\n  deny: [bash]\n")]) {
    assert.throws(() => parseAgentType(content, "bad.md"), /bad\.md:/);
  }
  assert.throws(() => parseAgentType(markdown("unknown: true\n")), /Unknown frontmatter field: unknown/);
  assert.throws(() => parseAgentType(markdown("model: &m provider\/id\ncolor: *m\n")), /alias|Alias/);
});

test("validate scalar fields, safe names, model and exact tool policy", () => {
  for (const name of ["../escape", "a/b", '""', "null", "123", "a.b"]) assert.throws(() => parseAgentType(markdown("", name)), /name/);
  for (const extra of ["model: model-only\n", "model: null\n", "thinkingLevel: extreme\n", "color: red\n", "color: toolPendingBg\n", "tools: bash\n", "tools:\n  allow: null\n", "tools:\n  block: [bash*]\n", "tools:\n  allow: [read, read]\n", "tools:\n  allow: [123]\n"]) assert.throws(() => parseAgentType(markdown(extra)));
  assert.throws(() => parseAgentType("---\nname: valid\ndescription: ''\n---\n"), /description/);
  for (const color of AGENT_COLORS) assert.equal(parseAgentType(markdown(`color: ${color}\n`)).color, color);
  for (const thinkingLevel of THINKING_LEVELS) assert.equal(parseAgentType(markdown(`thinkingLevel: ${thinkingLevel}\n`)).thinkingLevel, thinkingLevel);
});

test("selectTools has exact names, empty allow, block wins and stable available order", () => {
  const available = ["read", "bash", "agent_update"];
  assert.deepEqual(selectTools(undefined, available), available);
  assert.deepEqual(selectTools({}, available), available);
  assert.deepEqual(selectTools({ allow: [] }, available), []);
  assert.deepEqual(selectTools({ allow: ["bash", "read"], block: ["bash"] }, available), ["read"]);
  assert.deepEqual(selectTools({ block: ["bash"] }, available), ["read", "agent_update"]);
  for (const policy of [{ allow: ["Read"] }, { block: ["missing"] }, { allow: [], block: ["missing"] }, { allow: ["*"] }]) assert.throws(() => selectTools(policy, available));
});

test("bundled defaults are loaded with researcher restricted and worker unfiltered", () => {
  const store = new ConfigStore({ cwd: "/nonexistent-project", agentDir: "/nonexistent-user", includeProject: false });
  assert.equal(store.get("researcher").source, "bundled");
  assert.deepEqual(store.get("researcher").tools?.allow, ["read", "grep", "find", "ls", "agent_update", "agent_pause"]);
  assert.equal(store.get("worker").tools, undefined);
});

test("precedence, source, filePath, trust switch and defensive copies", (t) => {
  const f = fixture(t);
  for (const [directory, description] of [[f.bundledDir, "bundled"], [f.user, "user"], [f.project, "project"]]) writeFileSync(join(directory, "example.md"), serializeAgentType({ ...definition, description }));
  const store = new ConfigStore({ ...f, includeProject: true });
  assert.equal(store.get("example").description, "project");
  assert.equal(store.get("example").source, "project");
  assert.equal(store.get("example").filePath, join(f.project, "example.md"));
  store.get("example").description = "changed";
  store.list()[0].description = "changed";
  assert.equal(store.get("example").description, "project");
  assert.equal(new ConfigStore({ ...f, includeProject: false }).get("example").source, "user");
  assert.throws(() => store.get("missing"), /Unknown or invalid/);

  writeFileSync(join(f.bundledDir, "worker.md"), markdown("", "worker"));
  for (const file of ["worker-a.md", "worker-b.md"]) writeFileSync(join(f.user, file), markdown("", "worker"));
  store.reload();
  assert.throws(() => store.get("worker"), /Unknown or invalid/);
  assert.equal(store.diagnostics.length, 1);
  assert.match(store.diagnostics[0], /Duplicate agent name.*worker/);
  writeFileSync(join(f.user, "worker-c.md"), markdown("", "worker"));
  store.reload();
  assert.throws(() => store.get("worker"), /Unknown or invalid/);
  writeFileSync(join(f.project, "worker.md"), markdown("", "worker"));
  store.reload();
  assert.equal(store.get("worker").source, "project");
  assert.throws(() => new ConfigStore({ ...f, includeProject: false }).get("worker"), /Unknown or invalid/);
});

test("malformed overrides block both filename and declared name while other files load", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.bundledDir, "example.md"), serializeAgentType(definition));
  writeFileSync(join(f.bundledDir, "other.md"), serializeAgentType({ ...definition, name: "other" }));
  writeFileSync(join(f.project, "example.md"), markdown("unsupported: true\n", "other"));
  writeFileSync(join(f.project, "good.md"), markdown("", "good"));
  const store = new ConfigStore({ ...f, includeProject: true });
  assert.throws(() => store.get("example"));
  assert.throws(() => store.get("other"));
  assert.equal(store.get("good").source, "project");
  assert.equal(store.diagnostics.length, 1);
  assert.match(store.diagnostics[0], /Unknown frontmatter field/);
  writeFileSync(join(f.project, "z-other.md"), markdown("", "other"));
  store.reload();
  assert.throws(() => store.get("other"));
  rmSync(join(f.project, "z-other.md"));
  rmSync(join(f.project, "example.md"));
  store.reload();
  assert.equal(store.get("example").source, "bundled");
  assert.deepEqual(store.diagnostics, []);
});

test("duplicate declared names in malformed file cannot resurrect lower policy", (t) => {
  const f = fixture(t);
  for (const name of ["example", "other"]) writeFileSync(join(f.user, `${name}.md`), markdown("", name));
  writeFileSync(join(f.project, "broken.md"), markdown("name: other\n"));
  const store = new ConfigStore({ ...f, includeProject: true });
  assert.deepEqual(store.list(), []);
  assert.match(store.diagnostics[0], /unique|duplicate/i);
});

test("save validates and atomically writes user/project definitions and reloads", (t) => {
  const f = fixture(t);
  const store = new ConfigStore({ ...f, includeProject: true });
  const saved = store.save({ ...definition, tools: { allow: [] } }, "user");
  assert.equal(saved.source, "user");
  assert.deepEqual(parseAgentType(readFileSync(saved.filePath!, "utf8")).tools, { allow: [] });
  store.save({ ...definition, description: "Project" }, "project");
  assert.equal(store.get("example").description, "Project");
  assert.deepEqual(readdirSync(f.user), ["example.md"]);
  assert.deepEqual(readdirSync(f.project), ["example.md"]);
  assert.throws(() => store.save({ ...definition, name: "../escape" }, "user"));
  assert.throws(() => store.save({ ...definition, color: "red" }, "user"));
  assert.throws(() => new ConfigStore({ ...f, includeProject: false }).save(definition, "project"), /not enabled\/trusted/);
});

test("symlink definitions fail closed and symlink save destinations are rejected", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.bundledDir, "example.md"), serializeAgentType(definition));
  symlinkSync(join(f.bundledDir, "example.md"), join(f.user, "example.md"));
  const store = new ConfigStore({ ...f, includeProject: false });
  assert.throws(() => store.get("example"));
  assert.throws(() => store.save(definition, "user"), /Unsafe agent destination/);
  rmSync(f.user, { recursive: true });
  symlinkSync(f.bundledDir, f.user);
  store.reload();
  assert.throws(() => store.get("example"));
  assert.equal(store.diagnostics.length, 1);
  assert.match(store.diagnostics[0], /Unsafe symlink path/);
  assert.throws(() => store.save(definition, "user"), /Unsafe symlink path/);

  rmSync(f.user);
  mkdirSync(f.user);
  rmSync(f.project, { recursive: true });
  symlinkSync(f.bundledDir, f.project);
  const trusted = new ConfigStore({ ...f, includeProject: true });
  assert.throws(() => trusted.get("example"));
  assert.equal(trusted.diagnostics.length, 1);
  assert.match(trusted.diagnostics[0], /Unsafe symlink path/);
  assert.throws(() => trusted.save(definition, "project"), /Unsafe symlink path/);
});
