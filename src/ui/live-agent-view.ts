import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Input,
  Key,
  Markdown,
  matchesKey,
  ScrollView,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ThreadService, TranscriptSnapshot } from "../types.ts";
import { dialogText, type DialogHost } from "./dialog.ts";
import { AGENT_PROGRESS_INTERVAL, agentProgressIcon, agentTypeLabel } from "./ui.ts";
import type { LoaderStyle } from "../prefs/settings.ts";

type ThemeBg = Parameters<Theme["bg"]>[0];

/** Transcript detail level cycled by the t key: full → preview → compact. */
export type TranscriptDetail = "full" | "preview" | "compact";
const DETAIL_CYCLE: TranscriptDetail[] = ["full", "preview", "compact"];

export interface AgentViewportState {
  scrollTop: number;
  follow: boolean;
  showInherited?: boolean;
  detail?: TranscriptDetail;
}

/** Fully cover main, including at very small sizes; only trusted renderers emit terminal sequences. */
export function fillViewport(lines: string[], width: number, height: number): string[] {
  width = Math.max(0, Math.floor(width));
  height = Math.max(1, Math.floor(height));
  const result = lines.slice(0, height).map((line) => {
    const clipped = truncateToWidth(line, width, "", true);
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  });
  while (result.length < height) result.push(" ".repeat(width));
  return result;
}

function text(value: string): string {
  return stripTerminalSequences(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return "[unrenderable data]";
  }
}

/** Live transcript and manual steering. Never invoke tools' custom renderers or pass through raw controls. */
export class LiveAgentView {
  private snapshot: TranscriptSnapshot | undefined;
  private error: string | undefined;
  private disposed = false;
  private attachment = 0;
  private unsubscribe: (() => void) | undefined;
  private renderTimer: ReturnType<typeof setTimeout> | undefined;
  private progressTimer: ReturnType<typeof setInterval> | undefined;
  private cache = new WeakMap<
    object,
    { width: number; detail: TranscriptDetail; lines: string[] }
  >();
  private scroll: ScrollView;
  private content: string[] = [];
  private restoreViewport = true;
  private input = new Input({ prompt: "Steer > " });
  private editing = true;
  private focusedState = true;
  private pasting = false;
  private pasteTail = "";
  private sending = false;
  private steerStatus: string | undefined;
  private steerFailed = false;

  constructor(
    private host: DialogHost,
    private theme: Theme,
    private service: ThreadService,
    readonly path: string,
    private viewport: AgentViewportState,
    private done: (result: "back" | "main") => void,
    private nerdFontIcons = false,
    private loaderStyle: LoaderStyle = "circle",
  ) {
    this.scroll = new ScrollView(
      { render: () => this.content, invalidate() {} },
      { follow: "end", overscroll: "contain", scrollbar: "hidden" },
    );
    this.input.focused = true;
    this.input.onSubmit = (value) => void this.steer(value);
    void this.attach();
  }

  get focused(): boolean {
    return this.focusedState;
  }

  set focused(value: boolean) {
    this.focusedState = value;
    this.input.focused = value && this.editing;
  }

