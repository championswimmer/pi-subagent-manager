# Sleep until another agent settles

Status: implemented on the `wake-on-settle` branch (fork of v1.9.0). Not upstream.

Implementation notes (where the build differs from or adds to the text below):

- Wait-table logic lives in `src/orch/waits.ts`; `manager.ts` has thin hooks.
- A `failed` or `stopped` producer is refused at `agent_sleep` / `after` time (it could never complete unless resumed). Resume it first.
- `/root` notices (producer failed, wake could not run, restored waiter can wake) are a `waitNotice` event and always trigger a turn. A failed wake is held for `/root` rather than retried.
- A reserved `after` thread is saved as `paused` with `sleepUntil`/`sleepKind`/`sleepTask` view fields, as are sleepers (`sleepUntil`, `sleepKind`, `sleepNote`). `timeoutMs` on a reserved thread arms when it starts and is not persisted.
- A manual `agent_steer` on a reserved `after` thread starts it with its task followed by the steering message.
- Child tools filtered by an allow list must list `agent_sleep` to see it. The six bundled agents and `IMPORT_CHILD_TOOLS` include it.
- Access: `/root` may name any thread. A child may name only threads of its own top-level tree (same first path segment, so siblings and cousins under `/root` are fine; other independent roots are not). Unknown and out-of-tree paths give the same error to a child, so it cannot probe other trees. Inside a tree, any agent with `agent_sleep` can read sibling and cousin answers.
- A producer that is `failed`, `stopped` or `paused` (and not itself asleep) notifies `/root`. After a reload nothing restarts, so `/root` is told about every waiter whose pending producers are idle (`... paused after reload`).
- The `/root` trigger is suppressed for a producer's result only when every waiter it woke is a direct child of `/root`; a waiter deeper in a tree reports to its own parent, so `/root` still gets its turn.
- `agent_steer` on a waiter that is still winding down (called `agent_sleep`, not yet paused) is refused. Once paused, a manual steer wins. On a held waiter (all producers complete) it also carries the producers' answers.
- `agent_stop` on an ancestor also removes the wait entries of its descendants.
- `after` ignores `wait`: a deferred spawn returns at once as `paused`, and the parent is woken when it settles.
- Known limits: held "can wake" notices repeat on each session attach until `/root` acts; answers are not persisted, so a producer reaped or resumed while closed shows "(no text)" or counts as pending again.

## Problem

An agent that needs another agent's result has three choices today, and all cost tokens or turns:

1. Poll with `agent_status` or repeated `agent_wait` calls.
2. Hold a blocking `agent_wait` (no tokens, but only for its own descendants, and it keeps a concurrency slot).
3. Finish or pause, and let `/root` resume it later. Every hand-over then costs a `/root` model turn.

Children may address only their descendants (`assertAccess`), so a producer cannot wake a sibling consumer.

## Rule

The agent that is waited on is responsible for the wake. A waiting agent sleeps (paused, 0 tokens). When its producers settle, the **manager** resumes it. No model turn runs for the hand-over, in `/root` or anywhere else.

## New API

### `agent_sleep` (child tool)

```ts
agent_sleep({ until: string[], note?: string })
```

- `until`: thread paths (absolute, or relative to the caller like other path arguments). 1 to 16 entries.
- Valid paths: known threads; not the caller; not an ancestor of the caller; no cycle in the wait graph (A sleeps on B while B sleeps on A is refused).
- Producers are not limited to descendants. Sleeping only observes settlement; the manager performs the wake as `/root`.
- If every producer has already completed, the tool does not pause. It returns their final answers at once.
- Otherwise the caller pauses at the turn boundary (same rule as `agent_pause`: call it alone). Status: `Sleeping until /a, /b`.

Description text shown to every agent type (this is how the rule reaches all agents without prompt forks):

> Child-only: when you need the result of other agents, call this instead of polling. You pause with 0 tokens; when all listed agents complete, you are resumed in the same session with their final answers. Never loop on agent_status or agent_wait.

