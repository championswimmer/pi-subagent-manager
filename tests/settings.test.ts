import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  DEFAULT_MANAGER_SETTINGS,
  loadManagerSettings,
  saveManagerSettings,
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
  assert.deepEqual(result.settings, {
    maxLevels: 3,
    maxConcurrent: 16,
    maxThreads: 64,
    scopedModelFiltering: true,
  });
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
    settings: {
      maxLevels: 4,
      maxConcurrent: 9,
      maxThreads: 6,
      scopedModelFiltering: true,
    },
    diagnostics: [],
  });
});

test("untrusted project settings are not read", (t) => {
  const f = fixture(t);
  writeJson(f.globalFile, { maxLevels: 4 });
  mkdirSync(dirname(f.projectFile), { recursive: true });
  symlinkSync(join(f.root, "missing.json"), f.projectFile);
  const result = load(f, false);
  assert.deepEqual(result.settings, {
    ...DEFAULT_MANAGER_SETTINGS,
    maxLevels: 4,
  });
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
    [JSON.stringify({ scopedModelFiltering: "true" }), /scopedModelFiltering must be a boolean/],
    [JSON.stringify({ scopedModelFiltering: 1 }), /scopedModelFiltering must be a boolean/],
    [JSON.stringify({ scopedModelFiltering: 0 }), /scopedModelFiltering must be a boolean/],
    [JSON.stringify({ scopedModelFiltering: null }), /scopedModelFiltering must be a boolean/],
    [JSON.stringify({ scopedModelFiltering: "false" }), /scopedModelFiltering must be a boolean/],
    [JSON.stringify({ maxLevels: null }), /maxLevels must be a positive safe integer/],
    [
      JSON.stringify({ maxThreads: 9007199254740993 }),
      /maxThreads must be a positive safe integer/,
    ],
    [JSON.stringify({ maxLevels: 33 }), /maxLevels must be <= 32/],
    [JSON.stringify({ extra: 1 }), /Unknown settings key: extra/],
    [
      JSON.stringify({
        maxLevels: 2,
        maxConcurrent: 2,
        maxThreads: 2,
        extra: 1,
      }),
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
    scopedModelFiltering: true,
  });
});

test("symlink settings files and symlink-owned scope directories are not followed", (t) => {
  const f = fixture(t);
  const outside = join(f.root, "outside.json");
  writeFileSync(
    outside,
    JSON.stringify({ maxLevels: 9, maxConcurrent: 9, maxThreads: 9 }),
  );
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
  assert.deepEqual(result.settings, {
    ...DEFAULT_MANAGER_SETTINGS,
    maxLevels: 5,
  });
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
  assert.deepEqual(result.settings, {
    ...DEFAULT_MANAGER_SETTINGS,
    maxLevels: 5,
  });
  assert.match(result.diagnostics[0], pathPattern(join(f.cwd, ".pi", "agent")));

  rmSync(join(f.cwd, ".pi"), { recursive: true });
  mkdirSync(dirname(f.projectFile), { recursive: true });
  symlinkSync(outside, f.projectFile);
  result = load(f);
  assert.deepEqual(result.settings, {
    ...DEFAULT_MANAGER_SETTINGS,
    maxLevels: 5,
  });
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
  writeJson(join(agentDir, "subagent-manager", "settings.json"), {
    maxLevels: 4,
  });
  writeJson(join(cwd, ".pi", "agent", "subagent-manager", "settings.json"), {
    maxThreads: 12,
  });
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
  assert.deepEqual(result.settings, {
    ...DEFAULT_MANAGER_SETTINGS,
    maxConcurrent: 11,
  });
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0], pathPattern(f.globalFile));

  writeJson(f.globalFile, { maxLevels: 5, maxConcurrent: 6, maxThreads: 7 });
  writeJson(f.projectFile, { maxLevels: 2, maxConcurrent: 1.5, maxThreads: 9 });
  result = load(f);
  assert.deepEqual(result.settings, {
    maxLevels: 5,
    maxConcurrent: 6,
    maxThreads: 7,
    scopedModelFiltering: true,
  });
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

