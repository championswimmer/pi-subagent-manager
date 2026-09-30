import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AgentDriver,
  AgentType,
  ManagerOptions,
  SavedThread,
  SavedThreadView,
  ThreadService,
  ThreadView,
} from "./types.ts";
import { canonicalPath, inheritContext, isDescendant, parentPath } from "./paths.ts";

interface Record {
  view: ThreadView;
  definition: AgentType;
  inherited: AgentMessage[];
  contextReady?: Promise<void>;
  startup: AbortController;
  driver?: AgentDriver;
  initializing?: Promise<AgentDriver>;
  run?: Promise<void>;
  started?: Promise<void>;
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
      };
      if (active(view)) view.status = view.state === "running" ? "Working" : "Starting";
      return {
        view,
        definition: structuredClone(record.definition),
        ...(!view.sessionFile ? { inherited: structuredClone(record.inherited) } : {}),
      };
    });
  }
  restore(saved: SavedThread[]): void {
    if (this.records.size) throw new Error("Restore requires an empty thread registry");
    const restored = new Map<string, Record>();
    for (const item of saved) {
      const path = canonicalPath(item.view.path);
      if (
        path === "/root" ||
        restored.has(path) ||
        !["starting", "running", "paused", "completed", "failed", "stopped"].includes(
          item.view.state,
        )
      )
        throw new Error("Invalid saved thread registry");
      const view: ThreadView = { ...structuredClone(item.view), updatedAt: Date.now() };
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
        startup: new AbortController(),
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
    if (path.slice(1).split("/").length - 1 > (this.options.maxDepth ?? 8))
      throw new Error("Agent depth limit reached");
    if (this.records.size >= (this.options.maxThreads ?? 64))
      throw new Error("Total thread limit reached");
    this.assertCapacity();
    const type = structuredClone(this.options.getType(args.type));
    const parentRecord = parent && parent !== "/root" ? this.record(parent) : undefined;
    for (let ancestor = parent; ancestor && ancestor !== "/root"; ancestor = parentPath(ancestor)) {
      if (this.record(ancestor).stopRequested || this.record(ancestor).view.state === "stopped") {
        throw new Error(`Cannot spawn under stopped ancestor ${ancestor}; resume it first`);
      }
    }
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
      },
      definition: type,
      inherited,
      startup: new AbortController(),
      pauseRequested: false,
      stopRequested: false,
    };
    this.records.set(path, record);
    if (parentRecord && !parentRecord.driver) {
      record.contextReady = this.ensureDriver(parentRecord).then((driver) => {
        record.inherited = inheritContext(driver.snapshot());
        this.touch(record);
      });
      // start() awaits this promise; handle immediate rejection before its microtask begins.
      void record.contextReady.catch(() => {});
    }
    this.start(record, args.task);
    return args.wait === false ? this.view(record) : this.wait(caller, path, undefined, signal);
  }

  async steer(caller: string, path: string, message: string): Promise<ThreadView> {
    this.assertLive();
    path = canonicalPath(path, caller);
    this.assertAccess(caller, path);
    if (!message.trim()) throw new Error("Steering message must not be empty");
    const record = this.record(path);
    if (caller !== "/root" && this.record(caller).stopRequested)
      throw new Error("Stopping agents may not steer descendants");
    // A detached spawn reserves immediately, but its original task must reach prompt() before steering.
    const wasStarting = record.view.state === "starting";
    if (wasStarting) await record.started;
    this.assertLive();
    if (record.stopRequested && (wasStarting || active(record.view)))
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
    const driver = await this.ensureDriver(this.record(path));
    return JSON.stringify(driver.snapshot(), null, 2);
  }
  async deliver(path: string, content: string): Promise<void> {
    // Restored parents may be idle and unopened; reports still belong in their retained transcript.
    const driver = await this.ensureDriver(this.record(path));
    driver.sendUpdate(content);
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
    record.pauseRequested = false;
    record.stopRequested = false;
    record.startup = new AbortController();
    record.view.state = "starting";
    record.view.status = "Starting";
    delete record.view.output;
    delete record.view.error;
    const epoch = this.epoch;
    let markStarted!: () => void;
    record.started = new Promise((resolve) => {
      markStarted = resolve;
    });
    record.run = Promise.resolve().then(async () => {
      try {
        if (record.contextReady) await abortable(record.contextReady, record.startup.signal);
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
  private ensureDriver(record: Record): Promise<AgentDriver> {
    this.assertLive();
    if (record.driver) return Promise.resolve(record.driver);
    if (!record.initializing) {
      const signal = record.startup.signal;
      const creation = this.options
        .createDriver({
          path: record.view.path,
          type: record.definition,
          inherited: record.inherited,
          tools: this.options.toolsFor(record.view.path),
          parentPath: record.view.parent,
          sessionFile: record.view.sessionFile,
          signal,
          shouldPause: () => record.pauseRequested,
          onEvent: (event) => {
            if (active(record.view) && !record.pauseRequested) {
              record.view.status = event.text;
              this.touch(record);
            }
          },
        })
        .then(async (driver) => {
          if (this.disposed || signal.aborted) {
            await driver.abort();
            driver.dispose();
            throw new Error("Driver startup cancelled");
          }
          record.driver = driver;
          record.view.sessionFile = driver.sessionFile;
          return driver;
        });
      record.initializing = abortable(creation, signal).catch((error) => {
        record.initializing = undefined;
        throw error;
      });
    }
    return record.initializing;
  }
  private touch(record: Record): void {
    record.view.updatedAt = Date.now();
    if (!this.disposed) this.options.onEvent?.({ kind: "change", thread: this.view(record) });
  }
  private view(record: Record): ThreadView {
    return structuredClone({
      ...record.view,
      sessionFile: record.driver ? record.driver.sessionFile : record.view.sessionFile,
    });
  }
  private record(path: string): Record {
    const record = this.records.get(path);
    if (!record) throw new Error(`Unknown thread ${path}`);
    return record;
  }
  private assertLive(): void {
    if (this.disposed) throw new Error("Thread manager has shut down");
  }
  private assertCapacity(): void {
    if (
      [...this.records.values()].filter((record) => active(record.view)).length >=
      (this.options.maxConcurrent ?? 16)
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
