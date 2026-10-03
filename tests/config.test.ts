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
} from "../src/config.js";
import { THINKING_LEVELS, type AgentType } from "../src/types.js";

const definition: AgentType = {
  name: "example",
  description: "Example agent",
  systemPrompt: "# Instructions\n\nBe helpful.\n",
};
const markdown = (extra = "", name = "example") =>
  `---\nname: ${name}\ndescription: Example agent\n${extra}---\nBody\n`;

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const agentDir = join(root, "user");
  const bundledDir = join(root, "bundled");
  const projectLegacy = join(cwd, ".pi", "agents");
  const project = join(cwd, ".pi", "agent", "subagent-manager", "agents");
  const userLegacy = join(agentDir, "agents");
  const user = join(agentDir, "subagent-manager", "agents");
  for (const directory of [
    projectLegacy,
    project,
    userLegacy,
    user,
    bundledDir,
  ])
    mkdirSync(directory, { recursive: true });
  return {
    cwd,
    agentDir,
    bundledDir,
    project,
    projectLegacy,
    user,
    userLegacy,
  };
}

test("parse and serialize round-trip all fields and exact Markdown body", () => {
  const type: AgentType = {
    ...definition,
    models: ["provider/model/id", "provider/fallback"],
    modelSuggestions: ["Claude Opus", "GPT"],
    thinkingLevel: "high",
    color: "accent",
    tools: { allow: [], block: ["bash"] },
  };
  assert.deepEqual(parseAgentType(serializeAgentType(type)), type);
  assert.equal(parseAgentType(markdown(), "example.md").filePath, "example.md");
  const crlf = markdown().replaceAll("\n", "\r\n");
  assert.equal(parseAgentType(crlf).systemPrompt, "Body\r\n");
  assert.equal(
    parseAgentType("---\nname: empty\ndescription: Empty\n---").systemPrompt,
    "",
  );
});

test("legacy model frontmatter parses as models and serializes canonically", () => {
  const parsed = parseAgentType(markdown("model: provider/model/with/slashes\n"));
  assert.deepEqual(parsed, {
    ...definition,
    models: ["provider/model/with/slashes"],
    systemPrompt: "Body\n",
  });

  const legacy = {
    ...definition,
    model: "provider/model/with/slashes",
  };
  const serialized = serializeAgentType(legacy);
  assert.match(
    serialized,
    /^---\nname: example\ndescription: Example agent\nmodels:\n  - provider\/model\/with\/slashes\n---\n# Instructions\n\nBe helpful\.\n$/,
  );
  assert.doesNotMatch(serialized, /\nmodel:/);
  assert.deepEqual(parseAgentType(serialized), {
    ...definition,
    models: ["provider/model/with/slashes"],
  });
});

test("serializer excludes provenance and quotes YAML-sensitive strings", () => {
  const type = {
    ...definition,
    description: "colon: # yes\nmultiline",
    model: "provider/model",
    source: "user" as const,
    filePath: "/private/example.md",
  };
  const content = serializeAgentType(type);
  assert.doesNotMatch(content, /source:|filePath:|\nmodel:/);
  assert.deepEqual(parseAgentType(content), {
    ...definition,
    description: type.description,
    models: ["provider/model"],
  });
});

test("reject malformed YAML, duplicate keys, unknown fields and unsupported Claude fields", () => {
  for (const content of [
    "No frontmatter",
    markdown("name: duplicate\n"),
    markdown("tools: [\n"),
    markdown("permissionMode: bypassPermissions\n"),
    markdown("tools:\n  allow: []\n  allow: [bash]\n"),
    markdown("tools:\n  deny: [bash]\n"),
  ]) {
    assert.throws(() => parseAgentType(content, "bad.md"), /bad\.md:/);
  }
  assert.throws(
    () => parseAgentType(markdown("unknown: true\n")),
    /Unknown frontmatter field: unknown/,
  );
  assert.throws(
    () => parseAgentType(markdown("model: &m provider\/id\ncolor: *m\n")),
    /alias|Alias/,
  );
});

