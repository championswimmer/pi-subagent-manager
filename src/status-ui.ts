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
  withDialogSession,
} from "./dialog.ts";
import type { ThreadService } from "./types.ts";
import { buildStatusTree, type StatusRow } from "./thread-tree.ts";
import { showThreads, threadMetrics } from "./ui.ts";

export { buildStatusTree, type StatusRow };

const ROOT = "/root";
const TITLE = "Agents status";
const TREE_TITLE = "Agents tree";
const FOOTER =
  "Esc close · ↑↓ select · ←→ fold · PgUp/PgDn · Enter inspect · r refresh";

function agentCount(threads: readonly { path?: string }[]): number {
  const paths = new Set<string>();
  for (const thread of threads) {
    if (thread?.path && thread.path !== ROOT) paths.add(thread.path);
  }
  return paths.size;
}

function lexicalParent(path: string): string | null {
  const index = path.lastIndexOf("/");
  return index > 0 ? path.slice(0, index) : null;
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
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private host: DialogHost,
    private theme: Theme,
    private service: ThreadService,
    private done: (path: string | undefined) => void,
    selected?: string,
    private title = TITLE,
  ) {
    this.selectedPath = selected || ROOT;
  }

  invalidate(): void {}

  /** Arm the 1s refresh. Host disposal can leave the dialog promise pending. */
  startRefresh(): void {
    this.stopRefresh();
    this.timer = setInterval(() => this.host.requestRender(), 1000);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /** Stop the refresh. Safe to call more than once, including from dispose(). */
  dispose(): void {
    this.stopRefresh();
  }

  private stopRefresh(): void {
    if (this.timer === undefined) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

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
    return frameDialog(
      this.theme,
      width,
      height,
      this.heading(rows, start, treeCount),
      body,
      FOOTER,
    );
  }

  private heading(rows: StatusRow[], start: number, treeCount: number): string {
    if (this.title !== TREE_TITLE) return this.title;
    const agents = agentCount(this.service.list());
    const noun = agents === 1 ? "agent" : "agents";
    const total = rows.length;
    const shown = Math.max(0, Math.min(treeCount, total - start));
    if (shown <= 0) return `${TREE_TITLE}  ${agents} ${noun}`;
    return `${TREE_TITLE}  ${agents} ${noun}  ${start + 1}-${start + shown}/${total}`;
  }
}

async function showAgentDialog(
  ctx: ExtensionCommandContext,
  service: ThreadService,
  options: {
    title?: string;
    selected?: string;
    inspect?: (path: string) => Promise<void>;
  } = {},
): Promise<void> {
  const open = options.inspect ?? ((path: string) => showThreads(ctx, service, path));
  let selected = options.selected;
  for (;;) {
    // Cleared on close and from dispose(): DialogSession host disposal can
    // leave this promise pending, so finally alone may not run immediately.
    let dialog: StatusDialog | undefined;
    try {
      const chosen = await ctx.ui.custom<string | undefined>((host, theme, _keys, done) => {
        dialog = new StatusDialog(host, theme, service, done, selected, options.title);
        dialog.startRefresh();
        return dialog;
      }, DIALOG_OPTIONS);
      dialog?.dispose();
      dialog = undefined;
      if (!chosen) return;
      selected = chosen;
      await open(chosen);
    } finally {
      dialog?.dispose();
    }
  }
}

export async function showAgentStatus(
  ctx: ExtensionCommandContext,
  service: ThreadService,
  inspect?: (path: string) => Promise<void>,
): Promise<void> {
  if (!canOpenDialog(ctx)) return;
  await showAgentDialog(ctx, service, { inspect });
}

export async function showAgentTree(
  ctx: ExtensionCommandContext,
  service: ThreadService,
  selectedPath?: string,
): Promise<void> {
  if (!canOpenDialog(ctx)) return;
  await withDialogSession(ctx, (scoped) =>
    showAgentDialog(scoped, service, {
      title: TREE_TITLE,
      selected: selectedPath,
    }),
  );
}
