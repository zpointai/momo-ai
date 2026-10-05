import {proactivePermitted} from './proactive';
import { randomUUID } from 'node:crypto';
import type { AssistantRun, AssistantSource, RunRequest } from '../../src/shared/assistant';
import { moDelegationSchema, type MoDelegation } from '../../src/shared/mo';
import { agentRunSchema, type AgentRun } from '../../src/shared/orchestration';
import type { AgentCapability } from '../../src/shared/agent-team';
import type { MoContext, MoReadResult } from '../ai/mo-context';
import type { StorageClient } from '../storage/client';
import { selectAssistantContext } from '../context/adapters';
import { resourceKey } from '../context/manager';
import { hash } from './catalogue';
import { assertWorkItem, createTeam, handoff } from './team';
import { AppError } from '../errors';
import { emptyWorkControl } from '../../src/shared/work-control';
import type { PendingVoiceTask } from '../ai/voice-confirmation';

export type ExecutiveStore=Pick<StorageClient,'agent'>;
export interface MoExecutive {
  continuation?(input:RunRequest):Promise<string|undefined>;
  begin?(input:RunRequest,assistant:AssistantRun,rootId:string,signal:AbortSignal,eventId?:string):Promise<void>;
  delegate(input:RunRequest,assistant:AssistantRun,request:MoDelegation,known:AssistantSource[],signal:AbortSignal):Promise<MoReadResult&{receipt:object}>;
  validate(assistant:AssistantRun,signal:AbortSignal):Promise<void>;
  finish(assistant:AssistantRun,guard?:()=>Promise<void>):Promise<void>;
  createVoiceTask?(input:RunRequest,assistant:AssistantRun,pending:PendingVoiceTask,guard:()=>Promise<void>):Promise<{taskId:string;rootId:string}>;
}
/** Claim the already persisted attention root, preserving its original audit evidence. */
export async function beginExecutive(store:ExecutiveStore,native:MoContext,input:RunRequest,assistant:AssistantRun,rootId:string,signal:AbortSignal,eventId?:string){
 signal.throwIfAborted();const old=agentRunSchema.parse(await store.agent('get',rootId));
 const proactive=!!eventId&&old.desktopResponsibility?.proactive?.pending?.id===eventId&&old.desktopResponsibility.proactive.pending.assistantRunId===assistant.id;
 const continuing=old.executive?.state==='needs-owner'&&old.executive.conversationId===input.conversationId&&!old.executive.proposals?.length;
 if(old.event.accountId!==input.accountId||old.executive&&!continuing&&!proactive||old.scheduling||old.responsibility||old.desktopResponsibility&&!proactive&&!(continuing&&old.desktopResponsibility.proactive)||['running','queued','cancelled'].includes(old.status)||old.localDraftId||old.calendarProposalId||old.proposals.some(p=>p.status==='pending')||old.workControl?.closedAs)throw new AppError('conflict','This work already has an owner or a pending outcome. Open the existing work.');
 const {state,settings}=await native.authority(input),policy=state.policies.find(p=>p.family==='chat'&&p.accountId===input.accountId&&p.enabled);
 if(!state.config.enabled||state.config.paused||!policy||!['L0','L1','L2'].includes(policy.level))throw new AppError('permission_denied','Enable this account’s Mo workflow before handling work.');
 if(old.desktopResponsibility?.proactive){const denied=proactivePermitted(old,state,settings,input.accountId,Date.now());if(denied||old.desktopResponsibility.proactive.paused)throw new AppError('permission_denied',denied??'Responsibility is paused.');}
 const at=new Date().toISOString(),run=structuredClone(old);
 run.executiveOrigin??={context:old.context,team:old.team,policy:old.policy,config:old.config,profileRevision:old.profileRevision,status:old.status,checkpoint:old.checkpoint,finishedAt:old.finishedAt,result:old.result,decision:old.decision};
 if(continuing||proactive&&old.executive){run.executiveHistory??=[];if(run.executiveHistory.length>=12)throw new AppError('unavailable','This work has reached its continuation bound. Review its retained history.');run.executiveHistory.push({assistantRunId:old.executive!.assistantRunId,context:old.context,team:old.team,finishedAt:old.finishedAt});}
 run.executive={assistantRunId:assistant.id,conversationId:input.conversationId,revision:old.executive?old.executive.revision+1:0,state:'working',nextStep:proactive?old.desktopResponsibility!.proactive!.pending!.detail:'Mo will inspect the selected source and choose the required specialist'};
 run.policy=policy;run.config=state.config;run.profileRevision=state.revision;run.status='running';run.finishedAt=null;run.error=null;run.checkpoint='Mo claimed this work';
 run.context={...old.context,id:randomUUID(),hash:hash([]),createdAt:at,timezone:settings.timezone,items:[],limitations:[],sharing:{google:input.includeGoogle,tasks:!!input.includeLocal}};
 const selection=selectAssistantContext(input,[],[],settings,Date.now(),true);run.contextSelection=selection.selection;
 run.team=createTeam({...run,createdAt:at},selection.selection.budget);
 if(old.team){run.team.items[0].id=old.team.items[0].id;run.team.specialistId=run.team.items[0].id;}
 run.team.items[0].objective=input.prompt;run.team.items[0].status='running';
 run.workControl??=emptyWorkControl();run.workControl.snoozedUntil=null;run.workControl.revision++;run.workControl.history.push({at,action:'handle',detail:proactive?'An explicitly approved native event woke Mo on this root. Original evidence retained.':'Owner assigned this existing root to Mo. Original assessment evidence retained.'});
 await store.agent('claimExecutive',{run,expected:old});assistant.executiveRunId=run.id;
}
const scopes:Record<MoDelegation['specialist'],readonly string[]>={inbox:['inbox'],planner:['agenda','tasks'],briefing:['inbox','agenda','tasks','workflows','weather'],context:['inbox','agenda','tasks','workflows','weather'],review:['inbox','agenda','tasks','workflows','weather'],comms:['workflows']};
const capability:Record<MoDelegation['specialist'],AgentCapability>={inbox:'inbox.assess',planner:'planner.analyze',briefing:'briefing.synthesize',context:'context.read',review:'evidence.review',comms:'response.generate'};
export function validateDelegation(raw:MoDelegation){
  const request=moDelegationSchema.parse(raw);
  if(new Set(request.sources).size!==request.sources.length||request.sources.some(s=>!scopes[request.specialist].includes(s)))throw new AppError('permission_denied','That specialist cannot use the requested capability.');
  if(request.sourceId&&!request.sources.includes('inbox')||request.search&&!request.sources.includes('inbox')||(request.date||request.endDate)&&!request.sources.includes('agenda')||request.refreshWeather&&!request.sources.includes('weather'))throw new AppError('permission_denied','The source selector does not match this capability.');
  return request;
}
async function root(store:ExecutiveStore,assistant:AssistantRun){return assistant.executiveRunId?agentRunSchema.parse(await store.agent('get',assistant.executiveRunId)):null;}
export async function validateExecutive(store:ExecutiveStore,native:MoContext,assistant:AssistantRun,input:RunRequest,signal:AbortSignal){
  signal.throwIfAborted();const r=await root(store,assistant);if(!r)return;
  const {state,settings}=await native.authority(input);
  if(r.desktopResponsibility?.proactive){const denied=proactivePermitted(r,state,settings,input.accountId,Date.now());if(denied||r.desktopResponsibility.proactive.paused)throw new AppError('permission_denied',denied??'Responsibility is paused.');}
  if(r.status!=='running'||!r.executive||r.executive.assistantRunId!==assistant.id)throw new AppError('cancelled','Executive work is no longer active.');
  if(state.revision!==r.profileRevision||!state.config.enabled||state.config.paused||!state.policies.some(p=>p.id===r.policy.id&&p.version===r.policy.version&&p.enabled))throw new AppError('permission_denied','Executive authority changed. Start a new request.');
}
async function save(store:ExecutiveStore,r:AgentRun){const revision=r.executive!.revision;r.executive!.revision++;await store.agent('executiveUpdate',{run:r,expectedRevision:revision});}
export async function delegateMo(store:ExecutiveStore,native:MoContext,input:RunRequest,assistant:AssistantRun,raw:MoDelegation,known:AssistantSource[],signal:AbortSignal){
  const request=validateDelegation(raw),{settings,state}=await native.authority(input);
  const policy=state.policies.find(p=>p.family==='chat'&&p.accountId===input.accountId&&p.enabled);
  if(!state.config.enabled||!policy||!['L0','L1','L2'].includes(policy.level))throw new AppError('permission_denied','Enable this account’s chat workflow in Automations before delegating.');
  if(request.sources.some(s=>['inbox','agenda'].includes(s))&&(!input.includeGoogle||!state.config.shareGoogle)||request.sources.some(s=>['tasks','workflows'].includes(s))&&(!input.includeLocal||!state.config.shareTasks)||request.sources.includes('weather')&&!input.includeWeather)throw new AppError('permission_denied','The requested source is outside the current sharing grant.');
  if(request.specialist==='comms'&&settings.disabledModules.includes('relay'))throw new AppError('permission_denied','Comms is unavailable while Relay is disabled.');
  await validateExecutive(store,native,assistant,input,signal);
  const approved=await root(store,assistant);
  if(approved?.desktopResponsibility?.proactive&&!approved.desktopResponsibility.specialistScope?.includes(request.specialist))throw new AppError('permission_denied','This specialist is outside the approved responsibility scope.');
  const requestFingerprint=hash({specialist:request.specialist,sources:[...request.sources].sort(),date:request.date,sourceId:request.sourceId,endDate:request.endDate??null,search:request.search??null,...(request.refreshWeather?{refreshWeather:true}:{})});
  const previous=await root(store,assistant),cached=previous?.team?.items.find(w=>w.requestFingerprint===requestFingerprint);
  if(cached){
    const sources=known.filter(s=>cached.sources.some(r=>r.id===s.ref?.id&&r.revision===s.ref.revision&&r.type===s.ref.type));
    if(sources.length===cached.context.bindings.length){await native.validate(input,sources,signal);return {sources,warnings:['Reused this turn’s current specialist evidence; no repeated native read.'],receipt:{rootRunId:previous!.id,workItemId:cached.id,specialist:cached.role,status:cached.status,reused:true,evidenceIds:sources.map(s=>s.id)}};}
  }
  let loaded:MoReadResult;
  try{loaded=request.specialist==='review'?{sources:known.filter(s=>request.sources.includes(({mail:'inbox',calendar:'agenda',task:'tasks',workflow:'workflows',weather:'weather'} as const)[s.kind])),warnings:['Native evidence review; no second model was called.']}:await native.read(input,request,known,signal);}
  catch(error){signal.throwIfAborted();if(error instanceof AppError&&error.code!=='unavailable')throw error;loaded={sources:[],warnings:['The requested specialist source is unavailable. No facts were retrieved.']};}
  await native.validate(input,loaded.sources,signal);
  const current=await native.authority(input);if(current.state.revision!==state.revision)throw new AppError('permission_denied','Sharing or workflow settings changed during delegation.');
  const selection=selectAssistantContext({...input,messageId:loaded.sources.some(s=>s.resourceId===input.messageId)?input.messageId:undefined},loaded.sources,[],settings,Date.now(),true);
  if(selection.selection.blocked)throw new AppError('permission_denied','Specialist context exceeds the permitted budget.');
  const sources=selection.sources,at=new Date().toISOString();
  if(input.workId&&!assistant.executiveRunId){
    const existing=agentRunSchema.parse(await store.agent('get',input.workId));
    if(existing.event.accountId!==input.accountId)throw new AppError('permission_denied','The selected work belongs to another account.');
    // Conversational inspection refers to the existing work; it does not reassign or replay it.
    return {sources,warnings:loaded.warnings,mailSearch:loaded.mailSearch,receipt:{rootRunId:existing.id,specialist:request.specialist,inspection:true,evidenceIds:sources.map(s=>s.id)}};
  }
  let run=await root(store,assistant);
  const items=sources.map(s=>({id:s.id,kind:({mail:'email',calendar:'calendar',task:'task',workflow:'workflow',weather:'situation'} as const)[s.kind],accountId:s.accountId,resourceId:s.resourceId,revision:s.ref!.revision,title:s.label,text:s.detail,fetchedAt:s.fetchedAt,trust:'untrusted-source' as const,senderScope:null,threadId:null,delivery:s.delivery}));
  if(!run){
    run=agentRunSchema.parse({id:assistant.id,executive:{assistantRunId:assistant.id,conversationId:input.conversationId,revision:0,state:'working',nextStep:'Return the requested specialist evidence to Mo'},definition:'workflow-v1',event:{id:assistant.id,family:'chat',accountId:input.accountId,prompt:input.prompt},dedup:hash({kind:'mo-executive-v1',assistant:assistant.id}),context:{id:randomUUID(),hash:hash(items),createdAt:at,timezone:settings.timezone,items,limitations:loaded.warnings,available:{calendar:request.sources.includes('agenda'),tasks:request.sources.includes('tasks'),thread:false},sharing:{google:input.includeGoogle&&state.config.shareGoogle,tasks:!!input.includeLocal&&state.config.shareTasks}},contextSelection:selection.selection,policy,config:state.config,profileRevision:state.revision,createdAt:at,finishedAt:null,status:'running',checkpoint:'Mo coordinating',attempt:0,decision:null,result:null,findings:[],proposals:[],calls:[],error:null,shadow:null});
    run.team=createTeam(run,selection.selection.budget);
    await store.agent('enqueue',run);assistant.executiveRunId=run.id;
  }else{
    await validateExecutive(store,native,assistant,input,signal);
    const merged=[...run.context.items.filter(s=>!items.some(i=>i.id===s.id)),...items].slice(-20);
    run.context.items=merged;run.context.hash=hash(merged);run.contextSelection=selection.selection;
    const parent=run.team!.items[0];parent.sources=merged.map(s=>s.delivery!.ref);parent.context={selectionId:selection.selection.workItemId,bindings:merged.map(s=>({evidenceId:s.id,delivery:s.delivery!}))};parent.provenance.contextHash=run.context.hash;parent.revisionBindings=parent.sources.map(r=>({key:resourceKey(r),revision:r.revision}));
  }
  const parent=run.team!.items[0],bindings=items.map(s=>({evidenceId:s.id,delivery:s.delivery!}));parent.status='running';
  const child=handoff(run.team!,parent,request.specialist,request.objective,Date.now(),{requestFingerprint,allowedCapabilities:['context.read',...request.specialist==='context'?[]:[capability[request.specialist]]],sources:bindings.map(b=>b.delivery.ref),context:{selectionId:selection.selection.workItemId,bindings},provenance:{...parent.provenance,contextHash:run.context.hash},revisionBindings:bindings.map(b=>({key:resourceKey(b.delivery.ref),revision:b.delivery.ref.revision})),permission:{...parent.permission,actions:[]}});
  assertWorkItem(child,run,Date.now(),signal);
  // These specialists execute bounded native reads/review. No model is invoked just to restate a read.
  const unavailable=!sources.length&&loaded.warnings.some(w=>/unavailable|not shared|off|stale|expired|disabled|not read|not bound|incomplete|exceeds/i.test(w));
  child.status=unavailable?'held':'complete';child.resultSummary=`${sources.length} permitted evidence records returned.`;child.reason=unavailable?loaded.warnings[0]?.slice(0,240)??'Source unavailable.':null;
  run.team!.specialistId=child.id;run.checkpoint='Mo received '+request.specialist+' evidence';
  await native.validate(input,sources,signal);await validateExecutive(store,native,assistant,input,signal);await save(store,run);
  return {sources,warnings:loaded.warnings,mailSearch:loaded.mailSearch,receipt:{rootRunId:run.id,workItemId:child.id,specialist:child.role,status:child.status,objective:child.objective,evidenceIds:sources.map(s=>s.id),limitations:loaded.warnings}};
}
export async function finishExecutive(store:ExecutiveStore,assistant:AssistantRun){
  const run=await root(store,assistant);if(!run||run.status!=='running')return;
  const state=assistant.status==='cancelled'?'cancelled':assistant.status!=='succeeded'?/expired|stale|changed/i.test(assistant.error??'')?'stale':'failed':assistant.result?.clarification?'needs-owner':assistant.result?.reply||assistant.result?.responsibility||assistant.result?.suggestions.length?'prepared':run.team?.items.some(w=>w.parentWorkItemId&&w.status==='held')?'blocked':'completed';
  run.executive!.state=state;run.executive!.nextStep=state==='prepared'?'Review the prepared proposal in Work':state==='needs-owner'?'Answer Mo’s clarification':state==='completed'?'No further step':state==='cancelled'?'No further work will run':'Review the limitation and start a fresh request';
  run.executive!.proposals=[...(assistant.result?.reply?[{id:assistant.id,kind:'reply-proposal' as const}]:[]),...(assistant.result?.responsibility?[{id:assistant.id,kind:'responsibility-proposal' as const}]:[]),...(assistant.result?.suggestions??[]).map((_,index)=>({id:assistant.id+':'+index,kind:'task-proposal' as const}))];
  run.status=state==='cancelled'?'cancelled':['stale','failed','blocked'].includes(state)?'failed':['prepared','needs-owner'].includes(state)?'review':'complete';run.finishedAt=new Date().toISOString();run.error=assistant.error;run.checkpoint=run.executive!.nextStep.slice(0,100);
  const parent=run.team!.items[0];parent.status=state==='cancelled'?'cancelled':state==='completed'?'complete':['prepared','needs-owner'].includes(state)?'held':'failed';parent.resultSummary=assistant.result?.answer.slice(0,500)??null;parent.reason=assistant.error;
  if(assistant.result?.clarification)parent.unresolvedQuestions=[assistant.result.clarification];
  if(run.desktopResponsibility?.proactive){const r=run.desktopResponsibility;r.proactive!.pending=null;r.status=state==='completed'?'waiting':state==='cancelled'?'cancelled':'review';r.proactive!.waitingReason=state==='completed'?'Preparation finished. Waiting for the next approved meaningful change.':run.executive!.nextStep;r.revision++;}
  await save(store,run);
}
