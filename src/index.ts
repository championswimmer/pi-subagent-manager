import { randomUUID } from "node:crypto";
import { buildSessionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ConfigStore } from "./config.ts";
import { ThreadManager } from "./manager.ts";
import { DEFAULT_MANAGER_SETTINGS, loadManagerSettings } from "./settings.ts";
import { createDriverFactory } from "./runtime.ts";
import { agentTools } from "./tools.ts";
import { editAgentTypes, showThreads, updateWidget } from "./ui.ts";
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
  let store = new ConfigStore({
    cwd: process.cwd(),
    agentDir: getAgentDir(),
    includeProject: false,
  });
  let manager: ThreadManager | undefined;
  let limits = { ...DEFAULT_MANAGER_SETTINGS };
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
  let persistenceSignature = "";
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
    const message = error instanceof Error ? error.message : String(error);
    context?.ui.notify(`Subagent delivery failed: ${message}`, "warning");
  };
  const sendRootNotification = (notification: RootNotification) =>
    pi.sendMessage(
      {
        customType: "pi-subagent:update",
        content: notification.content,
        display: true,
        details: notification.details,
      },
      { triggerTurn: false },
    );
  const restoreRootMailbox = (ctx: ExtensionContext) => {
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
          details: { mailboxId: randomUUID(), path: thread.path, state: thread.state },
        };
        // Root sendMessage can defer while streaming too. Accept durably before queueing;
        // the eventual transcript message carries its ID for branch-local recovery.
        pi.appendEntry(ROOT_MAILBOX_ENTRY, notification);
        sendRootNotification(notification);
      } else void requireManager().deliver(event.recipient, message).catch(warnDelivery);
    } catch (error) {
      warnDelivery(error);
    }
  };

  for (const tool of agentTools(requireManager, "/root", () => store.list())) pi.registerTool(tool);
  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\n## pi-subagent\nYou are /root. Thread paths determine context ancestry, independently of agent type. Name children with concise task-based kebab-case paths (e.g. /root/controller-security-research), not their type name. Children can pause WITHOUT handing back an answer; completed and paused sessions can both receive more work via agent_steer. Working child threads appear above the footer. The main conversation is L1; the maximum is ${limits.maxLevels} levels including L1. For independent work, spawn all siblings with wait:false before calling agent_wait; the same pattern applies inside child agents that have delegation tools. Waiting parents count toward the shared ${limits.maxConcurrent}-thread concurrency limit. Available types:\n${store
      .list()
      .map((type) => `- ${type.name}: ${type.description}`)
      .join(
        "\n",
      )}\nUse agent_status to inspect and agent_wait to wait. Detached notifications do not automatically resume your turn.`,
  }));

  const attachSession = async (ctx: ExtensionContext) => {
    const token = ++generation;
    // session_start already belongs to the replacement session: never append the old registry here.
    if (manager) await manager.shutdown();
    context = ctx;
    store = new ConfigStore({
      cwd: ctx.cwd,
      agentDir: getAgentDir(),
      includeProject: ctx.isProjectTrusted(),
    });
    persistenceSignature = "";
    const settingsDiagnostics = loadLimits(ctx);
    const instance = new ThreadManager({
      ...limits,
      createDriver: createDriverFactory(requireContext),
      rootSnapshot: () => buildSessionContext(requireContext().sessionManager.getBranch()).messages,
      getType: (name) => store.get(name),
      toolsFor: (path) => agentTools(requireManager, path, () => store.list()),
      onEvent: (event) => {
        if (token !== generation) return;
        updateWidget(requireContext(), requireManager().list());
        if (event.kind !== "metrics") persist();
        delivery(event);
      },
    });
    manager = instance;
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
        ctx.ui.notify(`Could not restore subagent registry: ${String(error)}`, "error");
      }
    }
    restoreRootMailbox(ctx);
    updateWidget(ctx, requireManager().list());
    const diagnostics = [...store.diagnostics, ...settingsDiagnostics];
    if (diagnostics.length) ctx.ui.notify(diagnostics.join("\n"), "warning");
  };
  pi.on("session_start", async (_event, ctx) => attachSession(ctx));
  pi.on("session_tree", async (_event, ctx) => attachSession(ctx));
  const stopWorkingThreads = async () => {
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
    await manager?.shutdown();
    persist();
    if (context?.hasUI) context.ui.setWidget("pi-subagent", undefined);
    manager = undefined;
    context = undefined;
  });
  pi.registerCommand("agents", {
    description: "Inspect/resume retained threads, edit agent types or reload configuration",
    getArgumentCompletions: (prefix) =>
      ["types", "reload", "thread"]
        .filter((value) => value.startsWith(prefix))
        .map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const [command, ...rest] = args.trim().split(/\s+/);
      if (command === "types") {
        await editAgentTypes(ctx, store);
        store.reload();
      } else if (command === "reload") {
        store.reload();
        const diagnostics = [...store.diagnostics, ...loadLimits(ctx)];
        requireManager().setLimits(limits);
        ctx.ui.notify(
          diagnostics.length
            ? diagnostics.join("\n")
            : `Loaded ${store.list().length} agent types; maximum ${limits.maxLevels} levels`,
          diagnostics.length ? "warning" : "info",
        );
      } else if (!command || command === "thread") {
        await showThreads(ctx, requireManager().scope("/root"), rest.join(" ") || undefined);
      } else ctx.ui.notify("Usage: /agents [types | reload | thread /root/name]", "warning");
    },
  });
}
