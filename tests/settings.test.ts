import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  DEFAULT_MANAGER_SETTINGS,
  loadManagerSettings,
  type ManagerSettings,
} from "../src/settings.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-settings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const agentDir = join(root, "user");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  return {
    root,
    cwd,
    agentDir,
    globalFile: join(agentDir, "subagent-manager", "settings.json"),
    projectFile: join(cwd, ".pi", "agent", "subagent-manager", "settings.json"),
  };
}

function writeJson(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(value));
}

function load(
  paths: { cwd: string; agentDir: string },
  includeProject = true,
): { settings: ManagerSettings; diagnostics: string[] } {
  return loadManagerSettings({ ...paths, includeProject });
}

test("missing files keep defaults and do not diagnostic", (t) => {
  const f = fixture(t);
  const result = load(f);
  assert.deepEqual(result.settings, DEFAULT_MANAGER_SETTINGS);
  assert.deepEqual(result.settings, { maxLevels: 3, maxConcurrent: 16, maxThreads: 64 });
  assert.deepEqual(result.diagnostics, []);
  assert.notEqual(result.settings, DEFAULT_MANAGER_SETTINGS);
  result.settings.maxLevels = 99;
  assert.equal(DEFAULT_MANAGER_SETTINGS.maxLevels, 3);
  assert.deepEqual(
    loadManagerSettings({
      cwd: join(f.root, "missing-project"),
      agentDir: join(f.root, "missing-user"),
      includeProject: true,
    }),
    { settings: DEFAULT_MANAGER_SETTINGS, diagnostics: [] },
  );
});

test("global then project precedence, partial keys only", (t) => {
  const f = fixture(t);
  writeJson(f.globalFile, { maxLevels: 4, maxConcurrent: 5, maxThreads: 6 });
  writeJson(f.projectFile, { maxConcurrent: 9 });
  assert.deepEqual(load(f), {
    settings: { maxLevels: 4, maxConcurrent: 9, maxThreads: 6 },
    diagnostics: [],
  });
});

test("untrusted project settings are not read", (t) => {
  const f = fixture(t);
  writeJson(f.globalFile, { maxLevels: 4 });
  mkdirSync(dirname(f.projectFile), { recursive: true });
  symlinkSync(join(f.root, "missing.json"), f.projectFile);
  const result = load(f, false);
  assert.deepEqual(result.settings, { ...DEFAULT_MANAGER_SETTINGS, maxLevels: 4 });
  assert.deepEqual(result.diagnostics, []);
});

test("malformed JSON, types, unknown keys, fractional and out-of-range values are ignored", (t) => {
  const f = fixture(t);
  const cases: [string, RegExp][] = [
    ["{", /Invalid JSON/],
    ["null", /Settings must be a JSON object/],
    ["[]", /Settings must be a JSON object/],
    ["42", /Settings must be a JSON object/],
    ['"text"', /Settings must be a JSON object/],
    ["true", /Settings must be a JSON object/],
    [JSON.stringify({ maxLevels: 1.5 }), /maxLevels must be a positive safe integer/],
    [JSON.stringify({ maxConcurrent: 2.5 }), /maxConcurrent must be a positive safe integer/],
    [JSON.stringify({ maxThreads: 0 }), /maxThreads must be a positive safe integer/],
    [JSON.stringify({ maxLevels: -1 }), /maxLevels must be a positive safe integer/],
    [JSON.stringify({ maxConcurrent: "16" }), /maxConcurrent must be a positive safe integer/],
    [JSON.stringify({ maxThreads: true }), /maxThreads must be a positive safe integer/],
    [JSON.stringify({ maxLevels: null }), /maxLevels must be a positive safe integer/],
    [
      JSON.stringify({ maxThreads: 9007199254740993 }),
      /maxThreads must be a positive safe integer/,
    ],
    [JSON.stringify({ maxLevels: 33 }), /maxLevels must be <= 32/],
    [JSON.stringify({ extra: 1 }), /Unknown settings key: extra/],
    [
      JSON.stringify({ maxLevels: 2, maxConcurrent: 2, maxThreads: 2, extra: 1 }),
      /Unknown settings key: extra/,
    ],
  ];
  for (const [content, pattern] of cases) {
    mkdirSync(dirname(f.globalFile), { recursive: true });
    writeFileSync(f.globalFile, content);
    const result = load(f, false);
    assert.deepEqual(result.settings, DEFAULT_MANAGER_SETTINGS, content);
    assert.equal(result.diagnostics.length, 1, content);
    assert.match(result.diagnostics[0], pathPattern(f.globalFile), content);
    assert.match(result.diagnostics[0], pattern, content);
  }
});

