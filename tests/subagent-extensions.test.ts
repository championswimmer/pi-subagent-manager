import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  discoverSubagentExtensions,
  extensionDisplayName,
  selectSubagentExtensions,
} from "../src/orch/extensions.ts";

const managerEntry = fileURLToPath(new URL("../src/index.ts", import.meta.url));

test("extension labels prefer npm package names and retain local filename fallbacks", () => {
  for (const [file, expected] of [
    ["/Users/arnav/.pi/agent/npm/node_modules/pi-context-usage/src/index.ts", "pi-context-usage"],
    ["/npm/node_modules/pi-context-usage/extension.ts", "pi-context-usage"],
    ["/npm/node_modules/@scope/pi-tools/src/index.js", "@scope/pi-tools"],
    ["/npm/node_modules/outer/node_modules/inner/dist/index.mjs", "inner"],
    ["/npm/node_modules/.pnpm/pkg@1.0.0/node_modules/pkg/src/index.ts", "pkg"],
    ["/extensions/local/index.ts", "local"],
    ["/extensions/local/index.cjs", "local"],
    ["/extensions/custom.ts", "custom.ts"],
  ]) {
    assert.equal(extensionDisplayName(path.normalize(file)), expected);
  }
});

test("configured extension discovery respects trust, exclusions, packages and manager identity", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-subagent-extensions-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "user");
  const cwd = path.join(root, "workspace");
  const userExtensions = path.join(agentDir, "extensions");
  const projectExtensions = path.join(cwd, ".pi", "extensions");
  await mkdir(userExtensions, { recursive: true });
  await mkdir(projectExtensions, { recursive: true });
  const user = path.join(userExtensions, "user.ts");
  const disabled = path.join(userExtensions, "disabled.ts");
  const project = path.join(projectExtensions, "project.ts");
  const configured = path.join(agentDir, "extra.ts");
  for (const file of [user, disabled, project, configured]) {
    await writeFile(file, 'throw new Error("Discovery must not execute factories")');
  }
  await symlink(managerEntry, path.join(userExtensions, "manager.ts"));
  const installedManager = path.join(agentDir, "manager-copy");
  const localPackage = path.join(agentDir, "local-package");
  for (const [directory, name] of [
    [installedManager, "pi-subagent-manager"],
    [localPackage, "example"],
  ]) {
    await mkdir(directory);
    await writeFile(
      path.join(directory, "package.json"),
      JSON.stringify({ name, pi: { extensions: ["entry.ts"] } }),
    );
    await writeFile(
      path.join(directory, "entry.ts"),
      'throw new Error("Factory must not run during discovery")',
    );
  }
  await writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      extensions: ["./extra.ts", "-extensions/disabled.ts"],
      packages: ["./manager-copy", "./local-package"],
    }),
  );
  await writeFile(
    path.join(cwd, ".pi", "settings.json"),
    JSON.stringify({
      extensions: ["-extensions/project.ts"],
    }),
  );
  const discover = (projectTrusted: boolean) =>
    discoverSubagentExtensions({ cwd, agentDir, projectTrusted }).then((files) => files.map(({ path }) => path));
  const expected = [user, configured, path.join(localPackage, "entry.ts")].sort();
  assert.deepEqual((await discover(false)).sort(), expected);
  assert.deepEqual((await discover(true)).sort(), expected, "project exclusion honored");
  await writeFile(path.join(cwd, ".pi", "settings.json"), "{}");
  assert.deepEqual((await discover(true)).sort(), [...expected, project].sort());
  assert.deepEqual((await discover(false)).sort(), expected, "untrusted project files never load");
});

test("configured discovery skips missing packages rather than installing them", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-missing-package-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "user");
  const cwd = path.join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(cwd);
  const fakeNpm = path.join(root, "npm.cjs");
  const installMarker = path.join(root, "install-attempted");
  await writeFile(
    fakeNpm,
    `
    const fs = require("node:fs");
    if (process.argv.includes("install")) {
      fs.writeFileSync(${JSON.stringify(installMarker)}, "installation attempted");
      process.exit(1);
    }
    console.log(${JSON.stringify(path.join(root, "empty-global-root"))});
  `,
  );
  await writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({
      packages: ["npm:pi-subagent-missing-package-fixture@0.0.0"],
      npmCommand: [process.execPath, fakeNpm],
    }),
  );
  assert.deepEqual(await discoverSubagentExtensions({ cwd, agentDir, projectTrusted: false }), []);
  const { access } = await import("node:fs/promises");
  await assert.rejects(access(installMarker), { code: "ENOENT" });
});

