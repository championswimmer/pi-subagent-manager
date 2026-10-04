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
| Enter       | Watch thread; Main returns to the editor |
| i           | Existing actions: steer, stop, output, transcript |
| Esc         | Watcher → saved tree → Main |
| Ctrl+Q      | Return directly to Main |

Refreshes every second and keeps your selection, collapse state and scroll position.

### Live agent navigation (read-only)

The fullscreen watcher shows committed messages, the in-progress assistant reply/thinking, tool arguments/output updates, errors, and lifecycle status. It never sends a prompt, switches sessions, or changes model/tool/resource ownership. Inherited context is initially collapsed (**c** toggles it). Unsupported/custom content and images use safe text placeholders rather than native rich rendering. Legacy sessions without reliable inherited-prefix metadata show their whole transcript.

- **Up/Down, PageUp/PageDown, Home** scroll and pause following.
- **End** or **l** resumes following the live tail. Scroll/follow state is remembered per agent.
- **r** retries an unavailable observation without starting a turn. Starting threads are watchable; stopped/completed threads remain readable.
- Frames are sanitized, viewport-bounded and coalesced during bursts. Exit, root replacement and shutdown release observers/timers. Streaming deltas never enter persisted thread events.

#### Experimental exhausted-Down entry

Set `PI_SUBAGENT_NAVIGATION_EDITOR=1` before starting Pi to open the tree when focused physical **Down** has exhausted native history/cursor movement at the end of the draft. Native editing runs first; autocomplete, jumps, paste, configured shortcuts, duplicate history entries and changed drafts do not count as exhausted boundaries. Navigating preserves the main draft/cursor and does not require the root to be idle.

The editor adapter is **opt-in** pending the full real-terminal acceptance matrix. Unset the variable or use `PI_SUBAGENT_NAVIGATION_EDITOR=0` to leave the editor slot untouched; command entry still works. Pi has one custom-editor slot: installation is skipped if another factory owns it or an existing draft is nonempty, since the host cannot transfer cursor/undo/expanded-paste state. Load order can still let a later editor replace ours. Initial startup uses Pi's history hydration; replacement installations seed history once. Session-tree rebuilds keep the existing editor instance.

While navigation is open, the host fullscreen search shortcut is temporarily disabled through public keybindings to avoid stacking a second host overlay. The prior binding owner is restored only if no other extension replaced it. Independently opened overlays from unrelated extensions remain a host compatibility limitation.

Regular/fullscreen PTY smoke checks cover entry, root return, draft restoration, resize and host-search suppression. Broader manual acceptance (concurrent live turns, autocomplete/paste/undo interactions, remapped shortcuts and rich custom content) is still required before making the editor gesture default.

## Agents widget

A compact tree above the input editor, at most ten lines.

- Each row: colored type pill, path, state, task, active time, input `↑` / output `↓` tokens.
- A second, indented line shows latest activity.
- Active branches are shown first; overflow is counted, not listed.
- Time freezes while paused and resumes on continue.
