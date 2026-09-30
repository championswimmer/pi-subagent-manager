# Review: test value vs bloat for pi-subagent

Current keepers:
- `tests/runtime.test.ts` is the highest-value suite: real SDK, offline, no credentials, and it exercises isolation/tool policy/abort/session-file behavior.
- `tests/manager.test.ts` plus `tests/paths.test.ts` already cover the core thread/state contract and pure path/context rules well.

## Coverage map / recommendations
1. **Add one `src/index.ts` lifecycle integration test.** Fake `ExtensionAPI`/`ExtensionContext`, register the extension, then drive `session_start`/`session_shutdown`. Assert restore from the custom registry entry, `appendEntry` persistence/dedupe, root delivery via `sendMessage`, and stale-generation events being ignored. This is the biggest missing behavior.

2. **Add one real-SDK pause -> dispose -> reopen(JSONL) -> resume test in `tests/runtime.test.ts`.** The runtime suite currently proves pause and reopen separately; combine them once. Then trim `manager.test.ts`’s “save/restore retains definition snapshot and reopens JSONL on resume” to registry semantics only, since fake-manager reopen is lower-signal than the real SDK path.

3. **Add a tiny `tests/tools.test.ts` public-contract smoke test.** Use a fake manager and verify only the critical surface: `agent_pause` returns `{ terminate:true }`, `agent_output` paginates/truncates, and `agent_status` filters descendants correctly. One small contract test is enough.

4. **Trim brittle config assertions.** `bundled defaults are loaded with researcher restricted and worker unfiltered` is too coupled to bundled content. Replace exact allow-list assertions with “bundled agents load” plus one critical restriction. Also stop enumerating every `AGENT_COLORS` / `THINKING_LEVELS` literal unless those lists have actually regressed before.

5. **Merge low-signal UI microtests.** Keep one render/sanitize width smoke, one `/agents` interaction flow, and one edit-retry/save flow. `configured semantic thread color is resolved on every render` and the extra widget-theme microtest are low value unless they have prior regressions.

6. **Keep the suite layered and small.** Pure units: `paths/config`; controller contract: `manager/tools`; integration: `runtime/index`. Avoid adding more formatting-only or enum-exhaustion tests below that line.

## Practical offline gates
- Fast PR gate: `npm run check && tsx --test tests/manager.test.ts tests/runtime.test.ts tests/index.test.ts`
- Full offline suite: `npm test`
- UI/config-only changes: `tsx --test tests/config.test.ts tests/ui.test.ts`
