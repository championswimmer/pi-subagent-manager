# Tools and UI

## Model-facing tools

| Tool           | Purpose                                              |
| -------------- | ---------------------------------------------------- |
| `agent_types`  | List types and what they're for                      |
| `agent_spawn`  | Start `{path, type, task, wait?}`. Waits by default. |
| `agent_wait`   | Wait for settlement; optional `timeoutMs`            |
| `agent_steer`  | Send `{path, message}`; queues input or resumes      |
| `agent_status` | Inspect one path or list visible threads             |
| `agent_update` | Child: report progress                               |
| `agent_pause`  | Child: pause without an answer                       |
| `agent_stop`   | Cancel a descendant and its subtree                  |
| `agent_output` | Page through long final answers by character offset  |

```json
{
  "path": "controller-security-research",
  "type": "architect",
  "task": "Investigate controller security and plan the change",
  "wait": false
}
```

Then `agent_wait` or `agent_status` on `/root/controller-security-research`.

## Parallel and nested work

- Launch **all independent siblings with `wait: false`, then wait**. Spawning one foreground child and waiting before the next is sequential.
- Nesting works the same way: `/root` launches `team-a` and `team-b`; each launches its own workers.
- Only `architect` delegates among bundled types. A custom coordinator needs `agent_spawn` and `agent_wait` in `tools.allow`.
- Limits are shared across the tree — see [settings](settings.md#max-levels-maxlevels).

## Commands

| Command                       | Does                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `/agents`, `/agents settings` | [Settings](settings.md) dialog. **Agent definitions** jumps to the type editor.    |
| `/agents types`               | Type browser and editor — see [custom agents](custom-agents.md#editing-in-the-tui) |
| `/agents tree [path]`         | Live full tree; optional path preselects. `/agents status` is an alias.            |
| `/agents import`              | [Import picker](importing-agents.md)                                               |
| `/agents reload`              | Reload definitions and settings; show diagnostics                                  |

### `/agents tree` keys

| Key         | Action            |
| ----------- | ----------------- |
| ↑↓          | Select            |
| ←→          | Collapse / expand |
| PgUp / PgDn | Scroll            |
| Enter       | Inspect thread    |
| Esc         | Close             |

Refreshes every second and keeps your selection.

## Agents widget

A compact tree above the input editor, at most ten lines.

- Each row: colored type pill, path, state, task, active time, input `↑` / output `↓` tokens.
- A second, indented line shows latest activity.
- Active branches are shown first; overflow is counted, not listed.
- Time freezes while paused and resumes on continue.
