import { buildSessionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ConfigStore } from "./config.ts";
import { ThreadManager } from "./manager.ts";
import { createDriverFactory } from "./runtime.ts";
import { agentTools } from "./tools.ts";
import { editAgentTypes, showThreads, updateWidget } from "./ui.ts";
import type { SavedThread, ThreadEvent } from "./types.ts";

const REGISTRY_ENTRY = "pi-subagent:registry:v1";

export default function piSubagent(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let store = new ConfigStore({cwd:process.cwd(),agentDir:getAgentDir(),includeProject:false});
  store.reload();
  let manager: ThreadManager | undefined;
  let generation = 0;
  let persistenceSignature = "";
  const requireManager = () => {if (!manager) throw new Error("Subagent threads are not initialized; start a Pi session first"); return manager;};
  const requireContext = () => {if (!context) throw new Error("No active Pi session"); return context;};
  const persist = () => {
    if (!manager) return;
    const threads = manager.saved();
    // Token/tool activity updates the widget, not the durable registry. Persist lifecycle/identity only.
    const signature = JSON.stringify(threads.map(({view,definition}) => ({...view,updatedAt:0,status:view.state === "running" ? "Working" : view.status,definition})));
    if (signature !== persistenceSignature) { pi.appendEntry(REGISTRY_ENTRY,{version:1,threads}); persistenceSignature = signature; }
  };
  const delivery = (event: ThreadEvent) => {
    if (event.kind === "change") return;
    const thread = event.thread;
    const message = event.kind === "update" ? `Progress from ${thread.path}: ${event.message}` : thread.state === "completed" ? `Agent ${thread.path} completed. Final answer:\n${thread.output?.slice(0,16000) ?? "(no text)"}${(thread.output?.length ?? 0)>16000?"\n[Output truncated; use agent_output for more.]":""}` : `Agent ${thread.path} is ${thread.state}: ${thread.status}. ${thread.state === "paused"?"No answer handback; send input to resume the same session.":"Session retained for further input."}`;
    try {
      if (event.recipient === "/root") pi.sendMessage({customType:"pi-subagent:update",content:message,display:true,details:{path:thread.path,state:thread.state}}, {triggerTurn:false,deliverAs:"nextTurn"});
      else requireManager().deliver(event.recipient,message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context?.ui.notify(`Subagent delivery failed: ${message}`,"warning");
    }
  };

  for (const tool of agentTools(requireManager,"/root",()=>store.list())) pi.registerTool(tool);
  pi.on("before_agent_start",async event => ({systemPrompt:`${event.systemPrompt}\n\n## pi-subagent\nYou are /root. Thread paths determine context ancestry, independently of agent type. Children can pause WITHOUT handing back an answer; completed and paused sessions can both receive more work via agent_steer. Working child threads appear above the footer. Available types:\n${store.list().map(type=>`- ${type.name}: ${type.description}`).join("\n")}\nUse agent_status to inspect and agent_wait to wait. Detached notifications do not automatically resume your turn.`}));

  pi.on("session_start",async (_event,ctx) => {
    const token = ++generation;
    // session_start already belongs to the replacement session: never append the old registry here.
    if (manager) await manager.shutdown();
    context = ctx;
    store = new ConfigStore({cwd:ctx.cwd,agentDir:getAgentDir(),includeProject:ctx.isProjectTrusted()});
    store.reload();
    persistenceSignature = "";
    const instance = new ThreadManager({
      createDriver:createDriverFactory(requireContext),
      rootSnapshot:()=>buildSessionContext(requireContext().sessionManager.getBranch()).messages,
      getType:name=>store.get(name),
      toolsFor:path=>agentTools(requireManager,path,()=>store.list()),
      onEvent:event=>{
        if (token !== generation) return;
        updateWidget(requireContext(),requireManager().list());
        persist();
        delivery(event);
      },
    });
    manager = instance;
    const entries = ctx.sessionManager.getBranch();
    const entry = [...entries].reverse().find(item=>item.type === "custom" && item.customType === REGISTRY_ENTRY);
    if (entry?.type === "custom") {
      try {
        const data = entry.data as {version:number;threads:SavedThread[]};
        if (data.version !== 1 || !Array.isArray(data.threads)) throw new Error("Invalid registry format");
        instance.restore(data.threads);
      } catch (error) { ctx.ui.notify(`Could not restore subagent registry: ${String(error)}`,"error"); }
    }
    updateWidget(ctx,requireManager().list());
    if (store.diagnostics.length) ctx.ui.notify(store.diagnostics.join("\n"),"warning");
  });
  pi.on("session_shutdown",async () => { persist(); generation++; await manager?.shutdown(); manager=undefined;context=undefined; });
  pi.registerCommand("agents",{
    description:"Inspect/resume retained threads, edit agent types or reload configuration",
    getArgumentCompletions:prefix=>["types","reload","thread"].filter(value=>value.startsWith(prefix)).map(value=>({value,label:value})),
    handler:async (args,ctx)=>{
      const [command,...rest] = args.trim().split(/\s+/);
      if (command === "types") {await editAgentTypes(ctx,store); store.reload();}
      else if (command === "reload") {store.reload();ctx.ui.notify(store.diagnostics.length?store.diagnostics.join("\n"):`Loaded ${store.list().length} agent types`,store.diagnostics.length?"warning":"info");}
      else if (!command || command === "thread") {
        const controller={list:()=>requireManager().list(),get:(path:string)=>requireManager().get(path),output:(path:string)=>requireManager().output(path),transcript:(path:string)=>requireManager().transcript("/root",path),steer:(path:string,message:string)=>requireManager().steer("/root",path,message),stop:(path:string)=>requireManager().stop("/root",path)};
        await showThreads(ctx,controller,rest.join(" ") || undefined);
      } else ctx.ui.notify("Usage: /agents [types | reload | thread /root/name]","warning");
    },
  });
}