test("validate scalar fields, safe names, model preferences and exact tool policy", () => {
  for (const name of ["../escape", "a/b", '""', "null", "123", "a.b"])
    assert.throws(() => parseAgentType(markdown("", name)), /name/);
  for (const extra of [
    "model: model-only\n",
    "model: null\n",
    "models: null\n",
    "models: provider/model\n",
    "models: []\n",
    "models:\n  - provider/model\n  - provider/model\n",
    "model: provider/legacy\nmodels:\n  - provider/model\n",
    "thinkingLevel: extreme\n",
    "color: red\n",
    "color: toolPendingBg\n",
    "tools: bash\n",
    "tools:\n  allow: null\n",
    "tools:\n  block: [bash*]\n",
    "tools:\n  allow: [read, read]\n",
    "tools:\n  allow: [123]\n",
  ])
    assert.throws(() => parseAgentType(markdown(extra)));
  assert.throws(
    () => parseAgentType("---\nname: valid\ndescription: ''\n---\n"),
    /description/,
  );
  assert.deepEqual(
    parseAgentType(markdown("models:\n  - provider/model/with/slashes\n")).models,
    ["provider/model/with/slashes"],
  );
  for (const color of AGENT_COLORS)
    assert.equal(parseAgentType(markdown(`color: ${color}\n`)).color, color);
  for (const thinkingLevel of THINKING_LEVELS)
    assert.equal(
      parseAgentType(markdown(`thinkingLevel: ${thinkingLevel}\n`))
        .thinkingLevel,
      thinkingLevel,
    );
});

test("modelSuggestions accepts display aliases, preserves an explicit empty list, and rejects malformed values", () => {
  const parsed = parseAgentType(
    markdown(
      "models:\n  - provider/model/with/slashes\nmodelSuggestions:\n  - '  Claude Opus  '\n  - GPT\n  - Sonnet\n",
    ),
  );
  assert.deepEqual(parsed.models, ["provider/model/with/slashes"]);
  assert.deepEqual(parsed.modelSuggestions, ["Claude Opus", "GPT", "Sonnet"]);
  assert.equal(parsed.modelSuggestions!.some((name) => name.includes("/")), false);
  parsed.modelSuggestions!.push("mutated");
  assert.deepEqual(
    parseAgentType(
      markdown("modelSuggestions:\n  - '  Claude Opus  '\n  - GPT\n  - Sonnet\n"),
    ).modelSuggestions,
    ["Claude Opus", "GPT", "Sonnet"],
  );

  const empty = parseAgentType(markdown("modelSuggestions: []\n"));
  assert.deepEqual(empty.modelSuggestions, []);
  assert.match(serializeAgentType(empty), /modelSuggestions: \[\]/);
  assert.deepEqual(parseAgentType(serializeAgentType(empty)).modelSuggestions, []);
  assert.equal(parseAgentType(markdown()).modelSuggestions, undefined);
  assert.doesNotMatch(serializeAgentType(definition), /modelSuggestions/);

  const untrimmed = ["  Claude Opus  ", "GPT"];
  const serialized = serializeAgentType({
    ...definition,
    modelSuggestions: untrimmed,
  });
  untrimmed.push("later");
  assert.deepEqual(parseAgentType(serialized).modelSuggestions, [
    "Claude Opus",
    "GPT",
  ]);
  assert.equal(parseAgentType(serialized).models, undefined);

  for (const extra of [
    "modelSuggestions: Claude Opus\n",
    "modelSuggestions: null\n",
    "modelSuggestions:\n  - null\n",
    "modelSuggestions:\n  - 1\n",
    "modelSuggestions:\n  - true\n",
    "modelSuggestions:\n  - ''\n",
    "modelSuggestions:\n  - '   '\n",
    "modelSuggestions:\n  - GPT\n  - GPT\n",
    "modelSuggestions:\n  - Claude Opus\n  - ' Claude Opus '\n",
  ])
    assert.throws(() => parseAgentType(markdown(extra)), /modelSuggestions/);
});