function saveSettings(
  paths: { cwd: string; agentDir: string },
  scope: "user" | "project",
  settings: ManagerSettings,
  includeProject = true,
): string {
  return saveManagerSettings({ ...paths, includeProject, scope, settings });
}

function fileText(settings: ManagerSettings): string {
  return `${JSON.stringify(settings, null, 2)}\n`;
}

function assertNoTempFiles(directory: string): void {
  if (!existsSync(directory)) return;
  for (const name of readdirSync(directory)) {
    assert.equal(
      name.endsWith(".tmp") || name.startsWith(".settings."),
      false,
      name,
    );
  }
}

function rejection(fn: () => void, pattern: RegExp, path?: string): void {
  assert.throws(fn, (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, pattern);
    if (path !== undefined) assert.match(message, pathPattern(path));
    return true;
  });
}

test("save persists user and project settings and reload applies precedence", (t) => {
  const f = fixture(t);
  const user = {
    maxLevels: 4,
    maxConcurrent: 5,
    maxThreads: 6,
    scopedModelFiltering: true,
  };
  const project = {
    maxLevels: 2,
    maxConcurrent: 7,
    maxThreads: 8,
    scopedModelFiltering: true,
  };
  const userPath = saveSettings(f, "user", user, false);
  assert.equal(userPath, f.globalFile);
  assert.equal(readFileSync(userPath, "utf8"), fileText(user));
  assert.equal(lstatSync(userPath).isSymbolicLink(), false);
  assert.equal(lstatSync(userPath).isFile(), true);
  assert.equal(lstatSync(userPath).mode & 0o777, 0o600);
  assert.deepEqual(load(f, false), { settings: user, diagnostics: [] });
  assert.equal(existsSync(join(f.cwd, ".pi")), false);

  const updated = {
    maxLevels: 1,
    maxConcurrent: Number.MAX_SAFE_INTEGER,
    maxThreads: 32,
    scopedModelFiltering: true,
  };
  chmodSync(userPath, 0o644);
  assert.equal(saveSettings(f, "user", updated), userPath);
  assert.equal(readFileSync(userPath, "utf8"), fileText(updated));
  assert.equal(lstatSync(userPath).mode & 0o777, 0o600);
  assert.deepEqual(load(f, false).settings, updated);

  const projectPath = saveSettings(f, "project", project);
  assert.equal(projectPath, f.projectFile);
  assert.equal(readFileSync(projectPath, "utf8"), fileText(project));
  assert.equal(lstatSync(projectPath).mode & 0o777, 0o600);
  assert.deepEqual(load(f), { settings: project, diagnostics: [] });
  assert.deepEqual(load(f, false).settings, updated);
  assertNoTempFiles(dirname(userPath));
  assertNoTempFiles(dirname(projectPath));

  const reordered = {
    scopedModelFiltering: true,
    maxThreads: 9,
    maxLevels: 3,
    maxConcurrent: 11,
  };
  assert.equal(saveSettings(f, "project", reordered), projectPath);
  assert.equal(
    readFileSync(projectPath, "utf8"),
    fileText({
      maxLevels: 3,
      maxConcurrent: 11,
      maxThreads: 9,
      scopedModelFiltering: true,
    }),
  );
  assert.deepEqual(load(f).settings, {
    maxLevels: 3,
    maxConcurrent: 11,
    maxThreads: 9,
    scopedModelFiltering: true,
  });
});

