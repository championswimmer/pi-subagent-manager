import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AgentDriver,
  AgentType,
  DriverOptions,
  ManagerOptions,
  SavedThread,
  SavedThreadView,
  ThreadService,
  ThreadView,
} from "./types.ts";
import { canonicalPath, inheritContext, isDescendant, parentPath } from "./paths.ts";
import { DEFAULT_MANAGER_SETTINGS, type ManagerSettings } from "./settings.ts";

interface Record {
  view: ThreadView;
  definition: AgentType;
  inherited: AgentMessage[];
  contextReady?: Promise<void>;
  contextPending?: boolean;
  startup: AbortController;
  driver?: AgentDriver;
  initializing?: Promise<AgentDriver>;
  run?: Promise<void>;
  started?: Promise<void>;
  sessionLeafId?: string | null;
  /** Last authoritative cumulative usage applied from the current driver. */
  usageCursor?: { input: number; output: number };
  /** In-progress message usage. Shown live, never persisted. */
  liveInputTokens?: number;
  liveOutputTokens?: number;
  pauseRequested: boolean;
  stopRequested: boolean;
}
const active = (view: Pick<ThreadView, "state">) =>
  view.state === "starting" || view.state === "running";
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const cancel = () => reject(signal.reason ?? new Error("Startup cancelled"));
    signal.addEventListener("abort", cancel, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", cancel);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", cancel);
        reject(error);
      },
    );
  });
}

/** Runtime-neutral thread ownership, context inheritance, lifecycle and durable registry. */
export class ThreadManager {
  private records = new Map<string, Record>();
  private disposed = false;
  private epoch = 0;
  constructor(private options: ManagerOptions) {}

  /** New limits affect future launches/resumes, never cancel existing work. */
  setLimits(limits: ManagerSettings): void {
    this.options = { ...this.options, ...limits };
  }

  list(): ThreadView[] {
    return [...this.records.values()].map((record) => this.view(record));
  }

  /** Bind authority once; models and the user UI share this small composable service. */
  scope(caller: string): ThreadService {
    caller = canonicalPath(caller);
    return {
      list: () =>
        this.list().filter(
          (thread) =>
            caller === "/root" || thread.path === caller || isDescendant(thread.path, caller),
        ),
      get: (path) => this.get(path, caller),
      output: (path) => this.output(path, caller),
      transcript: (path) => this.transcript(caller, path),
      spawn: (args, signal) => this.spawn(caller, args, signal),
      steer: (path, message) => this.steer(caller, path, message),
      wait: (path, timeoutMs, signal) => this.wait(caller, path, timeoutMs, signal),
      update: (message) => this.update(caller, message),
      pause: (reason) => this.pause(caller, reason),
      stop: (path) => this.stop(caller, path),
    };
  }
  get(path: string, caller = "/root"): ThreadView {
    path = canonicalPath(path, caller);
    this.assertAccess(caller, path, true);
    if (path === "/root")
      return {
        path,
        parent: null,
        owner: path,
        type: "main",
        state: "running",
        task: "Main Pi session",
        status: "main",
        createdAt: 0,
        updatedAt: Date.now(),
      };
    return this.view(this.record(path));
  }
  output(path: string, caller = "/root"): string {
    const view = this.get(path, caller);
    if (view.state === "paused") return ""; // No answer handback from a paused turn.
    return view.output ?? "";
  }
  saved(): SavedThread[] {
    return [...this.records.values()].map((record) => {
      const current = this.view(record);
      // Explicit durable schema: adding UI fields must not silently change session storage.
      const view: SavedThreadView = {
        path: current.path,
        parent: current.parent,
        owner: current.owner,
        type: current.type,
        color: current.color,
        state: current.state,
        task: current.task,
        status: current.status,
        output: current.output,
        error: current.error,
        createdAt: current.createdAt,
        sessionFile: current.sessionFile,
        // Settled totals only. startedAt and partial usage must not churn persistence.
        elapsedMs: record.view.elapsedMs ?? 0,
        inputTokens: record.view.inputTokens ?? 0,
        outputTokens: record.view.outputTokens ?? 0,
      };
      const sessionLeafId = this.sessionLeafId(record);
      if (sessionLeafId !== undefined) view.sessionLeafId = sessionLeafId;
      if (active(view)) view.status = view.state === "running" ? "Working" : "Starting";
      return {
        view,
        definition: structuredClone(record.definition),
        ...(!view.sessionFile && !record.contextPending
          ? { inherited: structuredClone(record.inherited) }
          : {}),
      };
    });
  }
  restore(saved: SavedThread[]): void {
    if (this.records.size) throw new Error("Restore requires an empty thread registry");
    const restored = new Map<string, Record>();
    for (const item of saved) {
      const savedView = structuredClone(item.view);
      const path = canonicalPath(savedView.path);
      if (
        path === "/root" ||
        restored.has(path) ||
        !["starting", "running", "paused", "completed", "failed", "stopped"].includes(
          savedView.state,
        )
      )
        throw new Error("Invalid saved thread registry");
      const { sessionLeafId, ...storedView } = savedView;
      const view: ThreadView = {
        ...storedView,
        updatedAt: Date.now(),
        elapsedMs: storedView.elapsedMs ?? 0,
        inputTokens: storedView.inputTokens ?? 0,
        outputTokens: storedView.outputTokens ?? 0,
      };
      delete view.startedAt;
      if (view.parent !== parentPath(path)) throw new Error(`Invalid saved parent for ${path}`);
      if (active(view)) {
        view.state = "paused";
        view.status = "Interrupted by reload; send input to resume";
        delete view.output;
      }
      restored.set(path, {
        view,
        definition: structuredClone(item.definition),
        inherited: structuredClone(item.inherited ?? []),
        // A reservation saved before its lexical parent opened has no snapshot yet.
        contextPending: !view.sessionFile && item.inherited === undefined && view.parent !== null,
        startup: new AbortController(),
        ...(Object.prototype.hasOwnProperty.call(savedView, "sessionLeafId")
          ? { sessionLeafId }
          : {}),
        pauseRequested: false,
        stopRequested: false,
      });
    }
    for (const record of restored.values()) {
      if (record.view.parent && record.view.parent !== "/root" && !restored.has(record.view.parent))
        throw new Error(`Missing saved parent ${record.view.parent}`);
    }
    this.records = restored;
  }

