import assert from "node:assert/strict";
import test from "node:test";
import { subagentPrompt } from "../src/prompt.ts";
import { DEFAULT_MANAGER_SETTINGS } from "../src/settings.ts";

test("off produces no subagent system prompt", () => {
  assert.equal(subagentPrompt({ ...DEFAULT_MANAGER_SETTINGS, subagentMode: "off" }), undefined);
});

test("opportunistic guidance reserves delegation for parallel or very large work", () => {
  const prompt = subagentPrompt(DEFAULT_MANAGER_SETTINGS)!;
  assert.match(prompt, /do ordinary tasks yourself/);
  assert.match(prompt, /only when work can be parallelized or a task is very large/);
  assert.match(prompt, /do not spawn agents for small, straightforward tasks/);
  assert.doesNotMatch(prompt, /Delegate every user task/);
});

test("orchestration delegates all execution and restricts only the root", () => {
  const prompt = subagentPrompt({ ...DEFAULT_MANAGER_SETTINGS, subagentMode: "orchestration" })!;
  assert.match(prompt, /\/root only coordinates/);
  assert.match(prompt, /Delegate every user task.*even small or sequential tasks/);
  assert.match(prompt, /Do not inspect\/edit files, run commands, research, or execute task work yourself/);
  assert.match(prompt, /only to \/root; subagents execute the work/);
  assert.doesNotMatch(prompt, /do ordinary tasks yourself/);
});

test("enabled prompts give concise tool usage and live limits without an agent catalog", () => {
  for (const subagentMode of ["opportunistic", "orchestration"] as const) {
    const prompt = subagentPrompt({
      ...DEFAULT_MANAGER_SETTINGS,
      subagentMode,
      maxLevels: 4,
      maxConcurrent: 7,
    })!;
    assert.match(prompt, /Call agent_types before choosing a type/);
    assert.match(prompt, /spawn all siblings with wait:false before agent_wait/);
    assert.match(prompt, /Maximum depth: 4 levels including L1/);
    assert.match(prompt, /Shared concurrency: 7 active threads; waiting parents count/);
    assert.match(prompt, /Paused agents have no final answer/);
    assert.match(prompt, /Detached notifications do not resume your turn/);
    assert.doesNotMatch(prompt, /Available types:/);
    assert.ok(prompt.length < 1600, "avoid bloated injection");
  }
});