test("invalid settings do not mutate an existing file", (t) => {
  const f = fixture(t);
  const invalid: unknown[] = [
    { maxLevels: 0, maxConcurrent: 1, maxThreads: 1 },
    { maxLevels: -1, maxConcurrent: 1, maxThreads: 1 },
    { maxLevels: 1.5, maxConcurrent: 1, maxThreads: 1 },
    { maxLevels: 33, maxConcurrent: 1, maxThreads: 1 },
    { maxLevels: 1, maxConcurrent: "16", maxThreads: 1 },
    { maxLevels: 1, maxConcurrent: 1.5, maxThreads: 1 },
    { maxLevels: 1, maxConcurrent: 1, maxThreads: true },
    { maxLevels: 1, maxConcurrent: 1, maxThreads: 9007199254740993 },
    { maxLevels: 1, maxConcurrent: 1 },
    { maxLevels: 1, maxConcurrent: 1, maxThreads: 1, extra: 1 },
    {
      maxLevels: 1,
      maxConcurrent: 1,
      maxThreads: 1,
      scopedModelFiltering: "false",
    },
    { maxLevels: 1, maxConcurrent: 1, maxThreads: 1, scopedModelFiltering: 0 },
    { maxLevels: 1, maxConcurrent: 1, maxThreads: 1 },
    null,
    [],
    42,
    "text",
  ];
  assert.throws(
    () => saveSettings(f, "user", invalid[0] as ManagerSettings),
    /maxLevels must be a positive safe integer/,
  );
  assert.equal(existsSync(dirname(f.globalFile)), false);
  assert.equal(existsSync(f.globalFile), false);
  assert.equal(existsSync(join(f.cwd, ".pi")), false);

  const original = {
    maxLevels: 4,
    maxConcurrent: 5,
    maxThreads: 6,
    scopedModelFiltering: true,
  };
  saveSettings(f, "user", original);
  saveSettings(f, "project", {
    maxLevels: 2,
    maxConcurrent: 3,
    maxThreads: 4,
    scopedModelFiltering: true,
  });
  const userBefore = readFileSync(f.globalFile);
  const projectBefore = readFileSync(f.projectFile);
  const userIno = lstatSync(f.globalFile).ino;
  const projectIno = lstatSync(f.projectFile).ino;
  rejection(
    () =>
      saveSettings(f, "user", {
        maxLevels: 33,
        maxConcurrent: 1,
        maxThreads: 1,
        scopedModelFiltering: true,
      }),
    /maxLevels must be <= 32/,
  );
  rejection(
    () =>
      saveSettings(f, "user", {
        maxLevels: 1,
        maxConcurrent: 1,
        maxThreads: 1,
        scopedModelFiltering: true,
        extra: 1,
      } as unknown as ManagerSettings),
    /Unknown settings key: extra/,
  );
  rejection(
    () =>
      saveSettings(f, "user", {
        maxLevels: 1,
        maxConcurrent: 1,
      } as ManagerSettings),
    /maxThreads must be a positive safe integer/,
  );
  for (const settings of invalid) {
    assert.throws(() => saveSettings(f, "user", settings as ManagerSettings));
    assert.throws(() =>
      saveSettings(f, "project", settings as ManagerSettings),
    );
    assert.deepEqual(readFileSync(f.globalFile), userBefore);
    assert.deepEqual(readFileSync(f.projectFile), projectBefore);
    assert.equal(lstatSync(f.globalFile).ino, userIno);
    assert.equal(lstatSync(f.projectFile).ino, projectIno);
  }
  assertNoTempFiles(dirname(f.globalFile));
  assertNoTempFiles(dirname(f.projectFile));
  assert.deepEqual(load(f).settings, {
    maxLevels: 2,
    maxConcurrent: 3,
    maxThreads: 4,
    scopedModelFiltering: true,
  });
});

