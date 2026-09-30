# pi-subagent implementation contract

Research was completed and committed in 607d42e before implementation. See docs/research-{claude,codex}.md. This is a custom Pi surface: Claude-style frontmatter definitions + Codex-style paths + explicit pause/retain/resume.

## Identity and inheritance
- /root is main Pi thread. Paths use canonical absolute slash-separated names; shorthand is relative to caller. No dot segments, URL escapes, repeated/trailing slashes.
- A spawned child snapshots ONLY its lexical parent at spawn, not the caller. Nested lexical parent must already exist. Independent top-level roots (/k) have empty inherited messages. /root owns independent roots operationally but does NOT donate their context.
- Root controls every thread. Nonroot agents control only their descendants; self status is allowed. Wait on self/ancestors forbidden.
- Types are distinct from paths. Type definition has name, description, optional model (provider/id), optional thinkingLevel (off/minimal/low/medium/high/xhigh/max), color (Pi semantic foreground), tools {allow?: string[], block?: string[]}. Markdown body = systemPrompt. Strict tool names, block wins. Explicit empty allow = no tools.
- Global <getAgentDir()>/agents/*.md; trusted project <cwd>/.pi/agents/*.md overrides global. Bundled default researcher/worker are fallback. Fail malformed definitions with actionable diagnostics, do not silently broaden tool access.

## Shared modules
- src/types.ts contracts (main owns).
- src/config.ts parser, serializer, tool selection, ConfigStore; tests/config.test.ts (config coder owns).
- src/ui.ts type editor via Pi dialogs + external editor terminal handoff, thread UI, themed belowEditor widget; tests/ui.test.ts where practical (UI coder owns).
- src/runtime.ts SDK driver implementing DriverFactory from types.ts; tests/runtime.test.ts (runtime coder owns).
- src/paths.ts context sanitation and validation, src/manager.ts lifecycle, src/tools.ts model tool wrappers, src/index.ts host integration, tests/manager.test.ts and paths.test.ts (main owns).

## Driver contract
AgentDriver: prompt(message): Promise<void> resolves at actual settled state; steer(message): Promise<void> queues without awaiting current run; snapshot(): AgentMessage[]; output(): string; abort(): Promise<void>; dispose(): void; sendUpdate(content): void enqueues parent status without triggering a turn. DriverFactory async accepts DriverOptions {path,type,inherited,tools,onEvent,shouldPause}. onEvent event {kind:'activity'|'error', text:string}; shouldPause reads manager pauseRequested. Factory registers tools passed in options, uses isolated SDK resource loader, binds extensions, and stops continuation at pause turn boundary. Default model/thinking fall back to lexical parent (or main defaults for independent root, settings not history). Model catalog/auth from root ExtensionContext; do not use private runtime fields.

Manager owns states starting/running/paused/completed/failed/stopped; paused has no completion handback output. Completion and status event stream routed to lexical parent, independent roots operational owner /root. Stop aborts descendants, retains sessions for resume. Shutdown aborts and disposes everything. User refinement: both completed (handback) and paused (no handback) are retained and resumable, using same persisted SDK JSONL session. Driver.sessionFile is optional, DriverOptions.sessionFile reopens existing JSONL. Root registry is saved via pi.appendEntry and restored from active branch on session_start. On reload previously running/starting become paused with explicit interrupted reason; no automatic restart. SavedThread includes view and definition snapshot so changed config doesn't mutate existing threads. New sessions isolate root registry; no raw thread history folded into parent, only final answer for completed. Snapshot cloned and removes root system prompts and unmatched tool calls/results.

## Tools
agent_spawn {path,type,task,wait?:boolean=true}; agent_wait {path,timeoutMs?:number}; agent_steer {path,message}; agent_status {path?:string}; agent_update {message}; agent_pause {reason}; agent_stop {path}; agent_output {path,offset?:number,limit?:number}. Poll status explicitly supported; background completion/progress notifications delivered without unsolicited automatic model continuation. Pause returns state/reason not a final answer; /agents thread PATH offers transcript view, input/resume and stop. Lifecycle tools honor explicit tool filters.

## Safety and test gates
No auto-loaded parent external extensions/MCP inside child; supported tools are Pi builtins plus this extension's agent_* controls. Exact whitelist validation rejects unavailable tool names. All sessions share cwd and OS rights; tool filtering NOT sandbox. Limits depth/concurrency/total threads protect against recursive cost; waiting parents must not hold provider slots indefinitely. Cancellation stops waiting, not detached child; timeout resolves status. Parallel state mutations are reserved synchronously before awaits.

npm run check, npm test, SDK extension loading smoke test with no credentials, pack dry-run. Research commit; contracts/scaffold commit; config/lifecycle commit; integrated UI/runtime commit; verification/docs final commit. Agents do not commit or modify others' files.
