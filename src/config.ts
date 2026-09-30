import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { isMap, isScalar, parseDocument, stringify } from "yaml";
import { THINKING_LEVELS, type AgentType } from "./types.js";

// Pi semantic foreground tokens (background tokens are intentionally excluded).
export const AGENT_COLORS = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "scrollbarTrack",
  "scrollbarThumb",
  "searchMatchText",
  "userMessageText",
  "customMessageText",
  "customMessageLabel",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "thinkingMax",
  "bashMode",
] as const;

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
const TOOL = /^[a-zA-Z0-9_-]+$/;
const FIELDS = new Set(["name", "description", "model", "thinkingLevel", "color", "tools"]);

type AgentScope = "user" | "project";
type SaveOrigin = Pick<AgentType, "name" | "source" | "filePath">;

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

function validatePreservedDestination(filePath: string, directory: string): string {
  const resolved = resolve(filePath);
  if (dirname(resolved) !== directory || !resolved.endsWith(".md"))
    throw new Error(`Unsafe agent destination: ${resolved}`);
  const stat = lstatIfPresent(resolved);
  if (!stat?.isFile()) throw new Error(`Unsafe agent destination: ${resolved}`);
  return resolved;
}

function frontmatter(content: string): { yaml: string; body: string } {
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(content);
  if (!match || match.index !== 0)
    throw new Error("Expected YAML frontmatter enclosed by --- lines");
  return { yaml: match[1], body: content.slice(match[0].length) };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be a mapping`);
  return value as Record<string, unknown>;
}

function toolNames(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((name) => typeof name !== "string" || !TOOL.test(name))) {
    throw new Error(`${label} must be an array of exact tool names (no wildcards or patterns)`);
  }
  if (new Set(value).size !== value.length)
    throw new Error(`${label} contains duplicate tool names`);
  return [...value];
}

function toolPolicy(value: unknown): NonNullable<AgentType["tools"]> {
  const mapping = record(value, "tools");
  for (const key of Object.keys(mapping))
    if (key !== "allow" && key !== "block") throw new Error(`Unknown tools field: ${key}`);
  const result: NonNullable<AgentType["tools"]> = {};
  if (Object.hasOwn(mapping, "allow")) result.allow = toolNames(mapping.allow, "tools.allow");
  if (Object.hasOwn(mapping, "block")) result.block = toolNames(mapping.block, "tools.block");
  return result;
}

export function parseAgentType(content: string, filePath?: string): AgentType {
  try {
    const { yaml, body } = frontmatter(content);
    const doc = parseDocument(yaml, { uniqueKeys: true });
    if (doc.errors.length) throw new Error(doc.errors.map((error) => error.message).join("; "));
    const data = record(doc.toJS({ maxAliasCount: 0 }), "Frontmatter");
    for (const key of Object.keys(data))
      if (!FIELDS.has(key)) throw new Error(`Unknown frontmatter field: ${key}`);
    if (typeof data.name !== "string" || !NAME.test(data.name))
      throw new Error(
        "name must be a safe identifier using letters, numbers, underscores or hyphens",
      );
    if (typeof data.description !== "string" || !data.description.trim())
      throw new Error("description must be a nonempty string");
    const result: AgentType = {
      name: data.name,
      description: data.description,
      systemPrompt: body,
    };
    if (Object.hasOwn(data, "model")) {
      if (typeof data.model !== "string" || !/^[^\s/]+\/[^\s]+$/.test(data.model))
        throw new Error("model must be provider/model-id");
      result.model = data.model;
    }
    if (Object.hasOwn(data, "thinkingLevel")) {
      if (!THINKING_LEVELS.includes(data.thinkingLevel as AgentType["thinkingLevel"] & string))
        throw new Error(`thinkingLevel must be one of: ${THINKING_LEVELS.join(", ")}`);
      result.thinkingLevel = data.thinkingLevel as AgentType["thinkingLevel"];
    }
    if (Object.hasOwn(data, "color")) {
      if (!AGENT_COLORS.includes(data.color as (typeof AGENT_COLORS)[number]))
        throw new Error(`color must be a Pi foreground token: ${AGENT_COLORS.join(", ")}`);
      result.color = data.color as string;
    }
    if (Object.hasOwn(data, "tools")) result.tools = toolPolicy(data.tools);
    if (filePath !== undefined) result.filePath = filePath;
    return result;
  } catch (error) {
    throw new Error(
      `${filePath ?? "Agent definition"}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function serializeAgentType(type: AgentType): string {
  if (typeof type.systemPrompt !== "string") throw new Error("systemPrompt must be a string");
  const data: Record<string, unknown> = {
    name: type.name,
    description: type.description,
  };
  for (const key of ["model", "thinkingLevel", "color", "tools"] as const)
    if (type[key] !== undefined) data[key] = type[key];
  const content = `---\n${stringify(data)}---\n${type.systemPrompt}`;
  parseAgentType(content);
  return content;
}

export function selectTools(policy: AgentType["tools"], available: string[]): string[] {
  const validated = policy === undefined ? {} : toolPolicy(policy);
  const names = new Set(available);
  for (const name of [...(validated.allow ?? []), ...(validated.block ?? [])]) {
    if (!names.has(name)) throw new Error(`Unavailable tool name: ${name}`);
  }
  const allow = validated.allow === undefined ? names : new Set(validated.allow);
  const block = new Set(validated.block ?? []);
  return [...names].filter((name) => allow.has(name) && !block.has(name));
}

export interface ConfigStoreOptions {
  cwd: string;
  agentDir: string;
  includeProject: boolean;
  bundledDir?: string;
}

export class ConfigStore {
  diagnostics: string[] = [];
  private types = new Map<string, AgentType>();
  private readonly options: ConfigStoreOptions;

  constructor(options: ConfigStoreOptions) {
    this.options = { ...options };
    this.reload();
  }

  reload(): void {
    this.types.clear();
    this.diagnostics = [];
    const layers: [string, NonNullable<AgentType["source"]>][] = [
      [this.options.bundledDir ?? fileURLToPath(new URL("../agents/", import.meta.url)), "bundled"],
      [join(this.options.agentDir, "agents"), "user"],
    ];
    if (this.options.includeProject)
      layers.push([join(this.options.cwd, ".pi", "agents"), "project"]);
    for (const [directory, source] of layers) {
      let files: string[];
      try {
        const stat = assertNotSymlinkPath(directory);
        if (!stat) continue;
        if (!stat.isDirectory())
          throw new Error(`Agent directory must be a directory: ${directory}`);
        files = readdirSync(directory)
          .filter((file) => file.endsWith(".md"))
          .sort();
      } catch (error) {
        this.diagnostics.push(`${directory}: ${String(error)}`);
        // An unreadable override layer cannot safely expose lower-precedence policies.
        this.types.clear();
        continue;
      }
      const blocked = new Set<string>();
      const seenNames = new Set<string>();
      for (const file of files) {
        const filePath = join(directory, file);
        let content = "";
        try {
          if (!lstatSync(filePath).isFile())
            throw new Error("Agent definition must be a regular file, not a symlink");
          content = readFileSync(filePath, "utf8");
          const type = parseAgentType(content, filePath);
          if (seenNames.has(type.name)) {
            blocked.add(type.name);
            this.diagnostics.push(
              `${filePath}: Duplicate agent name in ${source} layer: ${type.name}`,
            );
            continue;
          }
          seenNames.add(type.name);
          this.types.set(type.name, { ...type, source });
        } catch (error) {
          blocked.add(file.slice(0, -3));
          // Extract declared names even if another field or duplicate key is malformed.
          try {
            const doc = parseDocument(frontmatter(content).yaml);
            if (isMap(doc.contents))
              for (const pair of doc.contents.items) {
                if (
                  isScalar(pair.key) &&
                  pair.key.value === "name" &&
                  isScalar(pair.value) &&
                  typeof pair.value.value === "string"
                )
                  blocked.add(pair.value.value);
              }
          } catch {
            /* Filename still provides a fail-closed tombstone. */
          }
          this.diagnostics.push(`${filePath}: ${String(error)}`);
        }
      }
      for (const name of blocked) this.types.delete(name);
    }
  }

  list(): AgentType[] {
    return structuredClone([...this.types.values()].sort((a, b) => a.name.localeCompare(b.name)));
  }

  get(name: string): AgentType {
    const type = this.types.get(name);
    if (!type) throw new Error(`Unknown or invalid agent type: ${name}`);
    return structuredClone(type);
  }

  canSaveProject(): boolean {
    return this.options.includeProject;
  }

  private scopeDirectory(scope: AgentScope): string {
    if (scope !== "user" && scope !== "project") throw new Error("Invalid agent scope");
    if (scope === "project" && !this.options.includeProject)
      throw new Error("Project agents are not enabled/trusted");
    return scope === "user"
      ? resolve(this.options.agentDir, "agents")
      : resolve(this.options.cwd, ".pi", "agents");
  }

  private destinationBasePaths(scope: AgentScope, directory: string): string[] {
    const base = resolve(scope === "user" ? this.options.agentDir : this.options.cwd);
    return scope === "user" ? [base, directory] : [base, join(base, ".pi"), directory];
  }

  destination(name: string, scope: AgentScope, original?: SaveOrigin): string {
    if (!NAME.test(name)) throw new Error("Unsafe agent name");
    const directory = this.scopeDirectory(scope);
    if (
      original?.name === name &&
      original.source === scope &&
      typeof original.filePath === "string"
    ) {
      return validatePreservedDestination(original.filePath, directory);
    }
    return resolve(directory, `${name}.md`);
  }

  save(type: AgentType, scope: AgentScope, original?: SaveOrigin): AgentType {
    const content = serializeAgentType(type);
    const validated = parseAgentType(content);
    const filePath = this.destination(validated.name, scope, original);
    const directory = dirname(filePath);
    // Reject redirected destination directories and files before writing.
    for (const path of [...this.destinationBasePaths(scope, directory), filePath]) {
      const stat = assertNotSymlinkPath(path);
      if (path === filePath && stat && !stat.isFile())
        throw new Error(`Unsafe agent destination: ${filePath}`);
    }
    mkdirSync(directory, { recursive: true });
    const temporary = join(dirname(filePath), `.${validated.name}.${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
      renameSync(temporary, filePath);
    } finally {
      if (lstatIfPresent(temporary)) unlinkSync(temporary);
    }
    this.reload();
    return { ...validated, filePath, source: scope };
  }
}
