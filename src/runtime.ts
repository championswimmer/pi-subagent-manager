import path from "node:path";
import { mkdir, realpath } from "node:fs/promises";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime,
  SessionManager, SettingsManager, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { selectTools } from "./config.ts";
import { inheritContext } from "./paths.ts";
import { THINKING_LEVELS, type DriverFactory, type ThinkingLevel } from "./types.ts";

const BUILTINS = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];

/** Isolated SDK sessions; neither external extensions nor the CLI's MCP factories are loaded. */
export function createDriverFactory(getRootContext: () => ExtensionContext): DriverFactory {
  // Keep resolved settings even after disposal: descendants inherit settings, not the caller's history.
  const resolved = new Map<string, { provider: string; id: string; thinking: ThinkingLevel }>();
  return async (options) => {
    const ctx = getRootContext();
    const rootId = ctx.sessionManager.getSessionId();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(rootId)) throw new Error("Unsafe root session id for subagent storage");
    const agentDir = getAgentDir();
    const sessionDir = path.join(agentDir, "subagents", rootId);
    await mkdir(sessionDir, { recursive: true });
    let sessionManager: SessionManager;
    if (options.sessionFile) {
      const directory = await realpath(sessionDir);
      const file = await realpath(options.sessionFile);
      const relative = path.relative(directory, file);
      if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative) || !file.endsWith(".jsonl")) {
        throw new Error("Subagent sessionFile must be a JSONL file inside this root's subagent sessions directory");
      }
      sessionManager = SessionManager.open(path.resolve(options.sessionFile), sessionDir, ctx.cwd);
    } else {
      sessionManager = SessionManager.create(ctx.cwd, sessionDir);
      for (const message of inheritContext(options.inherited)) {
        // Summary messages are projections, not appendable SDK session entries.
        if (message.role === "compactionSummary" || message.role === "branchSummary") {
          sessionManager.appendMessage({ role: "user", content: message.summary, timestamp: message.timestamp });
        } else if (message.role === "user" || message.role === "assistant" || message.role === "toolResult") {
          sessionManager.appendMessage(message);
        }
      }
    }
    const runtime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"),
      modelsStorePath: path.join(agentDir, "models-store.json"), allowModelNetwork: false,
    });
    for (const providerId of ctx.modelRegistry.getRegisteredProviderIds()) {
      const native = ctx.modelRegistry.getRegisteredNativeProvider(providerId);
      const config = ctx.modelRegistry.getRegisteredProviderConfig(providerId);
      if (native) runtime.registerNativeProvider(native);
      if (config) runtime.registerProvider(providerId, config);
    }
    const parent = options.parentPath ? resolved.get(`${rootId}:${options.parentPath}`) : undefined;
    let provider = parent?.provider ?? ctx.model?.provider;
    let id = parent?.id ?? ctx.model?.id;
    if (options.type.model) {
      const slash = options.type.model.indexOf("/");
      if (slash < 1 || slash === options.type.model.length - 1) throw new Error("Agent model must be provider/model-id");
      provider = options.type.model.slice(0, slash);
      id = options.type.model.slice(slash + 1);
    }
    const restored = options.sessionFile ? sessionManager.buildSessionContext() : undefined;
    if (restored?.model) {
      provider = restored.model.provider;
      id = restored.model.modelId;
    }
    const rootModel = provider && id ? ctx.modelRegistry.find(provider, id) : undefined;
    if (rootModel?.api === "pi-virtual") {
      throw new Error(`Virtual model ${provider}/${id} cannot be reproduced through the public registry API. Set this agent type's model to a physical provider/model-id.`);
    }
    const model = provider && id ? runtime.getModel(provider, id) : undefined;
    if (!model) throw new Error(`Subagent model ${provider ?? "(unset)"}/${id ?? "(unset)"} is unavailable; select a physical model in the root or agent type`);
    const savedThinking = restored && THINKING_LEVELS.includes(restored.thinkingLevel as ThinkingLevel)
      ? restored.thinkingLevel as ThinkingLevel : undefined;
    const thinkingLevel = savedThinking ?? options.type.thinkingLevel ?? parent?.thinking ?? ctx.thinkingLevel ?? "off";
    const toolNames = selectTools(options.type.tools, [...BUILTINS, ...options.tools.map(tool => tool.name)]);
    const allowed = new Set(toolNames);
    const settingsManager = SettingsManager.inMemory({ cacheWarming: "off" });
    let parkQueue = () => {};
    const pauseBoundary = () => {
      if (!options.shouldPause()) return undefined;
      parkQueue();
      return { continue: false };
    };
    const loader = new DefaultResourceLoader({
      cwd: ctx.cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true,
      systemPrompt: options.type.systemPrompt,
      appendSystemPromptOverride: () => [],
      extensionFactories: [(pi) => {
        pi.on("turn_end", pauseBoundary);
        pi.on("agent_before_settle", pauseBoundary);
        pi.on("tool_call", event => allowed.has(event.toolName) ? undefined : { block: true, reason: "Tool is not allowed by this agent type" });
      }],
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: ctx.cwd, agentDir, modelRuntime: runtime, model, thinkingLevel,
      settingsManager, resourceLoader: loader, sessionManager,
      tools: toolNames, customTools: options.tools.filter(tool => allowed.has(tool.name)),
    });
    try {
      await session.bindExtensions({ mode: "print" });
    } catch (error) {
      session.dispose();
      throw error;
    }
    // In 0.99.2 a boundary's continue:false only declines EXTRA continuation;
    // the public core hook is needed to stop automatic tool/steering continuation.
    const parked: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };
    parkQueue = () => {
      const queue = session.clearQueue();
      parked.steering.push(...queue.steering);
      parked.followUp.push(...queue.followUp);
    };
    const finishTurn = session.agent.finishTurn;
    session.agent.finishTurn = async (turn, signal) => {
      const decision = await finishTurn?.(turn, signal);
      if (options.shouldPause()) { parkQueue(); return { action: "end" }; }
      return decision || undefined;
    };
    resolved.set(`${rootId}:${options.path}`, { provider: model.provider, id: model.id, thinking: session.thinkingLevel });
    let disposed = false;
    let running = false;
    let aborted = false;
    let baseline = session.messages.length;
    let finalOutput = "";
    let abortPromise: Promise<void> | undefined;
    const emit = (kind: "activity" | "error", text: string) => options.onEvent({ kind, text: text.slice(0, 1000) });
    const unsubscribe = session.subscribe(event => {
      if (event.type === "tool_execution_start") emit("activity", `Tool: ${event.toolName}`);
      if (event.type === "tool_execution_end") emit(event.isError ? "error" : "activity", `Tool ${event.toolName}: ${event.isError ? "failed" : "finished"}`);
      if (event.type === "message_end" && event.message.role === "assistant") {
        const text = event.message.content.filter(block => block.type === "text").map(block => block.text).join("");
        if (text) emit("activity", text);
      }
    });
    const assertOpen = () => { if (disposed) throw new Error("Subagent driver is disposed"); };
    return {
      sessionFile: session.sessionFile,
      async prompt(message) {
        assertOpen();
        if (running) throw new Error("Subagent is already running; use steer instead");
        running = true;
        aborted = false;
        baseline = session.messages.length;
        finalOutput = "";
        try {
          for (const text of parked.steering.splice(0)) await session.steer(text);
          for (const text of parked.followUp.splice(0)) await session.followUp(text);
          await session.prompt(message, { expandPromptTemplates: false });
          await session.waitForIdle();
          const last = session.messages.slice(baseline).filter(msg => msg.role === "assistant").at(-1);
          if (aborted || last?.stopReason === "aborted") throw new Error("Subagent run aborted");
          if (last?.stopReason === "error") throw new Error(last.errorMessage || "Subagent model failed");
          if (last && !options.shouldPause()) finalOutput = last.content.filter(block => block.type === "text").map(block => block.text).join("");
        } catch (error) {
          emit("error", error instanceof Error ? error.message : String(error));
          throw error;
        } finally {
          running = false;
        }
      },
      async steer(message) { assertOpen(); await session.steer(message); },
      snapshot() { return structuredClone(session.messages); },
      output() { return finalOutput; },
      async abort() {
        if (disposed) return;
        if (running) aborted = true;
        if (!abortPromise) abortPromise = session.abort().finally(() => { abortPromise = undefined; });
        await abortPromise;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        aborted = true;
        unsubscribe();
        session.dispose();
      },
      sendUpdate(content) {
        assertOpen();
        // SDK session method is sendCustomMessage (ExtensionAPI calls it sendMessage).
        void session.sendCustomMessage({ customType: "subagent-update", content, display: true }, { triggerTurn: false, deliverAs: "nextTurn" })
          .catch(error => emit("error", String(error)));
      },
    };
  };
}
