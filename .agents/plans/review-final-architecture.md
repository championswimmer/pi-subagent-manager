# Final architecture review

## Verdict
Approved with caveats. The current snapshot is meaningfully cleaner than the earlier review targets: persistence ownership now lives in `ThreadManager.saved()`, tool descriptions are static while `agent_types` stays live, resumed threads keep the original `task`, and `ConfigStore` now owns save-scope decisions through `canSaveProject()` + `destination()`.

I reviewed `README.md`, `src/index.ts`, `src/config.ts`, `src/paths.ts`, `src/manager.ts`, `src/runtime.ts`, `src/tools.ts`, `src/ui.ts`, `src/types.ts`, plus the prior composability/test-value notes. I did **not** do upstream/docs research, and I am treating the runtime/integration-test area as still somewhat in motion per the stated caveat.

## Verified strengths
- Clear layering still holds: config/path rules are mostly pure, manager owns lifecycle/registry, runtime owns SDK binding, tools/ui stay thin.
- Files remain small enough to read end-to-end; no file looked split-for-the-sake-of-it.
- The README now matches the code much more closely, which reduces maintenance confusion.

## Actionable changes (max 3)

1. **Make the persisted thread shape explicit, not `Omit<ThreadView, "updatedAt">`.**  
   `SavedThread.view` still piggybacks on the UI/runtime view type. That means future view-only fields can accidentally become persistence fields. Introduce a small `SavedThreadView` interface in `types.ts` and have `saved()`/`restore()` map to it directly.

2. **Remove the redundant `inheritContext()` pass in `runtime.ts`.**  
   `ThreadManager.spawn()` already computes the inherited snapshot, then `createDriverFactory()` filters `options.inherited` again before replaying it into a new session. Pick one owner for snapshot shaping (manager is the clearer place) and append the already-shaped messages directly in runtime.

3. **Introduce a caller-scoped thread service instead of rebinding manager methods ad hoc.**  
   `tools.ts` and `/agents` each manually bind caller/root context around `ThreadManager`. A small `manager.scope(caller)` (or equivalent interface) would centralize access binding, shrink `index.ts`, and make UI/tool tests easier without widening the public surface.

## Caveats
- `src/runtime.ts` is still the densest file; I would not split it yet, but it is the first place likely to benefit from small helper extraction if more SDK behavior lands.
- I did not re-audit all test files directly here; my test-value stance is unchanged from `review-test-value.md`: keep integration coverage focused on runtime/index contracts, avoid adding UI/config microtests.
