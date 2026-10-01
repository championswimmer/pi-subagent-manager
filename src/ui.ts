import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseShell } from "shell-quote";
import {
  DynamicBorder,
  type ExtensionCommandContext,
  type ExtensionContext,
  getSelectListTheme,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  SelectList,
  Text,
  stripTerminalSequences,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { AGENT_COLORS, ConfigStore, parseAgentType, serializeAgentType } from "./config.ts";
import { editModelPreferences, MODEL_EDITOR_CANCEL } from "./model-picker.ts";
import { getModelPreferences } from "./models.ts";
import { THINKING_LEVELS, type AgentType, type ThreadService, type ThreadView } from "./types.ts";

export type ThreadController = Pick<
  ThreadService,
  "list" | "get" | "output" | "transcript" | "steer" | "stop"
>;

/** Plain terminal-safe text: never pass agent-supplied terminal commands through. */
export function sanitizeText(text: string): string {
  return stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

export function renderThreads(
  threads: ThreadView[],
  width: number,
  theme: Pick<Theme, "fg">,
): string[] {
  const priority = (thread: ThreadView) =>
    thread.state === "starting" || thread.state === "running"
      ? 0
      : thread.state === "paused"
        ? 1
        : 2;
  const visible = threads
    .filter((thread) => thread.path !== "/root")
    .sort(
      (a, b) => priority(a) - priority(b) || b.updatedAt - a.updatedAt || b.createdAt - a.createdAt,
    );
  const limit = visible.length > 8 ? 7 : 8;
  const lines = visible.slice(0, limit).map((thread) => {
    const color: ThemeColor = AGENT_COLORS.includes(thread.color as (typeof AGENT_COLORS)[number])
      ? (thread.color as ThemeColor)
      : thread.state === "failed"
        ? "error"
        : thread.state === "paused"
          ? "warning"
          : "accent";
    const label = `${sanitizeText(thread.path)} [${sanitizeText(thread.state)}]`;
    return truncateToWidth(
      `${theme.fg(color, label)} ${sanitizeText(thread.status || thread.task)}`,
      Math.max(0, width),
    );
  });
  if (visible.length > limit) {
    lines.push(
      truncateToWidth(
        theme.fg("muted", `+${visible.length - limit} more threads · /agents thread`),
        Math.max(0, width),
      ),
    );
  }
  return lines;
}

export function updateWidget(ctx: ExtensionContext, threads: ThreadView[]): void {
  if (!ctx.hasUI) return;
  if (!threads.some((thread) => thread.path !== "/root")) {
    ctx.ui.setWidget("pi-subagent", undefined, { placement: "belowEditor" });
    return;
  }
  ctx.ui.setWidget(
    "pi-subagent",
    () => ({
      render: (width) => renderThreads(threads, width, ctx.ui.theme),
      invalidate: () => {},
    }),
    { placement: "belowEditor" },
  );
}

export async function showThreads(
  ctx: ExtensionCommandContext,
  controller: ThreadController,
  path?: string,
): Promise<void> {
  if (!ctx.hasUI) return;
  let selectedPath = path;
  while (true) {
    try {
      if (!selectedPath) {
        const threads = controller.list().filter((thread) => thread.path !== "/root");
        if (!threads.length) {
          ctx.ui.notify("No subagent threads.", "info");
          return;
        }
        const labels = threads.map(
          (thread) =>
            `${sanitizeText(thread.path)} [${sanitizeText(thread.state)}] ${sanitizeText(thread.status)}`,
        );
        const selected = await ctx.ui.select("Subagent threads", labels);
        if (selected === undefined) return;
        selectedPath = threads[labels.indexOf(selected)]?.path;
        if (!selectedPath) return;
      }
      if (selectedPath === "/root")
        throw new Error("/root is the current Pi thread, not a subagent.");
      const thread = controller.get(selectedPath);
      const children = controller.list().filter((child) => child.parent === selectedPath);
      const title = `${sanitizeText(thread.path)} [${sanitizeText(thread.state)}] ${sanitizeText(thread.status)}`;
      const action = await ctx.ui.select(title, [
        "View output",
        "View transcript",
        "Send input / resume",
        "Stop",
        ...(children.length ? ["Children"] : []),
        "Back",
      ]);
      if (!action || action === "Back") {
        if (path) return;
        selectedPath = undefined;
        continue;
      }
      if (action === "View output" || action === "View transcript") {
        const text =
          action === "View output"
            ? controller.output(selectedPath)
            : await controller.transcript(selectedPath);
        // Built-in editor is a portable viewer; edits are explicitly discarded.
        await ctx.ui.editor(
          `${sanitizeText(selectedPath)} — READ ONLY (changes discarded)`,
          text.split("\n").map(sanitizeText).join("\n"),
        );
      } else if (action === "Send input / resume") {
        const message = await ctx.ui.editor("Send input / resume retained session", "");
        if (message?.trim()) await controller.steer(selectedPath, message);
      } else if (action === "Stop") {
        if (
          await ctx.ui.confirm(
            "Stop thread",
            `Stop ${sanitizeText(selectedPath)} and its descendants?`,
          )
        )
          await controller.stop(selectedPath);
      } else if (action === "Children") {
        const labels = children.map(
          (child) =>
            `${sanitizeText(child.path)} [${sanitizeText(child.state)}] ${sanitizeText(child.status)}`,
        );
        const selected = await ctx.ui.select("Children", labels);
        if (selected !== undefined)
          selectedPath = children[labels.indexOf(selected)]?.path ?? selectedPath;
      }
    } catch (error) {
      ctx.ui.notify(sanitizeText(error instanceof Error ? error.message : String(error)), "error");
      return;
    }
  }
}

/** Parse editor argv, rejecting shell operators instead of evaluating a shell command. */
export function editorArguments(command: string): string[] {
  const args = parseShell(command, process.env);
  if (!args.length || args.some((arg) => typeof arg !== "string") || !args[0]) {
    throw new Error(
      "VISUAL/EDITOR must be an executable and arguments, without shell operators or globs.",
    );
  }
  return args as string[];
}

async function externalEdit(ctx: ExtensionCommandContext, text: string): Promise<string> {
  if (ctx.mode !== "tui") throw new Error("External editing requires interactive TUI mode.");
  const [command, ...args] = editorArguments(process.env.VISUAL || process.env.EDITOR || "vi");
  const directory = await mkdtemp(join(tmpdir(), "pi-subagent-"));
  const file = join(directory, "agent.md");
  try {
    await writeFile(file, text, "utf8");
    await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
      tui.stop();
      try {
        const result = spawnSync(command!, [...args, file], {
          stdio: "inherit",
          env: process.env,
        });
        if (result.error) throw result.error;
        if (result.status !== 0)
          throw new Error(`Editor exited with status ${result.status ?? result.signal}.`);
      } finally {
        tui.start();
        tui.requestRender(true);
      }
      done();
      return { render: () => [], invalidate: () => {} };
    });
    return await readFile(file, "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function editToolList(
  ctx: ExtensionCommandContext,
  type: AgentType,
  field: "allow" | "block",
): Promise<void> {
  const mode = await ctx.ui.select(
    `tools.${field} (${sanitizeText(toolListMenuValue(type.tools?.[field]))})`,
    ["Unset (use default policy)", "Empty list", "Enter exact tool names"],
  );
  if (!mode) return;
  if (mode === "Unset (use default policy)") {
    if (type.tools) delete type.tools[field];
  } else {
    const value =
      mode === "Empty list"
        ? ""
        : await ctx.ui.editor(
            `tools.${field}: comma-separated exact names`,
            type.tools?.[field]?.join(", ") ?? "",
          );
    if (value === undefined) return;
    type.tools ??= {};
    type.tools[field] = value
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
  }
  if (type.tools && !Object.keys(type.tools).length) delete type.tools;
}

const AGENT_COLOR_PREVIEW = "/worker [running] Working";
const AGENT_COLOR_DEFAULT = "__default__";
const AGENT_COLOR_CANCEL = Symbol("agent-color-cancel");

class AgentColorPickerComponent extends Container {
  private readonly items: { value: string; label: string; description?: string }[];
  private readonly preview: Text;
  private readonly theme: Theme;
  readonly selectList: SelectList;

  constructor(
    tui: { requestRender(force?: boolean): void },
    theme: Theme,
    currentColor: AgentType["color"] | undefined,
    onSelect: (color: AgentType["color"] | undefined) => void,
    onCancel: () => void,
  ) {
    super();
    this.theme = theme;
    this.items = [
      {
        value: AGENT_COLOR_DEFAULT,
        label: "Default (inherit)",
        description: "Use Pi default foreground color",
      },
      ...AGENT_COLORS.map((color) => ({
        value: color,
        label: theme.fg(color, `● ${color}`),
        description: `Pi semantic foreground color: ${color}`,
      })),
    ];
    this.preview = new Text();
    this.selectList = new SelectList(this.items, 10, getSelectListTheme(), {
      minPrimaryColumnWidth: 18,
      maxPrimaryColumnWidth: 28,
    });
    const selectedIndex = this.items.findIndex(
      (item) => item.value === (currentColor ?? AGENT_COLOR_DEFAULT),
    );
    this.selectList.setSelectedIndex(selectedIndex >= 0 ? selectedIndex : 0);
    this.selectList.onSelectionChange = (item) => {
      this.updatePreview(tui, item.value);
    };
    this.selectList.onSelect = (item) => {
      onSelect(item.value === AGENT_COLOR_DEFAULT ? undefined : (item.value as AgentType["color"]));
    };
    this.selectList.onCancel = onCancel;
    this.addChild(new DynamicBorder((text) => theme.fg("muted", text)));
    this.updatePreview(tui, this.items[selectedIndex >= 0 ? selectedIndex : 0]!.value);
    this.addChild(this.preview);
    this.addChild(this.selectList);
    this.addChild(new DynamicBorder((text) => theme.fg("muted", text)));
  }

  getItems(): readonly { value: string; label: string; description?: string }[] {
    return this.items;
  }

  getPreview(): Text {
    return this.preview;
  }

  getSelectList(): SelectList {
    return this.selectList;
  }

  handleInput(keyData: string): void {
    this.selectList.handleInput(keyData);
  }

  private updatePreview(tui: { requestRender(force?: boolean): void }, value: string): void {
    const preview =
      value === AGENT_COLOR_DEFAULT
        ? `Preview: ${AGENT_COLOR_PREVIEW}`
        : this.theme.fg(value as ThemeColor, `Preview: ${AGENT_COLOR_PREVIEW}`);
    this.preview.setText(preview);
    tui.requestRender();
  }
}

async function selectAgentColor(
  ctx: ExtensionCommandContext,
  currentColor: AgentType["color"] | undefined,
): Promise<AgentType["color"] | undefined | typeof AGENT_COLOR_CANCEL> {
  return ctx.ui.custom(
    (tui, theme, _keys, done) => {
      return new AgentColorPickerComponent(
        tui,
        theme,
        currentColor,
        (value) => done(value),
        () => done(AGENT_COLOR_CANCEL),
      );
    },
    { overlay: true },
  );
}

async function editDocument(
  ctx: ExtensionCommandContext,
  type: AgentType,
  external: boolean,
): Promise<AgentType | undefined> {
  const original = serializeAgentType(type);
  let text = original;
  while (true) {
    try {
      if (external) {
        text = await externalEdit(ctx, text);
      } else {
        const end = text.indexOf("\n---", 4);
        const yaml = await ctx.ui.editor(
          "Agent frontmatter YAML (Markdown body preserved)",
          text.slice(4, end),
        );
        if (yaml === undefined) return;
        text = `---\n${yaml.replace(/\n?$/, "\n")}---\n${type.systemPrompt}`;
      }
      return {
        ...parseAgentType(text),
        filePath: type.filePath,
        source: type.source,
      };
    } catch (error) {
      const diagnostic = sanitizeText(error instanceof Error ? error.message : String(error));
      ctx.ui.notify(`Edit not accepted: ${diagnostic}. Original definition is unchanged.`, "error");
      if (
        !(await ctx.ui.confirm(
          "Invalid edit — retry?",
          `${diagnostic}\nRetry editing, or cancel to restore the previous definition.`,
        ))
      )
        return;
    }
  }
}

/** Avoid treating a renamed definition as permission to overwrite another file. */
function assertSaveDestination(
  store: ConfigStore,
  type: AgentType,
  original: AgentType | undefined,
  scope: "user" | "project",
): void {
  const entries = store.list();
  const sameName = entries.find((entry) => entry.name === type.name);
  if (sameName && (!original || type.name !== original.name)) {
    throw new Error(`Agent type ${type.name} already exists; choose a different name.`);
  }
  const destination = store.destination(type.name, scope, original);
  if (
    existsSync(destination) &&
    (!original?.filePath || resolve(original.filePath) !== destination)
  ) {
    throw new Error(
      `Refusing to overwrite existing definition ${destination}. Edit that definition instead.`,
    );
  }
}

const EDIT_MENU_ACTIONS = [
  "name",
  "description",
  "models",
  "thinkingLevel",
  "tools.allow",
  "tools.block",
  "color",
  "Edit frontmatter YAML",
  "External editor (entire Markdown)",
  "Save",
  "Cancel",
] as const;

type EditMenuAction = (typeof EDIT_MENU_ACTIONS)[number];

/** Omitted tool lists use the default policy; [] is an explicit empty list, not inheritance. */
function toolListMenuValue(names: string[] | undefined): string {
  if (names === undefined) return "Unset (use default policy)";
  if (names.length === 0) return "Empty list";
  return names.join(", ");
}

function editMenuLabel(action: EditMenuAction, draft: AgentType): string {
  switch (action) {
    case "name":
      return `name: ${sanitizeText(draft.name)}`;
    case "description":
      return `description: ${sanitizeText(draft.description)}`;
    case "models": {
      const models = getModelPreferences(draft);
      return `models: ${sanitizeText(models?.join(", ") ?? "Default (inherit)")}`;
    }
    case "thinkingLevel":
      return `thinkingLevel: ${sanitizeText(draft.thinkingLevel ?? "Default (inherit)")}`;
    case "tools.allow":
      return `tools.allow: ${sanitizeText(toolListMenuValue(draft.tools?.allow))}`;
    case "tools.block":
      return `tools.block: ${sanitizeText(toolListMenuValue(draft.tools?.block))}`;
    case "color":
      return `color: ${sanitizeText(draft.color ?? "Default (inherit)")}`;
    default:
      return action;
  }
}

export async function editAgentTypes(
  ctx: ExtensionCommandContext,
  store: ConfigStore,
): Promise<void> {
  if (!ctx.hasUI) return;
  while (true) {
    const types = store.list();
    const names = types.map((type) => type.name);
    const selection = await ctx.ui.select("Agent types", ["Create new type", ...names]);
    if (selection === undefined) return;
    const original = selection === "Create new type" ? undefined : store.get(selection);
    let draft: AgentType = original
      ? structuredClone(original)
      : { name: "new-agent", description: "New agent", systemPrompt: "" };
    while (true) {
      const labels = EDIT_MENU_ACTIONS.map((action) => editMenuLabel(action, draft));
      const selected = await ctx.ui.select(`Edit ${sanitizeText(draft.name)} (unsaved)`, labels);
      if (selected === undefined) break;
      const field = EDIT_MENU_ACTIONS[labels.indexOf(selected)];
      if (!field || field === "Cancel") break;
      try {
        if (field === "Save") {
          // Round-trip before saving: no partial or invalid configuration is accepted.
          const validated = parseAgentType(serializeAgentType(draft));
          const scopeChoice = await ctx.ui.select(
            "Save scope",
            store.canSaveProject() ? ["Global", "Trusted project"] : ["Global"],
          );
          if (!scopeChoice) continue;
          const scope = scopeChoice === "Global" ? "user" : "project";
          assertSaveDestination(store, validated, original, scope);
          const saved = store.save(validated, scope, original);
          ctx.ui.notify(
            `Saved ${sanitizeText(saved.filePath ?? saved.name)}${original && original.name !== saved.name ? " (original file retained)" : ""}.`,
            "info",
          );
          break;
        }
        if (field === "External editor (entire Markdown)" || field === "Edit frontmatter YAML") {
          const edited = await editDocument(
            ctx,
            draft,
            field === "External editor (entire Markdown)",
          );
          if (edited) draft = edited;
          continue;
        }
        const candidate = structuredClone(draft);
        if (field === "name" || field === "description") {
          const originalValue = candidate[field] ?? "";
          // Editor prefill must not carry terminal controls. An unmodified or
          // SDK-trimmed submit keeps the original, including whitespace and CRLF.
          const prefill = originalValue
            .replace(/\r\n/g, "\n")
            .replace(/\r/g, "\n")
            .split("\n")
            .map(sanitizeText)
            .join("\n");
          const value = await ctx.ui.editor(`Agent ${field}`, prefill);
          if (value === undefined) continue;
          candidate[field] = value === prefill || value === prefill.trim() ? originalValue : value;
        } else if (field === "models") {
          const value = await editModelPreferences(ctx, getModelPreferences(candidate));
          if (value === MODEL_EDITOR_CANCEL) continue;
          if (value.length === 0) {
            delete candidate.models;
            delete candidate.model;
          } else {
            candidate.models = [...value];
            delete candidate.model;
          }
        } else if (field === "thinkingLevel") {
          const value = await ctx.ui.select("Thinking level", [
            "Default (inherit)",
            ...THINKING_LEVELS,
          ]);
          if (!value) continue;
          if (value === "Default (inherit)") delete candidate.thinkingLevel;
          else candidate.thinkingLevel = value as AgentType["thinkingLevel"];
        } else if (field === "color") {
          const value = await selectAgentColor(ctx, candidate.color);
          if (value === AGENT_COLOR_CANCEL) continue;
          if (value === undefined) delete candidate.color;
          else candidate.color = value;
        } else if (field === "tools.allow" || field === "tools.block") {
          await editToolList(ctx, candidate, field === "tools.allow" ? "allow" : "block");
        }
        parseAgentType(serializeAgentType(candidate));
        draft = candidate;
      } catch (error) {
        ctx.ui.notify(
          sanitizeText(error instanceof Error ? error.message : String(error)),
          "error",
        );
      }
    }
  }
}
