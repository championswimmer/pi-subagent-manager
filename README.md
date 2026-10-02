# pi-subagent-manager

[![npm version](https://img.shields.io/npm/v/pi-subagent-manager.svg)](https://www.npmjs.com/package/pi-subagent-manager)
[![npm downloads](https://img.shields.io/npm/dm/pi-subagent-manager.svg)](https://www.npmjs.com/package/pi-subagent-manager)
[![CI](https://github.com/championswimmer/pi-subagent-manager/actions/workflows/tests.yml/badge.svg?branch=main)](https://github.com/championswimmer/pi-subagent-manager/actions/workflows/tests.yml)

A pi extension for named, steerable subagent threads. Agent **types** describe a model's job; thread **paths** describe its ancestry.

Requires pi **0.99.2+**. No build step.

```sh
pi install /absolute/path/to/pi-subagent
# Or try it without installing:
pi -e ./src/index.ts
```

## Threads and context

`/root` is the main pi conversation. A child gets a snapshot of its **lexical parent**, with its own system prompt and tool policy:

```text
/root
  /root/coding-researcher
  /root/change-file-names
    /root/change-file-names/review
/k                           # independent root: no /root history
  /k/l                       # inherits /k, never /root/coding-researcher
```

A nested parent must already exist. Relative names resolve under the calling agent. Root can control all trees; children can spawn immediate children and address only their descendants. Dot segments, URL escapes and ambiguous slash spellings are rejected.

Snapshots preserve conversation messages, including custom messages and shell output, but omit the parent's system prompt and unmatched tool calls/results. Later parent turns do not silently change a child's context. Model/thinking defaults inherit the effective parent's settings; independent roots use the main session's model defaults, **not its history**.

## Finish, pause, resume

There are two handback modes, with **one retained session**:

| Child action          | State       | Parent receives                         | Further work            |
| --------------------- | ----------- | --------------------------------------- | ----------------------- |
| Return a final answer | `completed` | Final answer, not the entire transcript | Resume the same session |
| Call `agent_pause`    | `paused`    | Status/reason, no final answer          | Resume the same session |

A child can report progress with `agent_update` without ending its task. Pause is enforced at the turn boundary. Call it alone, rather than alongside unrelated tools.

`agent_steer` queues input for a working child, or resumes a paused/completed/stopped child. `agent_stop` cancels a thread and its working descendants, retaining their sessions. Resume a stopped ancestor before continuing its descendants. Failure also retains the thread for inspection and retry.

New child conversations use pi's JSONL session format in the main session's session directory (normally `<pi-agent-dir>/sessions/<encoded-cwd>/`; custom session directories are respected). Each transcript has a name such as `worker /root/task` and a `parentSession` link to its lexical parent's transcript, so saved children appear as nested rows in `pi --resume` and `/resume` with **Threaded** sorting and an empty search. Recent/Fuzzy sorting and search show flat rows; named-only filtering can hide an unnamed parent. Independent roots link to the main session for display only; they still inherit no conversation history.

The parent saves the thread registry in its own session. `/reload` or reopening that parent restores retained threads; interrupted work becomes paused, never automatically restarted. Pending steering and progress mailboxes are persisted too. Existing transcripts under `<pi-agent-dir>/subagents/<parent-session-id>/` remain reopenable through the parent registry; they are not automatically moved or added to the native resume picker.

Resume the **main session** to continue using the managed thread tree and its tool policies. Opening a child directly in pi opens its transcript as a normal interactive session, not as a managed subagent. Avoid opening the same child while its parent is still running it. Because children are now ordinary sessions, `pi --continue` can pick a recently modified child instead of the main session; use `pi --resume` to select the main session explicitly.

A forked **main** session gets a fresh registry, so separate parents never write to the same child transcript. Parent tree navigation restores the selected branch's registry **and each child's saved transcript leaf**. Resuming from an older checkpoint creates another branch in the append-only child file; newer branches remain intact. Legacy registries without child leaf IDs reopen their latest transcript. In-memory main sessions cannot survive process exit.

## Agent types

### Shipped task-specialized defaults

| Type         | Thinking | Intended work                                                             |
| ------------ | -------- | ------------------------------------------------------------------------- |
| `explorer`   | `low`    | Fast repository lookup and behavior tracing, not audits or implementation |
| `tasker`     | `low`    | Short, bounded execution with clear acceptance criteria                   |
| `coder`      | `high`   | Sustained implementation, debugging, and refactoring                      |
| `reviewer`   | `high`   | Independent, evidence-led review; no unsolicited fixes                    |
| `researcher` | `high`   | Source-backed research and synthesis, subject to retrieval access         |
| `writer`     | `medium` | Creative long-form writing and voice-preserving revision                  |
| `designer`   | `medium` | Frontend visual hierarchy, interaction, and responsive/accessibility work |
| `architect`  | `high`   | Architecture, tradeoffs, planning, and explicitly authorized coordination |

All defaults **inherit the parent/default model** rather than pinning vendors that may be unavailable in `/scoped-models`. Customize model preferences per role with `/agents types`; thinking levels are explicit workload defaults, mapped by the SDK to model support. Each role has an explicit tool allowlist; only architect can delegate, and a planning request does not authorize execution.

Children do **not** inherit the parent's web/browser/MCP tools or skills. Researcher needs supplied sources or an available, authorized shell retrieval workflow for live research; otherwise it pauses for access. Designer must not claim visual/browser QA without actually available tooling and rendered inspection. Shell access is not enforced read-only: tool policies are **not an OS sandbox**.

Migration: replace generic `worker` with tasker for bounded jobs or coder for sustained work; use explorer for code lookup formerly assigned to researcher. Architect/researcher keep their names but have rewritten contracts. Custom overrides and retained threads are not renamed or overwritten.

See [task taxonomy, benchmark limitations, model recommendations, and evaluation guidance](docs/default-agents.md). Quantitative analysis is documented as an optional analyst specialization rather than another overlapping default.

Definitions are Markdown files with YAML frontmatter:

```markdown
---
name: coding-researcher
description: Investigate APIs and find evidence before implementation
models:
  - anthropic/claude-sonnet-4-6
  - openai/gpt-5
thinkingLevel: high
color: accent
tools:
  allow: [read, grep, find, ls, agent_types, agent_update, agent_pause]
  block: []
---

You are a coding researcher. Read the relevant source and documentation,
report concrete findings, and do not modify files.
```

The Markdown body is the agent's system prompt. `name` and `description` are required. Other fields are optional:

- **models:** an ordered YAML list of exact `provider/model-id` preferences. Model IDs may contain additional slashes. The first entry that exists in `/scoped-models` wins; the scan follows the list order, not the scoped-model order.
- **model:** deprecated compatibility alias for a single preference. Existing definitions still parse, but saving normalizes them to `models:` and does not write `model:` back out.
- **thinkingLevel:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. The SDK applies the selected model's supported levels.
- **color:** a pi semantic color, such as `accent`, `success`, `warning`, `error`, `muted` or `dim`, used as the background of the agent's type pill (e.g. `[researcher]`) and the foreground of its task-based path. Pill text is bold and automatically contrasts with the background. The color picker previews both; colors follow theme changes. Unset uses `accent`.
- **tools:** exact-name `allow` and/or `block` lists. Block wins. An empty allow list means **no tools**; omission allows supported tools. Unavailable names fail clearly, rather than widening access.

If `models`/`model` is omitted, the agent inherits the effective parent/default model. Matching is strict: preferences are matched verbatim against `/scoped-models`, and if none match — including when `/scoped-models` is empty — spawn fails with an actionable error instead of falling back to the registry.

Discovery precedence:

1. The eight bundled task-specialized defaults listed above.
2. `<pi-agent-dir>/agents/*.md` (normally `~/.pi/agent/agents/`).
3. `<cwd>/.pi/agents/*.md`, only when pi trusts the project.

Project types override global types. Malformed definitions and same-scope duplicate names produce diagnostics and fail closed for the affected type. Existing threads retain their original type definition; edits affect new threads.

### Configuration and thread UI

- `/agents types`: open the bordered agent-definition browser and two-column editor: **field names** on the left, **current values** on the right. **↑↓/Tab** selects fields, **Enter** edits, **Ctrl+S** saves, and **Esc** discards the draft. Multiline field dialogs use **Enter** for a newline and **Ctrl+S** to apply to the draft. Edit the system prompt, models, thinking, tools, color and save scope. Model preferences use an ordered picker: add available models (scoped entries are marked), remove entries, and move them up/down. The YAML editor edits the header together; **External editor** edits the whole Markdown file using `$VISUAL`, `$EDITOR`, or `vi`.
- `/agents reload`: reload definitions and show diagnostics.
- `/agents`: open a bordered settings dialog. Edit level, concurrency and retained-thread limits, choose global or trusted-project scope, and save with **Ctrl+S**. Settings apply immediately without interrupting existing work. **Agent definitions** opens the type editor.
- `/agents status`: open a live, bordered tree of all retained agents, including running and paused sessions. **↑↓** select, **←→** collapse/expand, **PgUp/PgDn** scroll, **Enter** inspect/resume/stop a thread, **Esc** close. The dialog refreshes every second and preserves selection.
- `/agents thread`: pick a retained thread, inspect its output/transcript, send input/resume, or stop it.
- `/agents thread /root/controller-security-research`: open one thread directly.

A compact, themed activity widget appears **below the editor, above pi's footer/status area**. Working threads are prioritized; excess rows are counted instead of taking over the screen. Each row shows a colored type pill and a matching foreground-only task path, with elapsed active time and cumulative input `↑` / output `↓` token counts on the right. Time refreshes every second while running; tokens refresh as the provider reports usage. Pauses freeze time; resuming accumulates it. The existing footer is unchanged.

## Model-facing tools

| Tool           | Purpose                                             |
| -------------- | --------------------------------------------------- |
| `agent_types`  | Discover current types and their intended jobs      |
| `agent_spawn`  | Spawn `{path, type, task, wait?}`; waits by default |
| `agent_wait`   | Wait for settlement; optional `timeoutMs`           |
| `agent_steer`  | Send `{path, message}` to a retained thread         |
| `agent_status` | Inspect one path, or list visible threads           |
| `agent_update` | Child progress report, without completion           |
| `agent_pause`  | Child pauses without an answer handback             |
| `agent_stop`   | Cooperatively cancel a descendant/subtree           |
| `agent_output` | Page through final text using character offsets     |

```json
{
  "path": "controller-security-research",
  "type": "researcher",
  "task": "Investigate controller security",
  "wait": false
}
```

Choose concise kebab-case paths describing the task, independently of the type. Then use `agent_wait` or `agent_status` on `/root/controller-security-research`.

### Parallel and nested work

Launch **all independent siblings with `wait: false` before waiting**. For example, `/root` can launch `team-a` and `team-b`, then each team can launch `worker-a` and `worker-b` the same way. This works even if tool calls are delivered sequentially: detached children run in separate SDK sessions. Same-turn foreground calls also overlap when pi executes their tool batch in parallel, but spawning one foreground child and awaiting it before launching the next is sequential.

Use the bundled `architect` for explicitly authorized team coordination. Other bundled roles intentionally do not delegate. A custom coordinating type's allow list must include `agent_spawn` and `agent_wait`. Children never bypass their tool policy or the shared limits; delegation does not provide unavailable web/browser capabilities.

### Manager settings

Settings belong to **this extension**, not another subagent package:

- Global: `<pi-agent-dir>/subagent-manager/settings.json` (normally `~/.pi/agent/subagent-manager/settings.json`).
- Project: `<cwd>/.pi/agent/subagent-manager/settings.json`, loaded only when pi trusts the project; overrides global values.

```json
{
  "maxLevels": 3,
  "maxConcurrent": 16,
  "maxThreads": 64
}
```

All keys are optional. `maxLevels` includes the main conversation as **L1**: the default permits L2 children and L3 grandchildren, but no L4. An independent root such as `/k` is still L2, so independent paths cannot bypass the limit. `maxLevels: 1` disables new children; supported values are integers from 1 to 32.

`maxConcurrent` counts starting/running threads **across the entire tree**, including parents waiting for children; `maxThreads` counts all retained threads. Both require positive safe integers. Capacity exhaustion fails clearly rather than queuing. Omitted settings use the defaults above. Unknown keys, malformed values and symlinked settings paths produce warnings; an invalid file is ignored atomically, preserving the preceding valid layer/defaults.

Use `/agents reload` to reload definitions and settings. New limits do not cancel existing threads or discard retained sessions; they govern new spawns and future concurrency reservations. Lowering the level limit still permits resuming previously retained deeper sessions, but no new agents can be spawned beyond the limit. `/reload` or reopening the parent also reloads settings. This extension does **not** read `.pi/subagents.json` or settings owned by `@tintinweb/pi-subagents`; avoid loading both extensions because they both register `/agents`.

Wait timeouts and cancellation do **not** kill detached children. Progress/settlement notifications do not force a parent model turn; they are recorded and visible for the parent's next interaction. Large final answers are paginated, not silently lost.

## Boundaries

- Tool policies are **not a sandbox**. Agents share the working directory and OS permissions; concurrent edits may conflict.
- Child sessions load pi built-in tools and this extension's controls, **not automatically discovered third-party extensions, MCP servers, skills or project context files**. This prevents recursive extension loading and keeps the tool policy explicit.
- Custom/native model provider registrations and runtime-only API keys are mirrored. Virtual/router models need a concrete configured model; unsupported providers fail with an actionable error.
- Defaults limit the tree to 3 levels including the main conversation, 16 active threads and 64 retained threads per parent session. Waiting agents count as active. Configure them using this extension's manager settings.

## Development

```sh
npm install
npm run check
npm test
npm run format:check
```

The suite is offline: meaningful lifecycle/policy tests plus scripted-provider SDK tests for nested parallel launches, level settings, pause, persistence and recovery. Generated JSONL scenarios cover multilevel nested agents, unopened lexical parents, interrupted work, durable mailboxes, root forks and same-file tree navigation. No live model credentials are required.

The code is deliberately layered:

- `config.ts`: frontmatter validation, precedence and atomic saves.
- `settings.ts`: validated global/project manager limits and safe configuration paths.
- `paths.ts`: canonical ancestry and safe context snapshots.
- `manager.ts`: runtime-independent ownership, lifecycle and retained registry. `scope(caller)` exposes the same caller-bound `ThreadService` to tools and UI.
- `runtime.ts`: isolated pi SDK sessions, providers and safe turn boundaries.
- `mailbox.ts`: accepted-input persistence, replay and transcript reconciliation.
- `tools.ts`: caller-bound model tool surface.
- `ui.ts`: configuration dialogs and activity/thread UI.
- `index.ts`: parent-session lifecycle and extension wiring.

The initial design is kept in [`.agents/plans`](.agents/plans); superseded review snapshots have been removed. Research came before implementation: [Claude](docs/research-claude.md) and [Codex](docs/research-codex.md).