test("untrusted project writes never create paths", (t) => {
  const f = fixture(t);
  const settings = {
    maxLevels: 2,
    maxConcurrent: 3,
    maxThreads: 4,
    scopedModelFiltering: true,
  };
  const before = readdirSync(f.cwd);
  rejection(() => saveSettings(f, "project", settings, false), /not enabled\/trusted/);
  assert.deepEqual(readdirSync(f.cwd), before);
  assert.equal(existsSync(join(f.cwd, ".pi")), false);
  assert.equal(existsSync(join(f.agentDir, "subagent-manager")), false);

  mkdirSync(join(f.cwd, ".pi"));
  rejection(() => saveSettings(f, "project", settings, false), /not enabled\/trusted/);
  assert.equal(existsSync(join(f.cwd, ".pi", "agent")), false);

  writeJson(f.projectFile, { maxLevels: 8, maxConcurrent: 8, maxThreads: 8 });
  const existing = readFileSync(f.projectFile);
  const existingIno = lstatSync(f.projectFile).ino;
  rejection(
    () =>
      saveSettings(
        f,
        "project",
        {
          maxLevels: 1,
          maxConcurrent: 1,
          maxThreads: 1,
          scopedModelFiltering: true,
        },
        false,
      ),
    /not enabled\/trusted/,
  );
  assert.deepEqual(readFileSync(f.projectFile), existing);
  assert.equal(lstatSync(f.projectFile).ino, existingIno);
  rejection(
    () =>
      saveManagerSettings({
        cwd: f.cwd,
        agentDir: f.agentDir,
        includeProject: true,
        scope: "global" as "user",
        settings,
      }),
    /Invalid settings scope/,
  );
  assert.deepEqual(readFileSync(f.projectFile), existing);
  assert.equal(existsSync(join(f.agentDir, "subagent-manager")), false);
});

