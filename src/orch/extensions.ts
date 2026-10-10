import { realpath, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const MANAGER_ENTRY = fileURLToPath(new URL("../index.ts", import.meta.url));

async function canonical(file: string): Promise<string> {
  return realpath(file).catch(() => path.resolve(file));
}

/** Exclude this manager before executing factories, including installed copies and symlinks. */
async function isManagerExtension(file: string, packageRoot?: string): Promise<boolean> {
  const resolved = await canonical(file);
  if (resolved === (await canonical(MANAGER_ENTRY))) return true;
  // Explicit paths and auto-discovered symlinks may not have package metadata.
  let directory = packageRoot ?? path.dirname(resolved);
  while (true) {
    try {
      const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
      return manifest.name === "pi-subagent-manager";
    } catch {
      const parent = path.dirname(directory);
      if (parent === directory) return false;
      directory = parent;
    }
  }
}

/**
 * The public ExtensionAPI cannot inspect the main session's resource loader. This is
 * deliberately configured-file discovery, not exact main-set inheritance: CLI-only,
 * inline and built-in extensions are not reloaded. Missing packages are never installed.
 */
export async function discoverSubagentExtensions(options: {
  cwd: string;
  agentDir: string;
  projectTrusted: boolean;
}): Promise<string[]> {
  const settingsManager = SettingsManager.create(options.cwd, options.agentDir, {
    projectTrusted: options.projectTrusted,
  });
  const packages = new DefaultPackageManager({ ...options, settingsManager });
  const resources = await packages.resolve(async () => "skip");
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const resource of resources.extensions) {
    if (!resource.enabled || resource.path.startsWith("builtin:")) continue;
    if (await isManagerExtension(resource.path, resource.metadata.packageRoot)) continue;
    const resolved = await canonical(resource.path);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    paths.push(resource.path);
  }
  return paths;
}
