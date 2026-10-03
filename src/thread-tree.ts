import type { ThreadView } from "./types.ts";

const ROOT = "/root";

export interface StatusRow {
  path: string;
  prefix: string;
  thread?: ThreadView;
  hasChildren: boolean;
}

interface StatusNode {
  path: string;
  thread?: ThreadView;
  children: StatusNode[];
}

function lexicalParent(path: string): string | null {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : null;
}

function comparePath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function chainHas(
  parentOf: Map<string, string | null>,
  start: string,
  target: string,
): boolean {
  const seen = new Set<string>();
  let current: string | null = start;
  while (current) {
    if (current === target || seen.has(current)) return true;
    seen.add(current);
    current = parentOf.get(current) ?? null;
  }
  return false;
}

/** Flatten retained agents. Parent links win over path shape; /root is always present.
 *  `comparePaths` orders siblings and roots only. Cycle repair stays lexical.
 */
export function buildStatusTree(
  threads: ThreadView[],
  collapsed: Set<string>,
  comparePaths: (a: string, b: string) => number = comparePath,
): StatusRow[] {
  const threadsByPath = new Map<string, ThreadView>();
  for (const thread of threads) {
    if (thread?.path && !threadsByPath.has(thread.path))
      threadsByPath.set(thread.path, thread);
  }
  const nodes = new Map<string, StatusNode>();
  const parentOf = new Map<string, string | null>();
  const nodeFor = (path: string): StatusNode => {
    let node = nodes.get(path);
    if (!node) {
      node = { path, thread: threadsByPath.get(path), children: [] };
      nodes.set(path, node);
    }
    return node;
  };
  const declaredParent = (path: string): string | null => {
    if (path === ROOT) return null;
    const thread = threadsByPath.get(path);
    if (thread)
      return thread.parent && thread.parent !== path ? thread.parent : null;
    return lexicalParent(path);
  };
  const ensure = (path: string, seen = new Set<string>()): void => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    nodeFor(path);
    if (parentOf.has(path)) return;
    const parent = declaredParent(path);
    parentOf.set(path, parent);
    if (parent) ensure(parent, seen);
  };
  ensure(ROOT);
  for (const path of threadsByPath.keys()) ensure(path);

  const linked = new Set<string>();
  for (const path of [...parentOf.keys()].sort(comparePath)) {
    const parent = parentOf.get(path);
    if (!parent || parent === path) continue;
    if (chainHas(parentOf, parent, path)) {
      parentOf.set(path, null);
      continue;
    }
    const parentNode = nodeFor(parent);
    const child = nodeFor(path);
    if (!parentNode.children.includes(child)) parentNode.children.push(child);
    linked.add(path);
  }

  const rows: StatusRow[] = [];
  const visited = new Set<string>();
  const conceal = (node: StatusNode) => {
    for (const child of node.children) {
      if (visited.has(child.path)) continue;
      visited.add(child.path);
      conceal(child);
    }
  };
  const walk = (list: StatusNode[], ancestors: boolean[], top: boolean) => {
    const ordered = [...list]
      .filter((node) => !visited.has(node.path))
      .sort((a, b) => comparePaths(a.path, b.path));
    for (const [index, node] of ordered.entries()) {
      visited.add(node.path);
      const last = index === ordered.length - 1;
      const stem = ancestors.map((isLast) => (isLast ? "   " : "│  ")).join("");
      rows.push({
        path: node.path,
        prefix: stem + (top ? "" : last ? "└─ " : "├─ "),
        hasChildren: node.children.length > 0,
        ...(node.thread ? { thread: node.thread } : {}),
      });
      if (collapsed.has(node.path)) conceal(node);
      else if (node.children.length > 0)
        walk(node.children, top ? [] : [...ancestors, last], false);
    }
  };
  walk(
    [...nodes.values()].filter((node) => !linked.has(node.path)),
    [],
    true,
  );
  const missed = [...nodes.values()].filter((node) => !visited.has(node.path));
  if (missed.length) walk(missed, [], true);
  return rows;
}