test("symlink directories and files are rejected on save", (t) => {
  const f = fixture(t);
  const settings = {
    maxLevels: 4,
    maxConcurrent: 5,
    maxThreads: 6,
    scopedModelFiltering: true,
  };
  const outside = join(f.root, "outside.json");
  const outsideText = JSON.stringify({
    maxLevels: 9,
    maxConcurrent: 9,
    maxThreads: 9,
  });
  writeFileSync(outside, outsideText);

  mkdirSync(dirname(f.globalFile), { recursive: true });
  symlinkSync(outside, f.globalFile);
  rejection(
    () => saveSettings(f, "user", settings),
    /Unsafe symlink path/,
    f.globalFile,
  );
  assert.equal(readFileSync(outside, "utf8"), outsideText);
  assert.equal(lstatSync(f.globalFile).isSymbolicLink(), true);
  assertNoTempFiles(dirname(f.globalFile));

  rmSync(f.globalFile);
  const linkedDir = join(f.root, "linked-global");
  mkdirSync(linkedDir);
  rmSync(dirname(f.globalFile), { recursive: true });
  symlinkSync(linkedDir, dirname(f.globalFile));
  rejection(
    () => saveSettings(f, "user", settings),
    /Unsafe symlink path/,
    dirname(f.globalFile),
  );
  assert.equal(existsSync(join(linkedDir, "settings.json")), false);
  assert.equal(lstatSync(dirname(f.globalFile)).isSymbolicLink(), true);

  rmSync(f.agentDir, { recursive: true });
  const realAgent = join(f.root, "real-agent");
  mkdirSync(realAgent);
  symlinkSync(realAgent, f.agentDir);
  rejection(
    () => saveSettings(f, "user", settings),
    /Unsafe symlink path/,
    f.agentDir,
  );
  assert.equal(existsSync(join(realAgent, "subagent-manager")), false);

  rmSync(f.agentDir);
  mkdirSync(dirname(f.globalFile), { recursive: true });
  mkdirSync(f.globalFile);
  rejection(
    () => saveSettings(f, "user", settings),
    /Settings must be a regular file/,
    f.globalFile,
  );
  assert.equal(lstatSync(f.globalFile).isDirectory(), true);
  assertNoTempFiles(dirname(f.globalFile));

  rmSync(f.globalFile, { recursive: true });
  saveSettings(f, "user", settings);
  const userBytes = readFileSync(f.globalFile);
  const realPi = join(f.root, "real-pi");
  mkdirSync(realPi);
  symlinkSync(realPi, join(f.cwd, ".pi"));
  rejection(
    () =>
      saveSettings(f, "project", {
        maxLevels: 1,
        maxConcurrent: 1,
        maxThreads: 1,
        scopedModelFiltering: true,
      }),
    /Unsafe symlink path/,
    join(f.cwd, ".pi"),
  );
  assert.equal(existsSync(join(realPi, "agent")), false);
  assert.deepEqual(readFileSync(f.globalFile), userBytes);

  rmSync(join(f.cwd, ".pi"));
  mkdirSync(join(f.cwd, ".pi"));
  const realAgentScope = join(f.root, "real-agent-scope");
  mkdirSync(realAgentScope);
  symlinkSync(realAgentScope, join(f.cwd, ".pi", "agent"));
  rejection(
    () => saveSettings(f, "project", settings),
    /Unsafe symlink path/,
    join(f.cwd, ".pi", "agent"),
  );
  assert.equal(existsSync(join(realAgentScope, "subagent-manager")), false);

  rmSync(join(f.cwd, ".pi"), { recursive: true });
  mkdirSync(join(f.cwd, ".pi", "agent"), { recursive: true });
  const realScope = join(f.root, "real-scope");
  mkdirSync(realScope);
  symlinkSync(realScope, dirname(f.projectFile));
  rejection(
    () => saveSettings(f, "project", settings),
    /Unsafe symlink path/,
    dirname(f.projectFile),
  );
  assert.equal(existsSync(join(realScope, "settings.json")), false);

  rmSync(dirname(f.projectFile));
  mkdirSync(dirname(f.projectFile), { recursive: true });
  symlinkSync(outside, f.projectFile);
  rejection(
    () => saveSettings(f, "project", settings),
    /Unsafe symlink path/,
    f.projectFile,
  );
  assert.equal(readFileSync(outside, "utf8"), outsideText);
  assert.equal(lstatSync(f.projectFile).isSymbolicLink(), true);
  assert.deepEqual(readFileSync(f.globalFile), userBytes);
  assertNoTempFiles(dirname(f.projectFile));

  const realProject = join(f.root, "real-project");
  mkdirSync(realProject);
  const linkedCwd = join(f.root, "linked-cwd");
  symlinkSync(realProject, linkedCwd);
  rejection(
    () =>
      saveManagerSettings({
        cwd: linkedCwd,
        agentDir: f.agentDir,
        includeProject: true,
        scope: "project",
        settings,
      }),
    /Unsafe symlink path/,
    linkedCwd,
  );
  assert.equal(existsSync(join(realProject, ".pi")), false);

  rmSync(f.projectFile);
  mkdirSync(f.projectFile);
  rejection(
    () => saveSettings(f, "project", settings),
    /Settings must be a regular file/,
    f.projectFile,
  );
  assert.equal(lstatSync(f.projectFile).isDirectory(), true);
  assert.deepEqual(readFileSync(f.globalFile), userBytes);
});

