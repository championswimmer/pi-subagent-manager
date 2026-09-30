# Lifecycle review

## Highest-priority correctness fixes

1. **`stop()` can miss descendants spawned during cancellation**  
   In `src/manager.ts::stop()`, the target set is snapshotted once with `item === record || isDescendant(item.view.path, path)`. In `src/manager.ts::spawn()`, the new record is not inserted into `records` until *after* any awaited parent snapshot (`await this.ensureDriver(parentRecord)`). That leaves a race where a stopping parent can still execute `agent_spawn` and create a late child after `stop()` already chose its target set. `src/tools.ts::agent_spawn` also only uses the abort signal for the `wait()` phase, so cancellation of the parent tool does not prevent the child record from being created.  
   **Fix:** reserve the path synchronously before awaits, and reject spawn when the caller or lexical parent has `stopRequested` / is no longer active. If you want subtree stop to be strong, add a subtree-level stop lock or a second descendant sweep before returning.

2. **Startup / restore are not cancellable, so stop/shutdown can hang in `starting`**  
   `src/types.ts::DriverFactory` has no abort signal. `src/manager.ts::start()` waits `await this.ensureDriver(record)` before it can observe `record.stopRequested` or `this.disposed`. `src/manager.ts::stop()` and `shutdown()` can only call `driver.abort()` once `record.driver` exists; they cannot cancel `record.initializing`. If `createDriver()` or restored-session reopen hangs, the manager can stay stuck in `starting`, and `stop()` / `shutdown()` will wait forever on `record.run`.  
   **Fix:** extend `DriverFactory` / `DriverOptions` with a startup abort signal, or split “allocate session / reserve record” from heavyweight driver initialization.

3. **`inheritContext()` drops valid Pi conversation messages**  
   `src/paths.ts::inheritContext()` removes every `role === "custom"` and `role === "bashExecution"`. In actual Pi types, those are not prompt/loadout-only artifacts: `node_modules/@earendil-works/pi-coding-agent/dist/core/messages.d.ts` defines them as first-class transcript messages, and `convertToLlm()` in `.../core/messages.js` turns both into normal user-context messages. So child threads currently lose extension-injected context and shell transcript context that Pi itself would preserve.  
   **Fix:** preserve these roles (or normalize them to user messages) while still stripping system/tool-loadout state.

4. **`stop()` clobbers already-settled descendants and deletes completed handback**  
   `src/manager.ts::stop()` targets *all* descendants, not only active ones, then unconditionally sets `item.view.state = "stopped"` and `delete item.view.output`. That means stopping a parent subtree can rewrite paused/completed descendants into `stopped`, even though `agent_stop` says “working children” and completed/paused sessions are supposed to remain retained + resumable.  
   **Fix:** only mutate active descendants. Leave already-settled children in `paused` / `completed` / `failed` with their existing output/status intact.

5. **Durability hole before `sessionFile` exists**  
   `src/manager.ts::saved()` drops any record without `driver?.sessionFile || view.sessionFile`. But `src/manager.ts::start()` exposes a visible `starting` thread before `ensureDriver()` can populate `sessionFile`. If reload/crash happens in that window, the thread disappears instead of restoring as paused/interrupted, which is weaker than the lifecycle contract.  
   **Fix:** make session reservation synchronous (preferred), or persist a provisional thread entry that can be reopened / marked interrupted on restore.

## Verified-good / no major issue found

- `src/paths.ts::canonicalPath()` + `src/manager.ts::assertAccess()` correctly enforce descendant-only access for non-root callers; I did not find a sibling/ancestor/unrelated-tree escape.
- Pause/no-answer handback looks aligned: `src/tools.ts::agent_pause` uses Pi’s supported `terminate` hint (`@earendil-works/pi-agent-core/dist/types.d.ts`), and `src/manager.ts::output()` intentionally suppresses paused output.
- `src/manager.ts::wait()` cancellation/timeout semantics match the contract: cancelling the wait does not stop the child.

## Human-readable architecture / naming improvements

- `ThreadView.owner` reads like an ACL owner, but behavior is really “operational notification recipient for parentless roots”. A name like `notificationOwner`, `handoffOwner`, or `operationalOwner` would make restore/settled routing easier to follow.
- `ThreadView.task` is overwritten in `src/manager.ts::start()` on every resume/steer, so UI loses the original decomposition goal and starts showing the latest resume message instead. Splitting this into immutable `goal` + mutable `latestInput` (or `resumePrompt`) would make lifecycle/debug output much easier to read.
- The lifecycle would be easier to reason about if `Record` separated persisted thread data from ephemeral runtime state (`driver`, `initializing`, `run`, pause/stop flags) and exposed an explicit transition like `stopping` / `interrupted` instead of hiding those states in booleans.
