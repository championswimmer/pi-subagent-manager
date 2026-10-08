import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SUBAGENT_MODES = ["off", "opportunistic", "orchestration"] as const;
export type SubagentMode = (typeof SUBAGENT_MODES)[number];

export const WIDGET_MODES = ["full", "minimal"] as const;
export type WidgetMode = (typeof WIDGET_MODES)[number];

export const LOADER_STYLES = ["circle", "braille", "hourglass"] as const;
export type LoaderStyle = (typeof LOADER_STYLES)[number];

export const TOOL_FILTERING_MODES = ["allowed", "all-except-blocked", "all"] as const;
export type ToolFilteringMode = (typeof TOOL_FILTERING_MODES)[number];

export const MODEL_SELECTION_MODES = [
  "pick-first-available",
  "pick-first-scoped",
  "use-current",
] as const;
export type ModelSelectionMode = (typeof MODEL_SELECTION_MODES)[number];

export interface ManagerSettings {
  subagentMode: SubagentMode;
  toolFiltering: ToolFilteringMode;
  widgetMode: WidgetMode;
  nerdFontIcons: boolean;
  loaderStyle: LoaderStyle;
  finalRecap: boolean;
  maxLevels: number;
  maxConcurrent: number;
  maxThreads: number;
  modelSelection: ModelSelectionMode;
}

export const DEFAULT_MANAGER_SETTINGS: ManagerSettings = {
  maxLevels: 3,
  maxConcurrent: 16,
  maxThreads: 64,
  modelSelection: "pick-first-scoped",
  subagentMode: "opportunistic",
  toolFiltering: "allowed",
  widgetMode: "full",
  nerdFontIcons: false,
  loaderStyle: "circle",
  finalRecap: false,
};

const KEYS = [
  "maxLevels",
  "maxConcurrent",
  "maxThreads",
  "modelSelection",
  "subagentMode",
  "toolFiltering",
  "widgetMode",
  "nerdFontIcons",
  "loaderStyle",
  "finalRecap",
] as const;
/** File-only key, read separately from ManagerSettings: layers are unioned, never overridden. */
const REQUIRED_CHILD_EXTENSIONS = "requiredChildExtensions";
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

