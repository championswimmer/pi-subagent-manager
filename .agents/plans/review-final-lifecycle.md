# Final lifecycle review

Status: **not full approval yet**. The previously reported fixes are present in the reviewed files: synchronous spawn reservation, abortable/cleaned-up startup, `inheritContext()` preserving `custom`/`bashExecution` while trimming unmatched tool state, active-descendant-only stop mutation, inherited-context fallback for transcript-less reservations, `rootSessionId` fork isolation, and pre-tree/switch/fork stop hooks.

## Remaining verified findings

1. **Immediate `steer()` can overtake the first prompt of a `starting` child.**
   `ThreadManager.steer()` treats `starting` as active. If `spawn(..., wait:false)` is followed in the same turn by `steer()`, `steer()` awaits `contextReady`/`ensureDriver()` and then calls `driver.steer(message)` even if `start()` has not yet reached `driver.prompt(task)`. Because `start()` begins on a later microtask, the driver can observe steering before the initial task prompt.
   - Small repro: `spawn("/root", { path:"worker", task:"A", wait:false })` and immediately `steer("/root", "worker", "B")` before the next tick.
   - Expected: `B` should queue after the initial `A` turn (or be rejected until `running`).
   - Actual: manager can deliver `steer("B")` before `prompt("A")`.

2. **A stopped ancestor does not fully block new descendants when root spawns below a retained child.**
   `spawn()` only rejects when the **caller** or the **direct parent** has `stopRequested`. It does not walk higher ancestors.
   - Small repro: complete `/root/a`, complete `/root/a/b`, call `stop("/root", "a")`, then `spawn("/root", { path:"a/b/c", ... })`.
   - Expected: reject because `/root/a` is a stopped ancestor.
   - Actual: accepted, since `/root/a/b` itself is retained and not marked stopping.

## Checked and did not find a concrete defect

- `index.ts` branch/root ownership looks correct for copied registries: mismatched `rootSessionId` is reset on attach.
- `session_before_tree` / `session_before_switch` / `session_before_fork` stop hooks are wired before reattach.
- I did not verify a new concrete failure around callback delivery during foreground waits from these files alone.