test("selection intersects trusted discovery and preserves legacy all/none", () => {
  const available = [{ id: "/a.ts", path: "/a.ts" }, { id: ".pi/b.ts", path: "/b.ts" }];
  assert.deepEqual(selectSubagentExtensions(available, true), ["/a.ts", "/b.ts"]);
  assert.deepEqual(selectSubagentExtensions(available, false), []);
  assert.deepEqual(selectSubagentExtensions(available, []), []);
  assert.deepEqual(selectSubagentExtensions(available, ["/b.ts", "/missing.ts"]), ["/b.ts"]);
  assert.deepEqual(selectSubagentExtensions(available, [".pi/b.ts", "/b.ts"]), ["/b.ts"]);
});

test("a global selection is portable between agent directories", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-subagent-agent-dirs-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "project");
  await mkdir(cwd);
  const dirs = ["alice", "bob"].map((name) => path.join(root, name));
  for (const agentDir of dirs) {
    await mkdir(path.join(agentDir, "extensions"), { recursive: true });
    await writeFile(path.join(agentDir, "extensions", "portable.ts"), "export default function() {}");
  }
  const discover = (agentDir: string) => discoverSubagentExtensions({ cwd, agentDir, projectTrusted: false });
  const saved = (await discover(dirs[0]!)).map(({ id }) => id);
  assert.deepEqual(saved, ["$PI_CODING_AGENT_DIR/extensions/portable.ts"]);
  assert.deepEqual(selectSubagentExtensions(await discover(dirs[1]!), saved), [
    path.join(dirs[1]!, "extensions", "portable.ts"),
  ]);
});

test("the same project selection loads the local copy from either worktree", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-subagent-worktrees-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir);
  const id = path.join(".pi", "extensions", "example.ts");
  const worktrees = ["main", "other"].map((name) => path.join(root, name));
  for (const cwd of worktrees) {
    const file = path.join(cwd, id);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "export default function() {}");
  }
  const first = await discoverSubagentExtensions({ cwd: worktrees[0]!, agentDir, projectTrusted: true });
  const saved = first.map((file) => file.id);
  assert.deepEqual(saved, [id]);

  const cwd = worktrees[1]!;
  const second = await discoverSubagentExtensions({ cwd, agentDir, projectTrusted: true });
  assert.deepEqual(selectSubagentExtensions(second, saved), [path.join(cwd, id)]);
  const untrusted = await discoverSubagentExtensions({ cwd, agentDir, projectTrusted: false });
  assert.deepEqual(selectSubagentExtensions(untrusted, saved), []);
});

test("auto-discovery includes standalone TS/JS and subdir entry points without configuration", async (t) => {
  const root = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "pi-subagent-auto-extensions-")),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  // Use a custom agent directory, not an assumed ~/.pi/agent location.
  const agentDir = path.join(root, "custom-agent-dir");
  const cwd = path.join(root, "workspace");
  const userDir = path.join(agentDir, "extensions");
  const projectDir = path.join(cwd, ".pi", "extensions");
  const files = [
    "standalone.ts",
    "standalone.js",
    "ts-dir/index.ts",
    "ts-dir/index.js",
    "js-dir/index.js",
  ];
  for (const base of [userDir, projectDir]) {
    for (const file of [
      ...files,
      "nested/no-entry/helper.ts",
      ".hidden.ts",
      "notes.txt",
      "ignored.ts",
    ]) {
      const target = path.join(base, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, 'throw new Error("Discovery must not execute factories")');
    }
    await writeFile(path.join(base, ".gitignore"), "ignored.ts\n");
    await symlink(managerEntry, path.join(base, "manager.ts"));
  }
  const entries = (base: string) =>
    ["standalone.ts", "standalone.js", "ts-dir/index.ts", "js-dir/index.js"].map((file) =>
      path.join(base, file),
    );
  const discover = (projectTrusted: boolean) =>
    discoverSubagentExtensions({ cwd, agentDir, projectTrusted }).then((files) => files.map(({ path }) => path));
  assert.deepEqual((await discover(false)).sort(), entries(userDir).sort());
  assert.deepEqual(
    (await discover(true)).sort(),
    [...entries(userDir), ...entries(projectDir)].sort(),
  );
  // Explicit exclusions must still win over auto-discovery.
  await writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ extensions: ["-extensions/standalone.ts"] }),
  );
  await writeFile(
    path.join(cwd, ".pi", "settings.json"),
    JSON.stringify({ extensions: ["-extensions/standalone.js"] }),
  );
  assert.deepEqual(
    (await discover(true)).sort(),
    [
      ...entries(userDir).filter((file) => file !== path.join(userDir, "standalone.ts")),
      ...entries(projectDir).filter((file) => file !== path.join(projectDir, "standalone.js")),
    ].sort(),
  );
});
