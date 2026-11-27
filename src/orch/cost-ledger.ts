import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ThreadView } from "../types.ts";

export const COST_ENTRY = "pi-subagent:cost:v1";
export interface CostRecord {
  threadId: string;
  totalUsd: number;
}

/** Whole-session accounting, like Pi's footer (not branch-local context). */
export class CostLedger {
  private totals = new Map<string, number>();
  /** Live running costs, superseded by `totals` once a thread settles. */
  private live = new Map<string, number>();

  restore(entries: readonly SessionEntry[]): void {
    this.totals.clear();
    this.live.clear();
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== COST_ENTRY) continue;
      const data = entry.data as Partial<CostRecord> | undefined;
      if (
        !data ||
        typeof data.threadId !== "string" ||
        !data.threadId ||
        typeof data.totalUsd !== "number" ||
        !Number.isFinite(data.totalUsd) ||
        data.totalUsd < 0
      )
        continue;
      // High-water marks make duplicate records and branch rewinds harmless.
      this.totals.set(data.threadId, Math.max(this.totals.get(data.threadId) ?? 0, data.totalUsd));
    }
  }

  get totalUsd(): number {
    let sum = 0;
    for (const id of new Set([...this.totals.keys(), ...this.live.keys()]))
      sum += Math.max(this.totals.get(id) ?? 0, this.live.get(id) ?? 0);
    return sum;
  }

  /** Mirror a running agent's live cost into the rollup without persisting it. */
  track(thread: ThreadView): void {
    if (thread.path === "/root" || !thread.costId) return;
    if (
      (thread.state === "starting" || thread.state === "running") &&
      thread.costUsd !== undefined &&
      Number.isFinite(thread.costUsd)
    )
      this.live.set(thread.costId, thread.costUsd);
    else this.live.delete(thread.costId);
  }

  /** Only inactive agents' authoritative own usage may enter the rollup. */
  settle(thread: ThreadView, append: (record: CostRecord) => void): number {
    if (thread.path === "/root" || !thread.costId) return 0;
    if (thread.state === "starting" || thread.state === "running") return 0;
    // The recorded total takes over from the live estimate.
    this.live.delete(thread.costId);
    if (
      thread.costUsd === undefined ||
      !Number.isFinite(thread.costUsd) ||
      thread.costUsd <= (this.totals.get(thread.costId) ?? 0)
    )
      return 0;
    const previous = this.totals.get(thread.costId) ?? 0;
    const record = { threadId: thread.costId, totalUsd: thread.costUsd };
    // Never advance the cursor on a failed persistence write.
    append(record);
    this.totals.set(record.threadId, record.totalUsd);
    return record.totalUsd - previous;
  }
}
