# Technical Research: OpenAI Codex subagents / multi-agent lifecycle

## Summary
Current upstream Codex has **two distinct subagent tool surfaces**. **MultiAgent V1** matches the classic lifecycle you asked about (`spawn_agent` → `send_input` → `wait_agent` → `close_agent` / `resume_agent`), but it is centered on **thread IDs**. **MultiAgent V2** matches the **hierarchical `/root/...` path model** you want, but it changes the lifecycle to `spawn_agent` → `send_message` / `followup_task` → `wait_agent` → `interrupt_agent`, with **no model-facing `close_agent` or `resume_agent`**. This means your desired combination of **path hierarchy + V1 lifecycle verbs** is **not a single upstream interface today**; it is a custom requirement built from parts that upstream currently splits across V1 and V2. [Docs](https://developers.openai.com/codex/subagents) [V1/V2 source](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs)

## Key Code Examples & APIs

### Surface comparison

| Concern | Upstream V1 | Upstream V2 |
| --- | --- | --- |
| Spawn result | `agent_id` + optional nickname | canonical `task_name` (+ optional nickname) |
| Primary targeting | thread id | hierarchical task path |
| Send more work | `send_input` | `send_message` or `followup_task` |
| Wait semantics | explicit target wait for final statuses | mailbox-activity wait, not target-specific |
| Stop/close | `close_agent` | `interrupt_agent` |
| Reopen | `resume_agent` | no model-facing resume |

Sources: [tool spec](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs), [V1 handlers](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents.rs), [V2 handlers](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_v2.rs)

### V1 lifecycle shape
```json
{
  "tool": "multi_agent_v1.spawn_agent",
  "arguments": { "message": "Investigate X", "fork_context": false }
}
```
```json
{
  "tool": "multi_agent_v1.send_input",
  "arguments": { "target": "<agent_id>", "message": "Continue", "interrupt": false }
}
```
```json
{
  "tool": "multi_agent_v1.wait_agent",
  "arguments": { "targets": ["<agent_id>"], "timeout_ms": 30000 }
}
```
```json
{ "tool": "multi_agent_v1.close_agent", "arguments": { "target": "<agent_id>" } }
```
```json
{ "tool": "multi_agent_v1.resume_agent", "arguments": { "id": "<agent_id>" } }
```
Sources: [spec](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs), [spawn](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents/spawn.rs), [send_input](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents/send_input.rs), [wait](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents/wait.rs), [close](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents/close_agent.rs), [resume](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents/resume_agent.rs)

### V2 lifecycle shape
```json
{
  "tool": "spawn_agent",
  "arguments": {
    "task_name": "researcher",
    "message": "Investigate X",
    "fork_turns": "none"
  }
}
```
```json
{
  "tool": "send_message",
  "arguments": { "target": "researcher", "message": "One more angle" }
}
```
```json
{
  "tool": "followup_task",
  "arguments": { "target": "/root/researcher", "message": "Now verify Y" }
}
```
```json
{ "tool": "wait_agent", "arguments": { "timeout_ms": 30000 } }
```
```json
{ "tool": "interrupt_agent", "arguments": { "target": "/root/researcher" } }
```
Sources: [spec](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs), [spawn](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs), [message flow](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs), [wait](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs), [interrupt](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_v2/interrupt_agent.rs)

### Path hierarchy
- Root agent path is `/root`.
- If the current agent is `/root/task1` and it spawns `task_3`, upstream V2 makes the child `/root/task1/task_3`.
- That child can be referred to locally as `task_3` or canonically as `/root/task1/task_3`.
- A sibling branch like `/root/task2/task_3` does **not** get that shorthand; it must use the canonical path.

Sources: [spawn tool description](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs), [path construction](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_common.rs)

### Custom agent files
```toml
# .codex/agents/reviewer.toml
name = "reviewer"
description = "PR reviewer focused on correctness, security, and missing tests."
model = "gpt-6.1-sol"
model_reasoning_effort = "medium"
sandbox_mode = "read-only"
developer_instructions = """
Review code like an owner.
Prioritize correctness, security, behavior regressions, and missing test coverage.
"""
```
Source: [official subagents docs](https://developers.openai.com/codex/subagents)

## Findings
1. **The public Codex docs are conceptual; the source is required for exact tool semantics.** Official docs say current local Codex clients support subagent workflows by default, surface subagent activity in the desktop app / CLI / IDE, and support custom agents in `~/.codex/agents/` or `.codex/agents/`. But the docs do **not** spell out the exact model-facing tool API; the current open-source implementation does. [Docs](https://developers.openai.com/codex/subagents)

2. **Upstream currently ships two different multi-agent APIs, not one.** V1 exposes namespaced tools `multi_agent_v1.spawn_agent`, `send_input`, `resume_agent`, `wait_agent`, and `close_agent`. V2 exposes `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, and `list_agents`. So `send_input` / `resume_agent` / `close_agent` are **V1 concepts**, while hierarchical task paths are a **V2 concept**. [Tool spec](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs) [V1 module](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents.rs) [V2 module](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_v2.rs)

3. **The exact lifecycle you asked for exists upstream only in V1.** In V1, `spawn_agent` returns an `agent_id`; `send_input` targets that id and can queue or interrupt; `wait_agent` waits on explicit target ids and returns final statuses; `close_agent` shuts down the target and descendants; `resume_agent` reopens a closed agent by id. [spawn](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents/spawn.rs) [send_input](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents/send_input.rs) [wait](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents/wait.rs) [close](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents/close_agent.rs) [resume](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents/resume_agent.rs)

4. **V2 replaces that lifecycle with path-based messaging and runtime-managed reuse.** `send_message` queues text without triggering a turn; `followup_task` sends text and triggers a turn; `interrupt_agent` interrupts the current turn but explicitly keeps the agent reusable; `list_agents` enumerates live agents in the current root tree. There is **no model-facing `close_agent` or `resume_agent` in V2**, so load/unload/resume are runtime concerns, not agent tools. [spec](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs) [message flow](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_v2/message_tool.rs) [followup_task](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_v2/followup_task.rs) [interrupt](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_v2/interrupt_agent.rs) [list_agents](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_v2/list_agents.rs)

5. **V2 path behavior already matches most of the hierarchy you want.** Upstream V2 constructs a canonical child path by taking the caller’s current agent path (or `/root`) and appending `task_name`. That means `/a/b` spawning `c` yields `/a/b/c`, and `/k/l` is a different subtree. The tool description explicitly says a child can be referred to by local shorthand (`task_3`) or canonical path, but a sibling subtree must use the canonical path. This confirms hierarchical naming, not unconditional history inheritance: V2 separately controls history with `fork_turns`. Pi-subagent will make the lexical-parent snapshot rule explicit and will not inherit from an unrelated caller. [path construction](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_common.rs) [spawn description](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs)

6. **Important distinction: upstream separates `task_name` from role selection.** In V2, `task_name` is the path label segment, so `task_name = "researcher"` can produce `/root/researcher`. But the actual role/model/instructions come from `agent_type` and/or a custom agent file, not from `task_name` itself. That means “`/root/researcher`” is a valid upstream path label, but it does **not** automatically mean “spawn the `researcher` custom agent” unless role selection is also configured and exposed. [spawn args/spec](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs) [official custom-agent docs](https://developers.openai.com/codex/subagents)

7. **Context inheritance is explicit and different between V1 and V2.** V1 has `fork_context: bool`; `true` forks the current thread history, `false` starts from only the delegated prompt. V2 has `fork_turns`, which accepts `none`, `all`, or a positive integer string like `"3"`; in current source, omitted `fork_turns` defaults to `all`. So V2 supports fresh children, full-history forks, and partial-history forks. [V1 spec](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs) [V2 spawn parser](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_v2/spawn.rs)

8. **Child config inheritance is parent-first, then layered overrides.** The source builds a child config from the parent’s effective config and live turn state, then applies requested model/reasoning overrides, then optional role/custom-agent config, then reapplies runtime-only overrides such as approval policy, permission profile, and cwd. Official docs match this: custom agents can define `model`, `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`, and `skills.config`, while omitted values inherit from the parent/default resolution chain. [child config source](https://github.com/openai/codex/blob/main/codex-rs/core/src/agent/child_config.rs) [docs](https://developers.openai.com/codex/subagents)

9. **Officially documented agent config covers the key knobs you asked about.** `agents.enabled` defaults to `true`; `agents.max_concurrent_threads_per_session` caps spawned threads; `agents.max_threads` is a legacy alias; `agents.default_subagent_model` and `agents.default_subagent_reasoning_effort` provide defaults; `agents.interrupt_message` controls whether interruption is recorded into model-visible context. Custom agent files require `name`, `description`, and `developer_instructions`. [config reference summary](https://developers.openai.com/codex/config-file/config-reference) [subagents docs](https://developers.openai.com/codex/subagents)

10. **`wait_agent` is materially different across versions, and this matters for any implementation that wants parity.** V1 `wait_agent` takes explicit `targets` and waits for final statuses, returning per-target status objects. V2 `wait_agent` takes only an optional timeout and waits for **mailbox activity or steered input**, returning a brief message plus `timed_out`; it is **not** a target-specific join/barrier API. [V1 wait](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents/wait.rs) [V2 wait](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs) [spec text](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs)

11. **The current CLI/TUI explicitly surfaces subagent state and path-based activity.** Public docs say activity is visible in the app/CLI/IDE; current TUI code renders Started / Interacted / Interrupted / Completed activity rows, shows a `/subagents` picker, and surfaces states such as Pending init, Running, Interrupted, Completed, Error, Shutdown, and Not found. [docs](https://developers.openai.com/codex/subagents) [TUI source](https://github.com/openai/codex/blob/main/codex-rs/tui/src/multi_agents.rs)

12. **Bottom line: your requested design partly matches upstream and partly extends it.** Hierarchical naming matches upstream V2; Pi-subagent’s mandatory lexical-parent snapshot rule is a custom constraint (upstream controls forks separately). The classic `send_input` / `resume_agent` / `close_agent` lifecycle is upstream V1 behavior. A system that wants **both together** would be implementing a **custom Pi surface**, not copying one current Codex surface verbatim. [V1/V2 spec](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs)

## Sources
- Kept: OpenAI Codex Subagents docs (<https://developers.openai.com/codex/subagents>) — official product-level behavior, inheritance, custom agent schema, and UI claims.
- Kept: OpenAI Codex config reference (<https://developers.openai.com/codex/config-file/config-reference>) — official `[agents]` settings and defaults/aliases.
- Kept: `multi_agents_spec.rs` (<https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_spec.rs>) — authoritative model-facing tool schema for V1 and V2.
- Kept: V1 handler sources (`multi_agents/*.rs`) — authoritative lifecycle behavior for `send_input`, `resume_agent`, `wait_agent`, `close_agent`.
- Kept: V2 handler sources (`multi_agents_v2/*.rs`) — authoritative lifecycle behavior for `spawn_agent`, `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, `list_agents`.
- Kept: `child_config.rs` (<https://github.com/openai/codex/blob/main/codex-rs/core/src/agent/child_config.rs>) — authoritative config inheritance / override logic.
- Kept: `multi_agents_common.rs` (<https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/multi_agents_common.rs>) — authoritative path construction for child agents.
- Kept: TUI source (`tui/src/multi_agents.rs`) — corroborates current user-visible status surfacing.
- Dropped: GitHub issues discussing docs/runtime mismatch for custom agents — useful background, but secondary to current docs + source and not needed for the checked conclusions here.
- Dropped: Community forum posts about subagent model selection — secondary and partially stale relative to current `main`.
- Dropped: PR discussions where current `main` source already reflects the merged behavior — helpful history, but less authoritative than the resulting code.

## Gaps
- I did **not** audit every app-server/generated wire schema; if implementation later depends on exact desktop/web protocol payloads, inspect `codex-rs/protocol/src/items.rs` and app-server type exports directly.
- The public config docs I checked do **not** appear to document every V2-specific internal knob; where V2 behavior matters here, I relied on current source rather than public config docs.
- If later implementation needs exact name-resolution rules for every V2 tool (not just the documented path behavior), inspect the current `AgentControl::resolve` path in upstream source before coding.
