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
import { agentTypeLabel } from "./ui.ts";

export interface AgentViewportState {
  scrollTop: number;
  follow: boolean;
  showInherited?: boolean;
  showThinking?: boolean;
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
  private cache = new WeakMap<object, { width: number; thinking: boolean; lines: string[] }>();
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
    this.scheduleRender();
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
      this.viewport.showThinking = !this.viewport.showThinking;
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

  private blocks(content: unknown, width: number): string[] {
    if (typeof content === "string") return this.markdown(content, width);
    if (!Array.isArray(content)) return this.wrap(json(content), width);
    return content.flatMap((value) => {
      const block = object(value);
      if (!block) return this.wrap(json(value), width);
      if (block.type === "text") return this.markdown(String(block.text ?? ""), width);
      if (block.type === "image") return ["[Image — text-only observer]"];
      if (block.type === "thinking")
        return this.viewport.showThinking
          ? this.markdown(String(block.thinking ?? "[redacted thinking]"), width, true)
          : [this.theme.fg("dim", "[Thinking hidden · t show]")];
      if (block.type === "toolCall")
        return [
          this.theme.fg(
            "accent",
            dialogText(`Tool call: ${String(block.name)} (${String(block.id)})`),
          ),
          ...this.preview(json(block.arguments), width),
        ];
      return this.preview(json(block), width);
    });
  }

  private message(message: AgentMessage, width: number): string[] {
    const cached = this.cache.get(message);
    if (cached && cached.width === width && cached.thinking === !!this.viewport.showThinking)
      return cached.lines;
    const data = message as unknown as Record<string, unknown>;
    const label =
      message.role === "toolResult"
        ? `Tool result: ${String(data.toolName)}${data.isError ? " — error" : ""}`
        : message.role;
    const collapsed = !["user", "assistant", "custom"].includes(message.role);
    const content = data.content ?? data.summary ?? data.output ?? data;
    const lines = [
      this.theme.fg(data.isError ? "error" : "accent", dialogText(label)),
      ...(collapsed ? this.preview(content, width) : this.blocks(content, width)),
      ...(data.errorMessage
        ? (collapsed
            ? this.preview(String(data.errorMessage), width)
            : this.wrap(String(data.errorMessage), width)
          ).map((line) => this.theme.fg("error", line))
        : []),
      "",
    ];
    this.cache.set(message, { width, thinking: !!this.viewport.showThinking, lines });
    return lines;
  }

  render(width: number): string[] {
    const height = Math.max(1, this.host.terminal?.rows ?? 24);
    const columns = Math.max(1, width);
    const snapshot = this.snapshot;
    const thread = snapshot?.thread;
    const header = this.theme.fg(
      "accent",
      dialogText(
        `${this.path} · ${agentTypeLabel(thread?.type ?? "agent", thread?.icon, this.nerdFontIcons)} · ${thread?.state ?? "attaching"} — Watching — main continues`,
      ),
    );
    const body: string[] = [];
    if (this.error)
      body.push(
        this.theme.fg("error", dialogText(`Attachment error: ${this.error}`)),
        "Ctrl+R Retry · Esc Back · Ctrl+Q Back to main",
      );
    if (!snapshot) {
      if (!this.error) body.push("Attaching to retained live session…");
    } else {
      if (snapshot.inheritedCount)
        body.push(
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
          this.theme.fg("warning", "Assistant streaming…"),
          ...this.message(snapshot.assistant, columns),
        );
      const committedResults = new Set(
        snapshot.messages
          .filter((message) => message.role === "toolResult")
          .map((message) => (message.role === "toolResult" ? message.toolCallId : "")),
      );
      for (const tool of snapshot.tools) {
        if (committedResults.has(tool.toolCallId)) continue;
        body.push(
          this.theme.fg(
            tool.isError ? "error" : "warning",
            dialogText(
              `Tool ${tool.toolName} — ${tool.state}${tool.isError ? " (error)" : ""}${tool.parentToolCallId ? " (nested)" : ""}`,
            ),
          ),
          ...this.preview(json(tool.args), columns),
        );
        if (tool.result !== undefined)
          body.push(...this.preview(object(tool.result)?.content ?? tool.result, columns));
        body.push("");
      }
      if (!body.length)
        body.push(
          thread?.state === "starting"
            ? "Starting — waiting for transcript attachment…"
            : "No retained messages yet.",
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
      : `${this.editing ? "Enter steer · Tab browse" : "Tab steer · Home/End scroll · c context · t thinking"} · Esc tree · Ctrl+Q main · ↑↓/PgUp/PgDn scroll · ${this.viewport.follow ? "following" : "scrolled"}`;
    const input = this.input.render(columns)[0]!;
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
    const lines =
      height === 1
        ? [input]
        : height === 2
          ? [header, input]
          : height === 3
            ? [header, this.theme.fg("dim", footer), input]
            : [header, status, ...visible, this.theme.fg("dim", footer), input];
    return fillViewport(lines, width, height);
  }
}
