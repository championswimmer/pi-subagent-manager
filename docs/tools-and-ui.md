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

The fullscreen watcher shows steer and agent messages in full, including the in-progress assistant reply. Tool calls, results, and other metadata show their name/status and only the first three wrapped lines of each arguments/output preview, followed by `...` when more is hidden. Use **i → Transcript** from the tree for retained tool details. Thinking is initially hidden (**t** toggles it). It never sends a prompt, switches sessions, or changes model/tool/resource ownership. Inherited context is initially collapsed (**c** toggles it). Unsupported/custom content and images use safe text placeholders rather than native rich rendering. Legacy sessions without reliable inherited-prefix metadata show their whole transcript.

- **Up/Down, PageUp/PageDown, Home** scroll and pause following.
- **End** or **l** resumes following the live tail. Scroll/follow state is remembered per agent.
- **r** retries an unavailable observation without starting a turn. Starting threads are watchable; stopped/completed threads remain readable.
- Frames are sanitized, viewport-bounded and coalesced during bursts. Exit, root replacement and shutdown release observers/timers. Streaming deltas never enter persisted thread events.

#### Left-arrow entry

Press physical **Left (←)** at the beginning of the main draft (or in an empty input) to open the subagent browser. Elsewhere, Left retains normal cursor movement. Down is always native editing/history navigation. Autocomplete, jumps, paste and configured shortcuts take precedence. Navigating preserves the main draft/cursor and does not require the root to be idle.

Left-arrow entry is enabled by default in the TUI; `/agents tree` remains available everywhere. Pi has one custom-editor slot: installation is skipped if another factory owns it or an existing draft is nonempty, since the host cannot transfer cursor/undo/expanded-paste state. Load order can still let a later editor replace ours. Initial startup uses Pi's history hydration; replacement installations seed history once. Session-tree rebuilds keep the existing editor instance.

While navigation is open, the host fullscreen search shortcut is temporarily disabled through public keybindings to avoid stacking a second host overlay. The prior binding owner is restored only if no other extension replaced it. **Known host limitation:** if an unrelated extension stacks another overlay above navigation, Pi's custom-UI completion can close the newer overlay instead. Avoid concurrent extension-owned overlays; a host identity-targeted completion API is needed to remove this limitation. No private host access or unsupported overlay-lifecycle workaround is used.

Run `python3 scripts/live-agent-navigation-smoke.py` after `npm install` for credential-free, offline POSIX PTY checks in regular/fullscreen mode (entry, root return, draft restoration, resize and host-search suppression). No model prompts are submitted. Broader manual acceptance covers concurrent live turns, autocomplete/paste/undo interactions, remapped shortcuts and rich custom content.

## Agents widget

The widget above the input editor has two display modes, selected with **Status Widget** in `/agents` settings:

- **Full** (default): the existing compact tree, at most twelve lines.
- **Minimal**: a summary line such as `3 running, 2 stopped, 1 failed, 1 paused    ↑12k ↓3k`, with semantic theme colors. Starting agents count as running; completed agents are counted when present. Token totals include only currently starting/running agents, not the main conversation or settled threads. Use `/agents tree` for details.

In full mode:

- Each row: colored type pill, path, state, task, active time, input `↑` / output `↓` tokens.
- A second, indented line shows latest activity.
- Active branches are shown first; the most recent agents within each state are preferred when previews overflow. Overflow is counted, not listed.
- Time freezes while paused and resumes on continue.
- A small status strip below the previews shows the running count (including starting agents) and **Press ← to open subagent browser**, including when agents overflow. Minimal mode also shows the hint. RPC output omits the keyboard hint.

### Interrupts and stopping agents

With the main input focused (default keybindings):

- **Esc** aborts the main turn (including a pending `agent_wait` or foreground spawn wait), **not the subagents**. Already-started subagents keep running.
- **Ctrl+C** clears the input; it does not stop the main turn or subagents.
- **Ctrl+C twice quickly** (within 500 ms) exits Pi. Session shutdown cooperatively stops all agents, retaining their sessions.

Inside the tree/watcher, **Esc** returns to the previous view without stopping an agent. To stop one subtree without exiting Pi, open **`/agents tree`**, select an agent, press **i**, and choose **Stop**. This stops that agent and its working descendants; other branches continue. Cancellation is cooperative, not a guarantee of killing external processes.
