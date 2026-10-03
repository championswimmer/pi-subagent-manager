import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ConfigStore } from "./config.ts";
import {
  canOpenDialog,
  dialogInput,
  dialogMenu,
  withDialogSession,
} from "./dialog.ts";
import {
  DEFAULT_MANAGER_SETTINGS,
  saveManagerSettings,
  type ManagerSettings,
  type SubagentMode,
} from "./settings.ts";
import { editAgentTypes } from "./ui.ts";

const FIELDS = [
  {
    id: "maxLevels",
    label: "Maximum levels",
    help: "How deep agents can delegate. Your main conversation is level 1; 3 allows an agent and its child. Positive integer, at most 32.",
  },
  {
    id: "maxConcurrent",
    label: "Concurrent agents",
    help: "How many agents can be active at once across all levels. Parents waiting for children also count. Positive safe integer.",
  },
  {
    id: "maxThreads",
    label: "Retained threads",
    help: "How many agent sessions can be kept for follow-up work, including completed and paused agents. At the limit, new agents cannot start. Positive safe integer.",
  },
] as const;

const MODE_OPTIONS = [
  {
    id: "off",
    label: "Off",
    value: "No subagent tools or prompt guidance",
    help: "Off: hide subagent tools and inject no subagent guidance into the system prompt. Existing work and retained sessions are kept.",
  },
  {
    id: "opportunistic",
    label: "Opportunistic",
    value: "Parallelizable or very large tasks only",
    help: "Opportunistic: make subagent tools available. Delegate only when tasks can be parallelized or a task is very large; otherwise work directly.",
  },
  {
    id: "orchestration",
    label: "Orchestration",
    value: "/root coordinates; subagents execute",
    help: "Orchestration: tell /root to delegate all task execution to subagents and only coordinate and synthesize results. This rule is not inherited by workers.",
  },
] as const;

const MODE_HELP =
  "Off: no subagent tools or prompt guidance. Opportunistic: delegate only parallelizable or very large tasks. Orchestration: /root delegates all execution and only coordinates and synthesizes results.";

const SCOPED_MODEL_FILTERING = {
  id: "scopedModelFiltering",
  label: "Scoped model filtering",
  help: "On: agents can use only models selected in /scoped-models. Off: agents can use any available model. Save and apply to activate changes.",
} as const;

export async function configureAgents(
  ctx: ExtensionCommandContext,
  options: {
    store: ConfigStore;
    settings: ManagerSettings;
    agentDir: string;
    apply(): void;
  },
): Promise<void> {
  if (!canOpenDialog(ctx)) return;
  await withDialogSession(ctx, (scoped) =>
    configureAgentsDialog(scoped, options),
  );
}

async function configureAgentsDialog(
  ctx: ExtensionCommandContext,
  options: {
    store: ConfigStore;
    settings: ManagerSettings;
    agentDir: string;
    apply(): void;
  },
): Promise<void> {
  let draft = { ...options.settings };
  let scope: "user" | "project" = ctx.isProjectTrusted() ? "project" : "user";
  let selectedId: string | undefined;
  while (true) {
    const dirty = JSON.stringify(draft) !== JSON.stringify(options.settings);
    const action = await dialogMenu(
      ctx,
      `Agents settings${dirty ? " · unsaved" : ""}`,
      [
        {
          id: "subagentMode",
          label: "Subagent Mode",
          value: MODE_OPTIONS.find((mode) => mode.id === draft.subagentMode)!.label,
          help: MODE_HELP,
        },
        ...FIELDS.map((field) => ({
          ...field,
          value: String(draft[field.id]),
        })),
        {
          id: SCOPED_MODEL_FILTERING.id,
          label: SCOPED_MODEL_FILTERING.label,
          value: draft.scopedModelFiltering ? "on" : "off",
          help: SCOPED_MODEL_FILTERING.help,
        },
        {
          id: "scope",
          label: "Save scope",
          value: scope === "user" ? "Global" : "Trusted project",
          help: scope === "user"
            ? "Global: save all values shown as your defaults for every project. Existing trusted-project settings still override them, including here. Switching scope only changes where you save, not the values shown."
            : "Trusted project: save all values shown for this project only, overriding your global defaults here. Other projects are unchanged. Switching scope only changes where you save, not the values shown.",
        },
        {
          id: "types",
          label: "Agent definitions",
          value: `${options.store.list().length} types`,
          help: "Create or edit agent definitions, model preferences and tool policy.",
        },
        {
          id: "defaults",
          label: "Restore defaults",
          help: "Replace all values shown with built-in defaults. Nothing is saved until you choose Save and apply.",
        },
        {
          id: "save",
          label: "Save and apply",
          labelPrefix: dirty ? { text: "(changes)", color: "warning" as const } : undefined,
          help: "Save all values to the selected scope and reload settings now. Project overrides still take precedence. Running agents and retained sessions are kept.",
        },
        {
          id: "cancel",
          label: "Cancel",
          help: "Close without saving manager settings.",
        },
      ],
      {
        selectedId,
        saveId: "save",
        footer: "↑↓/Tab navigate · Enter edit · Ctrl+S save · Esc cancel",
      },
    );
    if (!action || action === "cancel") return;
    selectedId = action;
    try {
      const field = FIELDS.find((field) => field.id === action);
      if (field) {
        const value = await dialogInput(
          ctx,
          field.label,
          String(draft[field.id]),
          field.help,
        );
        if (value === undefined) continue;
        const number = Number(value.trim());
        if (
          !/^\d+$/.test(value.trim()) ||
          !Number.isSafeInteger(number) ||
          number < 1 ||
          (field.id === "maxLevels" && number > 32)
        )
          throw new Error(field.help);
        draft[field.id] = number;
      } else if (action === "subagentMode") {
        const mode = await dialogMenu(ctx, "Subagent Mode", [...MODE_OPTIONS], {
          selectedId: draft.subagentMode,
        });
        if (MODE_OPTIONS.some((option) => option.id === mode))
          draft.subagentMode = mode as SubagentMode;
      } else if (action === "scopedModelFiltering") {
        draft.scopedModelFiltering = !draft.scopedModelFiltering;
      } else if (action === "scope") {
        if (!ctx.isProjectTrusted())
          ctx.ui.notify(
            "Project settings require a trusted project; saving globally.",
            "warning",
          );
        else scope = scope === "user" ? "project" : "user";
      } else if (action === "defaults") draft = { ...DEFAULT_MANAGER_SETTINGS };
      else if (action === "types") {
        await editAgentTypes(ctx, options.store);
        options.store.reload();
      } else if (action === "save") {
        const file = saveManagerSettings({
          cwd: ctx.cwd,
          agentDir: options.agentDir,
          includeProject: ctx.isProjectTrusted(),
          scope,
          settings: draft,
        });
        options.apply();
        ctx.ui.notify(
          `Saved ${file}. Settings reloaded; project overrides take precedence.`,
          "info",
        );
        return;
      }
    } catch (error) {
      ctx.ui.notify(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    }
  }
}
