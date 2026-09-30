import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ThreadManager } from "./manager.ts";
import type { AgentType, ThreadView } from "./types.ts";

const path = Type.String({ description: "Absolute agent path, or name relative to the caller" });
const text = Type.String({ minLength: 1 });
function compact(thread: ThreadView): ThreadView & { outputTruncated?: boolean } {
  if (thread.output && thread.output.length > 16000)
    return { ...thread, output: thread.output.slice(0, 16000), outputTruncated: true };
  return thread;
}
function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

/** All threads see the same verbs, with caller identity bound by closure, never model input. */
export function agentTools(
  getManager: () => ThreadManager,
  caller: string,
  getTypes: () => AgentType[],
): ToolDefinition[] {
  const threads = () => getManager().scope(caller);
  const make = (
    name: string,
    description: string,
    parameters: any,
    execute: (params: any, signal?: AbortSignal) => Promise<any> | any,
  ): ToolDefinition => ({
    name,
    label: name,
    description,
    parameters,
    execute: async (_id, params, signal) => execute(params, signal),
  });
  return [
    make(
      "agent_types",
      "List current agent types and their task descriptions. Reflects configuration reloads; call this before choosing a type.",
      Type.Object({}),
      () =>
        result(
          getTypes().map(({ name, description, model, thinkingLevel, color }) => ({
            name,
            description,
            model,
            thinkingLevel,
            color,
          })),
        ),
    ),
    make(
      "agent_spawn",
      "Spawn a named child. The lexical parent, NOT the caller, supplies a context snapshot. /root is the main thread; independent roots have no inherited context. Foreground waits by default; wait:false runs detached. Existing paths are retained and can be resumed with agent_steer. Use agent_types to discover current types.",
      Type.Object({ path, type: text, task: text, wait: Type.Optional(Type.Boolean()) }),
      async (params, signal) => result(compact(await threads().spawn(params, signal))),
    ),
    make(
      "agent_wait",
      "Wait for a descendant to complete, fail, stop or pause. Paused means no final answer handback. Cancellation/timeouts do not stop the child; poll status or wait again.",
      Type.Object({
        path,
        timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 3600000 })),
      }),
      async (params, signal) =>
        result(compact(await threads().wait(params.path, params.timeoutMs, signal))),
    ),
    make(
      "agent_steer",
      "Send input to a descendant. Working threads receive queued steering; completed, stopped and paused threads resume the SAME session with its previous context. Returns immediately; use agent_wait for the result.",
      Type.Object({ path, message: text }),
      async (params) => result(compact(await threads().steer(params.path, params.message))),
    ),
    make(
      "agent_status",
      "Read a thread's status or list visible descendants. Root can inspect all trees. Completion retains the session; pause retains it without final answer handback.",
      Type.Object({ path: Type.Optional(path) }),
      (params) =>
        result(params.path ? compact(threads().get(params.path)) : threads().list().map(compact)),
    ),
    make(
      "agent_update",
      "Child-only: send progress to the parent without ending this task. Delivery is recorded and displayed but does not interrupt or automatically restart the parent model.",
      Type.Object({ message: Type.String({ minLength: 1, maxLength: 8000 }) }),
      (params) => result(compact(threads().update(params.message))),
    ),
    make(
      "agent_pause",
      "Child-only: stop at this turn boundary WITHOUT returning a final answer. Keep the SAME session for user/parent input via agent_steer. To finish and hand back an answer instead, simply return your final assistant answer. Both states can be resumed.",
      Type.Object({ reason: text }),
      (params) => ({
        ...result({
          path: caller,
          pauseRequested: true,
          status: threads().pause(params.reason).status,
        }),
        terminate: true,
      }),
    ),
    make(
      "agent_stop",
      "Stop a descendant and its working children. Session history is retained; resume with agent_steer. This is cooperative cancellation, not sandbox process termination.",
      Type.Object({ path }),
      async (params) => result(compact(await threads().stop(params.path))),
    ),
    make(
      "agent_output",
      "Read completed thread output in character pages. Paused threads deliberately have no final answer handback. All sessions can be viewed by the user with /agents thread PATH.",
      Type.Object({
        path,
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000 })),
      }),
      (params) => {
        const output = threads().output(params.path),
          offset = params.offset ?? 0,
          limit = params.limit ?? 8000;
        return result({
          path: threads().get(params.path).path,
          text: output.slice(offset, offset + limit),
          totalCharacters: output.length,
          nextOffset: offset + limit < output.length ? offset + limit : null,
        });
      },
    ),
  ];
}
