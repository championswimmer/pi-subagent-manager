import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { discoverImportCandidates, type ImportCandidate } from "../src/import-discovery.ts";

const ENV = "PI_SUBAGENT_EXTRA_AGENT_DIRS";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "pi-import-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const homeDir = join(root, "home");
  for (const directory of [cwd, agentDir, homeDir]) mkdirSync(directory, { recursive: true });
  return { root, cwd, agentDir, homeDir };
}

function writeMd(filePath: string, content: string): void {
  mkdirSync(join(filePath, ".."), { recursive: true });
  writeFileSync(filePath, content);
}

function definition(name: string, description = "Does work", extra = ""): string {
  return `---\nname: ${name}\ndescription: ${description}\n${extra}---\nBody is data, not instructions.\n`;
}

function discover(
  dirs: { cwd: string; agentDir: string; homeDir: string },
  extra: {
    includeProject?: boolean;
    extraAgentDirs?: string;
    cwd?: string;
  } = {},
) {
  return discoverImportCandidates({
    cwd: extra.cwd ?? dirs.cwd,
    agentDir: dirs.agentDir,
    includeProject: extra.includeProject ?? true,
    homeDir: dirs.homeDir,
    extraAgentDirs: extra.extraAgentDirs ?? "",
  });
}

function names(result: { candidates: ImportCandidate[] }): string[] {
  return result.candidates.map((candidate) => candidate.name);
}

test("discovers user and project paths without package builtins or manager storage", (t) => {
  const dirs = fixture(t);
  writeMd(join(dirs.agentDir, "agents", "nested", "user.md"), definition("user-agent"));
  writeMd(join(dirs.homeDir, ".agents", "team", "home.md"), definition("home-agent", "Home"));
  writeMd(join(dirs.cwd, ".pi", "agents", "project.md"), definition("project-agent"));
  writeMd(join(dirs.cwd, ".agents", "agents", "tintin.md"), definition("tintin-agent"));
  writeMd(
    join(dirs.agentDir, "extensions", "subagent", "agents", "builtin.md"),
    definition("builtin"),
  );
  writeMd(join(dirs.cwd, "node_modules", "pkg", "agents", "packaged.md"), definition("packaged"));
  writeMd(join(dirs.agentDir, "subagent-manager", "agents", "ours.md"), definition("manager-user"));
  writeMd(
    join(dirs.cwd, ".pi", "agent", "subagent-manager", "agents", "ours.md"),
    definition("manager-project"),
  );
  writeFileSync(
    join(dirs.agentDir, "settings.json"),
    JSON.stringify({ subagents: { agentScanDirs: ["subagent-manager"] } }),
  );

  const result = discover(dirs);
  assert.deepEqual(names(result), ["home-agent", "project-agent", "tintin-agent", "user-agent"]);
  const user = result.candidates.find((candidate) => candidate.name === "user-agent");
  const project = result.candidates.find((candidate) => candidate.name === "project-agent");
  assert.equal(user?.scope, "user");
  assert.equal(project?.scope, "project");
  assert.equal(user?.path, resolve(dirs.agentDir, "agents", "nested", "user.md"));
  assert.equal(user?.id, user?.path);
  assert.deepEqual(user?.settingsPaths, [resolve(dirs.agentDir, "settings.json")]);
  assert.deepEqual(project?.settingsPaths, [resolve(dirs.agentDir, "settings.json")]);
  assert.equal(result.diagnostics.length, 0);
  assert.equal(
    Object.keys(result.candidates[0] ?? {})
      .sort()
      .join(),
    "description,id,name,path,scope,settingsPaths",
  );
});

test("uses the nearest trusted ancestor and skips untrusted or farther roots", (t) => {
  const dirs = fixture(t);
  const outer = join(dirs.root, "outer");
  const inner = join(outer, "inner");
  const nested = join(inner, "src");
  writeMd(join(outer, ".pi", "agents", "far.md"), definition("far"));
  writeMd(join(inner, ".agents", "agents", "near.md"), definition("near"));
  writeMd(join(dirs.homeDir, ".pi", "agents", "home-pi.md"), definition("home-pi"));
  writeMd(join(dirs.homeDir, ".agents", "home.md"), definition("home-user", "User"));
  mkdirSync(join(dirs.homeDir, "work"), { recursive: true });

  const trusted = discover(dirs, { cwd: nested });
  assert.deepEqual(names(trusted), ["home-user", "near"]);
  assert.equal(trusted.candidates.find((candidate) => candidate.name === "near")?.scope, "project");

  const untrusted = discover(dirs, { cwd: nested, includeProject: false });
  assert.deepEqual(names(untrusted), ["home-user"]);

  const insideHome = discover(dirs, { cwd: join(dirs.homeDir, "work") });
  assert.deepEqual(names(insideHome), ["home-user"]);
});