test("boundary integers have no artificial cap except maxLevels", (t) => {
  const f = fixture(t);
  writeJson(f.globalFile, {
    maxLevels: 32,
    maxConcurrent: Number.MAX_SAFE_INTEGER,
    maxThreads: 1_000_000,
  });
  writeJson(f.projectFile, { maxLevels: 1, maxConcurrent: 33 });
  assert.deepEqual(load(f).settings, {
    maxLevels: 1,
    maxConcurrent: 33,
    maxThreads: 1_000_000,
  });
});

test("symlink settings files and symlink-owned scope directories are not followed", (t) => {
  const f = fixture(t);
  const outside = join(f.root, "outside.json");
  writeFileSync(outside, JSON.stringify({ maxLevels: 9, maxConcurrent: 9, maxThreads: 9 }));
  mkdirSync(dirname(f.globalFile), { recursive: true });
  symlinkSync(outside, f.globalFile);
  let result = load(f, false);
  assert.deepEqual(result.settings, DEFAULT_MANAGER_SETTINGS);
  assert.match(result.diagnostics[0], /Unsafe symlink path/);
  assert.match(result.diagnostics[0], pathPattern(f.globalFile));

  rmSync(f.globalFile);
  const linkedDir = join(f.root, "linked-global");
  mkdirSync(linkedDir);
  writeFileSync(
    join(linkedDir, "settings.json"),
    JSON.stringify({ maxLevels: 8, maxConcurrent: 8, maxThreads: 8 }),
  );
  rmSync(dirname(f.globalFile), { recursive: true });
  symlinkSync(linkedDir, dirname(f.globalFile));
  result = load(f, false);
  assert.deepEqual(result.settings, DEFAULT_MANAGER_SETTINGS);
  assert.match(result.diagnostics[0], pathPattern(dirname(f.globalFile)));

  rmSync(f.agentDir, { recursive: true });
  const realAgent = join(f.root, "real-agent");
  mkdirSync(join(realAgent, "subagent-manager"), { recursive: true });
  writeFileSync(
    join(realAgent, "subagent-manager", "settings.json"),
    JSON.stringify({ maxThreads: 40 }),
  );
  symlinkSync(realAgent, f.agentDir);
  result = load(f, false);
  assert.deepEqual(result.settings, DEFAULT_MANAGER_SETTINGS);
  assert.match(result.diagnostics[0], pathPattern(f.agentDir));

  rmSync(f.agentDir);
  mkdirSync(f.agentDir);
  writeJson(f.globalFile, { maxLevels: 5 });
  const realPi = join(f.root, "real-pi");
  mkdirSync(join(realPi, "agent", "subagent-manager"), { recursive: true });
  writeFileSync(
    join(realPi, "agent", "subagent-manager", "settings.json"),
    JSON.stringify({ maxLevels: 7, maxConcurrent: 7, maxThreads: 7 }),
  );
  symlinkSync(realPi, join(f.cwd, ".pi"));
  result = load(f);
  assert.deepEqual(result.settings, { ...DEFAULT_MANAGER_SETTINGS, maxLevels: 5 });
  assert.match(result.diagnostics[0], pathPattern(join(f.cwd, ".pi")));

  rmSync(join(f.cwd, ".pi"));
  mkdirSync(join(f.cwd, ".pi"));
  const realAgentScope = join(f.root, "real-agent-scope");
  mkdirSync(join(realAgentScope, "subagent-manager"), { recursive: true });
  writeFileSync(
    join(realAgentScope, "subagent-manager", "settings.json"),
    JSON.stringify({ maxThreads: 41 }),
  );
  symlinkSync(realAgentScope, join(f.cwd, ".pi", "agent"));
  result = load(f);
  assert.deepEqual(result.settings, { ...DEFAULT_MANAGER_SETTINGS, maxLevels: 5 });
  assert.match(result.diagnostics[0], pathPattern(join(f.cwd, ".pi", "agent")));

  rmSync(join(f.cwd, ".pi"), { recursive: true });
  mkdirSync(dirname(f.projectFile), { recursive: true });
  symlinkSync(outside, f.projectFile);
  result = load(f);
  assert.deepEqual(result.settings, { ...DEFAULT_MANAGER_SETTINGS, maxLevels: 5 });
  assert.match(result.diagnostics[0], pathPattern(f.projectFile));
});