test("save creates missing owned directories", (t) => {
  const f = fixture(t);
  const user = {
    maxLevels: 4,
    maxConcurrent: 5,
    maxThreads: 6,
    scopedModelFiltering: true,
  };
  const project = {
    maxLevels: 2,
    maxConcurrent: 7,
    maxThreads: 8,
    scopedModelFiltering: true,
  };
  assert.equal(existsSync(dirname(f.globalFile)), false);
  const userPath = saveSettings(f, "user", user);
  assert.equal(userPath, f.globalFile);
  const userDir = dirname(userPath);
  assert.equal(lstatSync(userDir).isSymbolicLink(), false);
  assert.equal(lstatSync(userDir).isDirectory(), true);
  assert.equal(lstatSync(f.agentDir).isSymbolicLink(), false);
  assert.deepEqual(readdirSync(userDir), ["settings.json"]);
  assert.equal(existsSync(join(f.cwd, ".pi")), false);

  const projectDirs = [
    join(f.cwd, ".pi"),
    join(f.cwd, ".pi", "agent"),
    dirname(f.projectFile),
  ];
  for (const directory of projectDirs)
    assert.equal(existsSync(directory), false, directory);
  const projectPath = saveSettings(f, "project", project);
  assert.equal(projectPath, f.projectFile);
  for (const directory of projectDirs) {
    const stat = lstatSync(directory);
    assert.equal(stat.isSymbolicLink(), false, directory);
    assert.equal(stat.isDirectory(), true, directory);
  }
  assert.deepEqual(readdirSync(dirname(projectPath)), ["settings.json"]);
  assert.deepEqual(load(f), { settings: project, diagnostics: [] });

  rmSync(join(f.cwd, ".pi"), { recursive: true });
  mkdirSync(join(f.cwd, ".pi"));
  assert.equal(saveSettings(f, "project", project), f.projectFile);
  assert.equal(lstatSync(join(f.cwd, ".pi", "agent")).isDirectory(), true);
  assert.equal(lstatSync(dirname(f.projectFile)).isSymbolicLink(), false);

  const missingAgent = join(f.root, "missing-user");
  rejection(
    () =>
      saveManagerSettings({
        cwd: f.cwd,
        agentDir: missingAgent,
        includeProject: true,
        scope: "user",
        settings: user,
      }),
    /Settings directory must be a directory/,
    missingAgent,
  );
  assert.equal(existsSync(missingAgent), false);

  const missingCwd = join(f.root, "missing-project");
  rejection(
    () =>
      saveManagerSettings({
        cwd: missingCwd,
        agentDir: f.agentDir,
        includeProject: true,
        scope: "project",
        settings: project,
      }),
    /Settings directory must be a directory/,
    missingCwd,
  );
  assert.equal(existsSync(missingCwd), false);

  const blocked = join(f.root, "blocked");
  mkdirSync(blocked);
  writeFileSync(join(blocked, ".pi"), "not a directory");
  rejection(
    () =>
      saveManagerSettings({
        cwd: blocked,
        agentDir: f.agentDir,
        includeProject: true,
        scope: "project",
        settings: project,
      }),
    /Settings directory must be a directory/,
    join(blocked, ".pi"),
  );
  assert.equal(existsSync(join(blocked, ".pi", "agent")), false);

  const realParent = join(f.root, "real-parent");
  const linkedParent = join(f.root, "linked-parent");
  mkdirSync(realParent);
  symlinkSync(realParent, linkedParent);
  const cwd = join(linkedParent, "project");
  const agentDir = join(linkedParent, "user");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  const linkedUser = saveManagerSettings({
    cwd,
    agentDir,
    includeProject: true,
    scope: "user",
    settings: user,
  });
  const linkedProject = saveManagerSettings({
    cwd,
    agentDir,
    includeProject: true,
    scope: "project",
    settings: project,
  });
  assert.equal(lstatSync(dirname(linkedUser)).isSymbolicLink(), false);
  assert.equal(lstatSync(linkedUser).isFile(), true);
  assert.equal(lstatSync(linkedProject).isSymbolicLink(), false);
  assert.deepEqual(load({ cwd, agentDir }), {
    settings: project,
    diagnostics: [],
  });
});

