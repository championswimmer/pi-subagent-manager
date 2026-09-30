# Claude Code subagents / Agent SDK research

_Research only. No implementation done._

## Bottom line

- **Use file-based `.claude/agents/*.md` definitions if we need the full subagent feature surface** (`hooks`, `isolation: worktree`, `omitClaudeMd`, color, experimental cache TTL). **Programmatic SDK `AgentDefinition` is a subset**, and the Python SDK is the smallest subset. ([subagents docs](https://code.claude.com/docs/en/sub-agents), [TS SDK ref](https://code.claude.com/docs/en/agent-sdk/typescript), [Python SDK ref](https://code.claude.com/docs/en/agent-sdk/python), [Python source](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py))
- **Capability restriction is `tools` + `disallowedTools`.** In SDK session options, **`allowedTools` / `allowed_tools` only auto-approve permissions; they do not restrict availability**. ([TS SDK ref](https://code.claude.com/docs/en/agent-sdk/typescript), [permissions guide](https://code.claude.com/docs/en/agent-sdk/permissions))
- **Subagents are context-isolated by default**: fresh conversation, own system prompt, own context window, separate tool loop. They do **not** inherit the parent conversation history/tool results/auto memory/output style. ([subagents docs](https://code.claude.com/docs/en/sub-agents), [SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents))
- **Background is the default** in SDK/programmatic subagent use, and resume is a first-class concept; if we need live steering/interrupts/status handling, the streaming/client APIs matter more than one-shot `query()`. ([SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents), [SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions), [Python source `query.py`](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/query.py), [Python source `client.py`](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/client.py))

## 1) File-based frontmatter: supported fields

For custom subagent markdown files, the documented frontmatter fields are:

- **Required:** `name`, `description`
- **Optional:** `tools`, `disallowedTools`, `model`, `permissionMode`, `maxTurns`, `skills`, `mcpServers`, `hooks`, `memory`, `background`, `omitClaudeMd`, `effort`, `isolation`, `color`, `initialPrompt`, `experimental` (`cacheTtl` inside it)

Important config rules:

- **Exact camelCase matters** (`disallowedTools`, `maxTurns`, etc.).
- **Unknown fields are silently ignored**.
- `background: true` forces background execution.
- `isolation: worktree` is the documented file-based isolation mode.
- `omitClaudeMd: true` skips user/project/local `CLAUDE.md` loading for that subagent.

Source: [Create custom subagents](https://code.claude.com/docs/en/sub-agents)

## 2) SDK parity vs file-based frontmatter

### TypeScript `AgentDefinition` (documented)

Programmatic subagents in the TS Agent SDK support:

- `description`, `prompt`
- `tools`, `disallowedTools`
- `model`
- `skills`, `memory`, `mcpServers`
- `initialPrompt`, `maxTurns`
- `background`, `omitClaudeMd`
- `effort`, `permissionMode`
- `criticalSystemReminder_EXPERIMENTAL`

Source: [TS SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript), [SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents)

### Python `AgentDefinition` (documented + source-confirmed)

Current Python `AgentDefinition` supports:

- `description`, `prompt`
- `tools`, `disallowedTools`
- `model`
- `skills`, `memory`, `mcpServers`
- `initialPrompt`, `maxTurns`
- `background`, `effort`, `permissionMode`

Notably, the current Python implementation **does not define** `omitClaudeMd`, `hooks`, or `isolation` on `AgentDefinition`. That matches the narrower Python docs surface.

Sources: [Python SDK reference](https://code.claude.com/docs/en/agent-sdk/python), [Python source `types.py`](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py)

### Practical implication

If Pi needs per-agent `worktree` isolation, per-agent hooks, or full frontmatter parity, **do not assume programmatic `AgentDefinition` is enough**; the file-based subagent path is richer.

## 3) Tool allow/block semantics

### File-based / programmatic subagent capability shaping

- `tools` = **actual allowlist of tools present in the subagent session**.
- If `tools` is omitted, the subagent **inherits every tool available to subagents**.
- `disallowedTools` removes tools from the inherited/specified set.
- If a tool is left out, it is **not present at all** — no prompt, no fallback.

Sources: [Create custom subagents](https://code.claude.com/docs/en/sub-agents), [SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents)

### Do not confuse with SDK `allowedTools` / `allowed_tools`

- SDK `allowedTools` / `allowed_tools` are **permission auto-approval** lists.
- The docs are explicit: **“This does not restrict Claude to only these tools.”**
- Use `disallowedTools` to block tools at the session level; use subagent `tools` / `disallowedTools` to shape a subagent’s tool inventory.

Sources: [TS SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript), [permissions guide](https://code.claude.com/docs/en/agent-sdk/permissions)

### Universal subagent removals

The subagent docs say these are removed from **every** subagent, even if listed in `tools`:

- `AskUserQuestion`
- `EndConversation`
- `EnterPlanMode`
- `ScheduleWakeup`
- `WaitForMcpServers`
- `Workflow`

Conditionals:

- `ExitPlanMode` is removed unless the subagent `permissionMode` is `plan`
- `Agent` is removed at the depth limit

Source: [Create custom subagents](https://code.claude.com/docs/en/sub-agents)

### Foreground vs background tool surface

By default subagents inherit built-in + MCP tools from the main conversation, then Claude Code applies filters. The docs explicitly say **background subagents keep every MCP tool but only a reduced built-in set**:

`Read`, `Grep`, `Glob`, `LSP`, `Bash`, `PowerShell`, `Edit`, `Write`, `NotebookEdit`, `WebFetch`, `WebSearch`, `TodoWrite`, `Skill`, `ToolSearch`, `EnterWorktree`, `ExitWorktree`, `Monitor`, `TaskStop`, `SendMessage`, `Artifact` (plus `SubagentHandback` when applicable).

So the **same subagent definition can resolve to a different tool set in foreground vs background**.

Source: [Create custom subagents](https://code.claude.com/docs/en/sub-agents)

## 4) Context inheritance and isolation

### What a non-fork subagent gets at startup

The docs say a non-fork subagent starts fresh, but not empty. It gets:

- its **own system prompt** plus environment details
- the **delegation/task message**
- **`CLAUDE.md` files** (unless `omitClaudeMd`, and Explore/Plan skip them)
- a **git status snapshot** (Explore/Plan skip it)
- **preloaded skills** from the `skills` field
- a **sibling roster** reminder when `SendMessage` is available and other named agents exist

Sources: [Create custom subagents](https://code.claude.com/docs/en/sub-agents), [SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents)

### What it does **not** inherit

The docs explicitly say the subagent does **not** get:

- the parent **conversation history**
- the parent’s already-invoked **skills**
- the files Claude already **read**
- the parent **system prompt**
- the parent’s **auto memory**
- the parent’s **output style**
- the parent’s **context-window size** (the subagent’s model controls that)

Also: **skills do not inherit from the parent conversation**; if we want startup preload, we must list them in `skills`.

Sources: [Create custom subagents](https://code.claude.com/docs/en/sub-agents), [SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents)

### Working directory / isolation

- Subagents start in the parent session’s current working directory.
- `cd` inside Bash/PowerShell tool calls does not persist between calls.
- File-based agents can use `isolation: worktree` for a temporary git worktree.
- **Programmatic SDK AgentDefinition does not document per-agent `cwd`, `additionalDirectories`, or `isolation`.** Those controls are session-level, not per-agent.

Sources: [Create custom subagents](https://code.claude.com/docs/en/sub-agents), [TS SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript), [Python SDK reference](https://code.claude.com/docs/en/agent-sdk/python)

## 5) Foreground/background lifecycle

### Defaults and launch behavior

- In SDK subagents, **background is the default**.
- If an `Agent` tool call omits `run_in_background`, it launches a background subagent.
- Claude sets `run_in_background: false` when it needs the result before continuing.
- `background: true` forces background execution even when Claude wants the result.

Sources: [SDK subagents](https://code.claude.com/docs/en/agent-sdk/subagents), [Create custom subagents](https://code.claude.com/docs/en/sub-agents)

### Foreground behavior

- Foreground subagents **block the main conversation until complete**.
- Permission prompts are passed through to the user.

Source: [Create custom subagents](https://code.claude.com/docs/en/sub-agents)

### Background behavior

- Background subagents run concurrently while the main conversation continues.
- If a background subagent hits a permissioned tool call, Claude Code surfaces the prompt in the main session and names the subagent.
- `Esc` denies just that one tool call without stopping the subagent.
- Longer-lived permission grants apply to the **whole session**, including the main conversation.
- Results come back later as a **completion notification**; if asked early, Claude reports the subagent is still running.

Source: [Create custom subagents](https://code.claude.com/docs/en/sub-agents)

## 6) Steering, resume, stop/pause, status

### Steering

Documented steering controls:

- When fork mode is off, ask Claude to run a task in the **foreground** or **background**.
- Press **`Ctrl+B`** to background a running task.

Source: [Create custom subagents](https://code.claude.com/docs/en/sub-agents)

### Resume semantics

- Each subagent invocation is a **new instance** unless explicitly resumed.
- A resumed subagent retains **full conversation history, tool calls, results, and reasoning**.
- A completed subagent resumes **in the background** without a new `Agent` invocation.
- A resumed run keeps the **tool set from the first run**.
- Built-in **Explore** and **Plan** are **one-shot** and return no agent ID, so they **cannot be resumed**.

Source: [Create custom subagents](https://code.claude.com/docs/en/sub-agents)

### Session-level continue / resume / fork

SDK session semantics:

- `continue` / `continue_conversation=True` = resume the **most recent** session in the current directory
- `resume` = resume a **specific** `session_id`
- `fork` = create a **new** session with a copy of an existing session’s history
- `session_id` is returned on result messages

Source: [SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions)

### Status / monitoring surfaces

If Pi needs runtime observability, the official surfaces are:

- **SDK message stream**: background tasks (including subagents) emit `TaskStartedMessage`, `TaskProgressMessage`, and `TaskNotificationMessage` (`completed` / `failed` / `stopped`). ([Python SDK ref](https://code.claude.com/docs/en/agent-sdk/python))
- **Agent view CLI**: `claude agents --json` exposes session `state` = `working | blocked | done | failed | stopped`, live `status` = `busy | waiting | idle`, and `waitingFor` = `permission prompt | input needed | sandbox request | worker request | dialog open`. ([agent view](https://code.claude.com/docs/en/agent-view))

### Stop / pause behavior

- The Python streaming client exposes `interrupt()` and `stop_task(task_id)`; one-shot `query()` explicitly says **no interrupts / no follow-up messages**. ([Python source `client.py`](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/client.py), [Python source `query.py`](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/query.py))
- I found **no dedicated documented “pause subagent” API**. The documented controls are **background**, **stop**, and **resume**.
- If the user explicitly stops a subagent, it **does not auto-resume**; while its row is still present, the user can resume it from its transcript.

Sources: [Create custom subagents](https://code.claude.com/docs/en/sub-agents), [agent view](https://code.claude.com/docs/en/agent-view)

### Backgrounding a foreground session with active subagents

This is the closest thing to a “pause” semantic in the docs, and it matters:

- When backgrounding a foreground session, Claude Code tries to wait for running foreground subagents so work can carry over.
- If the user forces immediate backgrounding, **running subagents restart from the beginning** and previously spent tokens are spent again.
- Some work (for example active monitors) cannot carry over and is stopped.

Source: [agent view](https://code.claude.com/docs/en/agent-view)

## 7) Unsupported features / assumptions to avoid

- **Do not assume unknown frontmatter keys fail loudly.** The docs say they are silently ignored.
- **Do not assume `allowedTools` means capability restriction.** It is permission pre-approval, not tool removal.
- **Do not assume subagents can ask the user clarifying questions themselves.** `AskUserQuestion` is removed from every subagent.
- **Do not assume parent memory/style/history carry over.** Auto memory, output style, prior reads, and prior tool results do not.
- **Do not assume programmatic SDK agents can express all markdown-frontmatter features.** File-based config is richer, especially for `hooks` and `isolation`; Python is narrower still.
- **Do not assume a generic pause primitive exists.** The documented controls are backgrounding, stop, resume, and workflow/session-level carry-over behavior.
- **Do not assume per-agent filesystem scoping exists in the SDK.** No documented per-agent `cwd`, `additionalDirectories`, or `isolation` field exists in SDK `AgentDefinition`.

## Primary sources

- Claude Code subagents: https://code.claude.com/docs/en/sub-agents
- Agent SDK subagents: https://code.claude.com/docs/en/agent-sdk/subagents
- Agent SDK sessions: https://code.claude.com/docs/en/agent-sdk/sessions
- Agent SDK permissions: https://code.claude.com/docs/en/agent-sdk/permissions
- Agent view / background sessions: https://code.claude.com/docs/en/agent-view
- TypeScript SDK reference: https://code.claude.com/docs/en/agent-sdk/typescript
- Python SDK reference: https://code.claude.com/docs/en/agent-sdk/python
- Python SDK source (`AgentDefinition`): https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py
- Python SDK source (`query()`): https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/query.py
- Python SDK source (`ClaudeSDKClient`): https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/client.py