test("ConfigStore clones and saves modelSuggestions without changing model pins", (t) => {
  const f = fixture(t);
  const store = new ConfigStore({ ...f, includeProject: true });
  const input = ["Claude Opus", "GPT"];
  const saved = store.save(
    {
      ...definition,
      models: ["provider/model"],
      modelSuggestions: input,
    },
    "user",
  );
  input.push("mutated-input");
  saved.modelSuggestions!.push("mutated-return");
  assert.deepEqual(store.get("example").modelSuggestions, ["Claude Opus", "GPT"]);
  assert.deepEqual(store.get("example").models, ["provider/model"]);
  const listed = store.list().find((type) => type.name === "example")!;
  listed.modelSuggestions!.reverse();
  assert.deepEqual(store.get("example").modelSuggestions, ["Claude Opus", "GPT"]);
  assert.notEqual(
    store.get("example").modelSuggestions,
    store.list().find((type) => type.name === "example")!.modelSuggestions,
  );
  assert.match(
    readFileSync(saved.filePath!, "utf8"),
    /models:\n  - provider\/model\nmodelSuggestions:\n  - Claude Opus\n  - GPT\n/,
  );

  store.save({ ...definition, modelSuggestions: [] }, "user");
  assert.deepEqual(store.get("example").modelSuggestions, []);
  assert.equal(store.get("example").models, undefined);
  assert.match(
    readFileSync(store.get("example").filePath!, "utf8"),
    /modelSuggestions: \[\]/,
  );

  const cleared = store.save(
    { ...definition, description: "No suggestions" },
    "user",
  );
  assert.equal(cleared.modelSuggestions, undefined);
  assert.equal(store.get("example").modelSuggestions, undefined);
  assert.doesNotMatch(
    readFileSync(cleared.filePath!, "utf8"),
    /modelSuggestions/,
  );
});

test("selectTools has exact names, empty allow, block wins and stable available order", () => {
  const available = ["read", "bash", "agent_update"];
  assert.deepEqual(selectTools(undefined, available), available);
  assert.deepEqual(selectTools({}, available), available);
  assert.deepEqual(selectTools({ allow: [] }, available), []);
  assert.deepEqual(
    selectTools({ allow: ["bash", "read"], block: ["bash"] }, available),
    ["read"],
  );
  assert.deepEqual(selectTools({ block: ["bash"] }, available), [
    "read",
    "agent_update",
  ]);
  for (const policy of [
    { allow: ["Read"] },
    { block: ["missing"] },
    { allow: [], block: ["missing"] },
    { allow: ["*"] },
  ])
    assert.throws(() => selectTools(policy, available));
});

test("bundled defaults are architect, coder, reviewer, tasker and writer", () => {
  const store = new ConfigStore({
    cwd: "/nonexistent-project",
    agentDir: "/nonexistent-user",
    includeProject: false,
  });
  assert.deepEqual(
    store.list().map((type) => type.name),
    ["architect", "coder", "reviewer", "tasker", "writer"],
  );
});

test("precedence, source, filePath, trust switch and defensive copies", (t) => {
  const f = fixture(t);
  for (const [directory, description] of [
    [f.bundledDir, "bundled"],
    [f.user, "user"],
    [f.project, "project"],
  ])
    writeFileSync(
      join(directory, "example.md"),
      serializeAgentType({ ...definition, description }),
    );
  const store = new ConfigStore({ ...f, includeProject: true });
  assert.equal(store.get("example").description, "project");
  assert.equal(store.get("example").source, "project");
  assert.equal(store.get("example").filePath, join(f.project, "example.md"));
  store.get("example").description = "changed";
  store.list()[0].description = "changed";
  assert.equal(store.get("example").description, "project");
  assert.equal(
    new ConfigStore({ ...f, includeProject: false }).get("example").source,
    "user",
  );
  assert.throws(() => store.get("missing"), /Unknown or invalid/);

  writeFileSync(join(f.bundledDir, "worker.md"), markdown("", "worker"));
  for (const file of ["worker-a.md", "worker-b.md"])
    writeFileSync(join(f.user, file), markdown("", "worker"));
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
  assert.throws(
    () => new ConfigStore({ ...f, includeProject: false }).get("worker"),
    /Unknown or invalid/,
  );
});