function requirement(key: (typeof KEYS)[number]): string {
  if (key === "nerdFontIcons" || key === "finalRecap") return `${key} must be a boolean`;
  if (key === "subagentMode") return "subagentMode must be off, opportunistic or orchestration";
  if (key === "widgetMode") return "widgetMode must be full or minimal";
  if (key === "loaderStyle") return "loaderStyle must be circle, braille or hourglass";
  if (key === "toolFiltering") return "toolFiltering must be allowed, all-except-blocked or all";
  if (key === "modelSelection")
    return "modelSelection must be pick-first-available, pick-first-scoped or use-current";
  return `${key} must be a positive safe integer`;
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
    if (!isSupportedKey(key) && key !== "scopedModelFiltering" && key !== REQUIRED_CHILD_EXTENSIONS)
      throw new Error(`Unknown settings key: ${key}`);
  }
  const layer: Partial<ManagerSettings> = {};
  if (Object.hasOwn(record, "scopedModelFiltering")) {
    if (typeof record.scopedModelFiltering !== "boolean")
      throw new Error("scopedModelFiltering must be a boolean");
    if (!Object.hasOwn(record, "modelSelection"))
      layer.modelSelection = record.scopedModelFiltering
        ? "pick-first-scoped"
        : "pick-first-available";
  }
  for (const key of KEYS) {
    if (!Object.hasOwn(record, key)) continue;
    const value = record[key];
    if (key === "nerdFontIcons" || key === "finalRecap") {
      if (typeof value !== "boolean") throw new Error(requirement(key));
      layer[key] = value;
      continue;
    }
    if (key === "subagentMode") {
      if (!SUBAGENT_MODES.includes(value as SubagentMode)) throw new Error(requirement(key));
      layer.subagentMode = value as SubagentMode;
      continue;
    }
    if (key === "toolFiltering") {
      if (!TOOL_FILTERING_MODES.includes(value as ToolFilteringMode))
        throw new Error(requirement(key));
      layer.toolFiltering = value as ToolFilteringMode;
      continue;
    }
    if (key === "widgetMode") {
      if (!WIDGET_MODES.includes(value as WidgetMode)) throw new Error(requirement(key));
      layer.widgetMode = value as WidgetMode;
      continue;
    }
    if (key === "loaderStyle") {
      if (!LOADER_STYLES.includes(value as LoaderStyle)) throw new Error(requirement(key));
      layer.loaderStyle = value as LoaderStyle;
      continue;
    }
    if (key === "modelSelection") {
      if (!MODEL_SELECTION_MODES.includes(value as ModelSelectionMode))
        throw new Error(requirement(key));
      layer.modelSelection = value as ModelSelectionMode;
      continue;
    }
    if (!positiveSafeInteger(value)) throw new Error(requirement(key));
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

function readLayerContent(entry: SettingsLayer): string | undefined {
  for (const directory of entry.directories) {
    const stat = assertNotSymlinkPath(directory);
    if (!stat) return undefined;
    if (!stat.isDirectory())
      throw new Error(`Settings directory must be a directory: ${directory}`);
  }
  const stat = assertNotSymlinkPath(entry.filePath);
  if (!stat) return undefined;
  if (!stat.isFile()) throw new Error(`Settings must be a regular file: ${entry.filePath}`);
  return readFileSync(entry.filePath, "utf8");
}

function readLayer(entry: SettingsLayer): Partial<ManagerSettings> | undefined {
  const content = readLayerContent(entry);
  return content === undefined ? undefined : parseSettings(content);
}

export type ManagerSaveScope = "user" | "project";

function uiStateLayer(agentDir: string): SettingsLayer {
  const entry = layer(agentDir, ["subagent-manager"]);
  return { ...entry, filePath: join(dirname(entry.filePath), "ui-state.json") };
}

/** UI preference only: never participates in manager-settings precedence. */
export function loadManagerSaveScope(options: {
  agentDir: string;
  includeProject: boolean;
}): ManagerSaveScope {
  if (!options.includeProject) return "user";
  try {
    const content = readLayerContent(uiStateLayer(options.agentDir));
    if (content !== undefined) {
      const state: unknown = JSON.parse(content);
      if (
        state &&
        typeof state === "object" &&
        !Array.isArray(state) &&
        "saveScope" in state &&
        state.saveScope === "user"
      )
        return "user";
    }
  } catch {
    // Missing, invalid or unsafe UI state must not prevent opening settings.
  }
  return "project";
}

export function saveManagerSaveScope(agentDir: string, scope: ManagerSaveScope): void {
  if (scope !== "user" && scope !== "project") throw new Error("Invalid settings scope");
  const entry = uiStateLayer(agentDir);
  ensureScopeDirectories(entry.directories);
  writeAtomically(entry, `${JSON.stringify({ saveScope: scope }, null, 2)}\n`);
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface SettingsScopeOptions {
  cwd: string;
  agentDir: string;
  includeProject: boolean;
}

/** Global layer first, then the project layer when the project is trusted. */
function settingsLayers(options: SettingsScopeOptions): SettingsLayer[] {
  const layers = [layer(options.agentDir, ["subagent-manager"])];
  if (options.includeProject) layers.push(layer(options.cwd, [".pi", "agent", "subagent-manager"]));
  return layers;
}

export function loadManagerSettings(options: SettingsScopeOptions): {
  settings: ManagerSettings;
  diagnostics: string[];
} {
  const diagnostics: string[] = [];
  const settings: ManagerSettings = { ...DEFAULT_MANAGER_SETTINGS };
  for (const entry of settingsLayers(options)) {
    try {
      const parsed = readLayer(entry);
      if (parsed !== undefined) Object.assign(settings, parsed);
    } catch (error) {
      diagnostics.push(`${entry.filePath}: ${detail(error)}`);
    }
  }
  const required = loadRequiredChildExtensions(options);
  if (required.error) diagnostics.push(required.error);
  return { settings, diagnostics };
}

export interface RequiredChildExtensions {
  /** Resolved extension paths, global entries first, without duplicates. */
  paths: string[];
  /**
   * Set while any layer holds an invalid value, or cannot be parsed and mentions the key;
   * no subagent may start then.
   */
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Raw text of a layer; missing files and files that cannot be read yield undefined. */
function readLayerText(entry: SettingsLayer): string | undefined {
  try {
    return readLayerContent(entry);
  } catch {
    // loadManagerSettings reports these files; they contribute nothing here.
    return undefined;
  }
}

/** The JSON object in a layer's text; text that is not one yields undefined. */
function parseLayerRecord(content: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(content);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    // loadManagerSettings reports invalid JSON for every key.
    return undefined;
  }
}

function readLayerRecord(entry: SettingsLayer): Record<string, unknown> | undefined {
  const content = readLayerText(entry);
  return content === undefined ? undefined : parseLayerRecord(content);
}

/** Git Bash, MSYS, Cygwin and WSL drive paths (`/c/x`, `/mnt/c/x`) as Windows paths. */
function normalizeWindowsShellPath(filePath: string): string {
  if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\"))
    return filePath;
  const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return filePath;
  return `${match[1].toUpperCase()}:\\${match[2]?.replaceAll("/", "\\") ?? ""}`;
}

/**
 * Same steps as pi's `-e` path resolution (`resolvePath` in pi's utils/paths, not exported):
 * trim, Windows shell paths, `~` from $HOME, `file://` URLs, relative to cwd.
 */
function resolveExtensionPath(source: string, cwd: string): string {
  const windows = process.platform === "win32";
  const trimmed = windows ? normalizeWindowsShellPath(source.trim()) : source.trim();
  const home = process.env.HOME || homedir();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/") || (windows && trimmed.startsWith("~\\")))
    return join(home, trimmed.slice(2));
  if (trimmed.startsWith("file://")) return fileURLToPath(trimmed);
  return resolve(cwd, trimmed);
}

/**
 * Extensions every subagent must load. Unlike other keys, the global and project lists are
 * combined, so a repository can add required extensions but never remove the user's own.
 */
export function loadRequiredChildExtensions(
  options: SettingsScopeOptions,
): RequiredChildExtensions {
  const paths: string[] = [];
  const errors: string[] = [];
  for (const entry of settingsLayers(options)) {
    const content = readLayerText(entry);
    if (content === undefined) continue;
    const record = parseLayerRecord(content);
    if (!record) {
      // A typo must not silently drop a guard the file lists, so any mention of the key counts.
      if (content.includes(REQUIRED_CHILD_EXTENSIONS))
        errors.push(
          `${entry.filePath}: could not be parsed as a JSON object and mentions ${REQUIRED_CHILD_EXTENSIONS}; subagents will not start until it is fixed`,
        );
      continue;
    }
    if (!Object.hasOwn(record, REQUIRED_CHILD_EXTENSIONS)) continue;
    const value = record[REQUIRED_CHILD_EXTENSIONS];
    if (
      !Array.isArray(value) ||
      !value.every((source) => typeof source === "string" && source.trim() !== "")
    ) {
      errors.push(
        `${entry.filePath}: ${REQUIRED_CHILD_EXTENSIONS} must be an array of non-empty strings; subagents will not start until it is fixed`,
      );
      continue;
    }
    for (const source of value as string[]) {
      const resolved = resolveExtensionPath(source, options.cwd);
      if (!paths.includes(resolved)) paths.push(resolved);
    }
  }
  return errors.length ? { paths, error: errors.join("\n") } : { paths };
}

function serializedSettings(settings: ManagerSettings): string {
  if (settings === null || typeof settings !== "object" || Array.isArray(settings)) {
    throw new Error("Settings must be a JSON object");
  }
  for (const key of Object.keys(settings)) {
    if (!isSupportedKey(key)) throw new Error(`Unknown settings key: ${key}`);
  }
  const parsed = parseSettings(JSON.stringify(settings));
  for (const key of KEYS) {
    if (!Object.hasOwn(parsed, key)) throw new Error(requirement(key));
  }
  const serialized = `${JSON.stringify(parsed, null, 2)}\n`;
  const confirmed = parseSettings(serialized);
  for (const key of KEYS) {
    if (confirmed[key] !== parsed[key]) throw new Error(requirement(key));
  }
  return serialized;
}

function assertExistingDirectory(directory: string): void {
  const stat = assertNotSymlinkPath(directory);
  if (!stat?.isDirectory()) throw new Error(`Settings directory must be a directory: ${directory}`);
}

function ensureOwnedDirectory(directory: string): void {
  let stat = assertNotSymlinkPath(directory);
  if (!stat) {
    try {
      mkdirSync(directory);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    stat = assertNotSymlinkPath(directory);
  }
  if (!stat?.isDirectory()) throw new Error(`Settings directory must be a directory: ${directory}`);
}

function ensureScopeDirectories(directories: string[]): void {
  assertExistingDirectory(directories[0]);
  for (let index = 1; index < directories.length; index++) {
    assertExistingDirectory(directories[index - 1]);
    ensureOwnedDirectory(directories[index]);
  }
}

function assertRegularFileOrAbsent(filePath: string): void {
  const stat = assertNotSymlinkPath(filePath);
  if (stat && !stat.isFile()) throw new Error(`Settings must be a regular file: ${filePath}`);
}

function exclusiveCreateFlags(): number {
  return constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0);
}

function writeAtomically(entry: SettingsLayer, content: string): void {
  const filePath = entry.filePath;
  const temporary = join(dirname(filePath), `.settings.${randomUUID()}.tmp`);
  let created = false;
  try {
    for (const directory of entry.directories) assertExistingDirectory(directory);
    assertRegularFileOrAbsent(filePath);
    const fd = openSync(temporary, exclusiveCreateFlags(), 0o600);
    created = true;
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, content);
    } finally {
      closeSync(fd);
    }
    for (const directory of entry.directories) assertExistingDirectory(directory);
    assertRegularFileOrAbsent(filePath);
    const tempStat = assertNotSymlinkPath(temporary);
    if (!tempStat?.isFile()) throw new Error(`Settings must be a regular file: ${temporary}`);
    renameSync(temporary, filePath);
  } finally {
    if (created) {
      try {
        if (lstatIfPresent(temporary)) unlinkSync(temporary);
      } catch {
        // Keep the original save error if cleanup fails.
      }
    }
  }
}

