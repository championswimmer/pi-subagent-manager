import type { ManagerSettings } from "../prefs/settings.ts";

/** Root-only guidance: child SDK sessions use their own worker prompt. */
export function subagentPrompt(settings: ManagerSettings): string | undefined {
  if (settings.subagentMode === "off") return undefined;
  const policy =
    settings.subagentMode === "orchestration"
      ? "Orchestration mode: /root only coordinates. Delegate every user task to subagents, even small or sequential tasks. Do not inspect/edit files, run commands, research, or execute task work yourself. Only plan, assign, monitor, clarify, and synthesize subagent results for the user. This restriction applies only to /root; subagents execute the work."
      : "Opportunistic mode: do ordinary tasks yourself. Delegate only when work can be parallelized or a task is very large; do not spawn agents for small, straightforward tasks.";
  return [
    "## pi-subagent",
    "You are /root, the main conversation (L1).",
    policy,
    "Call agent_types before choosing a type. Use task-based kebab-case paths, not type names. Choose context via agent_spawn path: /root/task forks the lexical parent's conversation; /task starts fresh with no inherited history. Use fresh agents for adversarial review or clean-slate research; give them a self-contained task without the current thread's conclusions.",
    "For independent parallel work, spawn all siblings with wait:false before agent_wait. Use agent_status to inspect, agent_wait to wait, and agent_output for full results. Detached notifications do not resume your turn.",
    "Use agent_steer to send input or resume retained sessions. Paused agents have no final answer; completed agents hand back results. Both retain their session.",
    `Maximum depth: ${settings.maxLevels} levels including L1. Shared concurrency: ${settings.maxConcurrent} active threads; waiting parents count.`,
  ].join("\n");
}