test("malformed overrides block both filename and declared name while other files load", (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.bundledDir, "example.md"),
    serializeAgentType(definition),
  );
  writeFileSync(
    join(f.bundledDir, "other.md"),
    serializeAgentType({ ...definition, name: "other" }),
  );
  writeFileSync(
    join(f.project, "example.md"),
    markdown("unsupported: true\n", "other"),
  );
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
  for (const name of ["example", "other"])
    writeFileSync(join(f.user, `${name}.md`), markdown("", name));
  writeFileSync(join(f.project, "broken.md"), markdown("name: other\n"));
  const store = new ConfigStore({ ...f, includeProject: true });
  assert.deepEqual(store.list(), []);
  assert.match(store.diagnostics[0], /unique|duplicate/i);
});

test("legacy agent directories are ignored and do not override or fail closed", (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.bundledDir, "example.md"),
    serializeAgentType({ ...definition, description: "bundled" }),
  );
  writeFileSync(join(f.userLegacy, "example.md"), "not frontmatter");
  writeFileSync(
    join(f.userLegacy, "legacy-only.md"),
    serializeAgentType({
      ...definition,
      name: "legacy-only",
      description: "Legacy user",
    }),
  );
  writeFileSync(
    join(f.projectLegacy, "example.md"),
    serializeAgentType({ ...definition, description: "Legacy project" }),
  );
  writeFileSync(join(f.projectLegacy, "broken.md"), ":\n  [");
  const store = new ConfigStore({ ...f, includeProject: true });
  assert.equal(store.get("example").description, "bundled");
  assert.equal(store.get("example").source, "bundled");
  assert.equal(
    store.get("example").filePath,
    join(f.bundledDir, "example.md"),
  );
  assert.throws(() => store.get("legacy-only"), /Unknown or invalid/);
  assert.deepEqual(store.diagnostics, []);

  rmSync(f.userLegacy, { recursive: true });
  const outside = join(f.agentDir, "outside-package");
  mkdirSync(outside);
  writeFileSync(
    join(outside, "hijack.md"),
    serializeAgentType({
      ...definition,
      name: "hijack",
      description: "External package",
    }),
  );
  symlinkSync(outside, f.userLegacy);
  rmSync(f.projectLegacy, { recursive: true });
  symlinkSync(outside, f.projectLegacy);
  store.reload();
  assert.throws(() => store.get("hijack"), /Unknown or invalid/);
  assert.throws(() => store.get("legacy-only"), /Unknown or invalid/);
  assert.equal(store.get("example").source, "bundled");
  assert.deepEqual(store.diagnostics, []);
});

