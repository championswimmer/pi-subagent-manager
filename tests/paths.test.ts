import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { canonicalPath, inheritContext, isDescendant, parentPath } from "../src/paths.ts";

test("canonical ancestry is structural, not prefix matching or URL normalization",()=>{
  assert.equal(canonicalPath("coding-researcher","/root/worker"),"/root/worker/coding-researcher");
  assert.equal(parentPath("/a/b/c"),"/a/b");assert.equal(parentPath("/k"),null);
  assert.equal(isDescendant("/root/ab","/root/a"),false);
  for (const path of ["","/root/../worker","/root//worker","/root/worker/","/root/%61"," /root/a","/root/a?b","/root/a\\b"]) assert.throws(()=>canonicalPath(path));
});

test("context snapshots strip unfinished/orphaned tool exchanges and clone messages",()=>{
  const assistant=(content:any[]):AgentMessage=>({role:"assistant",content,api:"openai-responses",provider:"openai",model:"model",usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"toolUse",timestamp:1});
  const messages:AgentMessage[]=[{role:"user",content:"parent context",timestamp:1},assistant([{type:"text",text:"Checking"},{type:"toolCall",id:"done",name:"read",arguments:{path:"x"}},{type:"toolCall",id:"pending",name:"agent_spawn",arguments:{}}]),{role:"toolResult",toolCallId:"done",toolName:"read",content:[{type:"text",text:"contents"}],isError:false,timestamp:1},{role:"toolResult",toolCallId:"orphan",toolName:"read",content:[],isError:false,timestamp:1}];
  const inherited=inheritContext(messages);
  assert.equal(inherited.length,3);
  assert.deepEqual((inherited[1] as any).content.map((block:any)=>block.id??block.text),["Checking","done"]);
  (inherited[0] as any).content="child mutation";assert.equal((messages[0] as any).content,"parent context");
});
