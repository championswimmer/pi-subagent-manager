import type {
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings, Key, matchesKey } from "@earendil-works/pi-tui";
import {
  canOpenDialog,
  DIALOG_OPTIONS,
  type DialogHost,
  dialogHeight,
  dialogText,
  frameDialog,
} from "./dialog.ts";
import type { ThreadService, ThreadView } from "./types.ts";
import { showThreads, threadMetrics } from "./ui.ts";

const ROOT = "/root";
const TITLE = "Agents status";
const FOOTER =
  "Esc close · ↑↓ select · ←→ fold · PgUp/PgDn · Enter inspect · r refresh";

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

/** Flatten retained agents. Parent links win over path shape; /root is always present. */
export function buildStatusTree(
  threads: ThreadView[],
  collapsed: Set<string>,
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
      .sort((a, b) => comparePath(a.path, b.path));
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

function treeParent(rows: StatusRow[], index: number): StatusRow | undefined {
  const depth = rows[index]?.prefix.length ?? 0;
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    if (rows[cursor]!.prefix.length < depth) return rows[cursor];
  }
  return undefined;
}

function firstChild(rows: StatusRow[], index: number): StatusRow | undefined {
  const next = rows[index + 1];
  return next && next.prefix.length > (rows[index]?.prefix.length ?? 0)
    ? next
    : undefined;
}

function label(row: StatusRow): string {
  if (!row.thread)
    return row.path === ROOT
      ? `${dialogText(row.path)}  main  running  main`
      : `${dialogText(row.path)}  missing parent`;
  return [row.path, row.thread.type, row.thread.state, row.thread.status]
    .map((part) => dialogText(part))
    .join("  ");
}

export class StatusDialog {
  private selectedPath: string;
  private collapsed = new Set<string>();
  private viewport = 1;

  constructor(
    private host: DialogHost,
    private theme: Theme,
    private service: ThreadService,
    private done: (path: string | undefined) => void,
    selected?: string,
  ) {
    this.selectedPath = selected || ROOT;
  }

  invalidate(): void {}

  private rows(): StatusRow[] {
    return buildStatusTree(this.service.list(), this.collapsed);
  }

  private locate(rows: StatusRow[]): number {
    const exact = rows.findIndex((row) => row.path === this.selectedPath);
    if (exact >= 0) return exact;
    let parent = lexicalParent(this.selectedPath);
    while (parent) {
      const index = rows.findIndex((row) => row.path === parent);
      if (index >= 0) return index;
      parent = lexicalParent(parent);
    }
    const root = rows.findIndex((row) => row.path === ROOT);
    return root >= 0 ? root : 0;
  }

  handleInput(data: string): void {
    const keys = getKeybindings();
    if (keys.matches(data, "tui.select.cancel")) {
      this.done(undefined);
      return;
    }
    const rows = this.rows();
    const index = this.locate(rows);
    const row = rows[index];
    if (row) this.selectedPath = row.path;
    if (keys.matches(data, "tui.select.confirm")) {
      if (row?.thread && row.path !== ROOT) this.done(row.path);
      return;
    }
    if (data === "r") {
      this.host.requestRender();
      return;
    }
    if (matchesKey(data, Key.left)) {
      if (row?.hasChildren && !this.collapsed.has(row.path))
        this.collapsed.add(row.path);
      else if (row) {
        const parent = treeParent(rows, index);
        if (parent) this.selectedPath = parent.path;
      }
    } else if (matchesKey(data, Key.right)) {
      if (row?.hasChildren && this.collapsed.has(row.path))
        this.collapsed.delete(row.path);
      else {
        const child = row?.hasChildren ? firstChild(rows, index) : undefined;
        if (child) this.selectedPath = child.path;
      }
    } else {
      let next = index;
      if (keys.matches(data, "tui.select.up")) next -= 1;
      else if (keys.matches(data, "tui.select.down")) next += 1;
      else if (matchesKey(data, Key.pageUp)) next -= this.viewport;
      else if (matchesKey(data, Key.pageDown)) next += this.viewport;
      else if (matchesKey(data, Key.home)) next = 0;
      else if (matchesKey(data, Key.end)) next = Math.max(0, rows.length - 1);
      else return;
      this.selectedPath =
        rows[Math.max(0, Math.min(rows.length - 1, next))]?.path ??
        this.selectedPath;
    }
    this.host.requestRender();
  }

  private line(row: StatusRow, selected: boolean): string {
    const marker = row.hasChildren
      ? this.collapsed.has(row.path)
        ? "▸ "
        : "▾ "
      : "";
    const text = ` ${row.prefix}${selected ? "›" : " "} ${marker}${label(row)}`;
    if (selected) return this.theme.fg("accent", text);
    if (row.thread?.state === "failed") return this.theme.fg("error", text);
    if (row.thread?.state === "paused") return this.theme.fg("warning", text);
    return text;
  }

  private detail(row: StatusRow | undefined): string[] {
    if (!row?.thread) {
      return [
        ` ${row?.path === ROOT ? "Main Pi session" : "Missing parent"}`,
        "",
      ];
    }
    return [
      ` task ${dialogText(row.thread.task)}`,
      ` ${threadMetrics(row.thread)}`,
    ];
  }

  render(width: number): string[] {
    const rows = this.rows();
    const height = dialogHeight(this.host);
    const index = this.locate(rows);
    if (rows[index]) this.selectedPath = rows[index].path;
    const budget = Math.max(0, height - 4);
    const detail = budget > 2 ? this.detail(rows[index]) : [];
    const treeCount = Math.max(0, budget - detail.length);
    this.viewport = Math.max(1, treeCount);
    const start = treeCount
      ? Math.max(
          0,
          Math.min(index - treeCount + 1, Math.max(0, rows.length - treeCount)),
        )
      : 0;
    const body = [
      ...rows
        .slice(start, start + treeCount)
        .map((row) => this.line(row, row.path === this.selectedPath)),
      ...detail,
    ];
    return frameDialog(this.theme, width, height, TITLE, body, FOOTER);
  }
}

export async function showAgentStatus(
  ctx: ExtensionCommandContext,
  service: ThreadService,
  inspect?: (path: string) => Promise<void>,
): Promise<void> {
  if (!canOpenDialog(ctx)) return;
  const open = inspect ?? ((path: string) => showThreads(ctx, service, path));
  let selected: string | undefined;
  for (;;) {
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      const chosen = await ctx.ui.custom<string | undefined>(
        (host, theme, _keys, done) => {
          timer = setInterval(() => host.requestRender(), 1000);
          if (typeof timer.unref === "function") timer.unref();
          return new StatusDialog(host, theme, service, done, selected);
        },
        DIALOG_OPTIONS,
      );
      if (timer) clearInterval(timer);
      if (!chosen) return;
      selected = chosen;
      await open(chosen);
    } finally {
      if (timer) clearInterval(timer);
    }
  }
}
