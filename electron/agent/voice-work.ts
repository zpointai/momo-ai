import type { AssistantRun } from '../../src/shared/assistant';
import { agentRunSchema, type AgentRun } from '../../src/shared/orchestration';
import type { MoContext } from '../ai/mo-context';
import { hasVoiceProposal, retainedVoiceRun } from '../ai/voice-retention';
import { selectAssistantContext } from '../context/adapters';
import { AppError } from '../errors';
import { hash } from './catalogue';
import { createTeam } from './team';
import type { ExecutiveStore } from './mo-executive';

/** Same Executive operations, ephemeral backing until an explicitly requested artifact exists. */
export function voiceWorkStore(base:ExecutiveStore){
 const roots=new Map<string,AgentRun>();
 const store:ExecutiveStore={agent:async(operation,input)=>{
  if(operation==='get')return structuredClone(roots.get(String(input))??null);
  if(operation==='enqueue'){const run=agentRunSchema.parse(input);if(roots.has(run.id))throw new AppError('conflict','Voice work already exists.');roots.set(run.id,run);return run;}
  if(operation==='executiveUpdate'){
   const {run,expectedRevision}=input as {run:AgentRun;expectedRevision:number};
   if(roots.get(run.id)?.executive?.revision!==expectedRevision)throw new AppError('conflict','Voice work changed.');
   roots.set(run.id,structuredClone(run));return run;
  }
  throw new AppError('permission_denied','This voice session permits preparation only.');
 }};
 return {store,async finish(assistant:AssistantRun,guard?:()=>Promise<void>){
  const run=roots.get(assistant.executiveRunId??'');
  if(run&&assistant.status==='succeeded'&&hasVoiceProposal(assistant)){
   const retained=retainedVoiceRun(assistant);
   run.event.prompt='Review proposal prepared through Mo voice';
   run.context.items=run.context.items.filter(i=>retained.sources.some(s=>s.resourceId===i.resourceId));run.context.hash=hash(run.context.items);
   run.context.limitations=['Prepared through authenticated owner voice. Conversation text was ephemeral.'];
   for(const item of run.team?.items??[]){item.objective=item.parentWorkItemId?'Read evidence for the requested proposal':run.event.prompt;item.resultSummary=item.parentWorkItemId?'Permitted evidence read.':retained.result!.answer;item.unresolvedQuestions=[];}
   await guard?.();await base.agent('enqueue',run);
  }
  roots.clear();
 }};
}

export async function ensureVoiceProposalRoot(store:ExecutiveStore,native:MoContext,assistant:AssistantRun){
 if(assistant.channel?.channel!=='voice'||assistant.executiveRunId||assistant.status!=='succeeded'||!hasVoiceProposal(assistant))return;
 const input={id:assistant.id,conversationId:assistant.conversationId,accountId:assistant.accountId,mode:'chat' as const,prompt:assistant.prompt,includeGoogle:assistant.includeGoogle,includeLocal:assistant.includeLocal,includeWeather:assistant.includeWeather};
 const {settings,state}=await native.authority(input),policy=state.policies.find(p=>p.family==='chat'&&p.accountId===input.accountId&&p.enabled);
 if(!state.config.enabled||!policy||!['L0','L1','L2'].includes(policy.level))throw new AppError('permission_denied','Enable this account\'s Mo workflow before preparing work.');
 const at=new Date().toISOString(),selection=selectAssistantContext(input,assistant.sources,[],settings,Date.now(),true);
 const run=agentRunSchema.parse({id:assistant.id,executive:{assistantRunId:assistant.id,conversationId:assistant.conversationId,revision:0,state:'working',nextStep:'Prepare for owner review'},definition:'workflow-v1',event:{id:assistant.id,family:'chat',accountId:assistant.accountId,prompt:'Review proposal prepared through Mo voice'},dedup:hash({kind:'mo-executive-v1',assistant:assistant.id}),context:{id:assistant.id,hash:hash([]),createdAt:at,timezone:settings.timezone,items:[],limitations:[],available:{calendar:false,tasks:false,thread:false},sharing:{google:false,tasks:false}},contextSelection:selection.selection,policy,config:state.config,profileRevision:state.revision,createdAt:at,finishedAt:null,status:'running',checkpoint:'Mo preparing proposal',attempt:0,decision:null,result:null,findings:[],proposals:[],calls:[],error:null,shadow:null});
 run.team=createTeam(run,selection.selection.budget);await store.agent('enqueue',run);assistant.executiveRunId=run.id;
}
