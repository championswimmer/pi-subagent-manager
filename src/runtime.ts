import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  BOOTSTRAP_MESSAGE,
  buildBootstrapMessage,
  buildQueuedUserMessage,
  buildUpdateDetails,
  DurableMailbox,
} from "./mailbox.ts";
import { selectTools } from "./config.ts";
import { modelIdentity, getModelPreferences, selectPreferredModel } from "./models.ts";
import { THINKING_LEVELS, type DriverFactory, type ThinkingLevel } from "./types.ts";

const BUILTINS = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
type ScopedModel = ExtensionContext["scopedModels"][number];

function parseModelIdentity(identity: string): { provider: string; id: string } {
  const slash = identity.indexOf("/");
  return { provider: identity.slice(0, slash), id: identity.slice(slash + 1) };
}

function scopedModelsKey(scopedModels: readonly ScopedModel[]): string {
  return scopedModels
    .map(({ model, thinkingLevel }) => `${modelIdentity(model)}\0${thinkingLevel ?? ""}`)
    .join("\n");
}

/** Isolated SDK sessions; neither external extensions nor the CLI's MCP factories are loaded. */
export function createDriverFactory(getRootContext: () => ExtensionContext): DriverFactory {
  // Keep resolved settings even after disposal: descendants inherit settings, not the caller's history.
  const resolved = new Map<string, { provider: string; id: string; thinking: ThinkingLevel }>();
  return async (options) => {
    options.signal.throwIfAborted();
    const ctx = getRootContext();
    const rootId = ctx.sessionManager.getSessionId();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(rootId))
      throw new Error("Unsafe root session id for subagent storage");
    const agentDir = getAgentDir();
    const sessionDir = path.join(agentDir, "subagents", rootId);
    options.signal.throwIfAborted();
    await mkdir(sessionDir, { recursive: true });
    options.signal.throwIfAborted();
    let sessionManager: SessionManager;
    if (options.sessionFile) {
      options.signal.throwIfAborted();
      const directory = await realpath(sessionDir);
      options.signal.throwIfAborted();
      const file = await realpath(options.sessionFile);
      options.signal.throwIfAborted();
      const relative = path.relative(directory, file);
      if (
        !relative ||
        relative.startsWith(`..${path.sep}`) ||
        relative === ".." ||
        path.isAbsolute(relative) ||
        !file.endsWith(".jsonl")
      ) {
        throw new Error(
          "Subagent sessionFile must be a JSONL file inside this root's subagent sessions directory",
        );
      }
      sessionManager = SessionManager.open(path.resolve(options.sessionFile), sessionDir, ctx.cwd);
      if (options.sessionLeafId !== undefined) {
        if (options.sessionLeafId === null) sessionManager.resetLeaf();
        else sessionManager.branch(options.sessionLeafId);
      }
    } else {
      sessionManager = SessionManager.create(ctx.cwd, sessionDir);
      for (const message of options.inherited) {
        // Summary messages are projections, not appendable SDK session entries.
        if (message.role === "compactionSummary" || message.role === "branchSummary") {
          sessionManager.appendMessage({
            role: "user",
            content: message.summary,
            timestamp: message.timestamp,
          });
        } else if (message.role === "custom") {
          sessionManager.appendCustomMessageEntry(
            message.customType,
            message.content,
            message.display,
            message.details,
          );
        } else if (
          message.role === "user" ||
          message.role === "assistant" ||
          message.role === "toolResult" ||
          message.role === "bashExecution"
        ) {
          sessionManager.appendMessage(message);
        }
      }
    }
    const parent = options.parentPath ? resolved.get(`${rootId}:${options.parentPath}`) : undefined;
    const restored = options.sessionFile ? sessionManager.buildSessionContext() : undefined;
    const modelPreferences = getModelPreferences(options.type);
    const normalizeScopedModels = (
      scopedModels: ExtensionContext["scopedModels"] | null | undefined,
    ): readonly ScopedModel[] => scopedModels ?? [];
    const selectScopedPreference = (scopedModels: readonly ScopedModel[]) => {
      try {
        return selectPreferredModel(options.type, scopedModels);
      } catch (error) {
        if (scopedModels.length === 0 && error instanceof Error && !error.message.includes("[]"))
          throw new Error(`${error.message} Current /scoped-models scope: [].`);
        throw error;
      }
    };
    const initialScopedModels = normalizeScopedModels(ctx.scopedModels);
    let provider = parent?.provider ?? ctx.model?.provider;
    let id = parent?.id ?? ctx.model?.id;
    if (modelPreferences !== undefined) {
      ({ provider, id } = parseModelIdentity(selectScopedPreference(initialScopedModels)!));
    } else if (restored?.model) {
      provider = restored.model.provider;
      id = restored.model.modelId;
    }
    options.signal.throwIfAborted();
    const runtime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
      modelsStorePath: path.join(agentDir, "models-store.json"),
      allowModelNetwork: false,
      signal: options.signal,
    });
    options.signal.throwIfAborted();
    for (const providerId of ctx.modelRegistry.getRegisteredProviderIds()) {
      const native = ctx.modelRegistry.getRegisteredNativeProvider(providerId);
      const config = ctx.modelRegistry.getRegisteredProviderConfig(providerId);
      if (native) runtime.registerNativeProvider(native);
      if (config) runtime.registerProvider(providerId, config);
    }
    const mirrorRuntimeAuth = async (providerId: string) => {
      options.signal.throwIfAborted();
      if (ctx.modelRegistry.getProviderAuthStatus(providerId).source !== "runtime") return;
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(providerId);
      options.signal.throwIfAborted();
      if (apiKey !== undefined)
        await runtime.setRuntimeApiKey(providerId, apiKey, { signal: options.signal });
      options.signal.throwIfAborted();
    };
    const resolveRuntimeModel = async (
      providerId: string | undefined,
      modelId: string | undefined,
      scopedModels: readonly ScopedModel[],
    ) => {
      if (!providerId || !modelId)
        throw new Error(
          `Subagent model ${providerId ?? "(unset)"}/${modelId ?? "(unset)"} is unavailable; select a physical model in the root or agent type`,
        );
      await mirrorRuntimeAuth(providerId);
      const sourceModel =
        scopedModels.find(({ model }) => model.provider === providerId && model.id === modelId)?.model ??
        ctx.modelRegistry.find(providerId, modelId);
      if (sourceModel?.api === "pi-virtual") {
        throw new Error(
          `Virtual model ${providerId}/${modelId} cannot be reproduced through the public registry API. Set this agent type's model to a physical provider/model-id.`,
        );
      }
      const runtimeModel = runtime.getModel(providerId, modelId);
      if (!runtimeModel)
        throw new Error(
          `Subagent model ${providerId}/${modelId} is unavailable; select a physical model in the root or agent type`,
        );
      return runtimeModel;
    };
    const model = await resolveRuntimeModel(provider, id, initialScopedModels);
    const savedThinking =
      restored && THINKING_LEVELS.includes(restored.thinkingLevel as ThinkingLevel)
        ? (restored.thinkingLevel as ThinkingLevel)
        : undefined;
    const thinkingLevel =
      savedThinking ?? options.type.thinkingLevel ?? parent?.thinking ?? ctx.thinkingLevel ?? "off";
    const toolNames = selectTools(options.type.tools, [
      ...BUILTINS,
      ...options.tools.map((tool) => tool.name),
    ]);
    const allowed = new Set(toolNames);
    const settingsManager = SettingsManager.inMemory({ cacheWarming: "off" });
    let parkQueue = () => {};
    const pauseBoundary = () => {
      if (!options.shouldPause()) return undefined;
      parkQueue();
      return { continue: false };
    };
    const loader = new DefaultResourceLoader({
      cwd: ctx.cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
      noThemes: true,
      systemPrompt: [
        options.type.systemPrompt,
        `Your thread path is ${options.path}.`,
        options.parentPath
          ? `Your lexical parent is ${options.parentPath}; inherited conversation comes only from that parent.`
          : "You are an independent root thread with no inherited history.",
        "When finished, give your final answer normally so it can be handed back. To retain unfinished work without a final answer, call agent_pause (if available), then stop; resume only when instructed.",
      ].join("\n\n"),
      appendSystemPromptOverride: () => [],
      extensionFactories: [
        (pi) => {
          pi.on("turn_end", pauseBoundary);
          pi.on("agent_before_settle", pauseBoundary);
          pi.on("tool_call", (event) =>
            allowed.has(event.toolName)
              ? undefined
              : { block: true, reason: "Tool is not allowed by this agent type" },
          );
        },
      ],
    });
    options.signal.throwIfAborted();
    await loader.reload();
    options.signal.throwIfAborted();
    const { session } = await createAgentSession({
      cwd: ctx.cwd,
      agentDir,
      modelRuntime: runtime,
      model,
      thinkingLevel,
      scopedModels: [...initialScopedModels],
      settingsManager,
      resourceLoader: loader,
      sessionManager,
      tools: toolNames,
      customTools: options.tools.filter((tool) => allowed.has(tool.name)),
    });
    let lastScopedModelsKey = "";
    const updateResolved = () => {
      const currentModel = session.model;
      if (!currentModel) throw new Error(`Subagent ${options.path} has no selected model`);
      resolved.set(`${rootId}:${options.path}`, {
        provider: currentModel.provider,
        id: currentModel.id,
        thinking: session.thinkingLevel,
      });
    };
    const assertScopedRequestAuthorized = (
      currentIdentity: string | undefined,
      liveScopedModels: readonly ScopedModel[],
    ) => {
      if (modelPreferences === undefined) return;
      const preferredIdentity = selectScopedPreference(liveScopedModels);
      if (!preferredIdentity) return;
      if (!currentIdentity) throw new Error(`Subagent ${options.path} has no selected model`);
      if (currentIdentity !== preferredIdentity) {
        throw new Error(
          `Agent type ${JSON.stringify(options.type.name)} scope changed for subagent ${JSON.stringify(options.path)}: current model is ${currentIdentity} but preferred is ${preferredIdentity}; resume agent to use ${preferredIdentity}.`,
        );
      }
    };
    const assertCurrentModelAuthorized = () => {
      const currentModel = session.model;
      assertScopedRequestAuthorized(
        currentModel ? modelIdentity(currentModel) : undefined,
        normalizeScopedModels(getRootContext().scopedModels),
      );
    };
    const enforceScopedModelPolicy = async () => {
      const liveScopedModels = normalizeScopedModels(getRootContext().scopedModels);
      const key = scopedModelsKey(liveScopedModels);
      if (key !== lastScopedModelsKey) {
        session.setScopedModels([...liveScopedModels]);
        lastScopedModelsKey = key;
      }
      if (modelPreferences === undefined) {
        updateResolved();
        return;
      }
      const preferredIdentity = selectScopedPreference(liveScopedModels);
      if (!preferredIdentity) {
        updateResolved();
        return;
      }
      const currentModel = session.model;
      if (!currentModel || modelIdentity(currentModel) !== preferredIdentity) {
        const { provider: preferredProvider, id: preferredId } = parseModelIdentity(preferredIdentity);
        await session.setModel(
          await resolveRuntimeModel(preferredProvider, preferredId, liveScopedModels),
        );
      }
      updateResolved();
    };
    try {
      await enforceScopedModelPolicy();
      options.signal.throwIfAborted();
      await session.bindExtensions({ mode: "print" });
      options.signal.throwIfAborted();
    } catch (error) {
      session.dispose();
      throw error;
    }
    const streamFunction = session.agent.streamFunction;
    session.agent.streamFunction = async (requestModel, context, streamOptions) => {
      assertScopedRequestAuthorized(
        modelIdentity(requestModel),
        normalizeScopedModels(getRootContext().scopedModels),
      );
      return streamFunction(requestModel, context, streamOptions);
    };
    const mailbox = new DurableMailbox(sessionManager);
    const emitCheckpoint = () =>
      options.onEvent({
        kind: "checkpoint",
        text: "",
        sessionFile: session.sessionFile,
        sessionLeafId: sessionManager.getLeafId(),
      });
    const restoreAppends = mailbox.wrapAppends(emitCheckpoint);
    const ensurePersistedSession = () => {
      if (session.sessionFile && existsSync(session.sessionFile)) return;
      sessionManager.appendMessage(buildBootstrapMessage());
      emit("activity", BOOTSTRAP_MESSAGE);
    };
    const queueAccepted = async (kind: "steer" | "followUp", content: string) => {
      assertCurrentModelAuthorized();
      ensurePersistedSession();
      const accepted = mailbox.accept(kind, content);
      emitCheckpoint();
      if (kind === "followUp") session.agent.followUp(buildQueuedUserMessage(accepted));
      else session.agent.steer(buildQueuedUserMessage(accepted));
      mailbox.markEnqueued(accepted.id);
    };
    const resumePending = async () => {
      for (const accepted of mailbox.replayablePending()) {
        if (accepted.kind === "update") {
          await session.sendCustomMessage(
            {
              customType: "subagent-update",
              content: accepted.content,
              display: true,
              details: buildUpdateDetails(accepted),
            },
            { triggerTurn: false },
          );
          mailbox.markEnqueued(accepted.id);
          continue;
        }
        if (accepted.kind === "followUp") session.agent.followUp(buildQueuedUserMessage(accepted));
        else session.agent.steer(buildQueuedUserMessage(accepted));
        mailbox.markEnqueued(accepted.id);
      }
    };
    const clearPromptQueues = () => {
      session.clearQueue();
      mailbox.clearQueuedInputs();
    };
    // In 0.99.2 a boundary's continue:false only declines EXTRA continuation;
    // the public core hook is needed to stop automatic tool/steering continuation.
    parkQueue = clearPromptQueues;
    const finishTurn = session.agent.finishTurn;
    session.agent.finishTurn = async (turn, signal) => {
      const decision = await finishTurn?.(turn, signal);
      if (options.shouldPause()) {
        clearPromptQueues();
        return { action: "end" };
      }
      return decision || undefined;
    };
    updateResolved();
    let disposed = false;
    let running = false;
    let aborted = false;
    let baseline = session.messages.length;
    let finalOutput = "";
    let abortPromise: Promise<void> | undefined;
    const emit = (kind: "activity" | "error", text: string) =>
      options.onEvent({ kind, text: text.slice(0, 1000) });
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "tool_execution_start") emit("activity", `Tool: ${event.toolName}`);
      if (event.type === "tool_execution_end")
        emit(
          event.isError ? "error" : "activity",
          `Tool ${event.toolName}: ${event.isError ? "failed" : "finished"}`,
        );
      if (event.type === "message_end" && event.message.role === "assistant") {
        const text = event.message.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
        if (text) emit("activity", text);
      }
    });
    const assertOpen = () => {
      if (disposed) throw new Error("Subagent driver is disposed");
    };
    return {
      get sessionFile() {
        const file = session.sessionFile;
        return file && existsSync(file) ? file : undefined;
      },
      get sessionLeafId() {
        return sessionManager.getLeafId();
      },
      async prompt(message) {
        assertOpen();
        if (running) throw new Error("Subagent is already running; use steer instead");
        running = true;
        aborted = false;
        baseline = session.messages.length;
        finalOutput = "";
        try {
          await enforceScopedModelPolicy();
          await resumePending();
          await session.prompt(message, { expandPromptTemplates: false });
          await session.waitForIdle();
          const last = session.messages
            .slice(baseline)
            .filter((msg) => msg.role === "assistant")
            .at(-1);
          if (aborted || last?.stopReason === "aborted") throw new Error("Subagent run aborted");
          if (last?.stopReason === "error")
            throw new Error(last.errorMessage || "Subagent model failed");
          if (last && !options.shouldPause())
            finalOutput = last.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("");
        } catch (error) {
          emit("error", error instanceof Error ? error.message : String(error));
          throw error;
        } finally {
          updateResolved();
          running = false;
        }
      },
      async steer(message) {
        assertOpen();
        await queueAccepted("steer", message);
      },
      snapshot() {
        return structuredClone(session.messages);
      },
      output() {
        return finalOutput;
      },
      async abort() {
        if (disposed) return;
        if (running) aborted = true;
        clearPromptQueues();
        if (!abortPromise)
          abortPromise = session.abort().finally(() => {
            abortPromise = undefined;
          });
        await abortPromise;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        aborted = true;
        restoreAppends();
        unsubscribe();
        session.dispose();
      },
      async sendUpdate(content) {
        assertOpen();
        try {
          ensurePersistedSession();
          const accepted = mailbox.accept("update", content);
          emitCheckpoint();
          // SDK session method is sendCustomMessage (ExtensionAPI calls it sendMessage).
          await session.sendCustomMessage(
            {
              customType: "subagent-update",
              content,
              display: true,
              details: buildUpdateDetails(accepted),
            },
            { triggerTurn: false },
          );
          mailbox.markEnqueued(accepted.id);
        } catch (error) {
          emit("error", error instanceof Error ? error.message : String(error));
          throw error;
        }
      },
    };
  };
}
