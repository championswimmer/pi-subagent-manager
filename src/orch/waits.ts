/** Wait table for agent_sleep and agent_spawn `after`. See docs/sleep-until.md. */

export const MAX_WAIT_PRODUCERS = 16;
export const ANSWER_LIMIT = 16000;

export interface WaitEntry {
  /** sleep: a paused session to resume. spawn: a reserved thread that has not started. */
  kind: "sleep" | "spawn";
  /** Every producer, in the order given. */
  all: string[];
  /** Producers that have not completed yet. */
  pending: Set<string>;
  /** Final answers captured when each producer completed. */
  answers: Map<string, string>;
  note?: string;
  /** Task of a reserved `after` thread. */
  task?: string;
  /** Report-only timeout armed when a reserved thread starts. Not persisted. */
  timeoutMs?: number;
  /** The waiter has settled as paused (a reserved thread never started, so always true). */
  settled: boolean;
  /** Restored with every producer complete, or a wake failed: only /root decides. */
  held?: boolean;
}

export class WaitTable {
  private entries = new Map<string, WaitEntry>();

  get(waiter: string): WaitEntry | undefined {
    return this.entries.get(waiter);
  }
  has(waiter: string): boolean {
    return this.entries.has(waiter);
  }
  set(waiter: string, entry: WaitEntry): void {
    this.entries.set(waiter, entry);
  }
  delete(waiter: string): boolean {
    return this.entries.delete(waiter);
  }
  paths(): string[] {
    return [...this.entries.keys()];
  }
  [Symbol.iterator](): IterableIterator<[string, WaitEntry]> {
    return this.entries.entries();
  }

  /** Would `waiter` waiting on `producers` close a loop in the wait graph? */
  wouldCycle(waiter: string, producers: readonly string[]): boolean {
    const seen = new Set<string>();
    const stack = [...producers];
    while (stack.length) {
      const path = stack.pop()!;
      if (path === waiter) return true;
      if (seen.has(path)) continue;
      seen.add(path);
      stack.push(...(this.entries.get(path)?.pending ?? []));
    }
    return false;
  }

  /** A producer completed. Returns the waiters whose last pending producer it was. */
  complete(producer: string, answer: string): string[] {
    const emptied: string[] = [];
    for (const [waiter, entry] of this.entries) {
      if (!entry.pending.delete(producer)) continue;
      entry.answers.set(producer, answer);
      if (!entry.pending.size) emptied.push(waiter);
    }
    return emptied;
  }

  /** Waiters still pending on a producer (used when it fails or is stopped). */
  pendingOn(producer: string): string[] {
    return [...this.entries].filter(([, entry]) => entry.pending.has(producer)).map(([w]) => w);
  }

  /** Waiters that may be resumed now, oldest first. */
  ready(): string[] {
    return [...this.entries]
      .filter(([, entry]) => !entry.pending.size && entry.settled && !entry.held)
      .map(([waiter]) => waiter);
  }
}

export function truncateAnswer(output: string): string {
  return output.length > ANSWER_LIMIT
    ? `${output.slice(0, ANSWER_LIMIT)}\n[Answer truncated at ${ANSWER_LIMIT} characters.]`
    : output;
}

/** Each producer's path and final answer; the waiter cannot read a non-descendant itself. */
export function answersText(
  producers: readonly string[],
  answers: ReadonlyMap<string, string>,
): string {
  return producers
    .map((path) => `## ${path}\n${truncateAnswer(answers.get(path) ?? "") || "(no text)"}`)
    .join("\n\n");
}

export function wakeMessage(entry: Pick<WaitEntry, "all" | "answers" | "note">): string {
  return (
    `Every agent you waited on has completed: ${entry.all.join(", ")}.` +
    (entry.note ? `\nYour note: ${entry.note}` : "") +
    `\nTheir final answers:\n\n${answersText(entry.all, entry.answers)}`
  );
}