export function saveManagerSettings(options: {
  cwd: string;
  agentDir: string;
  includeProject: boolean;
  scope: "user" | "project";
  settings: ManagerSettings;
}): string {
  if (options.scope !== "user" && options.scope !== "project") {
    throw new Error("Invalid settings scope");
  }
  if (options.scope === "project" && !options.includeProject) {
    throw new Error("Project settings are not enabled/trusted");
  }
  const content = serializedSettings(options.settings);
  const entry =
    options.scope === "user"
      ? layer(options.agentDir, ["subagent-manager"])
      : layer(options.cwd, [".pi", "agent", "subagent-manager"]);
  ensureScopeDirectories(entry.directories);
  writeAtomically(entry, withRequiredChildExtensions(content, readLayerRecord(entry)));
  return entry.filePath;
}

/** The settings dialog does not edit this key, so a save keeps the file's own value verbatim. */
function withRequiredChildExtensions(
  content: string,
  existing: Record<string, unknown> | undefined,
): string {
  if (!existing || !Object.hasOwn(existing, REQUIRED_CHILD_EXTENSIONS)) return content;
  const merged = {
    ...JSON.parse(content),
    [REQUIRED_CHILD_EXTENSIONS]: existing[REQUIRED_CHILD_EXTENSIONS],
  };
  return `${JSON.stringify(merged, null, 2)}\n`;
}
