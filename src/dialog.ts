import type {
  ExtensionCommandContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  Input,
  Key,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

export interface DialogHost {
  requestRender(force?: boolean): void;
  terminal?: { rows: number };
}
export interface DialogRow {
  id: string;
  label: string;
  value?: string;
  help?: string;
}
export const DIALOG_OPTIONS = {
  overlay: true,
  overlayOptions: {
    anchor: "center",
    width: "90%",
    maxHeight: "90%",
    margin: 1,
  },
} as const;

export function dialogText(text: string): string {
  return stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

/** Match Pi's overlay height calculation; maxHeight alone would clip the bottom border. */
export function dialogHeight(host: DialogHost): number {
  const rows = host.terminal?.rows ?? 24;
  return Math.max(1, Math.min(rows - 2, Math.floor(rows * 0.9)));
}

export function frameDialog(
  theme: Theme,
  width: number,
  height: number,
  title: string,
  body: string[],
  footer: string,
): string[] {
  if (width <= 0 || height <= 0) return [];
  const fit = (text: string, columns: number) => {
    const clipped = truncateToWidth(text, Math.max(0, columns), "", true);
    return clipped + " ".repeat(Math.max(0, columns - visibleWidth(clipped)));
  };
  if (width < 4 || height < 4)
    return [fit(theme.fg("muted", dialogText(title)), width)];
  const inner = width - 2;
  const line = (text: string) =>
    theme.fg("border", "│") + fit(text, inner) + theme.fg("border", "│");
  const heading = truncateToWidth(` ${dialogText(title)} `, inner, "");
  const top = theme.fg(
    "border",
    "╭" +
      heading +
      "─".repeat(Math.max(0, inner - visibleWidth(heading))) +
      "╮",
  );
  const content = body.slice(0, height - 4).map(line);
  return [
    top,
    ...content,
    theme.fg("border", "├" + "─".repeat(inner) + "┤"),
    line(theme.fg("dim", dialogText(footer))),
    theme.fg("border", "╰" + "─".repeat(inner) + "╯"),
  ];
}

/** Bounded, two-column menu shared by settings and agent definitions. */
export class DialogMenu {
  private selected = 0;
  private viewport = 1;
  constructor(
    private host: DialogHost,
    private theme: Theme,
    readonly title: string,
    readonly rows: DialogRow[],
    private done: (id: string | undefined) => void,
    selectedId?: string,
    readonly footer = "↑↓ navigate · Enter select · Esc close",
    private saveId?: string,
  ) {
    const index = rows.findIndex((row) => row.id === selectedId);
    if (index >= 0) this.selected = index;
  }
  getSelectedId(): string | undefined {
    return this.rows[this.selected]?.id;
  }
  handleInput(data: string): void {
    const keys = getKeybindings();
    if (keys.matches(data, "tui.select.cancel")) return this.done(undefined);
    if (keys.matches(data, "tui.select.confirm"))
      return this.done(this.getSelectedId());
    if (this.saveId && matchesKey(data, Key.ctrl("s")))
      return this.done(this.saveId);
    let offset = 0;
    if (keys.matches(data, "tui.select.up")) offset = -1;
    else if (keys.matches(data, "tui.select.down") || matchesKey(data, Key.tab))
      offset = 1;
    else if (matchesKey(data, Key.pageUp)) offset = -this.viewport;
    else if (matchesKey(data, Key.pageDown)) offset = this.viewport;
    else if (matchesKey(data, Key.home)) this.selected = 0;
    else if (matchesKey(data, Key.end))
      this.selected = Math.max(0, this.rows.length - 1);
    this.selected = Math.max(
      0,
      Math.min(this.rows.length - 1, this.selected + offset),
    );
    this.host.requestRender();
  }
  invalidate(): void {}
  render(width: number): string[] {
    const height = dialogHeight(this.host);
    this.viewport = Math.max(1, height - 7);
    const start = Math.max(
      0,
      Math.min(
        this.selected - this.viewport + 1,
        this.rows.length - this.viewport,
      ),
    );
    const inner = Math.max(0, width - 4);
    const labelWidth = Math.min(28, Math.max(8, Math.floor(inner * 0.35)));
    const body = [
      this.theme.fg(
        "dim",
        ` ${this.rows.length ? this.selected + 1 : 0}/${this.rows.length} · Field / Value`,
      ),
      ...this.rows.slice(start, start + this.viewport).map((row, i) => {
        const label = truncateToWidth(dialogText(row.label), labelWidth, "");
        const text = `${start + i === this.selected ? "›" : " "} ${label}${" ".repeat(Math.max(0, labelWidth - visibleWidth(label)))} │ ${dialogText(row.value ?? "")}`;
        return start + i === this.selected
          ? this.theme.fg("accent", text)
          : text;
      }),
      "",
      this.theme.fg(
        "muted",
        ` ${dialogText(this.rows[this.selected]?.help ?? "")}`,
      ),
    ];
    return frameDialog(
      this.theme,
      width,
      height,
      this.title,
      body,
      this.footer,
    );
  }
}

export function canOpenDialog(ctx: ExtensionCommandContext): boolean {
  if (!ctx.hasUI) return false;
  if (ctx.mode && ctx.mode !== "tui") {
    ctx.ui.notify("Agents dialogs require interactive TUI mode.", "warning");
    return false;
  }
  return true;
}

export async function dialogMenu(
  ctx: ExtensionCommandContext,
  title: string,
  rows: DialogRow[],
  options: { selectedId?: string; footer?: string; saveId?: string } = {},
): Promise<string | undefined> {
  return ctx.ui.custom(
    (host, theme, _keys, done) =>
      new DialogMenu(
        host,
        theme,
        title,
        rows,
        done,
        options.selectedId,
        options.footer,
        options.saveId,
      ),
    DIALOG_OPTIONS,
  );
}

export async function dialogInput(
  ctx: ExtensionCommandContext,
  title: string,
  initial: string,
  help: string,
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>((host, theme, _keys, done) => {
    const input = new Input();
    input.setValue(dialogText(initial));
    input.onSubmit = done;
    input.onEscape = () => done(undefined);
    return {
      get focused() {
        return input.focused;
      },
      set focused(value: boolean) {
        input.focused = value;
      },
      handleInput: (data: string) => {
        input.handleInput(data);
        host.requestRender();
      },
      invalidate: () => input.invalidate(),
      render: (width: number) =>
        frameDialog(
          theme,
          width,
          dialogHeight(host),
          title,
          [
            "",
            ...input.render(Math.max(1, width - 4)).map((line) => ` ${line}`),
            "",
            theme.fg("muted", ` ${dialogText(help)}`),
          ],
          "Enter apply · Esc cancel",
        ),
    };
  }, DIALOG_OPTIONS);
}
