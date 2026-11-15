import type { InheritedContextEntry } from "../types.ts";

/** Preserve only pruner state; other extension state is private to its session. */
export function inheritedContextEntries(
  branch: readonly { type: string; customType?: string; data?: unknown }[],
): InheritedContextEntry[] {
  return structuredClone(
    branch.flatMap((entry) =>
      entry.type === "custom" &&
      (entry.customType === "context-prune-index" || entry.customType === "context-prune-frontier")
        ? [{ customType: entry.customType, data: entry.data }]
        : [],
    ),
  );
}
