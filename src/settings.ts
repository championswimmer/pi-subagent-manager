import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ManagerSettings {
  maxLevels: number;
  maxConcurrent: number;
  maxThreads: number;
}

export const DEFAULT_MANAGER_SETTINGS: ManagerSettings = {
  maxLevels: 3,
  maxConcurrent: 16,
  maxThreads: 64,
};

const KEYS = ["maxLevels", "maxConcurrent", "maxThreads"] as const;
const MAX_LEVELS = 32;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function assertNotSymlinkPath(path: string): ReturnType<typeof lstatSync> | undefined {
  const stat = lstatIfPresent(path);
  if (stat?.isSymbolicLink()) throw new Error(`Unsafe symlink path: ${path}`);
  return stat;
}

function isSupportedKey(key: string): key is (typeof KEYS)[number] {
  return KEYS.includes(key as (typeof KEYS)[number]);
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseSettings(content: string): Partial<ManagerSettings> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON: ${detail}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Settings must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!isSupportedKey(key)) throw new Error(`Unknown settings key: ${key}`);
  }
  const layer: Partial<ManagerSettings> = {};
  for (const key of KEYS) {
    if (!Object.hasOwn(record, key)) continue;
    const value = record[key];
    if (!positiveSafeInteger(value)) throw new Error(`${key} must be a positive safe integer`);
    if (key === "maxLevels" && value > MAX_LEVELS) throw new Error("maxLevels must be <= 32");
    layer[key] = value;
  }
  return layer;
}

interface SettingsLayer {
  filePath: string;
  directories: string[];
}

function layer(base: string, segments: string[]): SettingsLayer {
  let current = resolve(base);
  const directories = [current];
  for (const segment of segments) {
    current = join(current, segment);
    directories.push(current);
  }
  return { filePath: join(current, "settings.json"), directories };
}

function readLayer(entry: SettingsLayer): Partial<ManagerSettings> | undefined {
  for (const directory of entry.directories) {
    const stat = assertNotSymlinkPath(directory);
    if (!stat) return undefined;
    if (!stat.isDirectory())
      throw new Error(`Settings directory must be a directory: ${directory}`);
  }
  const stat = assertNotSymlinkPath(entry.filePath);
  if (!stat) return undefined;
  if (!stat.isFile()) throw new Error(`Settings must be a regular file: ${entry.filePath}`);
  return parseSettings(readFileSync(entry.filePath, "utf8"));
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function loadManagerSettings(options: {
  cwd: string;
  agentDir: string;
  includeProject: boolean;
}): { settings: ManagerSettings; diagnostics: string[] } {
  const diagnostics: string[] = [];
  const settings: ManagerSettings = { ...DEFAULT_MANAGER_SETTINGS };
  const layers = [layer(options.agentDir, ["subagent-manager"])];
  if (options.includeProject) layers.push(layer(options.cwd, [".pi", "agent", "subagent-manager"]));
  for (const entry of layers) {
    try {
      const parsed = readLayer(entry);
      if (parsed !== undefined) Object.assign(settings, parsed);
    } catch (error) {
      diagnostics.push(`${entry.filePath}: ${detail(error)}`);
    }
  }
  return { settings, diagnostics };
}
