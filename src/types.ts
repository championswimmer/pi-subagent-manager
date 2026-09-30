import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export interface AgentType {
  name: string;
  description: string;
  model?: string;
  thinkingLevel?: ThinkingLevel;
  color?: string;
  tools?: { allow?: string[]; block?: string[] };
  systemPrompt: string;
  filePath?: string;
  source?: "bundled" | "user" | "project";
}
export type ThreadState = "starting" | "running" | "paused" | "completed" | "failed" | "stopped";
export interface ThreadView {
  path: string;
  parent: string | null;
  owner: string;
  type: string;
  color?: string;
  state: ThreadState;
  task: string;
  status: string;
  output?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  sessionFile?: string;
}
export interface DriverEvent {
  kind: "activity" | "error";
  text: string;
}
export interface AgentDriver {
  prompt(message: string): Promise<void>;
  steer(message: string): Promise<void>;
  snapshot(): AgentMessage[];
  output(): string;
  abort(): Promise<void>;
  dispose(): void;
  sendUpdate(content: string): void;
  sessionFile?: string;
}
export interface DriverOptions {
  path: string;
  type: AgentType;
  inherited: AgentMessage[];
  tools: ToolDefinition[];
  onEvent(event: DriverEvent): void;
  shouldPause(): boolean;
  parentPath: string | null;
  sessionFile?: string;
  signal: AbortSignal;
}
export interface SavedThreadView {
  path: string;
  parent: string | null;
  owner: string;
  type: string;
  color?: string;
  state: ThreadState;
  task: string;
  status: string;
  output?: string;
  error?: string;
  createdAt: number;
  sessionFile?: string;
}
export interface SavedThread {
  view: SavedThreadView;
  definition: AgentType;
  /** Reserved threads may not have a transcript yet; preserve their initial context. */
  inherited?: AgentMessage[];
}
export interface ThreadService {
  list(): ThreadView[];
  get(path: string): ThreadView;
  output(path: string): string;
  transcript(path: string): Promise<string>;
  spawn(
    args: { path: string; type: string; task: string; wait?: boolean },
    signal?: AbortSignal,
  ): Promise<ThreadView>;
  steer(path: string, message: string): Promise<ThreadView>;
  wait(path: string, timeoutMs?: number, signal?: AbortSignal): Promise<ThreadView>;
  update(message: string): ThreadView;
  pause(reason: string): ThreadView;
  stop(path: string): Promise<ThreadView>;
}
export type DriverFactory = (options: DriverOptions) => Promise<AgentDriver>;
export type ThreadEvent =
  | { kind: "change"; thread: ThreadView }
  | { kind: "update"; thread: ThreadView; message: string; recipient: string }
  | { kind: "settled"; thread: ThreadView; recipient: string };
export interface ManagerOptions {
  createDriver: DriverFactory;
  rootSnapshot(): AgentMessage[];
  getType(name: string): AgentType;
  toolsFor(path: string): ToolDefinition[];
  onEvent?(event: ThreadEvent): void;
  maxDepth?: number;
  maxThreads?: number;
  maxConcurrent?: number;
}
