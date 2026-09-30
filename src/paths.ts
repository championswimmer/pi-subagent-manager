import type { AgentMessage } from "@earendil-works/pi-agent-core";

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export function canonicalPath(value: string, caller = "/root"): string {
  if (!value || value !== value.trim()) throw new Error("Agent path must not be empty or contain surrounding whitespace");
  const path = value.startsWith("/") ? value : `${caller}/${value}`;
  const parts = path.slice(1).split("/");
  if (!parts.every(part => SEGMENT.test(part)) || parts.length > 32) {
    throw new Error("Agent paths require slash-separated names (letters, digits, - or _); no dot segments, escapes, empty segments or trailing slash");
  }
  return path;
}
export function parentPath(path: string): string | null {
  canonicalPath(path);
  const last = path.lastIndexOf("/");
  return last === 0 ? null : path.slice(0, last);
}
export function isDescendant(path: string, ancestor: string): boolean {
  return path.startsWith(`${ancestor}/`);
}

/** Snapshot conversation, not the parent's prompt/loadout; retain only matched tool exchanges. */
export function inheritContext(messages: readonly AgentMessage[]): AgentMessage[] {
  const copy = structuredClone(messages);
  const pending = new Set<string>();
  const matched = new Set<string>();
  for (const message of copy) {
    if (message.role === "assistant") {
      for (const block of message.content) if (block.type === "toolCall") pending.add(block.id);
    } else if (message.role === "toolResult" && pending.has(message.toolCallId)) {
      matched.add(message.toolCallId);
      pending.delete(message.toolCallId);
    }
  }
  return copy.flatMap((message): AgentMessage[] => {
    // System/extension-only messages carry parent prompt state; a child uses its own type prompt.
    if (message.role === "system" || message.role === "custom" || message.role === "bashExecution") return [];
    if (message.role === "assistant") {
      if (message.stopReason === "error" || message.stopReason === "aborted") return [];
      message.content = message.content.filter(block => block.type !== "toolCall" || matched.has(block.id));
      if (!message.content.length) return [];
      // A tools-only assistant without remaining calls should not claim a toolUse stop.
      if (!message.content.some(block => block.type === "toolCall") && message.stopReason === "toolUse") message.stopReason = "stop";
    }
    if (message.role === "toolResult" && !matched.has(message.toolCallId)) return [];
    return [message];
  });
}
