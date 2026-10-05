# Tools and UI

## Model-facing tools

| Tool           | Purpose                                              |
| -------------- | ---------------------------------------------------- |
| `agent_types`  | Names, descriptions, resolved models and thinking    |
| `agent_spawn`  | Start `{path, type, task, wait?}`. Waits by default. |
| `agent_wait`   | Wait for settlement; optional `timeoutMs`            |
| `agent_steer`  | Send `{path, message}`; queues input or resumes      |
| `agent_status` | Inspect one path or list visible threads             |
| `agent_update` | Child: report progress                               |
| `agent_pause`  | Child: pause without an answer                       |
| `agent_stop`   | Cancel a descendant and its subtree                  |
| `agent_output` | Page through long final answers by character offset  |

`agent_types` returns one compact line per type, with the model and effective thinking level
that a new child of the caller would use under current settings. Unresolvable types are
marked unavailable with a reason. Preference lists, advisory model suggestions and UI metadata
are omitted. Spawning under another parent path can change inherited settings.

```json
{
  "path": "controller-security-research",
  "type": "architect",
  "task": "Investigate controller security and plan the change",
  "wait": false
}
```

Then `agent_wait` or `agent_status` on `/root/controller-security-research`.

Child progress and completion notifications are retained in the main agent's context without adding visible chat messages. By default they do not start another turn, keeping the main agent's final response last in the conversation even when detached children finish later. The opt-in **[labs] Final Recap** setting asks an idle main agent to summarize newly completed or failed asynchronous agents; results arriving during a summary are handled after that summary finishes. Progress updates and foreground results do not trigger summaries. Enabling it uses more tokens and context. Use the Agents widget, `/agents tree`, or `agent_output` to inspect child status and answers.

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

### Live agent navigation

The fullscreen watcher renders steer and agent messages (including thinking) as Markdown, same as pi's main transcript. Tool calls use pi's built-in call formats (`$ command`, `read path:range`, `grep /pattern/ in path`, …) rather than bare JSON; unknown tools fall back to pretty-printed JSON. Tool results and other metadata show their name/status and only the first three wrapped lines of each output preview, followed by `...` when more is hidden. Use **i → Transcript** from the tree for retained tool details. **t** cycles three detail levels with transcript controls focused: **preview** (default: three rows per call, first three rendered thinking lines), **compact** (one line per call, thinking hidden), **full** (complete calls and thinking). Inherited context is initially collapsed (**c** toggles it with transcript controls focused). Watching alone never starts a turn, switches sessions, or changes model/tool/resource ownership. Unsupported/custom content and images use safe text placeholders rather than native rich rendering. Legacy sessions without reliable inherited-prefix metadata show their whole transcript.

- The bottom **Steer** input is focused initially. Type and press **Enter** to send to the inspected agent, including nested descendants, through the same service as `agent_steer`: running agents receive queued input; paused/completed/stopped agents resume their retained session. Empty input is ignored. Sending leaves the viewer open; failures are shown and preserve the draft for retry.
- **Tab** switches between steering input and transcript controls. While typing, **c/t/l/r** are ordinary text and **Home/End** move the input cursor. Pasting never submits by itself.
- **Up/Down, PageUp/PageDown** scroll and pause following in either mode. With transcript controls focused, **Home** scrolls to the start; **End** or **l** resumes following the live tail. Scroll/follow state is remembered per agent.
- **Ctrl+R** (or **r** with transcript controls focused) retries an unavailable observation without starting a turn. Starting threads are watchable; stopped/completed threads remain readable.
- Frames are sanitized, viewport-bounded and coalesced during bursts. Exit, root replacement and shutdown release observers/timers. Streaming deltas never enter persisted thread events.

#### Arrow-key shortcuts

While any subagent is **starting or running**, press physical **Left (←)** at the beginning of the main draft (or in an empty input) to open the subagent browser. With no active subagents, or elsewhere in the draft, Left retains normal cursor movement. `/agents tree` remains available regardless of agent activity. Down is always native editing/history navigation. Autocomplete, jumps, paste and configured shortcuts take precedence. Navigating preserves the main draft/cursor and does not require the root to be idle.