  async spawn(
    caller: string,
    args: { path: string; type: string; task: string; wait?: boolean },
    signal?: AbortSignal,
  ): Promise<ThreadView> {
    this.assertLive();
    caller = canonicalPath(caller);
    if (
      caller !== "/root" &&
      (!active(this.record(caller).view) || this.record(caller).stopRequested)
    )
      throw new Error("Only a working agent may spawn children");
    signal?.throwIfAborted();
    const path = canonicalPath(args.path, caller);
    this.assertAccess(caller, path);
    if (path === "/root" || this.records.has(path))
      throw new Error(`Thread ${path} already exists; use agent_steer to resume it`);
    const parent = parentPath(path);
    if (parent && parent !== "/root") this.record(parent);
    if (caller !== "/root" && parent !== caller)
      throw new Error("An agent may spawn only its immediate children");
    if (!args.task.trim()) throw new Error("Task must not be empty");
    const segments = path.slice(1).split("/");
    // Independent roots still represent agents launched by the main L1 conversation.
    const level = segments.length + (segments[0] === "root" ? 0 : 1);
    const maxLevels = this.options.maxLevels ?? DEFAULT_MANAGER_SETTINGS.maxLevels;
    if (
      this.options.maxLevels === undefined && this.options.maxDepth !== undefined
        ? segments.length - 1 > this.options.maxDepth
        : level > maxLevels
    )
      throw new Error("Agent depth limit reached");
    if (this.records.size >= (this.options.maxThreads ?? DEFAULT_MANAGER_SETTINGS.maxThreads))
      throw new Error("Total thread limit reached");
    this.assertCapacity();
    const type = structuredClone(this.options.getType(args.type));
    const parentRecord = parent && parent !== "/root" ? this.record(parent) : undefined;
    this.assertStartableAncestors(path);
    // Reservation is synchronous: subtree cancellation sees children even during lazy parent reopen.
    const inherited =
      parent === "/root"
        ? inheritContext(this.options.rootSnapshot())
        : parentRecord?.driver
          ? inheritContext(parentRecord.driver.snapshot())
          : [];
    const now = Date.now();
    const record: Record = {
      view: {
        path,
        parent,
        owner: parent ?? caller,
        type: type.name,
        color: type.color,
        state: "starting",
        task: args.task,
        status: "Starting",
        createdAt: now,
        updatedAt: now,
        elapsedMs: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
      definition: type,
      inherited,
      contextPending: !!(parentRecord && !parentRecord.driver),
      startup: new AbortController(),
      pauseRequested: false,
      stopRequested: false,
    };
    this.records.set(path, record);
    if (record.contextPending) this.prepareInheritedContext(record);
    this.start(record, args.task);
    return args.wait === false ? this.view(record) : this.wait(caller, path, undefined, signal);
  }

  async steer(caller: string, path: string, message: string): Promise<ThreadView> {
    this.assertLive();
    caller = canonicalPath(caller);
    path = canonicalPath(path, caller);
    this.assertAccess(caller, path);
    if (!message.trim()) throw new Error("Steering message must not be empty");
    const record = this.record(path);
    for (;;) {
      this.assertLive();
      this.assertCallerMaySteer(caller);
      if (!active(record.view)) this.assertStartableAncestors(path);
      // A detached spawn reserves immediately, but its original task must reach prompt() before steering.
      if (record.view.state === "starting") {
        if (!record.started) throw new Error("Thread start invariant violated");
        await record.started;
        continue;
      }
      if (record.stopRequested && active(record.view))
        throw new Error("Thread is stopping; wait for stopped state before resuming");
      if (record.view.state === "running") {
        await record.driver!.steer(message);
        this.touch(record);
        return this.view(record);
      }
      this.assertCapacity();
      this.start(record, message);
      return this.view(record);
    }
  }
  async wait(
    caller: string,
    path: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<ThreadView> {
    path = canonicalPath(path, caller);
    this.assertAccess(caller, path);
    const record = this.record(path);
    if (!active(record.view)) return this.view(record);
    if (
      timeoutMs !== undefined &&
      (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 3_600_000)
    )
      throw new Error("timeoutMs must be between 0 and 3600000");
    if (signal?.aborted) throw new Error("Waiting cancelled; thread remains running");
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        error ? reject(error) : resolve();
      };
      const cancel = () => finish(new Error("Waiting cancelled; thread remains running"));
      signal?.addEventListener("abort", cancel, { once: true });
      if (timeoutMs !== undefined) timer = setTimeout(() => finish(), timeoutMs);
      record.run!.then(
        () => finish(),
        (error) => finish(new Error(errorText(error))),
      );
    });
    return this.view(record);
  }
  update(caller: string, message: string): ThreadView {
    const record = this.record(caller);
    if (!active(record.view)) throw new Error("Only a working child may report progress");
    if (!message.trim() || message.length > 8000)
      throw new Error("Progress message must contain 1–8000 characters");
    record.view.status = message;
    this.touch(record);
    this.options.onEvent?.({
      kind: "update",
      thread: this.view(record),
      message,
      recipient: record.view.parent ?? record.view.owner,
    });
    return this.view(record);
  }
  pause(caller: string, reason: string): ThreadView {
    const record = this.record(caller);
    if (!active(record.view)) throw new Error("Only a working child may pause itself");
    record.pauseRequested = true;
    record.view.status = reason.trim() || "Awaiting further input";
    this.touch(record);
    // Remains running until the SDK settles. No interim final answer leaks through wait().
    return this.view(record);
  }
  async stop(caller: string, path: string): Promise<ThreadView> {
    path = canonicalPath(path, caller);
    this.assertAccess(caller, path);
    const record = this.record(path);
    const targets = [...this.records.values()].filter(
      (item) => item === record || (isDescendant(item.view.path, path) && active(item.view)),
    );
    for (const item of targets) {
      item.stopRequested = true;
      item.startup.abort();
    }
    await Promise.all(
      targets.map(async (item) => {
        if (item.driver) await item.driver.abort();
        await item.run;
        item.view.state = "stopped";
        item.view.status = "Stopped; session retained";
        delete item.view.output;
        this.touch(item);
      }),
    );
    return this.view(record);
  }
  async transcript(caller: string, path: string): Promise<string> {
    path = canonicalPath(path, caller);
    this.assertAccess(caller, path, true);
    const driver = await this.ensureDriver(this.record(path), true);
    return JSON.stringify(driver.snapshot(), null, 2);
  }
  async deliver(path: string, content: string): Promise<void> {
    // Restored parents may be idle and unopened; reports still belong in their retained transcript.
    const driver = await this.ensureDriver(this.record(path), true);
    await driver.sendUpdate(content);
  }
  async shutdown(): Promise<void> {
    this.disposed = true;
    this.epoch++;
    const records = [...this.records.values()];
    for (const record of records) {
      record.stopRequested = true;
      record.startup.abort();
    }
    await Promise.all(
      records.map(async (record) => {
        await record.driver?.abort();
        await record.initializing?.catch(() => {});
        await record.run;
        record.driver?.dispose();
      }),
    );
  }

  private start(record: Record, message: string): void {
    this.freezeElapsed(record);
    record.pauseRequested = false;
    record.stopRequested = false;
    record.startup = new AbortController();
    record.view.state = "starting";
    record.view.status = "Starting";
    record.view.startedAt = Date.now();
    delete record.view.output;
    delete record.view.error;
    const epoch = this.epoch;
    let markStarted!: () => void;
    record.started = new Promise((resolve) => {
      markStarted = resolve;
    });
    record.run = Promise.resolve().then(async () => {
      try {
        const contextReady = this.prepareInheritedContext(record);
        if (contextReady) await abortable(contextReady, record.startup.signal);
        record.startup.signal.throwIfAborted();
        const driver = await this.ensureDriver(record);
        if (record.stopRequested || this.disposed) {
          record.view.state = "stopped";
          return;
        }
        const task = driver.prompt(message);
        record.view.state = "running";
        record.view.status = "Working";
        this.touch(record);
        markStarted();
        await task;
        record.view.state = record.stopRequested
          ? "stopped"
          : record.pauseRequested
            ? "paused"
            : "completed";
        if (record.view.state === "completed") {
          record.view.output = driver.output();
          record.view.status = "Completed; session retained";
        } else if (record.view.state === "stopped")
          record.view.status = "Stopped; session retained";
      } catch (error) {
        record.view.state = record.stopRequested ? "stopped" : "failed";
        record.view.error = errorText(error);
        record.view.status = record.stopRequested ? "Stopped; session retained" : record.view.error;
      } finally {
        this.freezeElapsed(record);
        record.liveInputTokens = 0;
        record.liveOutputTokens = 0;
        markStarted(); // Failed/cancelled initialization must also release callers waiting to steer.
        this.touch(record);
        if (!this.disposed && epoch === this.epoch)
          this.options.onEvent?.({
            kind: "settled",
            thread: this.view(record),
            recipient: record.view.parent ?? record.view.owner,
          });
      }
    });
    this.touch(record);
  }
  private ensureDriver(record: Record, readOnly = false): Promise<AgentDriver> {
    this.assertLive();
    if (record.driver) return Promise.resolve(record.driver);
    if (!record.initializing) {
      const signal =
        readOnly && !active(record.view) ? new AbortController().signal : record.startup.signal;
      const creation = Promise.resolve()
        .then(async () => {
          // Inspection and delivery can initialize a reserved child before start().
          const contextReady = this.prepareInheritedContext(record, readOnly);
          if (contextReady) await abortable(contextReady, signal);
          if (!record.view.sessionFile && record.view.parent && record.view.parent !== "/root") {
            const parentRecord = this.record(record.view.parent);
            if (!parentRecord.driver) await this.ensureDriver(parentRecord, readOnly);
          }
          const parentSessionFile = this.lexicalParentSessionFile(record);
          const options: DriverOptions = {
            path: record.view.path,
            type: record.definition,
            inherited: record.inherited,
            tools: this.options.toolsFor(record.view.path),
            parentPath: record.view.parent,
            sessionFile: record.view.sessionFile,
            signal,
            shouldPause: () => record.pauseRequested,
            onEvent: (event) => {
              if (event.kind === "usage") {
                this.applyUsage(record, event);
                return;
              }
              if (event.kind === "checkpoint") {
                this.touch(record);
                return;
              }
              if (active(record.view) && !record.pauseRequested) {
                record.view.status = event.text;
                this.touch(record);
              }
            },
            ...(parentSessionFile ? { parentSessionFile } : {}),
            ...(record.sessionLeafId !== undefined ? { sessionLeafId: record.sessionLeafId } : {}),
          };
          return this.options.createDriver(options);
        })
        .then(async (driver) => {
          if (this.disposed || signal.aborted) {
            await driver.abort();
            driver.dispose();
            throw new Error("Driver startup cancelled");
          }
          record.driver = driver;
          record.usageCursor = { input: 0, output: 0 };
          record.liveInputTokens = 0;
          record.liveOutputTokens = 0;
          record.view.sessionFile = driver.sessionFile;
          if (driver.sessionLeafId !== undefined) record.sessionLeafId = driver.sessionLeafId;
          this.touch(record);
          return driver;
        });
      let initializing!: Promise<AgentDriver>;
      initializing = abortable(creation, signal).catch((error) => {
        if (record.initializing === initializing) record.initializing = undefined;
        throw error;
      });
      record.initializing = initializing;
    }
    return record.initializing;
  }
  private touch(record: Record): void {
    record.view.updatedAt = Date.now();
    if (!this.disposed) this.options.onEvent?.({ kind: "change", thread: this.view(record) });
  }
  /** Fold driver-cumulative usage into persisted totals. Partials only refresh the live view. */
  private applyUsage(
    record: Record,
    event: { inputTokens: number; outputTokens: number; partial?: boolean },
  ): void {
    const cursor = record.usageCursor ?? { input: 0, output: 0 };
    if (event.partial) {
      const input = Math.max(0, event.inputTokens - cursor.input);
      const output = Math.max(0, event.outputTokens - cursor.output);
      if (input === record.liveInputTokens && output === record.liveOutputTokens) return;
      record.liveInputTokens = input;
      record.liveOutputTokens = output;
      if (!this.disposed) this.options.onEvent?.({ kind: "metrics", thread: this.view(record) });
      return;
    }
    record.view.inputTokens =
      (record.view.inputTokens ?? 0) + Math.max(0, event.inputTokens - cursor.input);
    record.view.outputTokens =
      (record.view.outputTokens ?? 0) + Math.max(0, event.outputTokens - cursor.output);
    record.usageCursor = { input: event.inputTokens, output: event.outputTokens };
    record.liveInputTokens = 0;
    record.liveOutputTokens = 0;
    this.touch(record);
  }
  private freezeElapsed(record: Record): void {
    const startedAt = record.view.startedAt;
    if (startedAt === undefined) return;
    record.view.elapsedMs = (record.view.elapsedMs ?? 0) + Math.max(0, Date.now() - startedAt);
    delete record.view.startedAt;
  }
  private prepareInheritedContext(record: Record, readOnly = false): Promise<void> | undefined {
    if (!record.contextPending) return record.contextReady;
    if (record.contextReady) return record.contextReady;
    if (!record.view.parent || record.view.parent === "/root") {
      record.inherited = inheritContext(this.options.rootSnapshot());
      record.contextPending = false;
      return undefined;
    }
    const parentRecord = this.record(record.view.parent);
    let ready!: Promise<void>;
    ready = this.ensureDriver(parentRecord, readOnly)
      .then((driver) => {
        record.inherited = inheritContext(driver.snapshot());
        record.contextPending = false;
        if (record.contextReady === ready) record.contextReady = undefined;
        this.touch(record);
      })
      .catch((error) => {
        if (record.contextReady === ready) record.contextReady = undefined;
        throw error;
      });
    record.contextReady = ready;
    void ready.catch(() => {});
    return ready;
  }
  private sessionLeafId(record: Record): string | null | undefined {
    const leaf = record.driver?.sessionLeafId;
    return leaf !== undefined ? leaf : record.sessionLeafId;
  }
  /** Live persisted file, else the saved file of a restored parent that has not been opened. */
  private lexicalParentSessionFile(record: Record): string | undefined {
    const parent = record.view.parent;
    if (!parent || parent === "/root") return undefined;
    const parentRecord = this.records.get(parent);
    if (!parentRecord) return undefined;
    return parentRecord.driver?.sessionFile ?? parentRecord.view.sessionFile;
  }
  private view(record: Record): ThreadView {
    const view = structuredClone({
      ...record.view,
      sessionFile: record.driver ? record.driver.sessionFile : record.view.sessionFile,
    });
    if (record.liveInputTokens) view.inputTokens = (view.inputTokens ?? 0) + record.liveInputTokens;
    if (record.liveOutputTokens)
      view.outputTokens = (view.outputTokens ?? 0) + record.liveOutputTokens;
    return view;
  }
  private record(path: string): Record {
    const record = this.records.get(path);
    if (!record) throw new Error(`Unknown thread ${path}`);
    return record;
  }
  private assertLive(): void {
    if (this.disposed) throw new Error("Thread manager has shut down");
  }
  private assertCallerMaySteer(caller: string): void {
    if (caller !== "/root" && this.record(caller).stopRequested)
      throw new Error("Stopping agents may not steer descendants");
  }
  private assertStartableAncestors(path: string): void {
    for (
      let ancestor = parentPath(path);
      ancestor && ancestor !== "/root";
      ancestor = parentPath(ancestor)
    ) {
      const record = this.record(ancestor);
      if (record.stopRequested || record.view.state === "stopped") {
        throw new Error(`Cannot continue under stopped ancestor ${ancestor}; resume it first`);
      }
    }
  }
  private assertCapacity(): void {
    if (
      [...this.records.values()].filter((record) => active(record.view)).length >=
      (this.options.maxConcurrent ?? DEFAULT_MANAGER_SETTINGS.maxConcurrent)
    )
      throw new Error("Concurrent thread limit reached; wait for a thread to settle");
  }
  private assertAccess(caller: string, path: string, self = false): void {
    caller = canonicalPath(caller);
    if (caller === "/root" && path !== "/root") return;
    if (self && path === caller) return;
    if (!isDescendant(path, caller))
      throw new Error(
        `${caller} may address only its descendants (not siblings, unrelated trees or ancestors)`,
      );
  }
}
