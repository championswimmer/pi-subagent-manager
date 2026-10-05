# Settings

Open with `/agents` (or `/agents settings`). Save with **Ctrl+S**. Changes apply immediately and never cancel running work.

## Files

| Scope   | Path                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------- |
| Global  | `<pi-agent-dir>/subagent-manager/settings.json` (normally `~/.pi/agent/subagent-manager/settings.json`) |
| Project | `<cwd>/.pi/agent/subagent-manager/settings.json` — trusted projects only; overrides global              |

All keys are optional. Defaults:

```json
{
  "subagentMode": "opportunistic",
  "widgetMode": "full",
  "nerdFontIcons": false,
  "modelSelection": "pick-first-scoped",
  "toolFiltering": "allowed",
  "maxLevels": 3,
  "maxConcurrent": 16,
  "maxThreads": 64
}
```

Unknown keys, bad values and symlinked paths produce warnings. An invalid file is ignored as a whole; the previous layer (or defaults) stays in effect.

Other packages' settings (e.g. `.pi/subagents.json`) are never read here.

---

## Subagent Mode (`subagentMode`)

How much the main model is encouraged to delegate.

| Option                    | What it does                                                                                                         | Use when                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `off`                     | Hides subagent tools; injects no guidance. Widget, notifications and import offer are hidden. `/agents` still works. | You want plain pi for a while, without uninstalling.             |
| `opportunistic` (default) | Tools on. Main model delegates only parallelizable or very large tasks; otherwise works directly.                    | Everyday use.                                                    |
| `orchestration`           | Tools on. `/root` delegates **all** execution and only coordinates and synthesizes.                                  | Big multi-part tasks where you want the main context kept clean. |

