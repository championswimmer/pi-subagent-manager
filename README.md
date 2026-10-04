# pi-subagent-manager

[![npm version](https://img.shields.io/npm/v/pi-subagent-manager.svg)](https://www.npmjs.com/package/pi-subagent-manager)
[![npm downloads](https://img.shields.io/npm/dm/pi-subagent-manager.svg)](https://www.npmjs.com/package/pi-subagent-manager)
[![CI](https://github.com/championswimmer/pi-subagent-manager/actions/workflows/tests.yml/badge.svg?branch=main)](https://github.com/championswimmer/pi-subagent-manager/actions/workflows/tests.yml)
[![codecov](https://codecov.io/gh/championswimmer/pi-subagent-manager/branch/main/graph/badge.svg)](https://codecov.io/gh/championswimmer/pi-subagent-manager)

A pi extension for named, steerable subagent threads. Agent **types** describe a model's job; thread **paths** describe its ancestry.

Requires pi **0.99.2+**. No build step.

```sh
pi install npm:pi-subagent-manager
```

For local development:

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

Six bundled roles cover the requested capabilities. Evidence-backed codebase and internet research goes to `researcher`; architecture and authorized coordination go to `architect`. Frontend implementation goes to `coder`. Targeted repository lookup goes to `tasker`. Independent review stays with `reviewer`. Creative and editorial prose stays with `writer`.

| Type        | Thinking | Intended work                                                            |
| ----------- | -------- | ------------------------------------------------------------------------ |
| `architect` | `high`   | Plans, tradeoffs, and authorized coordination                            |
| `coder`     | `high`   | Implementation, debugging, refactoring, and frontend UI                  |
| `researcher` | `high` | Source-backed codebase and internet research; no implementation edits    |
| `reviewer`  | `high`   | Evidence-led defects and the smallest local repair; no unsolicited fixes |
| `tasker`    | `low`    | Bounded jobs and targeted repository lookup                              |
| `writer`    | `medium` | Creative and editorial prose without invented facts                      |

All defaults **inherit the parent/default model**. They do not set `models` or `model`. Optional `modelSuggestions` are advisory display names only. They never select a runtime model, never count as a `/scoped-models` match, and never bypass scoped runtime preferences. Set real preferences with `/agents types` or a same-name user/project definition. Thinking levels are explicit workload defaults, mapped by the SDK to model support. Each role has an explicit tool allowlist; only architect can delegate, and a planning or research request does not authorize implementation.

Children can use the main session's registered non-hidden extension, web/browser, and MCP tools when the selected Tool Filtering policy permits them. The default researcher allowlist still selects local tools and authorized shell CLI/API routes; it reports access gaps rather than assuming retrieval tools are available. Skills are not automatically loaded. Architect can use supplied/local evidence or request a researcher when delegation is authorized. Coder must not claim rendered, accessibility, or browser QA without tooling that actually ran. Shell access is not enforced read-only: tool policies are **not an OS sandbox**.

Migration: bundled `worker`, `explorer`, and `designer` are not shipped. Use tasker for bounded jobs and repository lookup, coder for sustained implementation and frontend UI, architect for planning, and researcher for evidence research. Existing user/project `researcher` definitions still override the new bundled default; custom `designer` or `explorer` definitions still load. Project overrides user, and user overrides bundled. Retained threads keep their saved definitions. Nothing is renamed automatically.

See [default-agent routing, tool boundaries, and model suggestions](docs/default-agents.md), the [October 2026 model audit](docs/research-model-audit-2026-10.md), and [researcher workflow evidence](docs/research-researcher-workflow.md).

Definitions are Markdown files with YAML frontmatter:

```markdown
---
name: coding-researcher
description: Investigate APIs and find evidence before implementation
modelSuggestions:
  - sonnet-5.5
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

- **models:** an ordered YAML list of exact `provider/model-id` preferences. Model IDs may contain additional slashes. **Model Picking** controls selection: **Pick First (available)** picks the first available entry; **Pick First (scoped)** (default) additionally requires it to be in the main session's `/scoped-models`; **Use Current** ignores this list and uses the main session's current model. Preference order, not scoped-model order, determines the first match. Availability requires a configured provider with credentials.
- **model:** deprecated compatibility alias for a single preference. Existing definitions still parse, but saving normalizes them to `models:` and does not write `model:` back out.
- **modelSuggestions:** optional YAML list of advisory display names, such as `sonnet-5.5` or `gpt-6.1-sol`. These are not `provider/model-id` pins, not ordered runtime preferences, and not scoped-model matches. They never select a model and never bypass scoped runtime preferences, including when a definition also sets `models`. Omitting them leaves inheritance unchanged. A same-name user or project definition can replace the list; replacement still does not select a model unless that definition sets `models` or `model`.
- **thinkingLevel:** `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. The SDK applies the selected model's supported levels.
- **color:** a pi semantic color, such as `accent`, `success`, `warning`, `error`, `muted` or `dim`, used as the background of the agent's type pill (e.g. `[architect]`) and the foreground of its task-based path. Pill text is bold and automatically contrasts with the background. The color picker previews both; colors follow theme changes. Unset uses `accent`.
- **tools:** exact-name `allow` and/or `block` lists, applied according to the manager's **Tool Filtering** setting. By default, only listed `allow` tools are available and `block` wins; an empty or omitted allow list means **no tools**. Unavailable names in active lists fail clearly, rather than widening access; ignored lists do not affect tool selection.

In either **Pick First** mode, if `models`/`model` is omitted, the agent inherits the effective parent/default model. Matching is exact, and spawn fails clearly if no configured preference is available (or scoped, in scoped mode); it does not silently fall back. An empty `/scoped-models` list has no matches. **Use Current** always uses the main session's model, even for nested agents or reopened sessions; each agent's thinking level remains independent. `modelSuggestions` only assists searching in the model picker and never participates in runtime selection.

Discovery precedence:

1. The five bundled task-specialized defaults listed above.
2. `<pi-agent-dir>/subagent-manager/agents/*.md` (normally `~/.pi/agent/subagent-manager/agents/`).
3. `<cwd>/.pi/agent/subagent-manager/agents/*.md`, only when pi trusts the project.

These manager-owned directories are the only custom definition locations. Other packages' `<pi-agent-dir>/agents` and `.pi/agents` are **not** loaded directly; use the importer below.

Project types override global types. Malformed definitions and same-scope duplicate names produce diagnostics and fail closed for the affected type. Existing threads retain their original type definition; edits affect new threads.

### Import existing agents

On the first interactive TUI session with subagents enabled, the manager discovers external definitions read-only and offers an import. **Off** mode suppresses this automatic offer. After accepting, a **checkbox picker** lets you choose individual agents; nothing is selected by default. **↑↓** navigates, **Space** toggles a row, **Ctrl+A** toggles all, **Enter** submits (an empty selection skips), and **Esc** cancels. `/agents import` opens the picker again later, including after declining or cancelling.

The current session's model receives **only the selected file paths**, applicable source settings paths, the exact destination schema, current scoped models/tools, and detailed field-by-field migration instructions. It reads and writes the definitions itself in the existing conversation—there is **no deterministic conversion code** or separate importer agent/session. Originals remain untouched. Unsupported capabilities, lost security restrictions, unavailable models and collisions must be explained and approved before writing; compatible definitions need no second all-or-nothing selection. Definitions reload after model turns, or explicitly with `/agents reload`.

Sources researched: [`@tintinweb/pi-subagents` 0.19.0](https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/custom-agents.ts) and [npm `pi-subagents` 0.74.0](https://github.com/nicobailon/pi-subagents/blob/b6bda32f03b7f549623bc404c9be14dca298ddc4/src/agents/agents.ts). They are different packages with overlapping directories:

- Shared user definitions: `<pi-agent-dir>/agents`; npm also recursively scans `~/.agents`.
- Trusted project definitions: `.pi/agents`, `.agents/agents` (tintinweb), and recursive `.agents` (npm), including npm's nearest configured ancestor.
- npm's `PI_SUBAGENT_EXTRA_AGENT_DIRS` and source `settings.json` → `subagents.agentScanDirs` / `agentExcludeDirs` are discovery inputs. Overrides and defaults in source settings are interpreted by the model, not copied blindly.

Automatic project discovery requires project trust. Only agent definitions are offered: `skills`/`.skills` directory trees and all `SKILL.md` files are excluded (case-insensitively), even when a configured scan root points into them. Symlinks and `.chain.md` workflow files are excluded. Installed-package examples/builtins are not scanned; npm's optional git-root project anchoring is not reproduced. Shared paths do not establish a package identity; the model resolves the dialect from the selected fields. Import runs only in TUI mode; RPC/print/JSON sessions neither prompt nor consume first-run onboarding. A private `<pi-agent-dir>/subagent-manager/.import-offered` marker records that the offer was handled; it is not a converted-agent cache or capacity setting.

### Configuration and thread UI

- `/agents types`: open the bordered agent-definition browser and two-column editor: **field names** on the left, **current values** on the right. **↑↓/Tab** selects fields, **Enter** edits, **Ctrl+S** saves, and **Esc** discards the draft. Multiline field dialogs use **Enter** for a newline and **Ctrl+S** to apply to the draft. Edit the system prompt, models, thinking, tools, color and save scope. Model preferences use an ordered picker: selected models appear first in fallback order, followed by available models (scoped entries are marked). **Enter** toggles a model, **Ctrl+↑/↓** reorders a selected model without unselecting it, **Ctrl+S** applies preferences, and **Esc** discards changes. Below the selected models, [fuzzysort](https://github.com/farzher/fuzzysort) fuzzy-matches the draft's `modelSuggestions` against provider/id and display name: scoped matches first, other matches next (ranked by best match score), then remaining models alphabetically without duplicates. Typing filters these groups while keeping selected models visible; without suggestions the available models are alphabetical. Suggestions only aid selection and never change runtime model resolution. The YAML editor edits the header together; **External editor** edits the whole Markdown file using `$VISUAL`, `$EDITOR`, or `vi`.
- `/agents import`: select individual external definitions for model-driven migration.
- `/agents reload`: reload definitions and show diagnostics.
- `/agents` or `/agents settings`: open a bordered settings dialog. Choose **Subagent Mode** (**Off**, **Opportunistic**, or **Orchestration**), edit level, concurrency and retained-thread limits, choose **Model Picking** (**Pick First (available)**, **Pick First (scoped)**, or **Use Current**), choose global or trusted-project scope, and save with **Ctrl+S**. The mode field and chooser explain each option. Settings apply immediately without interrupting existing work. **Agent definitions** opens the type editor.
- `/agents tree`: open a live, bordered tree of all retained agents, including running and paused sessions. **↑↓** select, **←→** collapse/expand, **PgUp/PgDn** scroll, **Enter** inspects the selected thread, **Esc** close. The dialog refreshes every second and preserves selection. An optional path preselects that agent, for example `/agents tree /root/controller-security-research`.
- `/agents status`: alias of `/agents tree`.

A compact, themed **Agents** tree appears **above pi's input editor**. Nested subagents are indented beneath their parents; active branches are prioritized, and excess agents are counted instead of taking over the screen. Each agent shows a colored type pill, task path, state and task, with elapsed active time and cumulative input `↑` / output `↓` token counts on the right. An indented line shows its latest activity. The widget uses at most ten lines; `/agents tree` opens the full tree. An optional path preselects an agent, and **Enter** inspects it. `/agents status` is an alias. Time refreshes every second while running; tokens refresh as the provider reports usage. Pauses freeze time; resuming accumulates it. The existing editor and footer are unchanged.

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
  "type": "architect",
  "task": "Investigate controller security and plan the change",
  "wait": false
}
```

Choose concise kebab-case paths describing the task, independently of the type. Then use `agent_wait` or `agent_status` on `/root/controller-security-research`.

### Parallel and nested work

Launch **all independent siblings with `wait: false` before waiting**. For example, `/root` can launch `team-a` and `team-b`, then each team can launch `worker-a` and `worker-b` the same way. This works even if tool calls are delivered sequentially: detached children run in separate SDK sessions. Same-turn foreground calls also overlap when pi executes their tool batch in parallel, but spawning one foreground child and awaiting it before launching the next is sequential.

Use the bundled `architect` for explicitly authorized team coordination. With the default Tool Filtering mode, other bundled roles intentionally do not delegate, and a custom coordinating type's allow list must include `agent_spawn` and `agent_wait`. Less restrictive filtering modes can also expose delegation tools. Children follow the selected filtering mode and shared limits; delegation does not provide unavailable web/browser capabilities.

### Manager settings

Settings belong to **this extension**, not another subagent package:

- Global: `<pi-agent-dir>/subagent-manager/settings.json` (normally `~/.pi/agent/subagent-manager/settings.json`).
- Project: `<cwd>/.pi/agent/subagent-manager/settings.json`, loaded only when pi trusts the project; overrides global values.

```json
{
  "maxLevels": 3,
  "maxConcurrent": 16,
  "maxThreads": 64,
  "modelSelection": "pick-first-scoped",
  "subagentMode": "opportunistic",
  "toolFiltering": "allowed"
}
```

All keys are optional. `subagentMode` controls tool availability and concise system-prompt guidance:

- **`off`**: hide subagent tools and inject no subagent guidance. The main model is not told about this plugin; the automatic import offer, thread widget and root notifications are suppressed. `/agents` remains available to change settings or inspect retained threads.
- **`opportunistic`** (default): expose subagent tools and tell the main model to delegate only parallelizable or very large tasks; otherwise work directly.
- **`orchestration`**: expose subagent tools and tell `/root` to delegate all task execution. It only coordinates and synthesizes subagent results. This is a prompt policy, not a tool sandbox; the root-only rule is not inherited by workers.

Mode changes apply immediately without canceling running work or discarding retained sessions. Agent import requires **opportunistic** mode because migration uses the main thread's file tools; it is not offered automatically in orchestration mode.

`maxLevels` includes the main conversation as **L1**: the default permits L2 children and L3 grandchildren, but no L4. An independent root such as `/k` is still L2, so independent paths cannot bypass the limit. `maxLevels: 1` disables new children; supported values are integers from 1 to 32.

`maxConcurrent` counts starting/running threads **across the entire tree**, including parents waiting for children; `maxThreads` counts all retained threads. Both require positive safe integers. Capacity exhaustion fails clearly rather than queuing. Omitted settings use the defaults above. Unknown keys, malformed values and symlinked settings paths produce warnings; an invalid file is ignored atomically, preserving the preceding valid layer/defaults.

**Model Picking** (`modelSelection`) controls the model chosen when an agent's SDK session starts:

- **Pick First (available)** (`"pick-first-available"`): scan the definition's `models` in order and use the first available model with configured credentials, regardless of scope.
- **Pick First (scoped)** (`"pick-first-scoped"`, default): the same scan, restricted to available models in the main session's `/scoped-models`.
- **Use Current** (`"use-current"`): ignore `models` (and legacy `model`) and use the main session's current model, not a nested parent's or restored session's model. Agent-specific thinking levels still apply.

Neither `modelSuggestions` nor the scoped list's order affects runtime selection. Changing modes does not cancel an in-flight request or switch already-open sessions to the main model. Scoped checks continue to apply to future requests by retained preference-based agents while scoped mode is selected. Legacy `scopedModelFiltering: true` migrates to `"pick-first-scoped"`; `false` migrates to `"pick-first-available"`. An explicit `modelSelection` wins, and saving writes only the new setting.

**Tool Filtering** in `/agents settings` controls which tools each agent receives when its SDK session starts:

- **Allowed (except blocked)** (`toolFiltering: "allowed"`, default): only tools in the type's YAML `tools.allow` list, minus `tools.block`. A missing or empty allow list grants no tools.
- **All except blocked** (`"all-except-blocked"`): ignore `tools.allow`; expose all supported tools except those in `tools.block`.
- **All** (`"all"`): ignore both YAML lists and expose all supported tools.

“All” includes child-local built-in and manager tools plus the main session's registered non-hidden tools. Exact-name allow/block lists apply to this inventory. Inherited tools retain their exposure and active status: direct/model-only tools remain model-facing when active, while deferred/codemode tools can be discovered through child-local codemode. External calls reuse the main session's resources and context rather than loading fresh extensions or MCP connections; the main session's tool policy still applies to bridged callable tools. Filtering changes apply to newly initialized sessions, including retained sessions reopened after reload; already-open sessions keep their selected tool set. The main conversation's tools are unchanged.

Use `/agents reload` to reload definitions and settings. New limits do not cancel existing threads or discard retained sessions; they govern new spawns and future concurrency reservations. Lowering the level limit still permits resuming previously retained deeper sessions, but no new agents can be spawned beyond the limit. `/reload` or reopening the parent also reloads settings. Normal operation does **not** load `.pi/subagents.json` or other packages' settings as manager settings. Only explicit import discovery/model migration reads applicable source configuration. Avoid loading multiple subagent extensions because they can register the same `/agents` command.

Wait timeouts and cancellation do **not** kill detached children. Progress/settlement notifications do not force a parent model turn; they are recorded and visible for the parent's next interaction. Large final answers are paginated, not silently lost.

## Boundaries

- Tool policies are **not a sandbox**. Agents share the working directory and OS permissions; concurrent edits may conflict.
- Built-in tools, manager controls, codemode and tool search remain child-local. Permitted external tools use the main session's bridge/resources and context, so session-mutating external tools are not necessarily isolated to the child. Children do **not** reload third-party extensions or MCP servers, or automatically load skills or project context files.
- Other custom **model-only** tools fail closed: the SDK cannot bridge them while preserving root permission/result hooks. Run those in the main session. UI/command-driven resumes after reopening the main session need a main-session `agent_*` tool call to establish the execution bridge; use `agent_steer` rather than the thread dialog.
- Custom/native model provider registrations and runtime-only API keys are mirrored. Virtual/router models need a concrete configured model; unsupported providers fail with an actionable error.
- Defaults limit the tree to 3 levels including the main conversation, 16 active threads and 64 retained threads per parent session. Waiting agents count as active. Configure them using this extension's manager settings.

## Development

```sh
npm ci
npm run check
npm test
npm run format:check
```

The suite is offline: meaningful lifecycle/policy tests plus scripted-provider SDK tests for nested parallel launches, level settings, pause, persistence and recovery. Generated JSONL scenarios cover multilevel nested agents, unopened lexical parents, interrupted work, durable mailboxes, root forks and same-file tree navigation. No live model credentials are required.

The code is deliberately layered:

- `config.ts`: frontmatter validation, precedence and atomic saves.
- `agent-import.ts`, `import-discovery.ts`, `import-picker.ts`, `import-instructions.ts`: first-run consent, read-only source discovery, checkbox selection, and current-model migration guidance.
- `settings.ts`: validated global/project manager limits, model/tool-filtering policies and safe configuration paths.
- `paths.ts`: canonical ancestry and safe context snapshots.
- `manager.ts`: runtime-independent ownership, lifecycle and retained registry. `scope(caller)` exposes the same caller-bound `ThreadService` to tools and UI.
- `runtime.ts`: isolated pi SDK sessions, providers and safe turn boundaries.
- `mailbox.ts`: accepted-input persistence, replay and transcript reconciliation.
- `tools.ts`: caller-bound model tool surface.
- `ui.ts`: configuration dialogs and activity/thread UI.
- `index.ts`: parent-session lifecycle and extension wiring.

## Changelog

[CHANGELOG.md](CHANGELOG.md) is generated automatically when a version tag is pushed,
alongside a [GitHub Release](https://github.com/championswimmer/pi-subagent-manager/releases).
The [changelog workflow](.github/workflows/changelog.yml) runs independently of npm publishing.

- **Major** tags (`v1.0.0`): large `##` headings; optional handwritten highlights go in the GitHub Release.
- **Minor** tags (`v1.1.0`): smaller `###` headings under their major series.
- **Patch** tags (`v1.1.1`): `####` headings under their minor release.
- Missing initial tags get series headings (for example, `0.x` and `0.1.x`). Newer major/minor series appear first; each series starts with its initial release, followed by its patches newest-first.
- Prereleases are listed separately. Stable releases compare against the previous **stable ancestor tag**, so PRs from release candidates remain in the final release. Prereleases compare against the previous ancestor tag, including earlier prereleases.

GitHub's generated release notes list merged PRs and contributors without requiring labels
or Conventional Commits. The generator also checks **all pages** of closed PRs against the
Git commit range and adds missing merged PRs, including bots and squash/rebase merges.
A PR's merge commit must be reachable in the tagged history; unmerged PRs and later merges
are excluded. Direct commits are available through the full-history/compare links, not as PR bullets.
Dates are the tagged commit dates. Handwritten release highlights are preserved on reruns;
automatically generated sections are replaced rather than duplicated.

The workflow needs only the built-in `GITHUB_TOKEN` with `contents: write` and
`pull-requests: read`. It updates just `CHANGELOG.md` on the default branch without force
pushes. If branch protection is added, allow this automation to update that file or change
the publishing step to a changelog PR; otherwise the file update will fail, while the
GitHub Release and workflow artifact remain available.

Use **Actions → Publish changelog → Run workflow** to backfill the cumulative changelog.
Leave `tag` empty to rebuild only the file, or specify an existing tag to publish/repair
that release too. For a local preview (requires authenticated `gh` with repository contents-write
permission for GitHub's notes-generation endpoint, and fetched tags):

```sh
git fetch origin --tags
GITHUB_REPOSITORY=championswimmer/pi-subagent-manager npm run changelog
```

This rewrites the local `CHANGELOG.md` but does not publish anything. The workflow uses
`--publish` to publish the requested release and commit the generated file. Do not manually
edit generated entries; edit the GitHub Release and rerun the workflow instead.

### Tool choice

We use [GitHub generated release notes](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes)
plus a small tested renderer. [Release Drafter](https://github.com/release-drafter/release-drafter)
adds a draft lifecycle; [release-please](https://github.com/googleapis/release-please)
changes version/tag management and relies on Conventional Commits;
[git-cliff](https://git-cliff.org/docs/integration/github/) is primarily commit-oriented;
and [github-changelog-generator](https://github.com/github-changelog-generator/github-changelog-generator)
adds Ruby/Docker and needs heading postprocessing. Native notes fit the existing tag-based
npm release process without adding another release manager.

## Publishing

Pushing a `v<version>` tag runs [`.github/workflows/release.yml`](.github/workflows/release.yml)
to verify the tag matches `package.json`, typecheck, test, upload an npm tarball,
and publish to npm with provenance using GitHub Actions OIDC. No `NPM_TOKEN` secret
is required.

Configure an npm trusted publisher for `pi-subagent-manager` with GitHub owner
`championswimmer`, repository `pi-subagent-manager`, and workflow filename
`release.yml`. Leave the environment field empty (the workflow uses no environment).

`npm publish` automatically reruns typechecking and tests via `prepublishOnly`. The
package ships TypeScript sources and bundled agent definitions; pi loads them directly,
so no build step is needed. Check the `files` list in `package.json` when adding assets.

For the next release, update `package.json` and `package-lock.json` together (for
example, `npm version minor --no-git-tag-version`), validate, commit, create an
annotated `v<version>` tag, and push the commit and tag to trigger publishing.

The initial design is kept in [`.agents/plans`](https://github.com/championswimmer/pi-subagent-manager/tree/main/.agents/plans); superseded review snapshots have been removed. Research came before implementation: [Claude](docs/research-claude.md) and [Codex](docs/research-codex.md).