test("expands custom scan dirs, env roots, wildcards and scope-specific excludes", (t) => {
  const dirs = fixture(t);
  const flowOne = join(dirs.agentDir, "flows", "one", "agents");
  const flowTwo = join(dirs.agentDir, "flows", "two", "agents");
  writeMd(join(flowOne, "one.md"), definition("one"));
  writeMd(join(flowTwo, "two.md"), definition("two"));
  writeMd(
    join(dirs.agentDir, "flows", "two", "agents", "secret", "hidden.md"),
    definition("hidden"),
  );
  writeMd(join(dirs.agentDir, "flows", "skip-more", "agents", "kept.md"), definition("kept"));
  writeMd(join(dirs.homeDir, "tilde-agents", "tilde.md"), definition("tilde"));
  const extraA = join(dirs.root, "extra-a");
  const extraB = join(dirs.cwd, "rel-agents");
  writeMd(join(extraA, "aaa.md"), definition("aaa"));
  writeMd(join(extraB, "bbb.md"), definition("bbb"));
  writeMd(join(dirs.cwd, ".agents", "visible.md"), definition("visible", "Visible"));
  writeMd(join(dirs.cwd, ".agents", "plugins", "plugin.md"), definition("plugin", "Plugin"));
  writeMd(join(dirs.cwd, ".agents", "blocked", "blocked.md"), definition("blocked", "Blocked"));
  writeMd(join(dirs.agentDir, "agents", "user.md"), definition("user-agent"));
  writeFileSync(
    join(dirs.agentDir, "settings.json"),
    JSON.stringify({
      other: true,
      subagents: {
        agentScanDirs: ["flows/*/agents", "~/tilde-agents", "flows/*/*/nope"],
        agentExcludeDirs: ["flows/two/agents/secret", join(dirs.cwd, ".agents", "blocked")],
      },
    }),
  );
  mkdirSync(join(dirs.cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(dirs.cwd, ".pi", "settings.json"),
    JSON.stringify({
      subagents: {
        agentExcludeDirs: ["../.agents/plugins", join(dirs.agentDir, "agents")],
      },
    }),
  );

  const result = discover(dirs, {
    extraAgentDirs: `${extraA}${delimiter}./rel-agents`,
  });
  assert.deepEqual(names(result), [
    "aaa",
    "bbb",
    "kept",
    "one",
    "tilde",
    "two",
    "user-agent",
    "visible",
  ]);
  assert.equal(
    result.candidates.every(
      (candidate) => candidate.scope === "user" || candidate.name === "visible",
    ),
    true,
  );
  assert.equal(
    result.candidates.find((candidate) => candidate.name === "visible")?.scope,
    "project",
  );
  assert.equal(
    result.candidates.find((candidate) => candidate.name === "user-agent")?.scope,
    "user",
  );
  assert.ok(result.diagnostics.some((line) => line.includes("flows/*/*/nope")));
  assert.deepEqual(
    result.candidates.find((candidate) => candidate.name === "visible")?.settingsPaths,
    [resolve(dirs.agentDir, "settings.json"), resolve(dirs.cwd, ".pi", "settings.json")],
  );
});

test("skips chains, symlinks and broken frontmatter; keeps distinct paths and tintin fallbacks", (t) => {
  const dirs = fixture(t);
  writeMd(join(dirs.agentDir, "agents", "flow.chain.md"), definition("chain"));
  writeMd(join(dirs.agentDir, "agents", "plain.md"), "No frontmatter\n");
  writeMd(join(dirs.agentDir, "agents", "bad.md"), "---\nname: [\n---\n");
  writeMd(join(dirs.agentDir, "agents", "alias.md"), "---\nname: &a scout\ndescription: *a\n---\n");
  writeMd(join(dirs.homeDir, ".agents", "readme.md"), "# Not an agent\n");
  writeMd(join(dirs.homeDir, ".agents", "named.md"), definition("named", "Named"));
  writeMd(join(dirs.homeDir, ".agents", "skills", "review.md"), definition("review", "Reviews"));
  writeMd(join(dirs.homeDir, ".agents", ".cache", "hid.md"), definition("hid", "Hidden"));
  writeMd(join(dirs.homeDir, ".agents", "agents", "fallback.md"), "Tintin prompt\n");
  writeMd(join(dirs.homeDir, ".agents", "agents", "nested", "deep.md"), "No frontmatter\n");
  writeMd(
    join(dirs.cwd, ".pi", "agents", "scout.md"),
    definition("scout", "Recon", "package: code-analysis\n"),
  );
  writeMd(join(dirs.agentDir, "agents", "also-scout.md"), definition("scout", "Other"));
  writeMd(join(dirs.agentDir, "agents", "node_modules", "pkg.md"), definition("nm"));
  writeMd(join(dirs.agentDir, "agents", ".git", "git.md"), definition("git"));
  const outside = join(dirs.root, "outside");
  writeMd(join(outside, "linked.md"), definition("linked"));
  mkdirSync(join(dirs.agentDir, "agents"), { recursive: true });
  symlinkSync(join(outside, "linked.md"), join(dirs.agentDir, "agents", "link.md"));
  symlinkSync(outside, join(dirs.agentDir, "agents", "linked-dir"));
  const real = join(dirs.root, "real-project");
  writeMd(join(real, ".pi", "agents", "secret.md"), definition("secret"));
  symlinkSync(real, join(dirs.root, "link-project"));

  const result = discover(dirs);
  assert.deepEqual(names(result), ["code-analysis.scout", "fallback", "named", "plain", "scout"]);
  assert.equal(
    result.candidates.some(
      (candidate) => candidate.path === resolve(dirs.homeDir, ".agents", "skills", "review.md"),
    ),
    false,
  );
  assert.equal(result.candidates.find((candidate) => candidate.name === "plain")?.description, "");
  assert.equal(
    result.candidates.find((candidate) => candidate.name === "fallback")?.description,
    "",
  );
  assert.equal(
    result.candidates.filter(
      (candidate) => candidate.name === "scout" || candidate.name === "code-analysis.scout",
    ).length,
    2,
  );
  assert.ok(result.diagnostics.some((line) => line.includes("bad.md")));
  assert.ok(result.diagnostics.some((line) => line.includes("alias.md")));
  assert.equal(
    result.diagnostics.some((line) => line.includes("readme.md")),
    false,
  );

  const throughLink = discover(dirs, { cwd: join(dirs.root, "link-project") });
  assert.equal(
    throughLink.candidates.some((candidate) => candidate.name === "secret"),
    false,
  );

  const again = discover(dirs);
  assert.deepEqual(
    again.candidates.map((candidate) => candidate.id),
    result.candidates.map((candidate) => candidate.id),
  );
});

test("absent paths are silent, explicit extra dirs ignore the host env, and discovery does not write", (t) => {
  const dirs = fixture(t);
  writeMd(join(dirs.agentDir, "agents", "ok.md"), definition("ok"));
  writeFileSync(join(dirs.agentDir, "settings.json"), "{");
  const canary = join(dirs.agentDir, "agents", "ok.md");
  const before = readFileSync(canary, "utf8");
  const previous = process.env[ENV];
  process.env[ENV] = join(dirs.root, "from-env");
  writeMd(join(dirs.root, "from-env", "env.md"), definition("from-env"));
  try {
    const ignored = discover(dirs, { extraAgentDirs: "" });
    assert.deepEqual(names(ignored), ["ok"]);
    assert.ok(ignored.diagnostics.some((line) => line.includes("settings.json")));
    assert.equal(readFileSync(canary, "utf8"), before);

    const fromEnv = discoverImportCandidates({
      cwd: dirs.cwd,
      agentDir: dirs.agentDir,
      includeProject: false,
      homeDir: dirs.homeDir,
    });
    assert.ok(names(fromEnv).includes("from-env"));
    assert.equal(
      fromEnv.candidates.find((candidate) => candidate.name === "from-env")?.scope,
      "user",
    );
  } finally {
    if (previous === undefined) delete process.env[ENV];
    else process.env[ENV] = previous;
  }
});

test("settings behind symlinked scope directories cannot add scan roots or reach the model", (t) => {
  const dirs = fixture(t);
  const external = join(dirs.root, "external");
  writeMd(join(external, "agents", "secret.md"), definition("secret"));
  writeFileSync(
    join(external, "settings.json"),
    JSON.stringify({ subagents: { agentScanDirs: ["agents"] } }),
  );
  writeMd(join(dirs.cwd, ".agents", "visible.md"), definition("visible"));
  symlinkSync(external, join(dirs.cwd, ".pi"));
  const projectResult = discover(dirs);
  assert.deepEqual(names(projectResult), ["visible"]);
  assert.deepEqual(projectResult.candidates[0]!.settingsPaths, []);

  const linkedAgentDir = join(dirs.root, "linked-agent");
  symlinkSync(external, linkedAgentDir);
  const userResult = discover({ ...dirs, agentDir: linkedAgentDir }, { includeProject: false });
  assert.deepEqual(userResult.candidates, []);
});

test("npm non-YAML tool selectors remain selectable for model interpretation", (t) => {
  const dirs = fixture(t);
  writeMd(
    join(dirs.homeDir, ".agents", "loose.md"),
    "---\nname: loose\ndescription: Read-only metadata\ntools: *\n---\nPrompt body\n",
  );
  const result = discover(dirs);
  assert.deepEqual(names(result), ["loose"]);
  assert.equal(result.candidates[0]!.description, "Read-only metadata");
  assert.ok(result.diagnostics.length > 0); // The model must review incompatible fields.
});

test("reports an unreadable definition without failing the rest of discovery", (t) => {
  const dirs = fixture(t);
  const blocked = join(dirs.agentDir, "agents", "blocked.md");
  writeMd(blocked, definition("blocked"));
  writeMd(join(dirs.agentDir, "agents", "open.md"), definition("open"));
  chmodSync(blocked, 0);
  let readable = true;
  try {
    readFileSync(blocked, "utf8");
  } catch {
    readable = false;
  }
  try {
    const result = discover(dirs, { includeProject: false });
    if (readable) return;
    assert.deepEqual(names(result), ["open"]);
    assert.ok(result.diagnostics.some((line) => line.includes("blocked.md")));
  } finally {
    chmodSync(blocked, 0o644);
  }
});

function isSkillCandidate(candidate: ImportCandidate): boolean {
  const segments = candidate.path.split(/[/\\]/);
  const base = segments[segments.length - 1]?.toLowerCase();
  return (
    base === "skill.md" ||
    segments.some((segment) => {
      const lower = segment.toLowerCase();
      return lower === "skills" || lower === ".skills";
    })
  );
}

test("never offers skill trees or SKILL.md files from user, project, or configured roots", (t) => {
  const dirs = fixture(t);
  writeMd(
    join(dirs.homeDir, ".agents", "skills", "review.md"),
    definition("user-skill-review", "Reviews"),
  );
  writeMd(
    join(dirs.homeDir, ".agents", "skills", "nested", "deep.md"),
    definition("user-skill-deep", "Deep", "package: skills\n"),
  );
  writeMd(join(dirs.homeDir, ".agents", "Skills", "mixed.md"), definition("user-skill-mixed"));
  writeMd(join(dirs.homeDir, ".agents", ".skills", "hidden.md"), definition("user-dot-skill"));
  writeMd(join(dirs.homeDir, ".agents", ".SKILLS", "upper.md"), definition("user-dot-skill-upper"));
  writeMd(join(dirs.homeDir, ".agents", "SKILL.md"), definition("home-root-skill", "Nope"));
  writeMd(join(dirs.agentDir, "agents", "skills", "managed.md"), definition("agentdir-skill"));
  writeMd(join(dirs.agentDir, "agents", ".Skills", "dot.md"), definition("agentdir-dot-skill"));
  writeMd(join(dirs.cwd, ".agents", "skills", "project-skill.md"), definition("project-skill"));
  writeMd(join(dirs.cwd, ".agents", "sKiLlS", "case.md"), definition("project-skill-case"));
  writeMd(join(dirs.cwd, ".agents", ".skills", "project-dot.md"), definition("project-dot-skill"));
  writeMd(join(dirs.cwd, ".pi", "agents", "skills", "pi-skill.md"), definition("pi-skill"));
  writeMd(join(dirs.cwd, ".pi", "agents", "SKILLS", "pi-upper.md"), definition("pi-skill-upper"));

  writeMd(join(dirs.agentDir, "agents", "SKILL.md"), "---\nname: [\n---\n");
  writeMd(
    join(dirs.agentDir, "agents", "skill.md"),
    definition("lower-skill", "Lower", "package: skills-pkg\n"),
  );
  writeMd(
    join(dirs.homeDir, ".agents", "agents", "Skill.md"),
    definition("tintin-skill", "Tintin skill"),
  );
  writeMd(
    join(dirs.cwd, ".pi", "agents", "SKILL.md"),
    definition("project-direct-skill", "Direct", "package: pkg\n"),
  );
  writeMd(join(dirs.cwd, ".agents", "Skill.md"), definition("broad-direct-skill", "Broad"));

  writeMd(join(dirs.agentDir, "agents", "real-user.md"), definition("real-user"));
  writeMd(join(dirs.agentDir, "agents", "skills.md"), definition("skills-md-agent"));
  writeMd(join(dirs.agentDir, "agents", "skill", "helper.md"), definition("helper"));
  writeMd(join(dirs.homeDir, ".agents", "agents", "real-tintin.md"), definition("real-tintin"));
  writeMd(join(dirs.homeDir, ".agents", "team", "real-home.md"), definition("real-home", "Home"));
  writeMd(join(dirs.cwd, ".pi", "agents", "real-project.md"), definition("real-project"));
  writeMd(
    join(dirs.cwd, ".agents", "agents", "real-project-tintin.md"),
    definition("real-project-tintin"),
  );

  const scanDirect = join(dirs.root, "configured", "skills");
  const scanNested = join(dirs.root, "configured", "skills", "reviewer");
  const scanMixed = join(dirs.root, "configured", ".Skills", "CaseSkill");
  const scanReal = join(dirs.root, "configured", "keepers");
  writeMd(join(scanDirect, "direct.md"), definition("scan-direct", "Direct", "package: pkg\n"));
  writeMd(join(scanDirect, "SKILL.md"), definition("scan-direct-skillmd", "Direct"));
  writeMd(join(scanNested, "nested.md"), definition("scan-nested"));
  writeMd(join(scanMixed, "case.md"), definition("scan-mixed"));
  writeMd(join(scanReal, "scan-real.md"), definition("scan-real"));
  const vendor = join(dirs.root, "vendor");
  writeMd(join(vendor, "skills", "wild.md"), definition("wild-skill"));
  writeMd(join(vendor, "SKILLS", "wild-upper.md"), definition("wild-skill-upper"));
  writeMd(join(vendor, "agents", "wild-real.md"), definition("wild-real"));
  writeFileSync(
    join(dirs.agentDir, "settings.json"),
    JSON.stringify({
      subagents: {
        agentScanDirs: [scanDirect, scanNested, scanMixed, scanReal, join(vendor, "*")],
      },
    }),
  );

  const projectDirect = join(dirs.cwd, "local", "SKILLS");
  const projectNested = join(dirs.cwd, "local", ".skills", "nested-skill");
  const projectReal = join(dirs.cwd, "local", "keepers");
  writeMd(join(projectDirect, "proj-direct.md"), definition("project-scan-skill"));
  writeMd(
    join(projectNested, "proj-nested.md"),
    definition("project-scan-nested", "Nested", "package: pkg\n"),
  );
  writeMd(join(projectNested, "SKILL.md"), definition("project-scan-skillmd", "Nested"));
  writeMd(join(projectReal, "project-keeper.md"), definition("project-keeper"));
  writeFileSync(
    join(dirs.cwd, ".pi", "settings.json"),
    JSON.stringify({
      subagents: { agentScanDirs: [projectDirect, projectNested, projectReal] },
    }),
  );

  const envDirect = join(dirs.root, "env", ".skills");
  const envNested = join(dirs.root, "env", "Skills", "ChildSkill");
  const envReal = join(dirs.root, "env", "real-agents");
  writeMd(
    join(envDirect, "env-direct.md"),
    definition("env-direct-skill", "Env", "package: pkg\n"),
  );
  writeMd(join(envDirect, "SKILL.md"), definition("env-direct-skillmd", "Env"));
  writeMd(join(envNested, "env-nested.md"), definition("env-nested-skill"));
  writeMd(join(envReal, "env-real.md"), definition("env-real"));
  const previous = process.env[ENV];
  process.env[ENV] = `${envDirect}${delimiter}${envNested}${delimiter}${envReal}`;
  try {
    const result = discoverImportCandidates({
      cwd: dirs.cwd,
      agentDir: dirs.agentDir,
      includeProject: true,
      homeDir: dirs.homeDir,
    });
    assert.deepEqual(names(result), [
      "env-real",
      "helper",
      "project-keeper",
      "real-home",
      "real-project",
      "real-project-tintin",
      "real-tintin",
      "real-user",
      "scan-real",
      "skills-md-agent",
      "wild-real",
    ]);
    assert.deepEqual(result.candidates.filter(isSkillCandidate), []);
    assert.equal(
      result.diagnostics.some((line) => /skill/i.test(line)),
      false,
    );
    assert.equal(
      result.candidates.find((candidate) => candidate.name === "real-user")?.scope,
      "user",
    );
    assert.equal(
      result.candidates.find((candidate) => candidate.name === "real-project")?.scope,
      "project",
    );
    assert.equal(
      result.candidates.find((candidate) => candidate.name === "env-real")?.scope,
      "user",
    );
    assert.equal(
      result.candidates.find((candidate) => candidate.name === "project-keeper")?.scope,
      "project",
    );
  } finally {
    if (previous === undefined) delete process.env[ENV];
    else process.env[ENV] = previous;
  }
});

test("skill-only roots produce no import candidates", (t) => {
  const dirs = fixture(t);
  writeMd(
    join(dirs.homeDir, ".agents", "skills", "only.md"),
    definition("only-user", "Only", "package: skill\n"),
  );
  writeMd(join(dirs.homeDir, ".agents", "SKILL.md"), definition("only-home-skillmd", "Only"));
  writeMd(join(dirs.homeDir, ".agents", "Skills", "case.md"), definition("only-user-case"));
  writeMd(join(dirs.cwd, ".agents", "skills", "only.md"), definition("only-project"));
  writeMd(
    join(dirs.cwd, ".pi", "agents", "Skill.md"),
    definition("only-pi-skillmd", "Only", "package: pkg\n"),
  );
  writeMd(join(dirs.agentDir, "agents", ".SKILLS", "only.md"), definition("only-agentdir"));
  const onlyRoot = join(dirs.root, "only", "skills", "reviewer");
  writeMd(join(onlyRoot, "SKILL.md"), definition("only-configured", "Only", "package: pkg\n"));
  writeMd(join(onlyRoot, "agent.md"), definition("only-nested", "Only"));
  writeFileSync(
    join(dirs.agentDir, "settings.json"),
    JSON.stringify({ subagents: { agentScanDirs: [onlyRoot, join(dirs.root, "only", "SKILLS")] } }),
  );
  writeMd(join(dirs.root, "only", "SKILLS", "direct.md"), definition("only-direct-root"));
  const previous = process.env[ENV];
  process.env[ENV] = join(dirs.root, "only-env", ".SKILLS");
  writeMd(join(dirs.root, "only-env", ".SKILLS", "child", "env.md"), definition("only-env"));
  try {
    const result = discoverImportCandidates({
      cwd: dirs.cwd,
      agentDir: dirs.agentDir,
      includeProject: true,
      homeDir: dirs.homeDir,
    });
    assert.deepEqual(result.candidates, []);
    assert.deepEqual(result.candidates.filter(isSkillCandidate), []);
    assert.equal(
      result.diagnostics.some((line) => /skill/i.test(line)),
      false,
    );
  } finally {
    if (previous === undefined) delete process.env[ENV];
    else process.env[ENV] = previous;
  }
});
