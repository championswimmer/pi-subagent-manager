import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ConfigStore } from "../prefs/config.ts";
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
  type ModelSelectionMode,
  type SubagentMode,
  type ToolFilteringMode,
  type WidgetMode,
} from "../prefs/settings.ts";
import { editAgentTypes } from "./ui.ts";

const FIELDS = [
  {
    id: "maxLevels",
    label: "Maximum levels",
    help: "How deep agents can delegate.\nYour main conversation is level 1; 3 allows an agent and its child.\nPositive integer, at most 32.",
  },
  {
    id: "maxConcurrent",
    label: "Concurrent agents",
    help: "How many agents can be active at once across all levels.\nParents waiting for children also count.\nPositive safe integer.",
  },
  {
    id: "maxThreads",
    label: "Retained threads",
    help: "How many agent sessions can be kept for follow-up work, including completed and paused agents.\nAt the limit, new agents cannot start.\nPositive safe integer.",
  },
] as const;

const MODE_OPTIONS = [
  {
    id: "off",
    label: "Off",
    value: "No subagent tools or prompt guidance",
    help: "Off: hide subagent tools and inject no subagent guidance into the system prompt.\nExisting work and retained sessions are kept.",
  },
  {
    id: "opportunistic",
    label: "Opportunistic",
    value: "Parallelizable or very large tasks only",
    help: "Opportunistic: make subagent tools available.\nDelegate only when tasks can be parallelized or a task is very large; otherwise work directly.",
  },
  {
    id: "orchestration",
    label: "Orchestration",
    value: "/root coordinates; subagents execute",
    help: "Orchestration: tell /root to delegate all task execution to subagents and only coordinate and synthesize results.\nThis rule is not inherited by workers.",
  },
] as const;

const MODE_HELP =
  "Off: no subagent tools or prompt guidance.\nOpportunistic: delegate only parallelizable or very large tasks.\nOrchestration: /root delegates all execution and only coordinates and synthesizes results.";

const TOOL_FILTERING_OPTIONS = [
  {
    id: "allowed",
    label: "Allowed (except blocked)",
    value: "Allow list minus block list",
    help: "Only tools in the agent YAML allow list are available, minus its block list.\nBlocked tools take precedence. A missing or empty allow list means no tools.",
  },
  {
    id: "all-except-blocked",
    label: "All except blocked",
    value: "Ignore allow list",
    help: "All available tools except those in the agent YAML block list.\nThe allow list is completely ignored.",
  },
  {
    id: "all",
    label: "All",
    value: "Ignore both lists",
    help: "All available tools.\nThe agent YAML allow and block lists are completely ignored.",
  },
] as const;

const TOOL_FILTERING_HELP =
  "Allowed (except blocked): only allow-listed tools, minus blocked tools; a missing or empty allow list means no tools.\nAll except blocked: ignore the allow list; block-listed tools remain blocked.\nAll: ignore both lists.\nSave and apply to affect agents when their sessions start.";

const WIDGET_MODE_OPTIONS = [
  {
    id: "full",
    label: "Full",
    value: "Detailed agent status rows",
    help: "Full: show the existing agent status widget above the input box, with per-agent details.",
  },
  {
    id: "minimal",
    label: "Minimal",
    value: "One-line counts and running-agent tokens",
    help: "Minimal: show status counts in one line above the input box.\nStarting agents count as running. Token totals include only active (starting/running) agents.",
  },
] as const;

const WIDGET_MODE_HELP =
  "Full: detailed agent status rows above the input box.\nMinimal: one-line status counts and cumulative input/output tokens for active (starting/running) agents.\nSave and apply to update the widget immediately.";