Press physical **Right (→)** at the end of the main draft (or in an empty input) to collapse the full widget to a single status line for this session. This does not save settings or change the configured **Status Widget** mode. Refreshes, agent resumes, new main turns and session-tree navigation keep it collapsed; starting, switching or reloading a session restores the configured mode. Left still opens the full dialog while subagents are active, without expanding the widget. Elsewhere in the draft Right retains normal cursor movement; autocomplete, jumps, paste and shortcuts take precedence.

Arrow-key shortcuts are enabled by default in the TUI; `/agents tree` remains available everywhere. Pi has one custom-editor slot: installation is skipped if another factory owns it or an existing draft is nonempty, since the host cannot transfer cursor/undo/expanded-paste state. Load order can still let a later editor replace ours. Initial startup uses Pi's history hydration; replacement installations seed history once. Session-tree rebuilds keep the existing editor instance.

While navigation is open, the host fullscreen search shortcut is temporarily disabled through public keybindings to avoid stacking a second host overlay. The prior binding owner is restored only if no other extension replaced it. **Known host limitation:** if an unrelated extension stacks another overlay above navigation, Pi's custom-UI completion can close the newer overlay instead. Avoid concurrent extension-owned overlays; a host identity-targeted completion API is needed to remove this limitation. No private host access or unsupported overlay-lifecycle workaround is used.

Run `python3 scripts/live-agent-navigation-smoke.py` after `npm install` for credential-free, offline POSIX PTY checks in regular/fullscreen mode (idle Left gating, explicit command entry, root return, resize and host-search suppression). No model prompts are submitted. Broader manual acceptance covers concurrent live turns, autocomplete/paste/undo interactions, remapped shortcuts and rich custom content.

## Agents widget

The widget above the input editor has two display modes, selected with **Status Widget** in `/agents` settings:

- **Full** (default): the existing compact tree, at most twelve lines.
- **Minimal**: a summary line such as `3 running, 2 stopped, 1 failed, 1 paused    ↑12k ↓3k`, with semantic theme colors. Starting agents count as running; completed agents are counted when present. Token totals include only currently starting/running agents, not the main conversation or settled threads. Use `/agents tree` for details.

Once the main turn has ended and no subagents are starting or running, either mode collapses to a single status-count line without the browser hint. The full tree remains available via `/agents tree`; **Left** at the start of the draft opens it only while subagents are starting or running. A fresh main prompt hides agents that were already settled (completed, failed, stopped or paused); they remain in `/agents tree` and reappear in the widget only when resumed. Agents still starting or running remain visible, and new agents appear normally. Automatic Final Recap turns keep the current task's results visible. Visible agents use the configured display mode unless Right has collapsed the widget for this session.

In full mode:

- One row per agent: colored type pill, path, state, task, active time, input `↑` / output `↓` tokens.
- Activity and lifecycle messages (such as `Completed; session retained`) are omitted to save space; detailed status remains available in `/agents tree` and `agent_status`.
- Active branches are shown first; the most recent agents within each state are preferred when previews overflow. Overflow is counted, not listed.
- Time freezes while paused and resumes on continue.
- A small status strip below the previews shows the running count (including starting agents) and **Press ← to open subagent browser**, including when agents overflow. The full footer also shows **→ collapse**. Minimal mode keeps **← browser** inline so it stays one line. Browser hints appear only while subagents are starting or running; RPC output omits keyboard hints.
- With **[labs] Nerd Font icons** enabled, starting/running agents show a cycling progress glyph in the widget and fullscreen tree/live-view headers. Settled agents retain static role icons. The minimal summary also animates its running count. Animation timers stop on settlement or disposal; RPC output stays static.

### Interrupts and stopping agents

With the main input focused (default keybindings):

- **Esc** aborts the main turn (including a pending `agent_wait` or foreground spawn wait), **not the subagents**. Already-started subagents keep running.
- **Ctrl+C** clears the input; it does not stop the main turn or subagents.
- **Ctrl+C twice quickly** (within 500 ms) exits Pi. Session shutdown cooperatively stops all agents, retaining their sessions.

Inside the tree/watcher, **Esc** returns to the previous view without stopping an agent. To stop one subtree without exiting Pi, open **`/agents tree`**, select an agent, press **i**, and choose **Stop**. This stops that agent and its working descendants; other branches continue. Cancellation is cooperative, not a guarantee of killing external processes.
