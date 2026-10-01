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

Child conversations use pi's JSONL session format under `<pi-agent-dir>/subagents/<parent-session-id>/`. The parent saves the thread registry in its own session. `/reload` or reopening that parent restores retained threads; interrupted work becomes paused, never automatically restarted. Pending steering and progress mailboxes are persisted too.

A forked **main** session gets a fresh registry, so separate parents never write to the same child transcript. Parent tree navigation restores the selected branch's registry **and each child's saved transcript leaf**. Resuming from an older checkpoint creates another branch in the append-only child file; newer branches remain intact. Legacy registries without child leaf IDs reopen their latest transcript. In-memory main sessions cannot survive process exit.

## Agent types

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
- **color:** a pi semantic color, such as `accent`, `success`, `warning`, `error`, `muted` or `dim`, used as the background of the agent's name pill. Text is bold and automatically contrasts with the background. The color picker previews the pill; colors follow theme changes. Unset uses `accent`.
- **tools:** exact-name `allow` and/or `block` lists. Block wins. An empty allow list means **no tools**; omission allows supported tools. Unavailable names fail clearly, rather than widening access.

If `models`/`model` is omitted, the agent inherits the effective parent/default model. Matching is strict: preferences are matched verbatim against `/scoped-models`, and if none match — including when `/scoped-models` is empty — spawn fails with an actionable error instead of falling back to the registry.

Discovery precedence:

1. Bundled `researcher` and `worker` defaults.
2. `<pi-agent-dir>/agents/*.md` (normally `~/.pi/agent/agents/`).
3. `<cwd>/.pi/agents/*.md`, only when pi trusts the project.

Project types override global types. Malformed definitions and same-scope duplicate names produce diagnostics and fail closed for the affected type. Existing threads retain their original type definition; edits affect new threads.

### Configuration and thread UI

- `/agents types`: create/edit agent types. Field dialogs edit YAML defaults while preserving the prompt. Model preferences use an ordered picker: add available models (scoped entries are marked), remove entries, and move them up/down to control preference order. The YAML editor edits the header together; **Open in external editor** edits the whole Markdown file using `$VISUAL`, `$EDITOR`, or `vi`.
- `/agents reload`: reload definitions and show diagnostics.
- `/agents`: pick a thread, inspect its output/transcript, send input/resume, or stop it.
- `/agents thread /root/coding-researcher`: open one thread directly.

A compact, themed activity widget appears **below the editor, above pi's footer/status area**. Working threads are prioritized; excess rows are counted instead of taking over the screen. The existing footer is unchanged.

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
{ "path": "coding-researcher", "type": "researcher", "task": "Investigate this API", "wait": false }
```

Then use `agent_wait` or `agent_status` on `/root/coding-researcher`. Wait timeouts and cancellation do **not** kill detached children. Progress/settlement notifications do not force a parent model turn; they are recorded and visible for the parent's next interaction. Large final answers are paginated, not silently lost.

## Boundaries

- Tool policies are **not a sandbox**. Agents share the working directory and OS permissions; concurrent edits may conflict.
- Child sessions load pi built-in tools and this extension's controls, **not automatically discovered third-party extensions, MCP servers, skills or project context files**. This prevents recursive extension loading and keeps the tool policy explicit.
- Custom/native model provider registrations and runtime-only API keys are mirrored. Virtual/router models need a concrete configured model; unsupported providers fail with an actionable error.
- Defaults limit depth to 8, active threads to 16 and total retained threads to 64 per parent session. Waiting agents count as active. Limits live in `ManagerOptions`.

## Development

```sh
npm install
npm run check
npm test
npm run format:check
```

The suite is offline: meaningful lifecycle/policy tests plus scripted-provider SDK tests for pause, persistence and recovery. Generated JSONL scenarios cover multilevel nested agents, unopened lexical parents, interrupted work, durable mailboxes, root forks and same-file tree navigation. No live model credentials are required.

The code is deliberately layered:

- `config.ts`: frontmatter validation, precedence and atomic saves.
- `paths.ts`: canonical ancestry and safe context snapshots.
- `manager.ts`: runtime-independent ownership, lifecycle and retained registry. `scope(caller)` exposes the same caller-bound `ThreadService` to tools and UI.
- `runtime.ts`: isolated pi SDK sessions, providers and safe turn boundaries.
- `mailbox.ts`: accepted-input persistence, replay and transcript reconciliation.
- `tools.ts`: caller-bound model tool surface.
- `ui.ts`: configuration dialogs and activity/thread UI.
- `index.ts`: parent-session lifecycle and extension wiring.

The initial design is kept in [`.agents/plans`](.agents/plans); superseded review snapshots have been removed. Research came before implementation: [Claude](docs/research-claude.md) and [Codex](docs/research-codex.md).