const MODEL_SELECTION_OPTIONS = [
  {
    id: "pick-first-available",
    label: "Pick First (available)",
    value: "First available model in the agent's list",
    help: "Pick First (available):\nPick the first model in the agent's models list available in Pi with an enabled, authenticated provider.\nSkip missing models and providers without credentials; try the next preference.",
  },
  {
    id: "pick-first-scoped",
    label: "Pick First (scoped)",
    value: "First available preference in the session scope",
    help: "Pick First (scoped):\nPick the first available model in the agent's models list that is also selected in the current session's /scoped-models.\nSkip unavailable models and providers without credentials.",
  },
  {
    id: "use-current",
    label: "Use Current",
    value: "Use the main session's current model",
    help: "Use Current:\nIgnore the agent's models list and use the main session's current model.\nKeep each agent's configured thinking level, not the main session's thinking level.",
  },
] as const;

const MODEL_SELECTION_HELP =
  "Pick First (available): first preference with an enabled, authenticated provider in Pi.\nPick First (scoped): same, limited to the current session's /scoped-models.\nUse Current: ignore models and use the main session's current model; keep the agent's thinking level.\nOnly the models list affects runtime picking; modelSuggestions are search hints.\nSave and apply to affect agents when their sessions start.";

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
        {
          id: "toolFiltering",
          label: "Tool Filtering",
          value: TOOL_FILTERING_OPTIONS.find((mode) => mode.id === draft.toolFiltering)!.label,
          help: TOOL_FILTERING_HELP,
        },
        ...FIELDS.map((field) => ({
          ...field,
          value: String(draft[field.id]),
        })),
        {
          id: "modelSelection",
          label: "Model Picking",
          value: MODEL_SELECTION_OPTIONS.find((mode) => mode.id === draft.modelSelection)!.label,
          help: MODEL_SELECTION_HELP,
        },
        {
          id: "widgetMode",
          label: "Status Widget",
          value: WIDGET_MODE_OPTIONS.find((mode) => mode.id === draft.widgetMode)!.label,
          help: WIDGET_MODE_HELP,
        },
        {
          id: "scope",
          label: "Save scope",
          value: scope === "user" ? "Global" : "Current Project",
          help: "Global: save all values shown as your defaults for every project. Existing project settings still override them, including here.\nCurrent Project: save all values shown for this project only, overriding your global defaults here. Other projects are unchanged. Requires a trusted project.\nSwitching scope only changes where you save, not the values shown.",
        },
        {
          id: "types",
          label: "Agent definitions",
          value: `${options.store.list().length} types`,
          help: "Create or edit agent definitions.\nConfigure model preferences and tool policy for each agent type.",
        },
        {
          id: "defaults",
          label: "Restore defaults",
          help: "Replace all values shown with built-in defaults.\nNothing is saved until you choose Save and apply.",
        },
        {
          id: "save",
          label: "Save and apply",
          value: dirty ? "(changes)" : undefined,
          valueColor: dirty ? "warning" as const : undefined,
          help: "Save all values to the selected scope and reload settings now.\nProject overrides still take precedence.\nRunning agents and retained sessions are kept.",
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
      } else if (action === "toolFiltering") {
        const mode = await dialogMenu(ctx, "Tool Filtering", [...TOOL_FILTERING_OPTIONS], {
          selectedId: draft.toolFiltering,
        });
        if (TOOL_FILTERING_OPTIONS.some((option) => option.id === mode))
          draft.toolFiltering = mode as ToolFilteringMode;
      } else if (action === "modelSelection") {
        const mode = await dialogMenu(ctx, "Model Picking", [...MODEL_SELECTION_OPTIONS], {
          selectedId: draft.modelSelection,
        });
        if (MODEL_SELECTION_OPTIONS.some((option) => option.id === mode))
          draft.modelSelection = mode as ModelSelectionMode;
      } else if (action === "widgetMode") {
        const mode = await dialogMenu(ctx, "Status Widget", [...WIDGET_MODE_OPTIONS], {
          selectedId: draft.widgetMode,
        });
        if (WIDGET_MODE_OPTIONS.some((option) => option.id === mode))
          draft.widgetMode = mode as WidgetMode;
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
