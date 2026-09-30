# Composability review

Focused on boundary clarity, smaller public contracts, and human-followable structure. I intentionally did **not** re-review SDK internals or lifecycle race behavior.

1. **Separate authored agent config from resolved execution state.**  
   `src/manager.ts` currently writes inherited `model` / `thinkingLevel` back onto a cloned `AgentType`, while `src/runtime.ts` resolves effective model/thinking again from parent state and restored sessions. That makes `SavedThread.definition` mean both “what the file said” and “what actually ran.”  
   **Diff shape:** keep `definition` as the authored config snapshot; add a small persisted `execution` snapshot like `{ provider, modelId, thinkingLevel }` once the driver resolves. Runtime reads `execution` first on restore.  
   **Consequence:** clearer config/runtime boundary, easier restore semantics, and fewer cross-file invariants.

2. **Split live `ThreadView` from the persisted registry shape.**  
   `ThreadView` is doing three jobs: UI view, delivery payload, and durable storage. The proof is `src/index.ts` needing to zero `updatedAt` and normalize running `status` before persisting.  
   **Diff shape:** introduce `ThreadSnapshot` / `PersistedThread` with only durable fields; rebuild human status text when restoring or rendering.  
   **Consequence:** `persist()` gets much smaller, wording changes stop becoming storage concerns, and registry churn becomes easier to reason about.

3. **Expose a caller-scoped thread service instead of passing `ThreadManager` + caller strings everywhere.**  
   Access control is currently spread across raw manager methods, `agentTools(getManager, caller, ...)`, and the ad hoc `ThreadController` assembled in `src/index.ts`.  
   **Diff shape:** add `manager.scope(caller)` (or a `ThreadService` interface in `types.ts`) returning bound methods like `spawn`, `wait`, `steer`, `list`, `get`, `output`, `transcript`, `stop`, `update`, `pause`. Have both `tools.ts` and `ui.ts` depend on that interface.  
   **Consequence:** one access-control boundary, less wrapper code, easier mocking, and a simpler public contract to discover.

4. **Keep stable thread identity separate from the latest steering message.**  
   `start()` overwrites `view.task` on every resume, so a long-lived thread eventually describes the last nudge rather than the original job. That hurts human readability of retained trees.  
   **Diff shape:** keep `task` immutable after spawn and add `lastInput` / `currentTurn` only if needed for debugging.  
   **Consequence:** `/agents` and saved registries stay understandable after multiple resumes; threads read like durable work items, not transient prompts.

5. **Remove mutable agent-catalog text from static tool registration.**  
   Root `agent_spawn` is registered once, but its description eagerly embeds `store.list()`. After trusted-project load or `/agents reload`, runtime behavior changes while the tool help can stay stale.  
   **Diff shape:** keep `agent_spawn` description static; surface current type names via `before_agent_start`, `/agents types`, or a tiny `agent_types` helper/result.  
   **Consequence:** less repeated setup logic and no drift between discoverability text and actual runtime behavior.