test("bundled and canonical saves write only preferred storage", (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.bundledDir, "bundled-only.md"),
    serializeAgentType({
      ...definition,
      name: "bundled-only",
      description: "Bundled only",
    }),
  );
  writeFileSync(
    join(f.user, "custom.md"),
    serializeAgentType({
      ...definition,
      name: "custom-file",
      description: "Custom file",
    }),
  );
  writeFileSync(
    join(f.project, "project-agent.md"),
    serializeAgentType({
      ...definition,
      name: "project-only",
      description: "Canonical project",
    }),
  );
  writeFileSync(
    join(f.userLegacy, "untouched.md"),
    serializeAgentType({
      ...definition,
      name: "untouched",
      description: "Legacy user",
    }),
  );
  writeFileSync(
    join(f.projectLegacy, "untouched.md"),
    serializeAgentType({
      ...definition,
      name: "untouched",
      description: "Legacy project",
    }),
  );
  const store = new ConfigStore({ ...f, includeProject: true });

  const bundled = store.get("bundled-only");
  const savedBundled = store.save(
    { ...bundled, description: "Bundled override" },
    "user",
    bundled,
  );
  assert.equal(savedBundled.filePath, join(f.user, "bundled-only.md"));
  assert.equal(savedBundled.source, "user");
  assert.equal(
    parseAgentType(readFileSync(join(f.bundledDir, "bundled-only.md"), "utf8"))
      .description,
    "Bundled only",
  );
  assert.equal(store.get("bundled-only").description, "Bundled override");
  assert.equal(
    store.get("bundled-only").filePath,
    join(f.user, "bundled-only.md"),
  );

  const custom = store.get("custom-file");
  assert.equal(custom.filePath, join(f.user, "custom.md"));
  assert.equal(custom.source, "user");
  const savedCustom = store.save(
    { ...custom, description: "Updated custom" },
    "user",
    custom,
  );
  assert.equal(savedCustom.filePath, join(f.user, "custom.md"));
  assert.equal(
    parseAgentType(readFileSync(join(f.user, "custom.md"), "utf8"))
      .description,
    "Updated custom",
  );
  assert.equal(store.get("custom-file").description, "Updated custom");
  assert.ok(!readdirSync(f.user).includes("custom-file.md"));

  const projectAgent = store.get("project-only");
  assert.equal(projectAgent.filePath, join(f.project, "project-agent.md"));
  const savedProject = store.save(
    { ...projectAgent, description: "Preferred project" },
    "project",
    projectAgent,
  );
  assert.equal(savedProject.filePath, join(f.project, "project-agent.md"));
  assert.equal(savedProject.source, "project");
  assert.equal(store.get("project-only").description, "Preferred project");
  assert.ok(!readdirSync(f.project).includes("project-only.md"));
  assert.equal(
    parseAgentType(readFileSync(join(f.userLegacy, "untouched.md"), "utf8"))
      .description,
    "Legacy user",
  );
  assert.equal(
    parseAgentType(readFileSync(join(f.projectLegacy, "untouched.md"), "utf8"))
      .description,
    "Legacy project",
  );
  assert.deepEqual(readdirSync(f.userLegacy), ["untouched.md"]);
  assert.deepEqual(readdirSync(f.projectLegacy), ["untouched.md"]);
});

test("save validates and atomically writes user/project definitions and reloads", (t) => {
  const f = fixture(t);
  const store = new ConfigStore({ ...f, includeProject: true });
  const saved = store.save({ ...definition, tools: { allow: [] } }, "user");
  assert.equal(saved.source, "user");
  assert.deepEqual(
    parseAgentType(readFileSync(saved.filePath!, "utf8")).tools,
    { allow: [] },
  );
  store.save({ ...definition, description: "Project" }, "project");
  assert.equal(store.get("example").description, "Project");
  assert.deepEqual(readdirSync(f.user), ["example.md"]);
  assert.deepEqual(readdirSync(f.project), ["example.md"]);
  assert.deepEqual(readdirSync(f.userLegacy), []);
  assert.deepEqual(readdirSync(f.projectLegacy), []);
  assert.throws(() => store.save({ ...definition, name: "../escape" }, "user"));
  assert.throws(() => store.save({ ...definition, color: "red" }, "user"));
  assert.throws(
    () =>
      new ConfigStore({ ...f, includeProject: false }).save(
        definition,
        "project",
      ),
    /not enabled\/trusted/,
  );
});

test("symlink definitions fail closed and symlink save destinations are rejected", (t) => {
  const f = fixture(t);
  writeFileSync(
    join(f.bundledDir, "example.md"),
    serializeAgentType(definition),
  );
  symlinkSync(join(f.bundledDir, "example.md"), join(f.user, "example.md"));
  const store = new ConfigStore({ ...f, includeProject: false });
  assert.throws(() => store.get("example"));
  assert.throws(() => store.save(definition, "user"), /Unsafe symlink path/);

  rmSync(join(f.user, "example.md"));
  symlinkSync(join(f.user, "missing.md"), join(f.user, "worker.md"));
  assert.throws(
    () => store.save({ ...definition, name: "worker" }, "user"),
    /Unsafe symlink path/,
  );

  rmSync(f.user, { recursive: true });
  symlinkSync(join(f.agentDir, "missing-agents"), f.user);
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
  assert.throws(
    () => trusted.save(definition, "project"),
    /Unsafe symlink path/,
  );
});
