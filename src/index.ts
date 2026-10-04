import { randomUUID } from "node:crypto";
import { buildSessionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { ConfigStore } from "./prefs/config.ts";
import { IMPORT_REQUEST_PREFIX, markImportOffered, offerAgentImport } from "./prefs/agent-import.ts";
import { ThreadManager } from "./orch/manager.ts";
import { loadManagerSettings } from "./prefs/settings.ts";
import { configureAgents } from "./ui/settings-ui.ts";
import { AgentNavigationController, showAgentStatus } from "./ui/status-ui.ts";
import { AgentNavigationEditor } from "./ui/agent-navigation-editor.ts";
import { createDriverFactory } from "./orch/runtime.ts";
import { createInheritedToolSource } from "./orch/inherited-tools.ts";
import { subagentPrompt } from "./orch/prompt.ts";
import { agentTools } from "./orch/tools.ts";
import { editAgentTypes, updateWidget } from "./ui/ui.ts";
import type { SavedThread, ThreadEvent } from "./types.ts";

const REGISTRY_ENTRY = "pi-subagent:registry:v1";
const ROOT_MAILBOX_ENTRY = "pi-subagent:root-mailbox:v1";
type RootNotification = {
  rootSessionId: string;
  content: string;
  details: { mailboxId: string; path: string; state: string };
};

export default function piSubagent(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  const inheritedTools = createInheritedToolSource(pi);
  let store = new ConfigStore({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    includeProject: false,
  });
  let manager: ThreadManager | undefined;
  let limits = loadManagerSettings({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    includeProject: false,
  }).settings;
  const loadLimits = (ctx: ExtensionContext) => {
    const loaded = loadManagerSettings({
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      includeProject: ctx.isProjectTrusted(),
    });
    limits = loaded.settings;
    return loaded.diagnostics;
  };
  let generation = 0;
  let navigation = new AgentNavigationController();
  let navigationEditor: AgentNavigationEditor | undefined;
  let navigationEditorFactory: Parameters<ExtensionContext["ui"]["setEditorComponent"]>[0];
  let navigationGeneration = 0;
  const closeNavigation = (disposeEditor = false) => {
    navigationGeneration++;
    navigation.close();
    if (disposeEditor) {
      navigationEditor?.dispose();
      navigationEditor = undefined;
    }
  };
  const installNavigationEditor = (ctx: ExtensionContext, seedHistory: boolean) => {
    // Pi has one custom-editor slot: integrations owning it can opt out explicitly.
    if (!ctx.hasUI || ctx.mode !== "tui" || !ctx.ui.setEditorComponent ||
      process.env.PI_SUBAGENT_NAVIGATION_EDITOR !== "1") return;
    const existingFactory = ctx.ui.getEditorComponent?.();
    if (existingFactory && existingFactory !== navigationEditorFactory) return;
    // The host only transfers raw text, not cursor/undo/expanded-paste state.
    if (ctx.ui.getEditorText?.()) return;
    const history = buildSessionContext(ctx.sessionManager.getBranch()).messages.flatMap((message) => {
      if (message.role !== "user") return [];
      const content = message.content;
      return [typeof content === "string" ? content : content
        .filter((block) => block.type === "text").map((block) => block.text).join("")];
    });
    navigationEditorFactory = (tui, theme, keys) => {
      const editor = new AgentNavigationEditor(tui, theme, keys, {
        // Initial startup hydrates after session_start; replacement editors do not.
        initialHistory: seedHistory ? history : undefined,
        generation: () => navigationGeneration,
        canOpen: () => manager !== undefined && context?.mode === "tui" &&
          limits.subagentMode !== "off" && !navigation.isOpen,
        openTree: () => manager && context
          ? navigation.open(context, manager.scope("/root")) : undefined,
        onError: (error) => context?.ui.notify(
          error instanceof Error ? error.message : String(error), "error"),
      });
      navigationEditor = editor;
      return editor;
    };
    ctx.ui.setEditorComponent(navigationEditorFactory);
  };
  let persistenceSignature = "";
  let migrationRequested = false;
  let importInProgress = false;
  const importAgents = async (ctx: ExtensionContext, firstRun: boolean) => {
    // Migration requires the root's file tools and must not delegate source prompts.
    if (limits.subagentMode === "orchestration") {
      if (!firstRun)
        ctx.ui.notify("Agent import requires Opportunistic mode. Change Subagent Mode in /agents settings.", "info");
      return;
    }
    if (importInProgress) return;
    importInProgress = true;
    try {
      migrationRequested =
        (await offerAgentImport(pi, ctx, {
          agentDir: getAgentDir(),
          store,
          firstRun,
        })) || migrationRequested;
    } finally {
      importInProgress = false;
    }
  };
  // A migration can span clarification turns. Reload after each root turn, without converting files.
  pi.on("agent_end", async () => {
    if (limits.subagentMode === "off" || !migrationRequested) return;
    store.reload();
    if (store.diagnostics.length) context?.ui.notify(store.diagnostics.join("\n"), "warning");
  });
  const requireManager = () => {
    if (!manager) throw new Error("Subagent threads are not initialized; start a Pi session first");
    return manager;
  };
  const requireContext = () => {
    if (!context) throw new Error("No active Pi session");
    return context;
  };
  const persist = () => {
    if (!manager) return;
    const threads = manager.saved();
    const signature = JSON.stringify(threads);
    if (signature !== persistenceSignature) {
      pi.appendEntry(REGISTRY_ENTRY, {
        version: 1,
        rootSessionId: requireContext().sessionManager.getSessionId(),
        threads,
      });
      persistenceSignature = signature;
    }
  };
  const warnDelivery = (error: unknown) => {
    if (limits.subagentMode === "off") return;
    const message = error instanceof Error ? error.message : String(error);
    context?.ui.notify(`Subagent delivery failed: ${message}`, "warning");
  };
  const sendRootNotification = (notification: RootNotification) => {
    if (limits.subagentMode === "off" || context?.isIdle?.() === false) return;
    // Never submit to Pi's streaming queue: off must also suppress pending delivery.
    pi.sendMessage(
      {
        customType: "pi-subagent:update",
        content: notification.content,
        display: true,
        details: notification.details,
      },
      { triggerTurn: false },
    );
  };
  const restoreRootMailbox = (ctx: ExtensionContext) => {
    if (limits.subagentMode === "off" || ctx.isIdle?.() === false) return;
    const entries = ctx.sessionManager.getBranch();
    const delivered = new Set(
      entries.flatMap((entry) => {
        if (entry.type !== "custom_message" || entry.customType !== "pi-subagent:update") return [];
        const id = (entry.details as { mailboxId?: unknown } | undefined)?.mailboxId;
        return typeof id === "string" ? [id] : [];
      }),
    );
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== ROOT_MAILBOX_ENTRY) continue;
      const notification = entry.data as RootNotification | undefined;
      if (
        notification?.rootSessionId === ctx.sessionManager.getSessionId() &&
        typeof notification.content === "string" &&
        typeof notification.details?.mailboxId === "string" &&
        !delivered.has(notification.details.mailboxId)
      ) {
        sendRootNotification(notification);
        delivered.add(notification.details.mailboxId);
      }
    }
  };
  pi.on("agent_settled", async (_event, ctx) => {
    if (context?.sessionManager === ctx.sessionManager) restoreRootMailbox(ctx);
  });
  const delivery = (event: ThreadEvent) => {
    if (event.kind === "change" || event.kind === "metrics") return;
    const thread = event.thread;
    const message =
      event.kind === "update"
        ? `Progress from ${thread.path}: ${event.message}`
        : thread.state === "completed"
          ? `Agent ${thread.path} completed. Final answer:\n${thread.output?.slice(0, 16000) ?? "(no text)"}${(thread.output?.length ?? 0) > 16000 ? "\n[Output truncated; use agent_output for more.]" : ""}`
          : `Agent ${thread.path} is ${thread.state}: ${thread.status}. ${thread.state === "paused" ? "No answer handback; send input to resume the same session." : "Session retained for further input."}`;
    try {
      if (event.recipient === "/root") {
        const notification: RootNotification = {
          rootSessionId: requireContext().sessionManager.getSessionId(),
          content: message,
          details: {
            mailboxId: randomUUID(),
            path: thread.path,
            state: thread.state,
          },
        };
        // Persist first; defer delivery until the root is idle and the plugin is enabled.
        // The eventual transcript message carries its ID for branch-local recovery.
        pi.appendEntry(ROOT_MAILBOX_ENTRY, notification);
        sendRootNotification(notification);
      } else void requireManager().deliver(event.recipient, message).catch(warnDelivery);
    } catch (error) {
      warnDelivery(error);
    }
  };

  const rootTools = agentTools(requireManager, "/root", () => store.list());
  let toolsEnabled: boolean | undefined;
  const syncTools = () => {
    const enabled = limits.subagentMode !== "off";
    if (toolsEnabled === enabled) return;
    toolsEnabled = enabled;
    for (const tool of rootTools) {
      pi.registerTool({
        ...tool,
        // Hidden tools are neither model-visible nor discoverable/callable via codemode.
        exposure: enabled ? "direct" : "hidden",
        prepareLoadout: inheritedTools.captureLoadout,
        execute: (...args) => {
          if (limits.subagentMode === "off") throw new Error("Subagent Mode is off");
          inheritedTools.captureContext(args[4]);
          return tool.execute(...args);
        },
      });
    }
  };
  const refreshWidget = (ctx: ExtensionContext) => {
    if (limits.subagentMode === "off") {
      if (ctx.hasUI) ctx.ui.setWidget("pi-subagent", undefined);
    } else updateWidget(ctx, requireManager().list());
  };
  syncTools();
  pi.on("before_agent_start", async (event, ctx) => {
    const prompt = subagentPrompt(limits);
    if (!prompt) return;
    if (limits.subagentMode === "opportunistic" && event.prompt.startsWith(IMPORT_REQUEST_PREFIX)) {
      try {
        markImportOffered(getAgentDir());
      } catch (error) {
        ctx.ui.notify(`Could not save import onboarding state: ${String(error)}`, "warning");
      }
    }
    return {
      systemPrompt: `${event.systemPrompt}\n\n${prompt}`,
    };
  });

  const attachSession = async (ctx: ExtensionContext, installEditor = false, seedHistory = true) => {
    const token = ++generation;
    closeNavigation(installEditor);
    navigation = new AgentNavigationController();
    // session_start already belongs to the replacement session: never append the old registry here.
    if (manager) await manager.shutdown();
    inheritedTools.reset();
    context = ctx;
    store = new ConfigStore({
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      includeProject: ctx.isProjectTrusted(),
    });
    persistenceSignature = "";
    const settingsDiagnostics = loadLimits(ctx);
    syncTools();
    const instance = new ThreadManager({
      ...limits,
      createDriver: createDriverFactory(
        requireContext,
        () => limits.modelSelection,
        () => limits.toolFiltering,
        () => inheritedTools.snapshot(),
      ),
      rootSnapshot: () => buildSessionContext(requireContext().sessionManager.getBranch()).messages,
      getType: (name) => store.get(name),
      toolsFor: (path) => agentTools(requireManager, path, () => store.list()),
      onEvent: (event) => {
        if (token !== generation) return;
        refreshWidget(requireContext());
        if (event.kind !== "metrics") persist();
        delivery(event);
      },
    });
    manager = instance;
    if (installEditor) installNavigationEditor(ctx, seedHistory);
    const entries = ctx.sessionManager.getBranch();
    const entry = [...entries]
      .reverse()
      .find((item) => item.type === "custom" && item.customType === REGISTRY_ENTRY);
    if (entry?.type === "custom") {
      try {
        const data = entry.data as {
          version: number;
          rootSessionId: string;
          threads: SavedThread[];
        };
        if (data.version !== 1 || !Array.isArray(data.threads))
          throw new Error("Invalid registry format");
        // Forked parents own a new registry; they must not share writable child transcripts.
        if (data.rootSessionId === ctx.sessionManager.getSessionId())
          instance.restore(data.threads);
        else persist();
      } catch (error) {
        if (limits.subagentMode !== "off")
          ctx.ui.notify(`Could not restore subagent registry: ${String(error)}`, "error");
      }
    }
    restoreRootMailbox(ctx);
    refreshWidget(ctx);
    const diagnostics = [...store.diagnostics, ...settingsDiagnostics];
    if (limits.subagentMode !== "off" && diagnostics.length)
      ctx.ui.notify(diagnostics.join("\n"), "warning");
  };
  pi.on("session_start", async (event, ctx) => {
    await attachSession(ctx, true, event.reason !== "startup");
    if (limits.subagentMode !== "off") await importAgents(ctx, true);
  });
  pi.on("session_tree", async (_event, ctx) => attachSession(ctx));
  const stopWorkingThreads = async () => {
    closeNavigation();
    if (!manager) return;
    for (const thread of manager.list()) {
      const state = manager.get(thread.path).state;
      if (state === "starting" || state === "running") await manager.stop("/root", thread.path);
    }
  };
  // Finish old-thread cancellation while appendEntry still points to the old branch/session.
  pi.on("session_before_tree", stopWorkingThreads);
  pi.on("session_before_switch", stopWorkingThreads);
  pi.on("session_before_fork", stopWorkingThreads);
  pi.on("session_shutdown", async () => {
    generation++;
    closeNavigation(true);
    await manager?.shutdown();
    persist();
    if (context?.hasUI) context.ui.setWidget("pi-subagent", undefined);
    manager = undefined;
    context = undefined;
  });
  const agentSubcommands = ["tree", "status", "settings", "types", "import", "reload"] as const;
  pi.registerCommand("agents", {
    description: "Configure agent settings, import/edit definitions, or show the live tree",
    getArgumentCompletions: (argumentText) => {
      const text = argumentText.trimStart();
      const completed = text.match(/^(\S+)(\s+)([\s\S]*)$/);
      if (completed) {
        const command = completed[1]!.toLowerCase();
        if (command === "tree") {
          const paths = (manager?.list() ?? [])
            .map((thread) => thread.path)
            .filter((path) => path !== "/root");
          const matched = fuzzyFilter(paths, completed[3]!.trimStart(), (path) => path);
          if (matched.length === 0) return null;
          return matched.map((path) => ({ value: `tree ${path}`, label: path }));
        }
        if ((agentSubcommands as readonly string[]).includes(command)) return null;
      }
      const matched = fuzzyFilter([...agentSubcommands], text, (name) => name);
      if (matched.length === 0) return null;
      return matched.map((value) => ({ value, label: value }));
    },
    handler: async (args, ctx) => {
      const [command, ...rest] = args.trim().split(/\s+/);
      if (command === "import") {
        await importAgents(ctx, false);
      } else if (command === "types") {
        await editAgentTypes(ctx, store);
        store.reload();
      } else if (command === "reload") {
        store.reload();
        const diagnostics = [...store.diagnostics, ...loadLimits(ctx)];
        requireManager().setLimits(limits);
        syncTools();
        refreshWidget(ctx);
        restoreRootMailbox(ctx);
        ctx.ui.notify(
          diagnostics.length
            ? diagnostics.join("\n")
            : `Loaded ${store.list().length} agent types; maximum ${limits.maxLevels} levels`,
          diagnostics.length ? "warning" : "info",
        );
      } else if (!command || command === "settings") {
        await configureAgents(ctx, {
          store,
          settings: limits,
          agentDir: getAgentDir(),
          apply: () => {
            const diagnostics = loadLimits(ctx);
            requireManager().setLimits(limits);
            syncTools();
            refreshWidget(ctx);
            restoreRootMailbox(ctx);
            if (diagnostics.length) ctx.ui.notify(diagnostics.join("\n"), "warning");
          },
        });
      } else if (command === "status") {
        await showAgentStatus(ctx, requireManager().scope("/root"));
      } else if (command === "tree") {
        await navigation.open(ctx, requireManager().scope("/root"), rest.join(" ") || undefined);
      } else
        ctx.ui.notify(
          "Usage: /agents [tree [path] | status | settings | types | import | reload]",
          "warning",
        );
    },
  });
}