test("omitted scopedModelFiltering defaults to true and only a present layer overrides it", (t) => {
  const f = fixture(t);
  writeJson(f.globalFile, { maxLevels: 4 });
  writeJson(f.projectFile, { maxThreads: 9 });
  assert.deepEqual(load(f), {
    settings: { ...DEFAULT_MANAGER_SETTINGS, maxLevels: 4, maxThreads: 9 },
    diagnostics: [],
  });
  assert.equal(load(f).settings.scopedModelFiltering, true);

  writeJson(f.globalFile, { scopedModelFiltering: false });
  assert.equal(load(f).settings.scopedModelFiltering, false);
  assert.equal(load(f).settings.maxLevels, DEFAULT_MANAGER_SETTINGS.maxLevels);
  assert.equal(load(f).settings.maxThreads, 9);

  writeJson(f.projectFile, { maxConcurrent: 2 });
  assert.equal(
    load(f).settings.scopedModelFiltering,
    false,
    "a partial project layer must not reset an omitted boolean",
  );
  assert.equal(load(f).settings.maxConcurrent, 2);

  writeJson(f.projectFile, { scopedModelFiltering: true, maxLevels: 6 });
  assert.deepEqual(load(f).settings, {
    ...DEFAULT_MANAGER_SETTINGS,
    maxLevels: 6,
    scopedModelFiltering: true,
  });

  writeJson(f.globalFile, { maxLevels: 5 });
  writeJson(f.projectFile, { scopedModelFiltering: false, maxLevels: 1 });
  const ignored = load(f, false);
  assert.deepEqual(ignored.settings, {
    ...DEFAULT_MANAGER_SETTINGS,
    maxLevels: 5,
  });
  assert.equal(ignored.settings.scopedModelFiltering, true);
  assert.deepEqual(ignored.diagnostics, []);
  assert.equal(load(f).settings.scopedModelFiltering, false);
  assert.equal(load(f).settings.maxLevels, 1);
});

test("invalid scopedModelFiltering is ignored atomically and keeps the prior layer", (t) => {
  const f = fixture(t);
  writeJson(f.globalFile, { scopedModelFiltering: false, maxLevels: 4 });
  writeJson(f.projectFile, {
    scopedModelFiltering: "no",
    maxConcurrent: 3,
  });
  const result = load(f);
  assert.deepEqual(result.settings, {
    ...DEFAULT_MANAGER_SETTINGS,
    scopedModelFiltering: false,
    maxLevels: 4,
  });
  assert.equal(result.diagnostics.length, 1);
  assert.match(result.diagnostics[0], pathPattern(f.projectFile));
  assert.match(result.diagnostics[0], /scopedModelFiltering must be a boolean/);
});

test("save requires scopedModelFiltering and persists false with the other keys", (t) => {
  const f = fixture(t);
  const missing = {
    maxLevels: 2,
    maxConcurrent: 3,
    maxThreads: 4,
  } as ManagerSettings;
  rejection(() => saveSettings(f, "user", missing), /scopedModelFiltering must be a boolean/);
  assert.equal(existsSync(f.globalFile), false);
  rejection(
    () =>
      saveSettings(f, "user", {
        ...missing,
        scopedModelFiltering: "false",
      } as unknown as ManagerSettings),
    /scopedModelFiltering must be a boolean/,
  );
  assert.equal(existsSync(dirname(f.globalFile)), false);

  const saved = {
    maxLevels: 2,
    maxConcurrent: 3,
    maxThreads: 4,
    scopedModelFiltering: false,
  };
  const path = saveSettings(f, "user", saved);
  assert.equal(readFileSync(path, "utf8"), fileText(saved));
  assert.match(readFileSync(path, "utf8"), /"scopedModelFiltering": false/);
  assert.deepEqual(load(f, false), { settings: saved, diagnostics: [] });

  const before = readFileSync(path);
  const ino = lstatSync(path).ino;
  rejection(() => saveSettings(f, "user", missing), /scopedModelFiltering must be a boolean/);
  rejection(
    () =>
      saveSettings(f, "project", {
        ...saved,
        scopedModelFiltering: 1 as unknown as boolean,
      }),
    /scopedModelFiltering must be a boolean/,
  );
  assert.deepEqual(readFileSync(path), before);
  assert.equal(lstatSync(path).ino, ino);
  assert.equal(existsSync(f.projectFile), false);
  assert.deepEqual(load(f, false).settings, saved);
});