  private async steer(value: string): Promise<void> {
    const message = dialogText(value);
    if (this.disposed || this.sending || !message.trim()) return;
    this.sending = true;
    this.steerFailed = false;
    this.steerStatus = "Sending steering…";
    this.host.requestRender();
    try {
      // Same root-scoped service as the Actions menu: queues a running turn or resumes a settled one.
      await this.service.steer(this.path, message);
      if (this.disposed) return;
      if (this.input.getValue() === message) this.input.setValue("");
      this.steerStatus = "Steering sent";
    } catch (error) {
      if (this.disposed) return;
      this.steerFailed = true;
      this.steerStatus = `Steering failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      this.sending = false;
      if (!this.disposed) this.host.requestRender();
    }
  }

  private editInput(data: string): void {
    // Keep paste chunks (including embedded Esc, Tab and Enter) out of navigation shortcuts.
    const pasteData = this.pasteTail + data;
    if (pasteData.includes("\x1b[200~")) this.pasting = true;
    if (pasteData.includes("\x1b[201~")) this.pasting = false;
    this.pasteTail = this.pasting ? pasteData.slice(-5) : "";
    const before = this.input.getValue();
    this.input.handleInput(data);
    const safe = dialogText(this.input.getValue());
    if (safe !== this.input.getValue()) this.input.setValue(safe);
    if (safe !== before && !this.sending) this.steerStatus = undefined;
    this.host.requestRender();
  }

  private async attach(): Promise<void> {
    const attachment = ++this.attachment;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.error = undefined;
    this.scheduleRender();
    try {
      if (!this.service.observeTranscript)
        throw new Error("Live observation is unavailable for this service.");
      let latest: TranscriptSnapshot | undefined;
      const observation = await this.service.observeTranscript(this.path, (snapshot) => {
        latest = snapshot;
        if (this.disposed || attachment !== this.attachment) return;
        this.accept(snapshot);
      });
      if (this.disposed || attachment !== this.attachment) {
        observation.unsubscribe();
        return;
      }
      this.unsubscribe = observation.unsubscribe;
      this.accept(latest ?? observation.snapshot);
    } catch (error) {
      if (this.disposed || attachment !== this.attachment) return;
      this.error = error instanceof Error ? error.message : String(error);
      this.syncProgress();
      this.scheduleRender();
    }
  }

  private accept(snapshot: TranscriptSnapshot): void {
    if (
      this.snapshot &&
      (snapshot.generation < this.snapshot.generation ||
        (snapshot.generation === this.snapshot.generation &&
          snapshot.revision < this.snapshot.revision))
    )
      return;
    this.snapshot = snapshot;
    this.error = snapshot.error;
    this.syncProgress();
    this.scheduleRender();
  }

  private syncProgress(): void {
    const state = this.snapshot?.thread?.state;
    const active =
      this.nerdFontIcons &&
      !this.disposed &&
      !this.error &&
      (state === "starting" || state === "running");
    if (!active) {
      if (this.progressTimer !== undefined) clearInterval(this.progressTimer);
      this.progressTimer = undefined;
    } else if (this.progressTimer === undefined) {
      this.progressTimer = setInterval(() => this.scheduleRender(), AGENT_PROGRESS_INTERVAL);
      this.progressTimer.unref?.();
    }
  }

  private scheduleRender(): void {
    if (this.disposed || this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      if (!this.disposed) this.host.requestRender();
    }, 16);
    this.renderTimer.unref?.();
  }

  invalidate(): void {
    this.cache = new WeakMap();
    this.input.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    ++this.attachment;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    this.syncProgress();
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (this.pasting || (this.editing && data.includes("\x1b[200~"))) {
      this.editInput(data);
      return;
    }
    if (matchesKey(data, Key.escape)) return this.done("back");
    if (matchesKey(data, Key.ctrl("q")) || matchesKey(data, Key.ctrl("c")))
      return this.done("main");
    if (matchesKey(data, Key.tab)) {
      this.editing = !this.editing;
      this.input.focused = this.focused && this.editing;
      this.host.requestRender();
      return;
    }
    if (this.error && (matchesKey(data, Key.ctrl("r")) || (!this.editing && data === "r"))) {
      void this.attach();
      return;
    }
    // Transcript scrolling remains available while composing; Home/End edit the input.
    if (matchesKey(data, Key.up)) this.scroll.scrollBy(-1);
    else if (matchesKey(data, Key.down)) this.scroll.scrollBy(1);
    else if (matchesKey(data, Key.pageUp))
      this.scroll.scrollBy(-Math.max(1, this.scroll.viewportHeight));
    else if (matchesKey(data, Key.pageDown))
      this.scroll.scrollBy(Math.max(1, this.scroll.viewportHeight));
    else if (this.editing) {
      this.editInput(data);
      return;
    } else if (data === "c") {
      this.viewport.showInherited = !this.viewport.showInherited;
      this.invalidate();
    } else if (data === "t") {
      this.viewport.detail =
        DETAIL_CYCLE[(DETAIL_CYCLE.indexOf(this.detail) + 1) % DETAIL_CYCLE.length];
      this.invalidate();
    } else if (matchesKey(data, Key.home)) this.scroll.scrollTo(0, { disableFollow: true });
    else if (matchesKey(data, Key.end) || data === "l") this.scroll.scrollToEnd();
    else return;
    this.saveViewport();
    this.host.requestRender();
  }

  private saveViewport(): void {
    this.viewport.scrollTop = this.scroll.scrollTop;
    this.viewport.follow = this.scroll.isFollowingEnd;
  }

  private get detail(): TranscriptDetail {
    return this.viewport.detail ?? "preview";
  }

  /** One column of horizontal padding on each side of the transcript. */
  private pad(lines: string[]): string[] {
    return lines.map((line) => ` ${line}`);
  }

  /** Full-width themed band with one column of padding, like pi's tool boxes. */
  private band(lines: string[], token: ThemeBg, width: number): string[] {
    const inner = Math.max(1, width - 2);
    return lines.map((line) => {
      const clipped = truncateToWidth(line, inner, "", true);
      return this.theme.bg(
        token,
        ` ${clipped}${" ".repeat(Math.max(0, inner - visibleWidth(clipped)))} `,
      );
    });
  }

  private wrap(value: string, width: number): string[] {
    return text(value)
      .split("\n")
      .flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
  }

  /** Use the same themed Markdown (including code highlighting) as pi's main transcript. */
  private markdown(value: string, width: number, thinking = false): string[] {
    return new Markdown(
      text(value),
      0,
      0,
      getMarkdownTheme(),
      thinking
        ? { color: (value) => this.theme.fg("thinkingText", value), italic: true }
        : undefined,
    ).render(Math.max(1, width));
  }

  /** Tool/metadata previews are bounded by rendered rows, not just source newlines. */
  private preview(content: unknown, width: number): string[] {
    const values = Array.isArray(content) ? content : [content];
    const lines: string[] = [];
    for (const value of values) {
      const block = object(value);
      const valueText =
        typeof value === "string"
          ? value
          : block?.type === "text"
            ? String(block.text ?? "")
            : block?.type === "image"
              ? "[Image — text-only observer]"
              : json(value);
      // Avoid wrapping megabytes of tool output just to display its first three rows.
      const safe = text(valueText);
      const bounded = safe.slice(0, 32768);
      for (const line of bounded.split("\n")) {
        lines.push(...wrapTextWithAnsi(line, Math.max(1, width)));
        if (lines.length > 3) return [...lines.slice(0, 3), this.theme.fg("dim", "...")];
      }
      if (safe.length > bounded.length) return [...lines.slice(0, 3), this.theme.fg("dim", "...")];
    }
    return lines;
  }

  /** Renders padded rows: `width` is the full transcript width. Tool calls get a themed band. */
  private blocks(content: unknown, width: number): string[] {
    const inner = Math.max(1, width - 2);
    if (!Array.isArray(content)) return this.pad(this.blockLines(content, inner));
    return content.flatMap((value) => {
      const block = object(value);
      if (block?.type === "toolCall")
        return this.band(
          this.toolCall(String(block.name), block.arguments, inner),
          "toolSuccessBg",
          width,
        );
      return this.pad(this.blockLines(value, inner));
    });
  }

  private blockLines(value: unknown, width: number): string[] {
    if (typeof value === "string") return this.markdown(value, width);
    const block = object(value);
    if (!block) return this.wrap(json(value), width);
    if (block.type === "text") return this.markdown(String(block.text ?? ""), width);
    if (block.type === "image") return ["[Image — text-only observer]"];
    if (block.type === "thinking") {
      if (this.detail === "compact")
        return [this.theme.fg("dim", "[Thinking hidden · t cycles view]")];
      // Thinking is model-authored Markdown; preview truncates the rendered lines, not the source.
      const rendered = this.markdown(String(block.thinking ?? "[redacted thinking]"), width, true);
      if (this.detail === "full" || rendered.length <= 3) return rendered;
      return [...rendered.slice(0, 3), this.theme.fg("dim", "...")];
    }
    return this.preview(json(block), width);
  }

  private message(message: AgentMessage, width: number): string[] {
    const cached = this.cache.get(message);
    if (cached && cached.width === width && cached.detail === this.detail) return cached.lines;
    const data = message as unknown as Record<string, unknown>;
    const label =
      message.role === "toolResult"
        ? `Tool result: ${String(data.toolName)}${data.isError ? " — error" : ""}`
        : message.role;
    const collapsed = !["user", "assistant", "custom"].includes(message.role);
    const content = data.content ?? data.summary ?? data.output ?? data;
    const inner = Math.max(1, width - 2);
    const heading = this.theme.fg(data.isError ? "error" : "accent", dialogText(label));
    const errors = data.errorMessage
      ? (collapsed
          ? this.preview(String(data.errorMessage), inner)
          : this.wrap(String(data.errorMessage), inner)
        ).map((line) => this.theme.fg("error", line))
      : [];
    const lines =
      message.role === "toolResult"
        ? [
            ...this.band(
              [heading, ...this.preview(content, inner), ...errors],
              data.isError ? "toolErrorBg" : "customMessageBg",
              width,
            ),
            "",
          ]
        : [
            ...this.pad([heading]),
            ...(collapsed ? this.pad(this.preview(content, inner)) : this.blocks(content, width)),
            ...this.pad(errors),
            "",
          ];
    this.cache.set(message, { width, detail: this.detail, lines });
    return lines;
  }

  /**
   * Pi-style tool call lines, mirroring the main session's built-in renderers (`$ command`,
   * `read path:range`, `grep /pattern/ in path`, …) instead of bare JSON. All interpolated values
   * are sanitized; unknown tools fall back to pretty-printed JSON. Shaped by the detail mode:
   * compact keeps one truncated line, preview keeps three wrapped rows, full keeps everything
   * (bounded by the preview byte cap for pathological payloads).
   */
  private toolCall(name: string, args: unknown, width: number): string[] {
    const data = object(args);
    const str = (key: string): string | undefined => {
      const value = data?.[key];
      return typeof value === "string" ? text(value) : undefined;
    };
    const num = (key: string): number | undefined => {
      const value = data?.[key];
      return typeof value === "number" && Number.isFinite(value) ? value : undefined;
    };
    const title = (value: string) => this.theme.fg("accent", value);
    const detail = (value: string) => this.theme.fg("muted", value);
    const path = str("file_path") ?? str("path");
    let lines: string[];
    switch (name) {
      case "bash":
      case "powershell": {
        const prompt = name === "bash" ? "$" : ">";
        const command = (str("command") ?? "...").split("\n");
        const timeout = num("timeout");
        lines = [
          `${title(`${prompt} ${command[0]}`)}${timeout ? detail(` (timeout ${timeout}s)`) : ""}`,
          ...command.slice(1),
        ];
        break;
      }
      case "read": {
        const offset = num("offset");
        const limit = num("limit");
        const range =
          offset == null && limit == null
            ? ""
            : this.theme.fg(
                "warning",
                `:${offset ?? 1}${limit != null ? `-${(offset ?? 1) + limit - 1}` : ""}`,
              );
        lines = [`${title("read")} ${path ?? "?"}${range}`];
        break;
      }
      case "edit":
        lines = [`${title("edit")} ${path ?? "?"}`];
        break;
      case "write": {
        lines = [`${title("write")} ${path ?? "?"}`];
        const content = str("content");
        if (content) {
          const contentLines = content.split("\n");
          while (contentLines.length && contentLines.at(-1) === "") contentLines.pop();
          lines.push(...contentLines);
        }
        break;
      }
      case "grep": {
        const pattern = str("pattern");
        const glob = str("glob");
        const limit = num("limit");
        lines = [
          `${title("grep")} ${this.theme.fg("accent", `/${pattern ?? ""}/`)}` +
            `${path ? detail(` in ${path}`) : ""}${glob ? detail(` (${glob})`) : ""}` +
            `${limit != null ? detail(` limit ${limit}`) : ""}`,
        ];
        break;
      }
      case "find": {
        const pattern = str("pattern");
        const limit = num("limit");
        lines = [
          `${title("find")} ${this.theme.fg("accent", pattern ?? "")}` +
            `${path ? detail(` in ${path}`) : ""}${limit != null ? detail(` (limit ${limit})`) : ""}`,
        ];
        break;
      }
      case "ls": {
        const limit = num("limit");
        lines = [
          `${title("ls")} ${path ?? "."}${limit != null ? detail(` (limit ${limit})`) : ""}`,
        ];
        break;
      }
      default:
        lines = [title(dialogText(name)), ...json(args).split("\n")];
    }
    if (this.detail === "compact")
      return [truncateToWidth(lines[0] ?? "", Math.max(1, width), "…", true)];
    const wrapped = lines.flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
    if (this.detail === "preview" && wrapped.length > 3)
      return [...wrapped.slice(0, 3), this.theme.fg("dim", "...")];
    const bounded: string[] = [];
    let chars = 0;
    for (const line of wrapped) {
      if (chars > 32768) return [...bounded, this.theme.fg("dim", "...")];
      bounded.push(line);
      chars += line.length;
    }
    return bounded;
  }

  render(width: number): string[] {
    const height = Math.max(1, this.host.terminal?.rows ?? 24);
    const columns = Math.max(1, width);
    const snapshot = this.snapshot;
    const thread = snapshot?.thread;
    const inner = Math.max(1, columns - 2);
    const header = this.theme.fg(
      "accent",
      dialogText(
        `${this.path} · ${agentTypeLabel(thread?.type ?? "agent", thread?.icon, this.nerdFontIcons, thread ? agentProgressIcon(thread, this.nerdFontIcons, Date.now(), true, this.loaderStyle) : undefined)} · ${thread?.state ?? "attaching"} — Watching — main continues`,
      ),
    );
    const body: string[] = [];
    if (this.error)
      body.push(
        ` ${this.theme.fg("error", dialogText(`Attachment error: ${this.error}`))}`,
        " Ctrl+R Retry · Esc Back · Ctrl+Q Back to main",
      );
    if (!snapshot) {
      if (!this.error) body.push(" Attaching to retained live session…");
    } else {
      if (snapshot.inheritedCount)
        body.push(
          " " +
            this.theme.fg(
              "dim",
              `${snapshot.inheritedCount} inherited messages ${this.viewport.showInherited ? "shown" : "collapsed"} · c toggle`,
            ),
        );
      const start = this.viewport.showInherited ? 0 : snapshot.inheritedCount;
      for (const message of snapshot.messages.slice(start))
        body.push(...this.message(message, columns));
      if (snapshot.assistant)
        body.push(
          ` ${this.theme.fg("warning", "Assistant streaming…")}`,
          ...this.message(snapshot.assistant, columns),
        );
      const committedResults = new Set(
        snapshot.messages
          .filter((message) => message.role === "toolResult")
          .map((message) => (message.role === "toolResult" ? message.toolCallId : "")),
      );
      for (const tool of snapshot.tools) {
        if (committedResults.has(tool.toolCallId)) continue;
        const call = this.toolCall(tool.toolName, tool.args, inner);
        call[0] = `${call[0]} ${this.theme.fg(
          tool.isError ? "error" : "warning",
          dialogText(
            `— ${tool.state}${tool.isError ? " (error)" : ""}${tool.parentToolCallId ? " (nested)" : ""}`,
          ),
        )}`;
        body.push(...this.band(call, "toolSuccessBg", columns));
        if (tool.result !== undefined && this.detail !== "compact")
          body.push(
            ...this.band(
              this.preview(object(tool.result)?.content ?? tool.result, inner),
              tool.isError ? "toolErrorBg" : "customMessageBg",
              columns,
            ),
          );
        body.push("");
      }
      if (!body.length)
        body.push(
          thread?.state === "starting"
            ? " Starting — waiting for transcript attachment…"
            : " No retained messages yet.",
        );
    }
    this.content = body;
    const bodyHeight = Math.max(0, height - 4);
    this.scroll.updateLayout(body.length, bodyHeight, () => this.scheduleRender());
    if (this.restoreViewport) {
      if (this.viewport.follow) this.scroll.scrollToEnd();
      else this.scroll.scrollTo(this.viewport.scrollTop, { disableFollow: true });
      this.restoreViewport = false;
    }
    const visible = this.scroll
      .render(columns)
      .slice(this.scroll.scrollTop, this.scroll.scrollTop + bodyHeight);
    while (visible.length < bodyHeight) visible.push("");
    this.saveViewport();
    const footer = this.error
      ? "Ctrl+R Retry · Tab input/transcript · Esc tree · Ctrl+Q main"
      : `${this.editing ? "Enter steer · Tab browse" : `Tab steer · Home/End scroll · c context · t view:${this.detail}`} · Esc tree · Ctrl+Q main · ↑↓/PgUp/PgDn scroll · ${this.viewport.follow ? "following" : "scrolled"}`;
    const input = ` ${this.input.render(inner)[0]!}`;
    const status = this.theme.fg(
      this.steerStatus ? (this.steerFailed ? "error" : "muted") : this.error ? "error" : "muted",
      dialogText(
        this.steerStatus ??
          (this.error
            ? `Attachment error: ${this.error}`
            : thread
              ? `${thread.task} · ${thread.status}`
              : "Live transcript · Enter to steer"),
      ),
    );
    // Chrome rows share the transcript's one-column side padding; `visible` is already padded.
    const chrome = (line: string) => ` ${truncateToWidth(line, inner, "")}`;
    const lines =
      height === 1
        ? [input]
        : height === 2
          ? [chrome(header), input]
          : height === 3
            ? [chrome(header), chrome(this.theme.fg("dim", footer)), input]
            : [
                chrome(header),
                chrome(status),
                ...visible,
                chrome(this.theme.fg("dim", footer)),
                input,
              ];
    return fillViewport(lines, width, height);
  }
}