- Orchestration is a prompt policy, not a tool restriction. Workers don't inherit the root-only rule.
- Agent import needs `opportunistic` (it uses the main thread's file tools).

## Status Widget (`widgetMode`)

Controls the subagent status display above the input box. Choose **Status Widget** in `/agents` settings and save with **Ctrl+S**.

| Option             | Display |
| ------------------ | ------- |
| `full` (default)   | The existing multi-line tree with agent details, activity and navigation hints. |
| `minimal`          | One line of theme-colored status counts plus cumulative input `↑` / output `↓` tokens for agents currently starting or running. |

Minimal mode groups starting agents with running agents and excludes the main conversation. Token totals exclude completed, stopped, failed and paused agents. The fullscreen tree remains available via `/agents tree` in either mode.

## [labs] Nerd Font icons (`nerdFontIcons`)

Experimental features are tagged **[labs]** in settings. **[labs] Nerd Font icons** is an on/off toggle, **off by default**. Enable it in `/agents` and save with **Ctrl+S**, or set `"nerdFontIcons": true` in your settings file. Configure a [Nerd Font](https://www.nerdfonts.com/) in your terminal first; unsupported fonts may show boxes or incorrect glyphs. The extension does not install or detect fonts.

When enabled, an agent type’s optional `icon` appears before its readable name in the full widget, thread browsers, live watcher header, and type picker. Types without icons remain text-only; turning it off restores text-only labels without removing configured icons. The minimal widget remains an aggregate count, with no per-agent icons. Saved settings apply immediately to newly rendered widgets and dialogs.

All six bundled agents have [role-specific icons](default-agents.md#nerd-font-icons). Add or change an icon with **[labs] Icon** in `/agents types`, or the optional `icon` frontmatter field in [your own agent](custom-agents.md#icons-labs). Retained threads keep the icon from their saved agent definition.

## Model Picking (`modelSelection`)

Which model an agent gets when its session starts.

| Option                                                  | What it does                                                             | Use when                                                                                   |
| ------------------------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `pick-first-available` — **Pick First (available)**     | First entry in the type's `models` with configured credentials.          | You trust your per-agent lists and want them honored regardless of `/scoped-models`.       |
| `pick-first-scoped` — **Pick First (scoped)** (default) | Same, but the model must also be in the main session's `/scoped-models`. | You use `/scoped-models` as an allowlist (cost, compliance) and want agents to respect it. |
| `use-current` — **Use Current**                         | Ignores `models`; uses the main session's current model.                 | One model for everything, or quick testing.                                                |

- Types with no `models` inherit the parent's model in both Pick First modes.
- Your list's order decides, not the scoped list's order.
- No match → spawn fails clearly. An empty `/scoped-models` matches nothing.
- `use-current` always uses the **main** session's model, even for nested or reopened agents. Thinking levels stay per-agent.
- `modelSuggestions` never affects this.
- Switching modes doesn't change already-open sessions.
- Legacy `scopedModelFiltering: true` → `pick-first-scoped`; `false` → `pick-first-available`.

## Tool Filtering (`toolFiltering`)

How the type's `tools.allow` / `tools.block` lists are applied.

| Option                                             | What it does                                                         | Use when                                   |
| -------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------ |
| `allowed` — **Allowed (except blocked)** (default) | Only `allow` tools, minus `block`. Empty/missing `allow` = no tools. | Least privilege. Recommended.              |
| `all-except-blocked` — **All except blocked**      | Ignores `allow`; everything except `block`.                          | Your definitions only list what to forbid. |
| `all` — **All**                                    | Ignores both lists.                                                  | Trusted local experiments.                 |

- "All" includes child-local built-in and manager tools plus the main session's registered non-hidden tools. Exact-name allow/block lists apply to this inventory.
- Inherited tools retain exposure and active status. Deferred/codemode tools are discoverable through child-local codemode when permitted; direct tools remain model-facing when active.
- Built-in tools, manager controls, codemode and tool search remain child-local. External calls reuse main-session resources/context rather than loading fresh extensions or MCP connections. Bridged callable tools remain subject to the main session's tool policy; session-mutating external tools are not necessarily isolated to the child. Skills and project context files are not automatically loaded.
- Other custom **model-only** tools fail closed: the SDK cannot bridge them while preserving root permission/result hooks. Run those in the main session.
- UI/command-driven resumes after reopening the main session need a main-session `agent_*` tool call to establish the execution bridge; use `agent_steer` rather than the thread dialog.
- Applies to newly started sessions (including retained ones reopened after reload). Already-open sessions keep their selected tools, and the main session's tool set is unchanged.
- Non-default modes can expose `agent_spawn` to types that weren't meant to delegate.

## Max Levels (`maxLevels`)

Maximum tree depth, counting the main conversation as level 1. Integer 1–32. Default `3` = children and grandchildren.

| Value         | Effect                   | Use when                                             |
| ------------- | ------------------------ | ---------------------------------------------------- |
| `1`           | No new subagents         | Block spawning while still resuming existing threads |
| `2`           | Children only            | Flat fan-out; simplest to follow                     |
| `3` (default) | Children + grandchildren | An `architect` coordinating workers                  |
| `4+`          | Deeper trees             | Large hierarchical teams                             |

Independent roots like `/k` count as level 2, so they can't bypass the limit. Lowering it still lets you resume existing deeper threads.

## Max Concurrent (`maxConcurrent`)

Threads starting or running at once, across the whole tree. Parents waiting on children count. Default `16`.

Lower it for rate limits or cost. Raise it for wide fan-out. When full, spawns **fail** — they don't queue.

## Max Threads (`maxThreads`)

Total retained threads (any state) per main session. Default `64`.

Lower it to keep the tree tidy. Raise it for long sessions with many agents. When full, spawns fail.

## Scope

The dialog's scope field picks where to save: **global** or **trusted project**.
Your selection is remembered across dialog reopenings, projects, and Pi restarts,
even if you cancel. It is stored separately from manager settings in
`<agentDir>/subagent-manager/ui-state.json`. Untrusted projects always use Global
without overwriting your remembered choice. Existing project settings still
override global defaults; switching scope does not change the values shown.