### `agent_spawn({ ..., after?: string[] })`

- Optional. The thread is reserved at once (path, type, task saved) but does not start.
- It starts with its task plus the producers' final answers when all `after` paths complete.
- Same validation as `agent_sleep`. If all producers already completed, it starts at once.
- This lets `/root` lay out a whole chain in one turn, for example `L after [H, I, K]`.

## Manager changes (`src/orch/manager.ts`)

- New table `waits: Map<waiterPath, { producers: Set<string>; kind: "sleep" | "spawn"; note?: string; task?: string }>`.
- Settlement hook, in the existing `finally` block that emits `settled` (about :706):
  - Producer `completed`: remove it from every wait set. When a set becomes empty, wake the waiter (below).
  - Producer `failed` or `stopped`: keep the waiter asleep. Emit a `/root` notification with a turn trigger: `"/b sleeps on /a; /a failed: <reason>"`. A human or `/root` decides.
  - Waiter itself settles as `paused` because of `agent_sleep`: emit `settled` with a new flag `sleeping: true`.
- Wake:
  - `kind: "sleep"`: `steer("/root", waiter, message)`. The existing resume path keeps the session.
  - `kind: "spawn"`: `start(record, task + "\n\n" + message)`.
  - Message: for each producer, its path and final answer (each truncated to 16,000 characters, same limit as the root notification). A child cannot call `agent_output` on a non-descendant, so the text must be in the message.
- Race: a producer can complete after `agent_sleep` is called but before the waiter has settled as paused. The wake runs when the waiter settles; if the set is already empty then, it wakes at once.
- Capacity: if `maxConcurrent` is reached, the wake is queued and retried each time any thread settles.
- `agent_stop` on a waiter removes its wait entry. `agent_steer` on a sleeping waiter (by its parent or `/root`) also clears the entry: a manual resume wins.

## Root notifications (`src/index.ts`)

- `settled` with `sleeping: true`: persist the root mailbox entry (the record stays complete) with `trigger: false`. No `/root` turn.
- Producer `completed` that woke a waiter: unchanged persistence; `trigger: false` when every recipient of the result was a sleeping waiter and the producer's own parent is not `/root`. A direct child of `/root` still notifies `/root` as today, but with `trigger: false` if its completion woke at least one waiter. (Open point for review: whether `/root` should still get a turn when no root-level work remains.)
- Failures always trigger.

## Persistence (`src/orch/registry.ts`)

- Save `waits` per thread (`sleepUntil: string[]`, `kind`, `note`, pending `task` for `after`) in the registry delta, like pending steering.
- On restore, interrupted work comes back paused, never auto-restarted (existing rule). Sleeping threads stay asleep with their wait lists.
- A producer that settles after restore wakes its waiters normally.
- If all producers of a waiter already completed while Pi was closed, the waiter is not auto-started. `/root` gets a triggered notification: `"/b can wake: all producers completed"`.

## Tests (new file `tests/sleep-until.test.ts`, plus registry cases)

1. One producer completes; waiter resumed with its answer; no root trigger.
2. Two producers; wake only after both.
3. Producer fails; waiter stays asleep; root triggered.
4. Producer already completed: `agent_sleep` returns answers, no pause.
5. Producer completes before the waiter has settled as paused (race).
6. Cycle refused; self and ancestor refused; unknown path refused.
7. Waiter stopped while asleep: entry removed, no later wake.
8. Manual `agent_steer` on a sleeping waiter clears the entry.
9. `agent_spawn` with `after`: starts with task plus answers; immediate start when producers are done.
10. Capacity full: wake queued, runs after a settle.
11. Registry round trip: wait list survives save and restore; restore with all producers done triggers root, no auto-start.
12. Existing suite passes unchanged.

## Not in scope

- Waiting on non-agent events (files, monitors). `pi-background-monitor` already covers log matches.
- Changes to pi-checklist. The checklist can still record `meta.agent` by convention.
