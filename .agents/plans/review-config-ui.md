# Config/UI review

Scope reviewed in full: `src/config.ts`, `src/ui.ts`, `src/types.ts`, plus Pi UI/theme typings from `@earendil-works/pi-coding-agent`.

## Verified good

- Frontmatter parsing is mostly fail-closed: malformed YAML, duplicate keys, unknown fields, alias use, duplicate tool names, and symlinked definition files are rejected.
- The built-in **frontmatter YAML** editor preserves the Markdown body by reconstructing `---\n<yaml>---\n${type.systemPrompt}`; the external editor intentionally edits the full Markdown file.
- External-editor handoff is terminal-safe: `tui.stop() -> spawnSync(editor) -> tui.start() -> requestRender(true)`.
- Pi API usage is compatible: `setWidget(..., { placement: "belowEditor" })` is a valid placement, and `Theme.fg()` accepts the tokens listed in `AGENT_COLORS`.

## Findings (smallest composable remedies)

1. **Same-scope duplicate agent names are silently last-write-wins.**  
   In `ConfigStore.reload()`, two valid files in the **same layer** declaring the same `name` will just overwrite each other in `this.types.set(type.name, ...)`, with no diagnostic or tombstone. That makes provenance/file-path reporting ambiguous and defeats collision checking.  
   **Remedy:** track `seenNames` per layer; on the second hit, add a diagnostic and tombstone that name for the whole layer (same fail-closed behavior used for malformed overrides).  
   **Bounded test:** two valid `user/*.md` files with `name: worker` should make `store.get("worker")` fail and emit one duplicate-name diagnostic.

2. **Reload follows symlinked source directories even though saves reject redirected paths.**  
   `reload()` rejects symlinked files, but not symlinked layer directories such as `.pi/agents -> /tmp/x`. That means a “project” agent can actually come from outside the project after trust is granted.  
   **Remedy:** before `readdirSync(directory)`, reject `lstatSync(directory).isSymbolicLink()` and fail closed for that layer.  
   **Bounded test:** symlink `.pi/agents` to an external directory and verify nothing loads from that layer, with a diagnostic.

3. **Untrusted sessions still offer “Trusted project” as a save target.**  
   `editAgentTypes()` always shows `["Global", "Trusted project"]`, then relies on `store.save()` to reject untrusted project saves. Safe, but needlessly noisy UX around trust handling.  
   **Remedy:** only offer the project option when `ctx.isProjectTrusted()` / store config allows it; otherwise show only `Global` (or label the project option unavailable).  
   **Bounded test:** with `includeProject: false`, the scope chooser should not surface a path that inevitably errors.

4. **Thread UI exits on the first recoverable action error.**  
   `showThreads()` wraps the whole loop in one `try/catch`; any thrown error from `get/output/transcript/steer/stop` notifies and immediately `return`s. One transient failure drops the whole inspector.  
   **Remedy:** keep the dialog alive after recoverable per-action failures (`notify` then `continue`).  
   **Bounded test:** make `controller.transcript()` throw once and verify the user can still choose another action afterward.

5. **Fallback widget colors do not distinguish completed/stopped from running.**  
   In `renderThreads()`, fallback coloring is `failed -> error`, `paused -> warning`, everything else -> `accent`. For the below-editor widget, completed/stopped rows read as “active”.  
   **Remedy:** use a tiny state map: `completed -> success`, `stopped -> muted`, `running/starting -> accent`.  
   **Bounded test:** assert the theme receives `success/muted/error/warning` for those states when `thread.color` is unset/invalid.