test("scope directories under a symlinked ancestor are still accepted", (t) => {
  const f = fixture(t);
  const realParent = join(f.root, "real-parent");
  const linkedParent = join(f.root, "linked-parent");
  mkdirSync(realParent);
  symlinkSync(realParent, linkedParent);
  const cwd = join(linkedParent, "project");
  const agentDir = join(linkedParent, "user");
  writeJson(join(agentDir, "subagent-manager", "settings.json"), { maxLevels: 4 });
  writeJson(join(cwd, ".pi", "agent", "subagent-manager", "settings.json"), { maxThreads: 12 });
  assert.deepEqual(load({ cwd, agentDir }), {
    settings: { ...DEFAULT_MANAGER_SETTINGS, maxLevels: 4, maxThreads: 12 },
    diagnostics: [],
  });
});

test("invalid layer is ignored atomically and prior valid settings remain", (t) => {
  const f = fixture(t);
  writeJson(f.globalFile, { maxLevels: 5, maxConcurrent: 0, maxThreads: 10 });
  writeJson(f.projectFile, { maxConcurrent: 11 });
  let result = load(f);
  assert.deepEqual(result.settings, { ...DEFAULT_MANAGER_SETTINGS, maxConcurrent: 11 });
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0], pathPattern(f.globalFile));

  writeJson(f.globalFile, { maxLevels: 5, maxConcurrent: 6, maxThreads: 7 });
  writeJson(f.projectFile, { maxLevels: 2, maxConcurrent: 1.5, maxThreads: 9 });
  result = load(f);
  assert.deepEqual(result.settings, { maxLevels: 5, maxConcurrent: 6, maxThreads: 7 });
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0], pathPattern(f.projectFile));
  assert.match(result.diagnostics[0], /maxConcurrent/);

  writeFileSync(f.globalFile, "{");
  writeFileSync(f.projectFile, "[]");
  result = load(f);
  assert.deepEqual(result.settings, DEFAULT_MANAGER_SETTINGS);
  assert.equal(result.diagnostics.length, 2);
  assert.match(result.diagnostics[0], pathPattern(f.globalFile));
  assert.match(result.diagnostics[1], pathPattern(f.projectFile));
});

test("unreadable settings file is ignored", (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root bypasses mode 000");
    return;
  }
  const f = fixture(t);
  writeJson(f.globalFile, { maxConcurrent: 3, maxThreads: 3, maxLevels: 3 });
  chmodSync(f.globalFile, 0o000);
  try {
    const result = load(f, false);
    assert.deepEqual(result.settings, DEFAULT_MANAGER_SETTINGS);
    assert.equal(result.diagnostics.length, 1);
    assert.match(result.diagnostics[0], pathPattern(f.globalFile));
    assert.match(result.diagnostics[0], /EACCES|permission/i);
  } finally {
    chmodSync(f.globalFile, 0o600);
  }
});

test("non-directory scope path is an ignored layer", (t) => {
  const f = fixture(t);
  writeFileSync(join(f.agentDir, "subagent-manager"), "not a directory");
  const result = load(f, false);
  assert.deepEqual(result.settings, DEFAULT_MANAGER_SETTINGS);
  assert.match(result.diagnostics[0], /Settings directory must be a directory/);
  assert.match(result.diagnostics[0], pathPattern(f.globalFile));
});

test("never reads .pi/subagents.json or settings outside the scope files", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.cwd, ".pi", "agent"), { recursive: true });
  writeFileSync(
    join(f.cwd, ".pi", "subagents.json"),
    JSON.stringify({ maxLevels: 9, maxConcurrent: 9, maxThreads: 9 }),
  );
  writeFileSync(
    join(f.cwd, ".pi", "agent", "settings.json"),
    JSON.stringify({ maxLevels: 8, maxConcurrent: 8, maxThreads: 8 }),
  );
  writeFileSync(
    join(f.agentDir, "settings.json"),
    JSON.stringify({ maxLevels: 7, maxConcurrent: 7, maxThreads: 7 }),
  );
  writeJson(f.globalFile, { maxLevels: 4 });
  writeJson(f.projectFile, { maxThreads: 11 });
  assert.deepEqual(load(f), {
    settings: { ...DEFAULT_MANAGER_SETTINGS, maxLevels: 4, maxThreads: 11 },
    diagnostics: [],
  });
});

function pathPattern(path: string): RegExp {
  return new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}
