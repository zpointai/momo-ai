import { workSource } from '../../src/shared/work';
import { voiceWorkStore, ensureVoiceProposalRoot } from './voice-work';
import { createVoiceLocalTask } from './voice-local-task';
import type { AssistantRun } from '../../src/shared/assistant';
import {approveProactive,correlateEvent,filterProactive,holdProactive,proactivePermitted,taskEvents,type NativeWorkEvent} from './proactive';
import { MO_IDENTITY } from '../../src/shared/mo';
import { beginExecutive, delegateMo, validateExecutive, finishExecutive, type MoExecutive } from './mo-executive';
import type { MoContext } from '../ai/mo-context';
import { newResponsibility, stageRelay, prepareRelayResult } from './relay';
import { desktopResponsibility } from './desktop-responsibility';
import { sameContinuation } from './relay-store';
import { relayCommandSchema, relayEventSchema, relayReceiptSchema, relaySnapshotSchema, type RelayCommand, type RelaySnapshot, type RelayReceipt } from '../../src/shared/relay';
import { situationEvidence } from '../situation/evidence';
import { loadSchedulingContext, interpretScheduling, schedulingReply, schedulingQuery, calendarRangeRevision, schedulingFreshMs } from './scheduling';
import { plannerAvailabilitySchema, projectSchedulingDelivery, projectSchedulingActions, schedulingInterpretationSchema, schedulingReplyPlanSchema, type SchedulingInterpretation } from '../../src/shared/scheduling';
import type { CalendarAction } from '../../src/shared/calendar-actions';
import type { LocalMailDraft, MailThread } from '../../src/shared/mail';
import type { SituationService } from '../situation/service';
import { BackgroundStore } from './background-store';
import { backgroundAuthority,backgroundContext,backgroundSourceEnabled,backgroundMetadata,deriveInsights,revisionSet,backgroundLimits } from './background';
import { backgroundDefaults,activeInsights,type BackgroundTrigger,type BackgroundInsight } from '../../src/shared/background';
import { resourceKey } from '../context/manager';
import type { MicroDecisionResult } from './micro-decisions';
import { BriefingStore } from './briefing-store';
import type { CalendarActionService } from '../calendar/service';
import { assertWorkItem, contextRequest, createTeam, finishTeam, handoff, nativeRoute, specialist, specialistRole } from './team';
import { deterministicPlanner, evidenceLedger, sameCalendarTime } from './review';
import { JevMicroDecisions, inboxSignals, reviewSignals, microQuestions } from './micro-decisions';
import { inferenceAllowed,assertSessionRequestAvailable,sessionAccountingPurpose,sessionRequestLimit } from '../ai/session-authority';
import { buildBriefing,type BriefingAction } from './briefing';
import { selectBriefingContext, selectWorkflowContext } from '../context/adapters';
import type { BriefingSnapshot,DailyIntelligence } from '../../src/shared/daily-intelligence';
import {threadRevision} from '../mail/thread';
import type { MailService } from '../mail/service';
import {assessmentState} from '../../src/shared/assessment';
import { briefingEligibilitySchema,type BriefingEligibility,type EligibilityIssue } from '../../src/shared/briefing';
import { scheduledWindow } from '../../src/shared/schedule-window';
import { effectiveLimits,generationTokens } from '../../src/shared/usage';
import { randomUUID } from 'node:crypto';
import { agentCommandSchema,agentRunSchema,agentStateSchema,intakeSchema,agentSnapshotSchema,processingResultSchema,type AgentCommand,type AgentContext,type AgentIntake,type AgentRun,type AgentSnapshot,type AgentState,type LocalProposal } from '../../src/shared/orchestration';
import type { StorageClient } from '../storage/client';
import type { CredentialStore } from '../credentials/store';
import type { GoogleService } from '../google/service';
import { addDays,dateInZone,eventOnDate } from '../../src/shared/google';
import { AppError } from '../errors';
import { DeepSeekProcessor,JevDecider,type DecisionProvider,type ProcessingProvider } from './providers';
import { applyPriority,hash,preferenceFor,profiles,qualityPass,thresholds } from './catalogue';
import { activateCandidate,evaluateCandidate,proposeCandidate,rollbackCandidate } from './learning';
import { validatePolicy } from './policy';
import { workflowModule } from '../../src/shared/modules';
type Store=Pick<StorageClient,'agent'|'get'|'workspace'|'taskCommand'>;
type Google=Pick<GoogleService,'state'|'summary'|'inbox'|'calendar'>&Partial<Pick<GoogleService,'readMailThread'>>;
const freshMs=5*60000;
const sourceIsOwner=(from:string,email:string|undefined)=>!!email&&(from.match(/<([^<>]+)>\s*$/)?.[1]??from).trim().toLowerCase()===email.toLowerCase();
export function proposalHash(p:Pick<LocalProposal,'id'|'taskId'|'draft'|'accountId'|'sourceId'|'sourceRevision'|'expiresAt'|'policyVersion'>){return hash({id:p.id,taskId:p.taskId,accountId:p.accountId,draft:p.draft,sourceId:p.sourceId,sourceRevision:p.sourceRevision,expiresAt:p.expiresAt,policyVersion:p.policyVersion});}
export class OrchestrationService {
 private moAssistant?:Pick<import('../ai/service').AssistantService,'start'|'cancel'>;
 connectMo(assistant:NonNullable<OrchestrationService['moAssistant']>){this.moAssistant=assistant;}
 /** Existing native producers call this method; no renderer event-injection API. */
 observeNative(events:NativeWorkEvent[]):Promise<void>{
  if(this.closed||process.argv.includes('--no-background-work'))return Promise.resolve();
  const operation=this.commandQueue.then(async()=>{
   await this.ready;let changed=false;
   for(const event of events.slice(0,100)){
    const all=await this.runs(),matches=correlateEvent(all,event);
    for(const old of matches){
     const run=structuredClone(old),r=run.desktopResponsibility!,p=r.proactive!,state=await this.state(),settings=(await this.storage.get()).values;
     const denied=proactivePermitted(run,state,settings,(await this.google.state()).activeAccountId,this.now());
     if(denied){if(denied==='closed'||run.error===denied)continue;holdProactive(run,denied,'stale');if(this.now()>=Date.parse(r.expiresAt))r.status='expired';}
     else {const result=filterProactive(run,event,all,this.now());if(result==='ignore')continue;}
     await this.storage.agent('proactiveUpdate',{expected:old,next:run});changed=true;
     if(old.desktopResponsibility?.proactive?.pending&&!p.pending)this.moAssistant?.cancel(old.desktopResponsibility.proactive.pending.assistantRunId);
     if(p.pending&&p.pending.assistantRunId!==old.desktopResponsibility?.proactive?.pending?.assistantRunId){
      try{
       if(!this.moAssistant)throw new AppError('unavailable','Mo is unavailable.');
       const mail=p.resources.filter(ref=>ref.type==='email');
       await this.moAssistant.start({id:p.pending.assistantRunId,conversationId:r.conversationId,workId:run.id,mode:'chat',prompt:`Continue this explicitly approved responsibility: ${r.objective}. Native trigger: ${p.pending.detail} Inspect only the approved linked sources, choose relevant specialists and prepare a useful next step. Do not send, save external actions or expand scope.`,accountId:run.event.accountId,includeGoogle:p.resources.some(ref=>ref.connector==='google'),includeLocal:true,...(mail.length===1?{messageId:mail[0].id}:{})},run.id,p.pending.id);
      }catch(error){
       const current=agentRunSchema.parse(await this.storage.agent('get',run.id));if(current.desktopResponsibility?.proactive?.pending?.id===p.pending.id){const held=structuredClone(current);holdProactive(held,error instanceof AppError?error.message:'Mo could not start. Review this responsibility.');await this.storage.agent('proactiveUpdate',{expected:current,next:held});}
      }
     }
    }
   }
   if(changed)await this.publish();
  });this.commandQueue=operation.catch(()=>{});return operation;
 }
 private async inspectProactive(){
  if(process.argv.includes('--no-background-work'))return;
  const account=(await this.google.state()).activeAccountId;
  const events=taskEvents((await this.storage.workspace()).tasks,account,this.now()),at=new Date(this.now()).toISOString();
  for(const run of await this.runs())for(const ref of run.desktopResponsibility?.proactive?.resources??[])if(ref.type==='task'&&ref.accountId===account&&!events.some(e=>e.resourceId===ref.id))events.push({accountId:account,type:'task',resourceId:ref.id,revision:hash('unavailable'),at,expiresAt:new Date(this.now()+300000).toISOString(),trigger:'source-change',detail:'The linked task is no longer available.',removed:true});
  await this.observeNative(events);
  const operation=this.commandQueue.then(async()=>{let changed=false;for(const old of await this.runs()){
   if(!old.desktopResponsibility?.proactive)continue;
   const reason=proactivePermitted(old,await this.state(),(await this.storage.get()).values,account,this.now());if(!reason||reason==='closed'||old.error===reason)continue;
   const run=structuredClone(old);holdProactive(run,reason,'stale');if(this.now()>=Date.parse(run.desktopResponsibility!.expiresAt))run.desktopResponsibility!.status='expired';await this.storage.agent('proactiveUpdate',{expected:old,next:run});changed=true;if(old.executive)this.moAssistant?.cancel(old.executive.assistantRunId);
  }if(changed)await this.publish();});this.commandQueue=operation.catch(()=>{});await operation;
 }

 moExecutive(native:MoContext):MoExecutive {
  const ephemeral=new Map<string,ReturnType<typeof voiceWorkStore>>();
  const storeFor=(assistant:AssistantRun)=>{if(assistant.channel?.voice?.retention!=='ephemeral')return this.storage;let entry=ephemeral.get(assistant.id);if(!entry){entry=voiceWorkStore(this.storage);ephemeral.set(assistant.id,entry);}return entry.store;};
  return {
   createVoiceTask:async(input,assistant,pending,guard)=>{await this.ready;const receipt=await createVoiceLocalTask(this.storage,native,input,assistant,pending,guard);await this.publish();return receipt;},
   continuation:async input=>{if(!input.workId)return;const root=await this.storage.agent('get',input.workId) as AgentRun|null;if(root?.event.accountId!==input.accountId)throw new AppError('permission_denied','The selected work belongs to another account.');return root.executive?.state==='needs-owner'&&root.executive.conversationId===input.conversationId?root.id:undefined;},
   begin:async(input,assistant,id,signal,eventId)=>{await this.ready;await beginExecutive(this.storage,native,input,assistant,id,signal,eventId);await this.publish();},
   delegate:async(input,assistant,request,known,signal)=>{await this.ready;const result=await delegateMo(storeFor(assistant),native,input,assistant,request,known,signal);await this.publish();return result;},
   validate:async(assistant,signal)=>{await validateExecutive(storeFor(assistant),native,assistant,{id:assistant.id,conversationId:assistant.conversationId,accountId:assistant.accountId,mode:'chat',prompt:assistant.prompt,includeGoogle:assistant.includeGoogle,includeLocal:assistant.includeLocal,includeWeather:assistant.includeWeather},signal);},
   finish:async (assistant,guard)=>{const store=storeFor(assistant);await guard?.();await ensureVoiceProposalRoot(store,native,assistant);await finishExecutive(store,assistant);await ephemeral.get(assistant.id)?.finish(assistant,guard);ephemeral.delete(assistant.id);await this.publish();},
  };
 }
 async relaySnapshot():Promise<RelaySnapshot>{await this.ready;await this.storage.agent('relayPrune',this.now());return {...relaySnapshotSchema.parse(await this.storage.agent('relaySnapshot')),assistant:MO_IDENTITY};}
 relayCommand(raw:RelayCommand):Promise<RelaySnapshot>{
  const command=relayCommandSchema.parse(raw);
  if(['configureTransport','secureSetup','syncTransport','checkReadiness','authorizeOutbound','sendSms','reconcileSms'].includes(command.action))throw new AppError('permission_denied','Use the native Relay transport boundary.');
  if(command.action==='snapshot')return this.relaySnapshot();
  if(['cancel','complete','archive'].includes(command.action))this.cancel('id' in command?command.id:undefined);
  const operation=this.commandQueue.then(async()=>{
   if(command.action==='create'){
    if(command.binding.provider==='synthetic'&&!this.relaySynthetic)throw new AppError('permission_denied','Synthetic bindings are available only in isolated test profiles.');
    const roots=await this.relaySnapshot();if(roots.responsibilities.length>=100)throw new AppError('unavailable','Responsibility retention is full.');
    const task=(await this.storage.workspace()).tasks.find(t=>t.id===command.taskId);if(!task)throw new AppError('unavailable','Select an existing local task.');
    await this.account(task.accountId??null);
    const run=newResponsibility(command,task,await this.state(),(await this.storage.get()).values,this.now());
    await this.storage.agent('enqueue',run);
   }else if(command.action==='get'){
    const receipt=await this.storage.agent('relayGet',command.id) as RelayReceipt|null;
    const snapshot=await this.relaySnapshot();if(receipt&&!snapshot.receipts.some(r=>r.id===receipt.id))snapshot.receipts.unshift(receipt);
    if(receipt?.rootRunId&&!snapshot.responsibilities.some(r=>r.id===receipt.rootRunId)){const run=await this.storage.agent('get',receipt.rootRunId) as AgentRun|null;if(run?.responsibility)snapshot.responsibilities.unshift({id:run.id,responsibility:run.responsibility});}
    return {...snapshot,receipts:snapshot.receipts.slice(0,200),responsibilities:snapshot.responsibilities.slice(0,100)};
   }else if(command.action==='editDraft'||command.action==='reviewDraft'||command.action==='dismiss'){
    await this.storage.agent('relayDraft',{id:command.id,action:command.action,now:this.now(),...(command.action==='editDraft'?{body:command.body,revision:command.expectedRevision}:{})});
   }else if(command.action==='cancel'||command.action==='complete'||command.action==='archive'||command.action==='wait'){
    await this.storage.agent('relayChange',{id:command.id,revision:'expectedRevision' in command?command.expectedRevision:0,action:command.action,now:this.now()});
   }
   await this.publish();return this.relaySnapshot();
  });this.commandQueue=operation.catch(()=>{});return operation;
 }
 /** Future authenticated gateway calls this boundary. No production transport is enabled. */
 async receiveRelay(raw:unknown){
  const event=relayEventSchema.parse(raw);
  if(!this.relaySynthetic||event.authentication.mode!=='synthetic'||event.provider!=='synthetic')throw new AppError('permission_denied','Relay is not connected. Gateway intake is not configured.');
  const operation=this.commandQueue.then(async()=>{const receipt=relayReceiptSchema.parse(await this.storage.agent('relayIntake',{event,now:this.now()}));await this.publish();this.kick();return receipt;});
  this.commandQueue=operation.catch(()=>{});return operation;
 }
 /** Native paired gateway client only; no renderer IPC accepts transport envelopes. */
 async receiveRelayFromGateway(raw:unknown){const event=relayEventSchema.parse(raw);if(event.provider!=='twilio'||event.authentication.mode!=='gateway')throw new AppError('permission_denied','Authenticated Twilio gateway event required.');const operation=this.commandQueue.then(async()=>{const receipt=relayReceiptSchema.parse(await this.storage.agent('relayIntake',{event,now:this.now()}));await this.publish();this.kick();return receipt;});this.commandQueue=operation.catch(()=>{});return operation;}
 private async executeRelayContinuation(run:AgentRun,controller:AbortController){
  const expected=structuredClone(run),epoch=this.schedulingAuthorityEpoch,receiptId=run.responsibility!.activeEventId!;
  const settings=(await this.storage.get()).values,limits=effectiveLimits(settings,run.config),signal=AbortSignal.any([controller.signal,AbortSignal.timeout(limits.normalSeconds*1000)]);
  let receipt=relayReceiptSchema.parse(await this.storage.agent('relayGet',receiptId));
  const check=async()=>{
   signal.throwIfAborted();if(this.cancelledScheduling.has(run.id)||epoch!==this.schedulingAuthorityEpoch)throw new AppError('cancelled','Relay authority was cancelled.');
   const current=await this.storage.agent('get',run.id) as AgentRun|null,r=current?.responsibility;
   if(!current||!r||!sameContinuation(current,run)||!['queued','processing'].includes(r.status)||Date.parse(r.reviewAt)<=this.now()||Date.parse(r.expiresAt)<=this.now())throw new AppError('permission_denied','Relay responsibility authority changed or expired.');
   const state=await this.state(),policy=this.policy(state,run.event),native=(await this.storage.get()).values;
   if(policy.version!==run.policy.version||JSON.stringify(state.config)!==JSON.stringify(run.config)||!state.config.shareTasks||native.disabledModules.some(m=>m==='relay'||m==='planner'))throw new AppError('permission_denied','Relay disclosure authority changed.');
   await this.account(run.event.accountId);signal.throwIfAborted();
  };
  try{
   await check();
   const task=(await this.storage.workspace()).tasks.find(t=>t.id===run.responsibility!.resource.id);await check();
   if(!task)throw new AppError('unavailable','The linked native task is no longer available.');
   stageRelay(run,task,receipt,await this.state(),settings,this.now());await check();
   await this.storage.agent('relayStage',{run,expected});
   run.attempt=1;run.checkpoint='Comms Mo: reviewing attributed update';run.limits=limits;
   const work=specialist(run);work.status='running';contextRequest(run,work,['R1','T1'],this.now(),signal);await this.save(run);
   // Without inference authority, only a truthful local clarification template is prepared.
   let result:unknown={schema:'comms-v1',intent:'unclear',claimQuote:'',evidence:['R1','T1'],reply:'clarify'};
   if(inferenceAllowed()&&settings.deepseekEnabled&&await this.credentials.status('deepseek')==='configured'&&this.deepseek.coordinate){
    let started=this.now();
    result=await this.deepseek.coordinate({key:await this.credentials.read('deepseek'),model:run.config.deepseekModel,route:'DRAFT_REPLY',context:run.context,prompt:run.responsibility!.objective,maxTokens:Math.min(1024,generationTokens(limits,'short')),totalTokens:Math.min(1024,limits.workflowTokens),maxRounds:1,signal,allowedTools:[],
     beforeRound:async()=>{await check();assertSessionRequestAvailable();if(run.calls.length>=24)throw new AppError('unavailable','Responsibility generation limit reached.');const id=randomUUID();await this.storage.agent('reserve',{id,runId:run.id,provider:'deepseek',daily:run.config.dailyCalls,providerDaily:settings.dailyCallLimit,perRun:Math.min(24,limits.callsPerWorkflow),model:run.config.deepseekModel,profile:'relay-comms',purpose:run.accountingPurpose??'ordinary',maxTokens:Math.min(1024,generationTokens(limits,'short')),at:new Date(this.now()).toISOString()});run.calls.push({id,provider:'deepseek',purpose:'relay-comms',requestedModel:run.config.deepseekModel,reportedModel:null,status:'reserved',usage:null,elapsedMs:0});started=this.now();await this.save(run);},
     usage:async(model,usage)=>{Object.assign(run.calls.at(-1)!,{reportedModel:model,usage,status:'complete',elapsedMs:Math.max(0,this.now()-started)});await this.save(run);},checkAuthority:check},'comms');
   }else run.findings.push({code:'LOCAL_CLARIFICATION_ONLY_NO_MODEL',severity:'info'});
   await check();
   const currentTask=(await this.storage.workspace()).tasks.find(t=>t.id===task.id);if(!currentTask||hash(currentTask)!==hash(task))throw new AppError('conflict','The native task changed during preparation.');
   await check();receipt=relayReceiptSchema.parse(await this.storage.agent('relayGet',receiptId));
   prepareRelayResult(run,receipt,result,this.now());
   const review=handoff(run.team!,work,'review','Verify attributed claims and acknowledgement-only disclosure',this.now());review.status='complete';
   run.team!.ledger={workItemId:review.id,at:new Date(this.now()).toISOString(),passed:true,semantic:'not-requested',checks:[{code:'ATTRIBUTED_SOURCE',status:'pass',detail:'Quoted claim matches the sender text; native task status is separate.'},{code:'BOUNDED_REPLY',status:'pass',detail:'Native acknowledgement/clarification contains no task facts or execution promise.'}]};
   await check();finishTeam(run);await this.storage.agent('relayCommit',{run,receipt,now:this.now()});await this.publish();
  }catch(error){
   const current=await this.storage.agent('get',run.id) as AgentRun|null;
   if(current?.responsibility){
    // Retain charged/unknown usage even when a cancellation fence rejects a late result.
    current.calls=run.calls.map(c=>c.status==='reserved'?{...c,status:'unknown' as const}:c);
    if(sameContinuation(current,expected)&&['queued','processing'].includes(current.responsibility.status)){
     current.status=controller.signal.aborted?'cancelled':'review';current.responsibility.status=controller.signal.aborted?'cancelled':'needs-decision';current.responsibility.nextStage='owner-review';current.responsibility.waitingReason='Continuation stopped. Review before authorizing further work.';current.error=error instanceof AppError?error.message:'Relay preparation was interrupted; no automatic retry.';current.finishedAt=new Date(this.now()).toISOString();current.checkpoint='Relay continuation held';
    }
    finishTeam(current);await this.storage.agent('update',current);
   }
   const held=await this.storage.agent('relayGet',receiptId) as RelayReceipt|null;
   if(held&&['queued','processing'].includes(held.disposition)){held.disposition=controller.signal.aborted?'cancelled':'held';held.reason=controller.signal.aborted?'cancelled':'authority-changed';held.updatedAt=new Date(this.now()).toISOString();held.timeline.push({at:held.updatedAt,detail:'Preparation stopped; no external action and no automatic replay.'});await this.storage.agent('relayPutReceipt',held);}
   await this.publish();
  }
 }
 private cancelledScheduling=new Set<string>();private schedulingAuthorityEpoch=0;
 async schedulingChanged(){await this.publish();}
 private async schedulingProjection(runs:AgentRun[],accountId:string|null){
  if(!accountId||!runs.some(r=>r.scheduling&&r.event.accountId===accountId))return runs;
  const mail=this.mail?await this.mail.command({action:'list',accountId}):undefined,calendar=this.calendarActions?(await this.calendarActions.command({action:'list'})).actions:[];
  const projected=await Promise.all(runs.map(async run=>{if(!run.scheduling||run.event.accountId!==accountId||['queued','running'].includes(run.status))return run;const next=projectSchedulingActions(mail?projectSchedulingDelivery(run,mail,this.now()):run,calendar,this.now());if(JSON.stringify(next.scheduling)!==JSON.stringify(run.scheduling))return await this.storage.agent('projectScheduling',{run:next,expected:run}) as AgentRun|null;return next;}));return projected.filter((r):r is AgentRun=>!!r);
 }
 private async schedulingRun(id:string){const raw=await this.storage.agent('get',id);const run=raw?agentRunSchema.parse(raw):null;if(!run?.scheduling)throw new AppError('unavailable','This scheduling workflow is no longer retained.');return run;}
 private async schedulingPermission(run:AgentRun){
  const state=await this.state(),policy=this.policy(state,run.event),settings=(await this.storage.get()).values;
  if(policy.level==='L0'||!state.config.shareGoogle||settings.disabledModules.some(m=>m==='inbox'||m==='planner'))throw new AppError('permission_denied','Inbox and Planner scheduling permission is unavailable.');await this.account(run.event.accountId);return {state,policy,settings};
 }
 private replaceSchedulingTeam(run:AgentRun,rootId:string){
  run.team=createTeam({...run,createdAt:new Date(this.now()).toISOString()},run.contextSelection!.budget);
  const newRoot=run.team.items[0].id;
  for(const w of run.team.items){if(w.id===newRoot)w.id=rootId;if(w.parentWorkItemId===newRoot)w.parentWorkItemId=rootId;for(const h of w.handoffHistory)if(h.from===newRoot)h.from=rootId;}
 }
 private async stageScheduling(run:AgentRun,candidate:SchedulingInterpretation){
  const oldHash=run.context.hash,rootId=run.team!.items[0].id,{state,settings}=await this.schedulingPermission(run);
  const loaded=await loadSchedulingContext(run.event,settings.timezone,()=>this.google.readMailThread!(run.event.accountId!,run.event.scheduling!.threadId),q=>this.google.calendar(q,true),this.now,candidate);
  const selected=selectWorkflowContext(loaded,run.event,state,settings,this.now(),false,true);
  if(selected.selection.blocked)throw new AppError('permission_denied','The interpreted scheduling context exceeds the permitted budget.');
  await this.authority(run);if(this.cancelledScheduling.has(run.id))throw new AppError('cancelled','Scheduling cancelled.');
  run.context=selected.context;run.contextSelection=selected.selection;run.scheduling!.contextHistory.push({hash:oldHash,phase:'interpreted',at:new Date(this.now()).toISOString()});
  this.replaceSchedulingTeam(run,rootId);await this.storage.agent('refreshScheduling',{run,expectedContextHash:oldHash,stage:true});
 }
 async observeSchedulingThread(thread:MailThread){
  const google=await this.google.state();if(google.activeAccountId!==thread.accountId)return;
  const email=google.accounts.find(a=>a.id===thread.accountId)?.email.toLowerCase();
  for(const run of await this.runs()){
   if(!run.scheduling||run.event.accountId!==thread.accountId||run.event.scheduling?.threadId!==thread.id||['queued','running','cancelled'].includes(run.status))continue;
   const revision=threadRevision(thread);if(this.schedulingThreadMatches(run,thread)||revision===run.event.scheduling.threadRevision||run.scheduling.followUp?.observedThreadRevision===revision)continue;
   const expected=structuredClone(run);
   const responded=thread.messages.some(m=>!run.context.items.some(s=>s.resourceId===m.message.id)&&!sourceIsOwner(m.message.from,email));
   run.scheduling.phase='stale';run.scheduling.draftStale=true;run.scheduling.followUp={state:responded?'recipient-responded':'replanning-suggested',detail:responded?'A new recipient message needs follow-up. Replan from the current thread; your saved draft is preserved.':'The source thread changed. Replan from the current thread before using earlier proposed times.',checkedAt:new Date(this.now()).toISOString(),observedThreadRevision:revision};run.checkpoint=responded?'Recipient response requires follow-up':'Source changed; replanning required';await this.storage.agent('projectScheduling',{run,expected});await this.publish();
  }
 }
 private async checkScheduling(id:string){
  let run=await this.schedulingRun(id);await this.schedulingPermission(run);
  if(['queued','running','cancelled'].includes(run.status))throw new AppError('conflict','Wait for the active workflow or start another request after cancellation.');
  const thread=await this.google.readMailThread!(run.event.accountId!,run.event.scheduling!.threadId);await this.observeSchedulingThread(thread);run=await this.schedulingRun(id);
  try{await this.revalidateScheduling(run);}catch(error){
   if(run.scheduling!.followUp?.state!=='recipient-responded')run.scheduling!.followUp={state:'calendar-changed',detail:error instanceof AppError?error.message.slice(0,240):'Current calendar evidence is unavailable. Replan before using earlier proposed times.',checkedAt:new Date(this.now()).toISOString()};
   run.scheduling!.phase='stale';run.scheduling!.draftStale=true;run.checkpoint='Proposed times stale; replanning required';await this.save(run);
  }
 }
 private async replanScheduling(id:string,confirmed?:NonNullable<AgentIntake['scheduling']>['confirmed']){
  const old=await this.schedulingRun(id),{state,policy,settings}=await this.schedulingPermission(old);
  if(['queued','running','cancelled'].includes(old.status)||old.scheduling!.contextHistory.length>=6)throw new AppError('conflict','This workflow is active, cancelled, or reached its six-revision limit.');
  const priorAction=old.calendarProposalId?(await this.calendarActions?.command({action:'list'}))?.actions.find(a=>a.id===old.calendarProposalId):undefined;
  if(priorAction&&['dispatching','unknown','succeeded'].includes(priorAction.status))throw new AppError('conflict','Inspect the recorded calendar outcome before preparing further times. Completed calendar changes are never replayed.');
  const epoch=this.schedulingAuthorityEpoch;this.cancelledScheduling.delete(id);
  const thread=await this.google.readMailThread!(old.event.accountId!,old.event.scheduling!.threadId),google=await this.google.state(),email=google.accounts.find(a=>a.id===old.event.accountId)?.email.toLowerCase();
  const latest=thread.messages.filter(m=>!m.message.from.toLowerCase().includes(email??'\0')).sort((a,b)=>b.message.receivedAt.localeCompare(a.message.receivedAt))[0];
  if(!latest)throw new AppError('unavailable','No complete recipient source is available.');
  const revision=threadRevision(thread),event={...old.event,resourceId:latest.message.id,scheduling:{...old.event.scheduling!,threadRevision:revision,...(confirmed?{confirmed}:revision!==old.event.scheduling!.threadRevision?{confirmed:undefined}:{})}};
  const loaded=await loadSchedulingContext(event,settings.timezone,async()=>thread,q=>this.google.calendar(q,true),this.now,revision===old.event.scheduling!.threadRevision?old.scheduling!.inbox?.candidate:undefined),selected=selectWorkflowContext(loaded,event,state,settings,this.now(),false,true);
  await this.account(event.accountId);if(epoch!==this.schedulingAuthorityEpoch||this.cancelledScheduling.has(id))throw new AppError('cancelled','Scheduling changed while replanning.');
  const run=agentRunSchema.parse({...old,event,context:selected.context,contextSelection:selected.selection,policy,config:state.config,profileRevision:state.revision,status:selected.selection.blocked?'review':'queued',finishedAt:selected.selection.blocked?new Date(this.now()).toISOString():null,calendarProposalId:undefined,result:null,error:null,findings:[],decision:null,checkpoint:'Owner requested replanning; original draft preserved',scheduling:{version:1,phase:'understanding',inbox:null,planner:null,draftHash:null,draftStale:!!old.localDraftId,replacementPending:!!old.localDraftId,previousDraftIds:old.scheduling!.previousDraftIds??[],contextHistory:[...old.scheduling!.contextHistory,{hash:old.context.hash,phase:old.scheduling!.phase,at:new Date(this.now()).toISOString()}]}});
  this.replaceSchedulingTeam(run,old.team!.items[0].id);await this.storage.agent('refreshScheduling',{run,expectedContextHash:old.context.hash,stage:false});await this.publish();this.kick();
 }
 private async useReplannedReply(id:string){
  const run=await this.schedulingRun(id);await this.schedulingPermission(run);
  const calendar=run.calendarProposalId?(await this.calendarActions?.command({action:'list'}))?.actions.find(a=>a.id===run.calendarProposalId&&a.status==='succeeded'):undefined;
  if(calendar&&run.scheduling!.calendarReplyActionId!==calendar.id&&calendar.draft.time.kind==='timed'){
    await this.revalidateScheduling(run);const time=calendar.draft.time,fmt=new Intl.DateTimeFormat('en-GB',{timeZone:calendar.draft.timezone,dateStyle:'full',timeStyle:'short'});
    const body=`Thanks for coordinating. The meeting has been moved to ${fmt.format(new Date(time.start))}–${new Intl.DateTimeFormat('en-GB',{timeZone:calendar.draft.timezone,timeStyle:'short'}).format(new Date(time.end))} (${calendar.draft.timezone}). Please let me know if anything else needs adjusting.`;
    run.result={text:'Reply reflects the confirmed, separately approved calendar update.',draft:body,evidence:run.context.items.map(s=>s.id),reminders:[]};run.scheduling!.draftHash=hash(body);run.scheduling!.replacementPending=true;run.scheduling!.calendarReplyActionId=calendar.id;run.team!.ledger!.checks.push({code:'CONFIRMED_CALENDAR_REPLY',status:'pass',detail:'Exact target time, remaining range evidence and native succeeded action verified; mail still requires approval.'});
  }
  if(run.status!=='complete'||!run.scheduling!.replacementPending||!run.result?.draft||!run.team?.ledger?.passed)throw new AppError('conflict','A newly reviewed reply is not ready.');
  const epoch=this.schedulingAuthorityEpoch;await this.revalidateScheduling(run);const draftId=randomUUID();
  const response=await this.mail!.command({action:'compose',id:draftId,accountId:run.event.accountId!,mode:'reply',sourceMessageId:run.event.resourceId!,body:run.result.draft,grounding:{runId:run.id,threadId:run.event.scheduling!.threadId,threadRevision:run.event.scheduling!.threadRevision,workflow:'inbox-planner-v1'}},async()=>{await this.schedulingPermission(run);await this.revalidateScheduling(run);if(epoch!==this.schedulingAuthorityEpoch||this.cancelledScheduling.has(run.id))throw new AppError('cancelled','Scheduling changed.');});
  if(!response.drafts.some(d=>d.id===draftId))throw new AppError('unavailable','The revised local draft could not be confirmed.');
  run.scheduling!.previousDraftIds=[...(run.scheduling!.previousDraftIds??[]),run.localDraftId!];run.localDraftId=draftId;run.scheduling!.replacementPending=false;run.scheduling!.draftStale=false;run.scheduling!.followUp=undefined;run.checkpoint='Revised reply prepared; original draft retained';await this.save(run);
 }
 async validateSchedulingCalendar(action:CalendarAction):Promise<()=>boolean>{
  if(action.tool!=='calendar.update')return()=>true;
  const epoch=this.schedulingAuthorityEpoch,run=await this.schedulingRun(action.workflow!.runId),s=run.scheduling!,facts=s.planner,candidate=facts?.candidates.find(c=>c.id===action.workflow!.candidateId);
  const {state,policy,settings}=await this.schedulingPermission(run);
  if(policy.version!==run.policy.version||JSON.stringify(state.config)!==JSON.stringify(run.config)||settings.timezone!==run.context.timezone)throw new AppError('permission_denied','Scheduling settings changed. Replan before updating.');
  if(run.status!=='complete'||s.phase!=='awaiting-owner'||s.followUp?.state==='completed'||s.draftStale||this.cancelledScheduling.has(run.id)||run.context.hash!==action.workflow!.contextHash||facts?.coverage!=='complete'||!candidate||!facts.relatedEvent?.event||facts.relatedEvent.id!==action.eventId||facts.relatedEvent.revision!==action.target!.revision||action.draft.accountId!==run.event.accountId||action.draft.time.kind!=='timed'||action.draft.time.start!==candidate.start||action.draft.time.end!==candidate.end||action.draft.timezone!==candidate.timezone||action.draft.title!==facts.relatedEvent.event.title)throw new AppError('permission_denied','Calendar proposal is not bound to current verified scheduling facts.');
  await this.revalidateScheduling(run);const at=this.now();return()=>epoch===this.schedulingAuthorityEpoch&&!this.cancelledScheduling.has(run.id)&&this.now()-at<freshMs&&Date.parse(candidate.start)>this.now();
 }
 private async prepareSchedulingCalendar(id:string,candidateId:string){
  const run=await this.schedulingRun(id);await this.schedulingPermission(run);const s=run.scheduling!,facts=s.planner,candidate=facts?.candidates.find(c=>c.id===candidateId),event=facts?.relatedEvent?.event;
  if(!this.calendarActions||s.inbox?.intent!=='reschedule'||!candidate||!event||!facts?.relatedEvent||s.draftStale)throw new AppError('conflict','A confidently identified event and current verified time are required.');
  if(run.calendarProposalId){const existing=(await this.calendarActions.command({action:'list'})).actions.find(a=>a.id===run.calendarProposalId);if(existing&&!['denied','expired','failed'].includes(existing.status)&&Date.parse(existing.expiresAt)>this.now())throw new AppError('conflict','Review or decline the existing calendar proposal first.');if(existing&&['succeeded','unknown','dispatching'].includes(existing.status))throw new AppError('conflict','Inspect the existing calendar outcome before preparing another update.');}
  await this.revalidateScheduling(run);
  const prepared=await this.calendarActions.command({action:'prepareUpdate',eventId:event.id,expectedRevision:facts.relatedEvent.revision,workflow:{runId:run.id,contextHash:run.context.hash,candidateId},draft:{accountId:run.event.accountId!,title:event.title,timezone:candidate.timezone,time:{kind:'timed',start:candidate.start,end:candidate.end}}});
  run.team!.ledger!.checks.push({code:'CALENDAR_UPDATE_BINDING',status:'pass',detail:'Review verified the source, exact native event revision, chosen candidate and separate pending calendar approval. No action authority granted.'});
  run.calendarProposalId=prepared.review!.action.id;s.selectedCandidateId=candidateId;run.checkpoint='Calendar update prepared; separate owner approval required';await this.save(run);
 }


 private async continueScheduling(id:string,confirmed:NonNullable<AgentIntake['scheduling']>['confirmed']){
  const old=(await this.runs()).find(r=>r.id===id);
  if(!old?.scheduling||old.localDraftId||['queued','running'].includes(old.status)||old.scheduling.contextHistory.length>=6)throw new AppError('conflict','This task is active, already has a draft, or reached its clarification limit. Review the existing result.');
  this.cancelledScheduling.delete(id);
  const state=await this.state(),event={...old.event,scheduling:{...old.event.scheduling!,confirmed}},policy=this.policy(state,event),settings=(await this.storage.get()).values;
  if(policy.level==='L0')throw new AppError('permission_denied','Local reply preparation requires an existing L1 or L2 email policy.');
  await this.account(event.accountId);
  const loaded=await this.context(event,state),selected=selectWorkflowContext(loaded,event,state,settings,this.now(),false,true);
  await this.account(event.accountId);
  if(this.cancelledScheduling.has(id))throw new AppError('cancelled','Scheduling continuation was cancelled.');
  const run=agentRunSchema.parse({...old,event,context:selected.context,contextSelection:selected.selection,policy,config:state.config,profileRevision:state.revision,status:selected.selection.blocked?'review':'queued',finishedAt:selected.selection.blocked?new Date(this.now()).toISOString():null,error:selected.selection.blocked?'Required scheduling context exceeds the saved context budget.':null,result:null,decision:null,findings:[],scheduling:{version:1,phase:selected.selection.blocked?'needs-information':'understanding',inbox:null,planner:null,draftHash:null,contextHistory:[...old.scheduling.contextHistory,{hash:old.context.hash,phase:old.scheduling.phase,at:new Date(this.now()).toISOString()}]},checkpoint:'Owner clarified the scheduling request'});
  run.team=createTeam({...run,createdAt:new Date(this.now()).toISOString()},selected.selection.budget);
  // Keep the Executive identity while replacing bounded child work for the clarified scope.
  const rootId=run.team.items[0].id,retainedRoot=old.team!.items[0].id;
  for(const w of run.team.items){if(w.id===rootId)w.id=retainedRoot;if(w.parentWorkItemId===rootId)w.parentWorkItemId=retainedRoot;for(const h of w.handoffHistory)if(h.from===rootId)h.from=retainedRoot;}
  if(run.steps.length<32)run.steps.push({at:new Date(this.now()).toISOString(),checkpoint:run.checkpoint,status:run.status});
  if(run.finishedAt)finishTeam(run);
  await this.storage.agent('reviseScheduling',{run,expectedContextHash:old.context.hash});await this.publish();this.kick();
 }
 private pendingInsights=new Map<string,BackgroundInsight[]>();private backgroundRequest:Promise<void>|null=null;
 private active:{id:string;controller:AbortController}|null=null;private pumping:Promise<void>|null=null;private kickRequested=false;private closed=false;private commandQueue:Promise<unknown>=Promise.resolve();private lastTick=0;private lastPrune=0;
 private publishSequence=0;private cachedPause=false;readonly ready:Promise<void>;
 constructor(private storage:Store,private credentials:Pick<CredentialStore,'read'|'status'>&Partial<Pick<CredentialStore,'peekStatus'>>,private google:Google,private changed:(value:AgentSnapshot)=>void,private jev:DecisionProvider=new JevDecider(),private deepseek:ProcessingProvider=new DeepSeekProcessor(),private now=Date.now,private mail?:Pick<MailService,'command'>,private briefings=new BriefingStore(),private calendarActions?:Pick<CalendarActionService,'command'>,private backgrounds=new BackgroundStore(),private situation?:Pick<SituationService,'snapshot'>,private relaySynthetic=false){this.ready=this.state().then(s=>{this.cachedPause=s.config.paused;});}
 private async situationAuthority(settings:Parameters<typeof backgroundAuthority>[0],state:AgentState,google:Parameters<typeof backgroundAuthority>[2]){return backgroundAuthority(settings,state,google,(await this.situation?.snapshot().catch(()=>undefined))?.config.revision);}
 paused(){return this.cachedPause;}
 private async state(){return agentStateSchema.parse(await this.storage.agent('state'));}
 private async runs(){const raw=await this.storage.agent('runs');return agentSnapshotSchema.shape.runs.parse(raw);}
 async snapshot(metadataOnly=false){
  const state=await this.state();await this.storage.agent('projectExecutiveOutcomes');let runs=await this.runs();const activeAccount=(await this.google.state()).activeAccountId;
  runs=await this.schedulingProjection(runs,activeAccount);
  const usage=await this.storage.agent('usage'),costs=await this.storage.agent('costs').catch(()=>undefined);
  const base=agentSnapshotSchema.parse({state,runs,usage,costs,activityArchives:await this.storage.agent('activityArchives')});
  const settings=(await this.storage.get()).values,google=await this.google.state(),now=this.now();
  const jevReady=settings.deepseekEnabled&&(metadataOnly?this.credentials.peekStatus?.('deepseek'):await this.credentials.status('deepseek'))==='configured';
  const scheduleStatus=state.policies.map(p=>{
   let reason=!p.enabled?'This account workflow is off.':!state.config.enabled?'Workflow processing is off.':state.config.paused?'Global pause stops new dispatches.':!p.schedule.enabled||p.family!=='briefing'?'Manual trigger only; no schedule is active.':p.accountId!==google.activeAccountId?'Select this workflow’s original account.':!google.accounts.some(a=>a.id===p.accountId&&a.status==='connected')?'The account needs a connection or reconnect.':settings.disabledModules.includes(workflowModule(p.family))?'The workflow’s workspace is disabled.':!jevReady?'The primary AI connection must be enabled with an available saved key.':base.costs?.stopped?'Estimated-spend stop blocks new paid dispatches.':null;
   const window=scheduledWindow(p,runs,now);const eligibleNow=!reason&&window.eligible;reason??=window.reason;
   return{policyId:p.id,checkedAt:new Date(now).toISOString(),eligibleNow,reason};
  });
  let daily=await this.briefings.get(google.activeAccountId);if(daily?.synthesis.status==='running'){const run=runs.find(r=>r.id===daily!.synthesis.runId);if(run&&!['queued','running'].includes(run.status)){await this.saveSynthesis(run);daily=await this.briefings.get(google.activeAccountId);}else if(!run){daily={...daily,synthesis:{...daily.synthesis,status:'failed',reason:'The earlier AI run is no longer available.',text:null}};await this.briefings.put(daily,daily.snapshot.id);}}
  const backgroundAuthorityKey=await this.situationAuthority(settings,state,google);await this.backgrounds.invalidate(google.activeAccountId,backgroundAuthorityKey,now);await this.backgrounds.reconcile(new Set(runs.filter(r=>r.status==='complete'&&r.team?.ledger?.passed||r.executiveOrigin?.team?.ledger?.passed||this.active?.id===r.id&&this.pendingInsights.has(r.id)).map(r=>r.id)),now);
  const settled=runs.filter(r=>r.event.family==='email'&&assessmentState(r,state.feedback).status!=='active');
  for(const i of (await this.backgrounds.all()).filter(i=>i.status==='active')){const original=settled.find(r=>i.sources.some(s=>s.type==='briefing'?s.id===r.id:s.type==='email'&&r.context.items.some(c=>c.resourceId===s.id&&c.revision===s.revision)));if(original)await this.backgrounds.disposition(i.id,i.accountId,assessmentState(original,state.feedback).status as 'dismissed'|'resolved',now);}
  const insights=(await this.backgrounds.all()).filter(i=>i.accountId===google.activeAccountId).reverse();
  return agentSnapshotSchema.parse({...base,background:{insights:[...insights.filter(i=>i.status==='active'),...insights.filter(i=>i.status!=='active')].slice(0,200),activeCount:activeInsights(insights,google.activeAccountId,now).length,lastRunId:runs.find(r=>r.background&&r.event.accountId===google.activeAccountId)?.id??null},scheduleStatus,dailyIntelligence:daily,briefingEligibility:await this.safeBriefingEligibility(google.activeAccountId,state,runs)});
 }
 /** Read-only prerequisites. No context gathering, secret read, queue entry or reservation. */
 private async briefingEligibility(accountId:string|null,state?:AgentState,runs?:AgentRun[]):Promise<BriefingEligibility>{
  state??=await this.state();runs??=await this.runs();const settings=(await this.storage.get()).values,google=await this.google.state(),config=state.config;
  const issues:EligibilityIssue[]=[],add=(code:string,message:string,target:EligibilityIssue['target'],label:string)=>issues.push({code,message,target,label});
  if(!inferenceAllowed())add('session_no_inference','AI inference is disabled for this review session. Daily facts remain available.','ai','Review session authority');
  const active=runs.find(r=>r.event.family==='briefing'&&!r.background&&r.event.accountId===accountId&&['queued','running'].includes(r.status));
  if(!accountId||google.activeAccountId!==accountId||!google.accounts.some(a=>a.id===accountId&&a.status==='connected'))add('account','Select the original connected account for this briefing.','accounts','Review account connection');
  if(settings.disabledModules.includes('dashboard'))add('module','Dashboard processing is disabled in Settings.','automation','Review workflow setup');
  if(!config.enabled||config.paused)add('workflow',config.paused?'Global pause stops new workflow dispatches.':'Workflow processing is off.','automation','Review workflow setup');
  const policy=state.policies.find(p=>p.family==='briefing'&&p.accountId===accountId&&p.enabled);
  if(!policy)add('policy','This account’s briefing workflow is off.','automation','Review briefing workflow');
  else try{validatePolicy(policy);}catch(error){add('policy',error instanceof AppError?error.message:'The briefing policy needs review.','automation','Review briefing workflow');}
  if(!config.shareGoogle)add('sharing','Bounded Google context sharing for workflows is off.','automation','Review workflow sharing');
  const jev=false;
  const fallback=settings.deepseekEnabled&&(!this.credentials.peekStatus||this.credentials.peekStatus('deepseek')==='configured');
  if(!jev&&!fallback)add('provider','An enabled workflow provider with an available saved key is required.','ai','Review AI connections');
  if(active)add('active','A briefing for this account is already queued or running.','automation','Inspect active briefing');
  if(runs.filter(r=>['queued','running'].includes(r.status)).length>=25)add('queue','The workflow queue is full. Wait for current work or inspect and cancel an existing request.','automation','Inspect current activity');
  const provider=jev?'jev':'deepseek',limits=effectiveLimits(settings,config),checkedAt=new Date(this.now()).toISOString();
  const dispatch=await this.storage.agent('dispatchEligibility',{id:'preflight',runId:'preflight',provider,daily:config.dailyCalls,providerDaily:settings.dailyCallLimit,perRun:limits.callsPerWorkflow,model:provider==='jev'?config.jevModel:config.deepseekModel,maxTokens:provider==='jev'?0:generationTokens(limits,'short'),at:checkedAt}) as {issues:EligibilityIssue[];exposure:BriefingEligibility['exposure']};
  issues.push(...dispatch.issues);
  return briefingEligibilitySchema.parse({accountId,checkedAt,eligible:issues.length===0,issues,activeRunId:active?.id??null,exposure:dispatch.exposure});
 }
 private async safeBriefingEligibility(accountId:string|null,state?:AgentState,runs?:AgentRun[]){try{return await this.briefingEligibility(accountId,state,runs);}catch{return {accountId,checkedAt:new Date(this.now()).toISOString(),eligible:false,activeRunId:null,issues:[{code:'accounting_unavailable',target:'usage' as const,label:'Review AI usage',message:'AI eligibility could not be verified.'}]};}}
 private async publish(){const sequence=++this.publishSequence;const snapshot=await this.snapshot(true);if(sequence===this.publishSequence)this.changed(snapshot);}
 private async save(run:AgentRun){if(run.finishedAt)finishTeam(run);const last=run.steps.at(-1);if((last?.checkpoint!==run.checkpoint||last?.status!==run.status)&&run.steps.length<32)run.steps.push({at:new Date(this.now()).toISOString(),checkpoint:run.checkpoint,status:run.status});await this.storage.agent('update',agentRunSchema.parse(run));await this.saveSynthesis(run);await this.publish();}
 private async saveState(state:AgentState){state.revision++;await this.storage.agent('saveState',state);this.cachedPause=state.config.paused;await this.publish();}
 cancel(id?:string){if(!id)this.schedulingAuthorityEpoch++;if(id)this.cancelledScheduling.add(id);if(this.active&&(!id||this.active.id===id))this.active.controller.abort();}
 async close(){this.closed=true;this.cancel();await this.pumping;}
 async resume(trigger:'startup'|'resume'='resume'){await this.ready;this.cancel();await this.requestBackground(trigger);await this.tick(false);this.kick();}
 private async account(id:string|null){if(!id)return;const state=await this.google.state();if(state.activeAccountId!==id||!state.accounts.some(a=>a.id===id&&a.status==='connected'))throw new AppError('permission_denied','Select the original connected account.');}
 private async collectBriefing(trigger:BriefingSnapshot['trigger'],refresh:boolean,background=false){
  const state=await this.state(),settings=(await this.storage.get()).values,google=await this.google.state(),accountId=google.activeAccountId;
  const plannerEnabled=!settings.disabledModules.includes('planner')&&(!background||!!accountId&&backgroundSourceEnabled(state,settings,accountId,'task')),inboxEnabled=!settings.disabledModules.includes('inbox')&&(!background||!!accountId&&backgroundSourceEnabled(state,settings,accountId,'email'));
  if(settings.disabledModules.includes('dashboard'))throw new AppError('permission_denied','Dashboard is disabled.');
  const now=this.now(),timezone=settings.timezone,today=dateInZone(new Date(now),timezone);
  const [calendar,tasks,runs,actions]=await Promise.all([
   plannerEnabled&&(!background||state.config.shareGoogle)&&accountId&&google.accounts.some(a=>a.id===accountId&&a.status==='connected')?this.google.calendar({accountId,startDate:today,endDate:addDays(today,7),timezone,refresh}).catch(()=>undefined):undefined,
   !background||state.config.shareTasks&&plannerEnabled?this.storage.workspace().then(w=>background?w.tasks.filter(t=>t.accountId===accountId):w.tasks).catch(()=>undefined):undefined,this.runs().then(runs=>this.schedulingProjection(runs,accountId)).catch(()=>undefined),this.storage.agent('briefingActions').then(v=>v as BriefingAction[]).catch(()=>undefined),
  ]);
  const current=await this.google.state();if(current.activeAccountId!==accountId)throw new AppError('conflict','Account changed while preparing daily intelligence.');
  const situation = !settings.disabledModules.includes('situation') ? await this.situation?.snapshot().catch(()=>undefined) : undefined;
  return buildBriefing({accountId,now,timezone,trigger,state,calendar,tasks,runs,actions,plannerEnabled,inboxEnabled,situation,calendarStatus:plannerEnabled?'unavailable':'disabled',authorityRevision:hash({situation:situation?.config.revision,accountId,accounts:google.accounts.map(a=>({id:a.id,status:a.status})),timezone,disabled:settings.disabledModules,config:state.config,policy:state.policies.find(p=>p.family==='briefing'&&p.accountId===accountId)})});
 }
 private async prepareBriefing(trigger:BriefingSnapshot['trigger'],refresh:boolean):Promise<DailyIntelligence>{
  const snapshot=await this.collectBriefing(trigger,refresh),prior=await this.briefings.get(snapshot.accountId);
  // Reuse an identical current projection on passive reads; explicit refresh fences in-flight synthesis.
  if(trigger==='view'&&prior?.snapshot.revision===snapshot.revision&&this.now()-Date.parse(prior.snapshot.createdAt)<300000)return prior;
  const value:DailyIntelligence={snapshot,synthesis:{snapshotId:snapshot.id,snapshotRevision:snapshot.revision,runId:null,updatedAt:snapshot.createdAt,status:'not-requested',reason:'Daily facts ready. AI summary has not been requested.',text:null}};
  if(trigger==='schedule'){const policy=(await this.state()).policies.find(p=>p.family==='briefing'&&p.accountId===snapshot.accountId);if(policy)value.scheduleReceipt={policyId:policy.id,date:dateInZone(new Date(this.now()),policy.schedule.timezone)};}
  await this.briefings.put(value);return value;
 }
 private async blockSynthesis(record:DailyIntelligence,reason:string){await this.briefings.put({...record,synthesis:{...record.synthesis,status:'blocked',reason,updatedAt:new Date(this.now()).toISOString(),text:null}},record.snapshot.id);}
 private async dailyBriefing(refresh:boolean,synthesize:boolean,trigger:'manual'|'schedule'){
  const record=await this.prepareBriefing(synthesize||refresh?trigger:'view',refresh);
  await this.publish(); // Snapshot is durable and visible before any optional dispatch check.
  if(!synthesize)return record;
  const eligibility=await this.safeBriefingEligibility(record.snapshot.accountId);
  if(!eligibility.eligible){await this.blockSynthesis(record,eligibility.issues[0].code);await this.publish();return record;}
  try{await this.start({id:randomUUID(),family:'briefing',accountId:record.snapshot.accountId,prompt:'Interpret this daily snapshot. Report supported priorities, preparation and conflicts with evidence. Do not infer attendance, task completion, weather, traffic, unknown durations, commitments or resolved conflicts. Do not suggest duplicate tasks.',trigger,causationId:null,depth:0,origin:trigger==='schedule'?'connector':'user'},record.snapshot);}
  catch(error){await this.blockSynthesis(record,error instanceof AppError?error.message:'Synthesis could not start.');await this.publish();}
  return record;
 }
 private async validateBriefingBinding(run:AgentRun,refresh=false){
  const binding=run.briefingBinding!,record=await this.briefings.get(run.event.accountId);
  if(!record||record.snapshot.id!==binding.snapshotId||record.snapshot.revision!==binding.revision)throw new AppError('conflict','Daily snapshot changed; this AI result is stale.');
  const current=await this.collectBriefing('view',refresh);
  if(current.revision!==binding.revision)throw new AppError('conflict','Daily sources or permissions changed; refresh the briefing.');
 }
 private async saveSynthesis(run:AgentRun){
  if(!run.briefingBinding)return;
  const record=await this.briefings.get(run.event.accountId);if(!record||record.snapshot.id!==run.briefingBinding.snapshotId||record.snapshot.revision!==run.briefingBinding.revision)return;
  const status:DailyIntelligence['synthesis']['status']=['queued','running'].includes(run.status)?'running':run.status==='complete'&&run.result&&(run.team?.ledger?.passed??(run.quality&&qualityPass(run.quality.answers)))?'complete':run.status==='review'?'held':run.error?.includes('changed')||run.error?.includes('stale')?'stale':'failed';
  await this.briefings.put({...record,synthesis:{snapshotId:record.snapshot.id,snapshotRevision:record.snapshot.revision,runId:run.id,updatedAt:new Date(this.now()).toISOString(),status,reason:status==='complete'?'Reviewed AI interpretation':status==='running'?'Preparing AI summary':status==='held'?'AI summary held for review':'AI summary unavailable; daily facts remain available.',text:status==='complete'?run.result!.text:null}},record.snapshot.id);
 }
 private policy(state:AgentState,event:AgentIntake){const p=state.policies.find(p=>p.family===event.family&&p.accountId===event.accountId&&p.enabled);if(!state.config.enabled||state.config.paused||!p)throw new AppError('permission_denied','Enable this account workflow in Automations; global pause must be off.');validatePolicy(p);return p;}
 private async revalidateEvidence(run:AgentRun){
  if(run.event.scheduling){await this.revalidateScheduling(run);return;}
  if(run.background){const fresh=await this.collectBackground(false);const refs=revisionSet(fresh.context);if(run.background.sourceGrants.some(r=>refs.get(resourceKey(r))!==r.revision))throw new AppError('conflict','Background sources changed or became unavailable. Refresh intelligence.');return;}
  if(run.briefingBinding)return this.validateBriefingBinding(run);
  if(run.event.replyTo){
   const thread=await this.google.readMailThread!(run.event.accountId!,run.event.replyTo.threadId);
   if(thread.accountId!==run.event.accountId||threadRevision(thread)!==run.event.replyTo.threadRevision||thread.truncated||Math.abs(this.now()-Date.parse(thread.fetchedAt))>freshMs)throw new AppError('conflict','The current thread changed. Prepare a new reply.');
   return;
  }
  const items=run.context.items;
  for(const source of items.filter(s=>s.kind==='email')){
   const response=await this.google.summary({accountId:source.accountId,id:source.resourceId},true),message=response.messages.find(m=>m.id===source.resourceId);
   if(response.accountId!==run.event.accountId||!message||hash({title:message.subject.slice(0,240),text:`From: ${message.from.slice(0,120)}; Date: ${message.receivedAt}; ${message.snippet.slice(0,600)}`})!==source.revision)throw new AppError('conflict','An email source changed. Start a new request.');
  }
  if(items.some(s=>s.kind==='task')){const tasks=(await this.storage.workspace()).tasks;for(const source of items.filter(s=>s.kind==='task')){const task=tasks.find(t=>t.id===source.resourceId&&t.accountId===run.event.accountId);if(!task||hash(task)!==source.revision)throw new AppError('conflict','A task source changed. Start a new request.');}}
  if(items.some(s=>s.kind==='calendar')){
   const today=dateInZone(new Date(this.now()),run.context.timezone),calendar=await this.google.calendar({accountId:run.event.accountId!,startDate:today,endDate:addDays(today,7),timezone:run.context.timezone,refresh:true});
   if(calendar.accountId!==run.event.accountId||Math.abs(this.now()-Date.parse(calendar.fetchedAt))>freshMs)throw new AppError('conflict','Calendar source scope or freshness changed.');
   for(const source of items.filter(s=>s.kind==='calendar')){const event=calendar.events.find(e=>e.id===source.resourceId);if(!event||hash({title:event.title.slice(0,240),text:JSON.stringify({time:event.time,status:event.status,recurringEventId:event.recurringEventId})})!==source.revision)throw new AppError('conflict','A calendar source changed. Start a new request.');}
   const proposal=run.result?.calendarProposal;
   if(proposal&&calendar.events.some(e=>e.title.trim().toLocaleLowerCase()===proposal.draft.title.trim().toLocaleLowerCase()&&sameCalendarTime(e.time,proposal.draft.time)))throw new AppError('conflict','This event already exists in the permitted calendar range.');
  }
 }
 private async authority(run:AgentRun){
  if(run.team&&!run.finishedAt)assertWorkItem(specialist(run),run,this.now()); if(run.contextSelection?.blocked)throw new AppError('permission_denied','Required context is unavailable or exceeds this workflow context budget.');
  const nativeSettings=(await this.storage.get()).values;const disabled=nativeSettings.disabledModules;
  if(run.background&&await this.situationAuthority(nativeSettings,await this.state(),await this.google.state())!==run.background.authorityRevision)throw new AppError('permission_denied','Background scope or configuration changed.');
  if(run.event.scheduling&&(nativeSettings.timezone!==run.context.timezone||disabled.includes('planner')))throw new AppError('permission_denied','Scheduling workspace or timezone settings changed.');
  if(disabled.includes(workflowModule(run.event.family))||run.team?.items.some(w=>w.sources.some(r=>disabled.includes(r.module)))||run.team&&specialist(run).role==='planner'&&disabled.includes('planner'))throw new AppError('permission_denied','A required workspace is disabled in Settings.');
  const state=await this.state();const policy=this.policy(state,run.event);if(policy.version!==run.policy.version||JSON.stringify(state.config)!==JSON.stringify(run.config))throw new AppError('permission_denied','Workflow permissions changed. Review a new request.');
  await this.account(run.event.accountId);if(run.briefingBinding)await this.validateBriefingBinding(run);if(this.now()-+new Date(run.context.createdAt)>freshMs)throw new AppError('permission_denied','Context is stale. Run the workflow again.');
 }
 private async context(event:AgentIntake,state:AgentState):Promise<AgentContext>{
  const sourceSettings=(await this.storage.get()).values;const timezone=sourceSettings.timezone;const items:AgentContext['items']=[],limitations:string[]=[];const available={calendar:false,tasks:false,thread:false};
  if(event.family==='email'&&(!event.accountId||!event.resourceId))throw new AppError('invalid_input','Select an email first.');
  if(['email','briefing'].includes(event.family)&&!state.config.shareGoogle)throw new AppError('permission_denied','Google context sharing for workflows is off.');
  if(event.scheduling){
   if(sourceSettings.disabledModules.includes('planner')||!this.google.readMailThread||!this.mail)throw new AppError('permission_denied','Inbox and Planner must be available for coordinated scheduling.');
   return loadSchedulingContext(event,timezone,()=>this.google.readMailThread!(event.accountId!,event.scheduling!.threadId),q=>this.google.calendar(q,true),this.now);
  }
  if(event.replyTo){
   if(event.family!=='email'||event.origin!=='user'||event.trigger!=='manual'||!event.accountId||!event.resourceId||!this.google.readMailThread||!this.mail)throw new AppError('permission_denied','Select an email assessment and explicitly request a local reply.');
   const original=(await this.runs()).find(r=>r.id===event.replyTo!.runId&&r.event.accountId===event.accountId&&r.event.resourceId===event.resourceId&&!r.event.replyTo);
   const source=original?.context.items.find(s=>s.kind==='email'&&s.resourceId===event.resourceId);
   if(!original||!source||source.revision!==event.replyTo.sourceRevision||source.threadId!==event.replyTo.threadId)throw new AppError('conflict','The selected assessment identity changed. Reopen its source.');
   const thread=await this.google.readMailThread(event.accountId,event.replyTo.threadId);await this.account(event.accountId);
   if(thread.accountId!==event.accountId||thread.id!==event.replyTo.threadId||threadRevision(thread)!==event.replyTo.threadRevision||!thread.messages.some(m=>m.message.id===event.resourceId)||this.now()-Date.parse(thread.fetchedAt)>freshMs)throw new AppError('conflict','The current thread changed. Refresh the source and review Draft reply again.');
   const selected=thread.messages.find(m=>m.message.id===event.resourceId)!.message;
   if(hash({title:selected.subject.slice(0,240),text:`From: ${selected.from.slice(0,120)}; Date: ${selected.receivedAt}; ${selected.snippet.slice(0,600)}`})!==source.revision)throw new AppError('conflict','The assessed source changed. Assess the current message before drafting.');
   if(thread.truncated||thread.messages.length>12||thread.messages.some(m=>m.truncated||!m.textAvailable))throw new AppError('unavailable','More information needed: this thread is incomplete or exceeds the bounded reply context. Supply the missing details in a manual local reply.');
   const messages=[...thread.messages].sort((a,b)=>Number(b.message.id===event.resourceId)-Number(a.message.id===event.resourceId));
   for(const m of messages){const title=m.message.subject.slice(0,240),text='From: '+m.message.from+'; Date: '+m.message.receivedAt+'\n'+m.text;
    if(text.length>12000)throw new AppError('unavailable','More information needed: this message exceeds the bounded reply context. Use a manual local reply.');
    items.push({id:'M'+(items.length+1),kind:'email',accountId:event.accountId,resourceId:m.message.id,revision:threadRevision(thread),title,text,fetchedAt:thread.fetchedAt,trust:'untrusted-source',senderScope:source.senderScope,threadId:thread.id});
   }
   if(Buffer.byteLength(JSON.stringify(items),'utf8')>10000)throw new AppError('unavailable','More information needed: this thread exceeds the bounded reply context. Use a manual local reply.');
   const sharing={google:true,tasks:false};available.thread=true;limitations.push('Current thread text only. Attachments, calendar and tasks are not included. Ask the owner about missing decisions or facts.');
   return{id:randomUUID(),hash:hash({items:items.map(({fetchedAt:_at,...item})=>item),timezone,sharing}),createdAt:new Date(this.now()).toISOString(),timezone,items,limitations,available,sharing};
  }
  if(state.config.shareGoogle&&event.accountId){
   if(event.family==='email'||event.family==='briefing'){
    const data=await(event.family==='email'?this.google.summary({accountId:event.accountId,id:event.resourceId!},true):this.google.inbox({accountId:event.accountId}));
    if(data.accountId!==event.accountId||this.now()-+new Date(data.fetchedAt)>freshMs)throw new AppError('permission_denied','Email context is stale or belongs to another account.');
    if(event.family==='email'&&!data.messages.some(m=>m.id===event.resourceId))throw new AppError('unavailable','The selected message is unavailable.');
    for(const mail of data.messages.filter(m=>event.family!=='email'||m.id===event.resourceId).slice(0,6)){
     const sender=mail.from.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0].toLowerCase();const text=`From: ${mail.from.slice(0,120)}; Date: ${mail.receivedAt}; ${mail.snippet.slice(0,600)}`;const title=mail.subject.slice(0,240);
     items.push({id:'M'+(items.filter(s=>s.kind==='email').length+1),kind:'email',accountId:event.accountId,resourceId:mail.id,revision:hash({title,text}),title,text,fetchedAt:data.fetchedAt,trust:'untrusted-source',senderScope:sender?hash({account:event.accountId,sender}):null,threadId:mail.threadId});
    }limitations.push('Only selected/first-page email snippets are supplied. Full bodies and prior threads are unavailable.');if(data.failed)limitations.push('Some email metadata could not be loaded.');
   }
   if((event.family!=='chat'||specialistRole({event})==='planner')&&!/^list my tasks$/i.test(event.prompt.trim())&&!sourceSettings.disabledModules.includes('planner')){
    try{const today=dateInZone(new Date(this.now()),timezone);const data=await this.google.calendar({accountId:event.accountId,startDate:today,endDate:addDays(today,7),timezone,refresh:true});if(data.accountId!==event.accountId||this.now()-+new Date(data.fetchedAt)>freshMs)throw new Error('Stale');available.calendar=!data.truncated&&!data.skipped&&data.events.length<=6;
     for(const e of data.events.slice(0,6)){const text=JSON.stringify({time:e.time,status:e.status,recurringEventId:e.recurringEventId});const title=e.title.slice(0,240);items.push({id:'E'+(items.filter(s=>s.kind==='calendar').length+1),kind:'calendar',accountId:event.accountId,resourceId:e.id,revision:hash({title,text}),title,text,fetchedAt:data.fetchedAt,trust:'untrusted-source',senderScope:null,threadId:null});}if(!available.calendar)limitations.push('Calendar availability is incomplete; do not assert free time.');
    }catch{limitations.push('Calendar unavailable; do not infer free time.');}
   }
  }
  if(state.config.shareTasks&&event.accountId&&!sourceSettings.disabledModules.includes('planner')){const tasks=(await this.storage.workspace()).tasks.filter(t=>t.accountId===event.accountId&&t.status==='open');available.tasks=tasks.length<=6;if(!available.tasks)limitations.push('Task list exceeds the six-item context limit.');for(const t of tasks.slice(0,6))items.push({id:'T'+(items.filter(s=>s.kind==='task').length+1),kind:'task',accountId:event.accountId,resourceId:t.id,revision:hash(t),title:t.title,text:JSON.stringify(t.due),fetchedAt:new Date(this.now()).toISOString(),trust:'untrusted-source',senderScope:null,threadId:null});}
  const sharing={google:state.config.shareGoogle,tasks:state.config.shareTasks};return{id:randomUUID(),hash:hash({items:items.map(({fetchedAt:_fetchedAt,...item})=>item),timezone,sharing}),createdAt:new Date(this.now()).toISOString(),timezone,items,limitations,available,sharing};
 }
 async start(raw:AgentIntake,boundBriefing?:BriefingSnapshot){await this.ready;const event=intakeSchema.parse(raw);if(event.origin==='momo'||event.depth>0||event.causationId)throw new AppError('permission_denied','MoMo-generated changes do not trigger another workflow.');const state=await this.state();if(event.family==='briefing'&&!boundBriefing){const record=await this.prepareBriefing(event.trigger==='schedule'?'schedule':'manual',true);boundBriefing=record.snapshot;await this.publish();const eligibility=await this.safeBriefingEligibility(event.accountId,state);if(!eligibility.eligible){await this.blockSynthesis(record,eligibility.issues[0].code);await this.publish();throw new AppError('permission_denied',eligibility.issues[0].message);}}const policy=this.policy(state,event);if((await this.storage.get()).values.disabledModules.includes(workflowModule(event.family)))throw new AppError('permission_denied','This workspace is disabled in Settings.');await this.account(event.accountId);if(event.scheduling){const previous=await this.storage.agent('schedulingForSource',{accountId:event.accountId,resourceId:event.resourceId,threadRevision:event.scheduling.threadRevision})??await this.storage.agent('schedulingForThread',{accountId:event.accountId,threadId:event.scheduling.threadId});if(previous)return agentRunSchema.parse(previous);}if(event.family==='briefing'){const eligibility=await this.briefingEligibility(event.accountId,state);if(!eligibility.eligible)throw new AppError('permission_denied',eligibility.issues[0].message);}if(event.replyTo&&(await this.runs()).some(r=>r.id!==event.id&&r.event.replyTo&&r.event.accountId===event.accountId&&r.event.resourceId===event.resourceId&&['queued','running'].includes(r.status)))throw new AppError('conflict','A reply for this message is already queued or running.');const contextSettings=(await this.storage.get()).values;const prepared=boundBriefing?selectBriefingContext(boundBriefing,event.id,state,contextSettings,this.now()):null;const loaded=prepared?.context??await this.context(event,state);const selected=prepared??selectWorkflowContext(loaded,event,state,contextSettings,this.now(),specialistRole({event})==='planner',!!event.scheduling);const context=selected?.context??loaded;await this.account(event.accountId);
  if((event.replyTo||event.scheduling)&&policy.level==='L0')throw new AppError('permission_denied','This workflow only observes. Local reply preparation requires an existing L1 or L2 policy.');
  const dedup=event.scheduling?hash({version:'coordinated-scheduling-v1',account:event.accountId,resource:event.resourceId,threadRevision:event.scheduling.threadRevision}):hash({scheduling:event.scheduling,replyRequestId:event.replyTo?event.id:undefined,replyTo:event.replyTo,processingVersion:'agent-team-v1',family:event.family,account:event.accountId,resource:event.resourceId??null,prompt:event.prompt,context:context.hash,briefingRevision:boundBriefing?.id,profile:state.revision,models:[state.config.jevModel,state.config.deepseekModel],bucket:event.trigger==='schedule'?dateInZone(new Date(this.now()),policy.schedule.timezone):Math.floor(this.now()/freshMs)});
  const run=agentRunSchema.parse({...(event.scheduling?{scheduling:{version:1,phase:'understanding',inbox:null,planner:null,draftHash:null}}:{}),...(selected?{contextSelection:selected.selection}:{}),...(boundBriefing?{briefingBinding:{snapshotId:boundBriefing.id,revision:boundBriefing.revision}}:{}),id:event.id,accountingPurpose:sessionAccountingPurpose(),definition:'workflow-v1',event,dedup,context,policy,config:state.config,profileRevision:state.revision,createdAt:new Date(this.now()).toISOString(),finishedAt:null,status:'queued',checkpoint:'Queued',attempt:0,decision:null,result:null,findings:[],proposals:[],calls:[],error:null,shadow:null});run.team=createTeam(run,selected.selection.budget);if(selected?.selection.blocked){run.status='review';run.checkpoint='Context review required';if(run.scheduling)run.scheduling.phase='needs-information';run.error='More information needed: required context is unavailable or exceeds this workflow context budget. Refresh the source or use a manual reply.';run.finishedAt=new Date(this.now()).toISOString();}if(run.finishedAt)finishTeam(run);const result=agentRunSchema.parse(await this.storage.agent('enqueue',run));await this.saveSynthesis(result);await this.publish();this.kick();return result;
 }
 private kick(){if(this.closed)return;if(this.pumping){this.kickRequested=true;return;}this.kickRequested=false;this.pumping=this.drain().catch(()=>{}).finally(()=>{this.pumping=null;if(this.kickRequested)this.kick();});}
 async idle(){while(this.pumping)await this.pumping;}
 private async drain(){for(;;){if(this.closed)break;const next=await this.storage.agent('next');if(!next)break;const run=agentRunSchema.parse(next);const controller=new AbortController();this.active={id:run.id,controller};await this.execute(run,controller);this.active=null;}}
 private async execute(run:AgentRun,controller:AbortController){
  if(run.responsibility){await this.executeRelayContinuation(run,controller);return;}
  if(!run.team){run.status='review';run.error='This queued workflow predates specialist roles. Start a new request after reviewing its sources.';run.finishedAt=new Date(this.now()).toISOString();await this.save(run);return;}
  const limits=effectiveLimits((await this.storage.get()).values,run.config);limits.callsPerWorkflow=Math.min(limits.callsPerWorkflow,Math.max(1,sessionRequestLimit()));if(run.background)limits.callsPerWorkflow=Math.min(limits.callsPerWorkflow,Math.max(1,run.background.providerLimit));run.limits=limits;
  const seconds=run.background?Math.min(backgroundLimits.seconds,limits.normalSeconds):limits.profile==='complex'?limits.complexSeconds:limits.normalSeconds;
  const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(seconds*1000)]);
  const work=specialist(run);
  for(const item of run.team.items)item.deadline=new Date(Math.min(Date.parse(item.deadline),this.now()+seconds*1000)).toISOString();
  run.status='running';run.attempt=1;run.checkpoint='Preflight';work.status='running';await this.save(run);
  const reserve=async(provider:'jev'|'deepseek',purpose:string)=>{
   if(run.background&&run.calls.length>=run.background.providerLimit)throw new AppError('unavailable','Background provider-call bound reached.');assertSessionRequestAvailable();await this.authority(run);signal.throwIfAborted();
   const settings=(await this.storage.get()).values;
   if(!(provider==='jev'?settings.jevEnabled:settings.deepseekEnabled)||await this.credentials.status(provider)!=='configured')throw new AppError('unavailable','The required AI connection is unavailable.');
   const id=randomUUID();
   await this.storage.agent('reserve',{id,runId:run.id,provider,daily:run.config.dailyCalls,providerDaily:settings.dailyCallLimit,perRun:limits.callsPerWorkflow,model:provider==='jev'?run.config.jevModel:run.config.deepseekModel,profile:run.background?'background-inbox':run.decision?.route??purpose,purpose:run.accountingPurpose??'ordinary',maxTokens:provider==='deepseek'?generationTokens(limits,limits.profile==='complex'?'complex':'normal'):0,at:new Date(this.now()).toISOString()});
   const call:AgentRun['calls'][number]={id,provider,purpose,requestedModel:provider==='jev'?run.config.jevModel:run.config.deepseekModel,reportedModel:null,status:'reserved',usage:null,elapsedMs:0};
   run.calls.push(call);run.checkpoint=purpose;await this.save(run);return call;
  };
  const micro=new JevMicroDecisions(async(state,questions,requestSignal)=>{
   const call=await reserve('jev',run.result?'atomic-review':'micro-decision'),started=this.now();
   try{
    const response=await this.jev.decide(await this.credentials.read('jev'),run.config.jevModel,state,questions,AbortSignal.any([requestSignal,AbortSignal.timeout(30000)]));
    Object.assign(call,{status:'complete',reportedModel:response.reportedModel,usage:response.usage,elapsedMs:Math.max(0,this.now()-started)});
    await this.save(run);return response;
   }catch(error){call.status='unknown';await this.save(run);throw error;}
  });
  try{
   await this.authority(run);await this.revalidateEvidence(run);signal.throwIfAborted();
   if(run.scheduling){await this.executeScheduling(run,signal,async(kind,prompt)=>{
    const settings=(await this.storage.get()).values;if(!this.deepseek.coordinate||!inferenceAllowed()||!settings.deepseekEnabled||await this.credentials.status('deepseek')!=='configured')return undefined;
    const remaining=limits.workflowTokens-run.calls.reduce((n,c)=>n+(c.usage?.output??(c.provider==='deepseek'?generationTokens(limits,'normal'):0)),0);
    if(remaining<256)throw new AppError('unavailable','Workflow generation budget exhausted.');
    if(run.decision)run.decision.route=kind==='interpret'?'CALENDAR_REASONING':'DRAFT_REPLY';run.processingProfile={template:'scheduling-'+kind+'-v2',thinking:'none'};
    let started=this.now();
    return this.deepseek.coordinate({key:await this.credentials.read('deepseek'),model:run.config.deepseekModel,route:kind==='interpret'?'CALENDAR_REASONING':'DRAFT_REPLY',context:kind==='interpret'?{...run.context,items:run.context.items.filter(s=>s.kind==='email'&&s.resourceId===run.event.resourceId)}:run.context,prompt,maxTokens:Math.min(generationTokens(limits,'normal'),remaining),totalTokens:remaining,maxRounds:1,signal,allowedTools:[],beforeRound:async()=>{await reserve('deepseek','scheduling-'+kind);started=this.now();},usage:async(model,usage)=>{Object.assign(run.calls.at(-1)!,{reportedModel:model,usage,status:'complete',elapsedMs:Math.max(0,this.now()-started)});await this.save(run);},checkAuthority:async()=>{signal.throwIfAborted();await this.authority(run);}},kind);
   });return;}
   const context=contextRequest(run,work,run.context.items.map(s=>s.id),this.now(),signal);
   if(context.sources.length!==run.context.items.length)throw new AppError('permission_denied','Selected context is no longer available.');
   const route=nativeRoute(run);
   run.decision={answers:{},questionSet:'native-specialist-v1',questionHash:hash({role:work.role,route}),routingVersion:'routing-v1',thresholds,requestedModel:run.config.jevModel,reportedModel:null,route,reasons:['NATIVE_CAPABILITY_SELECTION'],priority:'unknown',preferenceVersion:null,degraded:false};
   if(work.role==='inbox'&&route!=='NO_LLM'){
    try{
     const signals=await micro.assess(inboxSignals,{request:run.event.prompt,context:run.context},signal);
     await this.authority(run);signal.throwIfAborted();
     run.decision.answers=Object.fromEntries(signals.map(s=>[s.id,s.raw]));
     const priority=signals.find(s=>s.id==='priority')?.selected;
     run.decision.priority=priority==='high'||priority==='normal'?priority:'unknown';
    }catch(error){signal.throwIfAborted();if(error instanceof AppError&&error.code==='permission_denied')throw error;run.findings.push({code:'MICRO_DECISION_UNAVAILABLE',severity:'info'});}
   }
   const state=await this.state(),scope=run.context.items.find(s=>s.kind==='email')?.senderScope??null,preference=preferenceFor(state,run.event.accountId,scope);
   run.decision.priority=applyPriority(run.decision.priority,preference);run.decision.preferenceVersion=preference?.id??null;work.priority=run.decision.priority;
   if(state.config.shadow){const candidate=state.candidates.find(c=>c.status==='evaluated'&&c.accountId===run.event.accountId&&c.scope===scope);if(candidate)run.shadow={candidateId:candidate.id,baseline:work.priority,candidate:applyPriority(work.priority,candidate)};}
   run.checkpoint='Preparing result';await this.save(run);
   if(run.policy.level==='L0'&&!run.background){run.status='complete';}
   else{
    if(run.background)run.result=await this.prepareBackgroundResult(run,micro,signal);
    else if(route==='NO_LLM')run.result=deterministicPlanner(run);
    else{
     run.processingProfile={template:profiles[route].template,thinking:profiles[route].thinking};
     await reserve('deepseek','processing');
     let started=this.now(),firstRound=true;
     run.result=processingResultSchema.parse(await this.deepseek.process({
      key:await this.credentials.read('deepseek'),model:run.config.deepseekModel,route,context:run.context,prompt:run.event.prompt,
      maxTokens:generationTokens(limits,limits.profile==='complex'?'complex':'normal'),totalTokens:limits.workflowTokens,
      maxRounds:Math.min(4,Math.max(1,limits.callsPerWorkflow-run.calls.length+1)),signal,
      beforeRound:async()=>{if(firstRound)firstRound=false;else await reserve('deepseek','processing');started=this.now();},
      usage:async(model,usage)=>{Object.assign(run.calls.at(-1)!,{reportedModel:model,usage,status:'complete',elapsedMs:Math.max(0,this.now()-started)});await this.save(run);},
      checkAuthority:async()=>{signal.throwIfAborted();await this.authority(run);},
      allowedTools:work.allowedTools,plannerProposals:work.role==='planner',
      readContext:async ids=>{
       await this.authority(run);signal.throwIfAborted();
       const selected=contextRequest(run,work,ids,this.now(),signal);
       run.team!.toolCompletions.push({workItemId:work.id,tool:'read_context',evidenceIds:ids,at:new Date(this.now()).toISOString()});
       await this.save(run);return selected.sources;
      },
     }));
    }
    signal.throwIfAborted();await this.authority(run);
    const review=handoff(run.team,work,'review','Verify evidence and requested deliverables',this.now());review.status='running';
    contextRequest(run,review,run.context.items.map(s=>s.id),this.now(),signal);
    run.team.ledger=evidenceLedger(run,work,run.result,this.now());
    if(!run.team.ledger.passed){
     review.status='held';run.status='review';run.error=run.team.ledger.checks.find(c=>c.status==='reject')!.detail;
     run.findings.push({code:'NATIVE_EVIDENCE_REJECTION',severity:'review'});
    }else if(run.result.clarification){
     review.status='complete';run.status='review';run.error=run.result.clarification;
    }else{
     if(route!=='NO_LLM'&&profiles[route].quality){
      try{
       const signals=await micro.assess(reviewSignals,{request:run.event.prompt,context:run.context,finalOutput:run.result},signal);
       await this.authority(run);signal.throwIfAborted();
       run.quality={answers:Object.fromEntries(signals.map(s=>[s.id,s.raw])),questionSet:'atomic-review-v1',questionHash:hash(microQuestions(reviewSignals)),requestedModel:run.config.jevModel,reportedModel:run.calls.at(-1)?.reportedModel??null};
       run.team.ledger.semantic=signals.some(s=>s.selected!=='no')?'flags':'no-flags';
       run.findings.push({code:run.team.ledger.semantic==='flags'?'ADVISORY_SEMANTIC_CONCERNS':'ADVISORY_NO_SEMANTIC_FLAGS',severity:'info'});
      }catch(error){signal.throwIfAborted();if(error instanceof AppError&&error.code==='permission_denied')throw error;run.team.ledger.semantic='unavailable';run.findings.push({code:'ATOMIC_REVIEW_UNAVAILABLE',severity:'info'});}
     }
     await this.revalidateEvidence(run);await this.authority(run);signal.throwIfAborted();
     const fresh=evidenceLedger(run,work,run.result,this.now());fresh.semantic=run.team.ledger.semantic;run.team.ledger=fresh;
     if(!fresh.passed)throw new AppError('permission_denied','Evidence changed during review.');
     review.status='complete';review.resultSummary='Native evidence checks passed. Prose correctness still requires owner judgment.';
     await this.authority(run);signal.throwIfAborted();
     if(run.event.replyTo&&run.result.draft){
      const response=await this.mail!.command({action:'compose',id:run.id,accountId:run.event.accountId!,mode:'reply',sourceMessageId:run.event.resourceId!,body:run.result.draft,grounding:{runId:run.id,threadId:run.event.replyTo.threadId,threadRevision:run.event.replyTo.threadRevision}},async()=>{signal.throwIfAborted();await this.authority(run);signal.throwIfAborted();});
      if(!response.drafts.some(d=>d.id===run.id))throw new AppError('unavailable','The local draft could not be confirmed. Inspect Local drafts.');
      run.localDraftId=run.id;
     }
     if(run.result.calendarProposal){
      if(!this.calendarActions)throw new AppError('unavailable','Calendar proposal preparation is unavailable.');
      const prepared=await this.calendarActions.command({action:'prepare',draft:run.result.calendarProposal.draft});
      run.calendarProposalId=prepared.review!.action.id;
     }
     run.proposals=work.permission.actions.includes('task-proposal')?await this.makeProposals(run):[];
     signal.throwIfAborted();await this.authority(run);signal.throwIfAborted();
     if(run.background){await this.commitBackground(run,signal);}
     run.status='complete';
    }
   }
  }catch(error){
   run.status=controller.signal.aborted?'cancelled':error instanceof AppError&&error.message==='WORKFLOW_BUDGET_EXHAUSTED'?'budget_exhausted':run.result?'partial':'failed';
   run.error=controller.signal.aborted?'Workflow cancelled. Provider usage may already be charged.':signal.aborted?'Workflow timed out; no automatic retry.':error instanceof AppError?error.message:'The required AI result was unavailable. No action was authorized.';
   if(run.scheduling)run.scheduling.phase=controller.signal.aborted?'cancelled':error instanceof AppError&&error.code==='conflict'?'stale':run.scheduling.planner?'partial':'failed';
   if(run.result)run.findings.push({code:'INCOMPLETE_UNVERIFIED_OUTPUT',severity:'review'});
  }
  if(run.error)run.error=run.error.slice(0,240);
  run.calls=run.calls.map(c=>c.status==='reserved'?{...c,status:'unknown'}:c);
  this.pendingInsights.delete(run.id);run.finishedAt=new Date(this.now()).toISOString();run.checkpoint=run.status==='complete'?'Complete':run.status;await this.save(run);
 }
 private async revalidateScheduling(run:AgentRun){
  const binding=run.event.scheduling!;
  const thread=await this.google.readMailThread!(run.event.accountId!,binding.threadId);
  if(thread.accountId!==run.event.accountId||thread.id!==binding.threadId||!this.schedulingThreadMatches(run,thread)||thread.truncated||!thread.messages.some(m=>m.message.id===run.event.resourceId)||Math.abs(this.now()-Date.parse(thread.fetchedAt))>freshMs)throw new AppError('conflict','The scheduling source thread changed or became unavailable. Refresh the source.');
  const facts=run.scheduling?.planner;
  if(facts?.coverage==='complete'){
   const data=await this.google.calendar(schedulingQuery(run.event.accountId!,facts.scope),true);
   if(Math.abs(this.now()-Date.parse(data.fetchedAt))>freshMs||!(await this.schedulingRangeMatches(run,data)))throw new AppError('conflict','Calendar evidence changed. Refresh scheduling before using the proposed times.');
   if(facts.candidates.some(c=>Date.parse(c.start)<=this.now()))throw new AppError('conflict','A proposed time is no longer in the future. Refresh scheduling.');
  }
 }

 private schedulingThreadMatches(run:AgentRun,thread:MailThread){
  const known=run.scheduling?.sentMessageIds??[],messages=thread.messages.filter(m=>!known.includes(m.message.id)||run.context.items.some(s=>s.kind==='email'&&s.resourceId===m.message.id));
  return threadRevision({...thread,messages})===run.event.scheduling!.threadRevision;
 }
 async observeSchedulingCalendar(data:import('../../src/shared/google').CalendarData){
  for(const run of await this.runs()){
   const facts=run.scheduling?.planner;
   if(!facts||run.event.accountId!==data.accountId||['queued','running','cancelled'].includes(run.status)||run.scheduling?.phase==='stale')continue;
   const query=schedulingQuery(data.accountId,facts.scope);
   if(data.timezone!==query.timezone||data.startDate>query.startDate||data.endDate<query.endDate)continue;
   const bounded={...data,startDate:query.startDate,endDate:query.endDate,events:data.events.filter(e=>{for(let d=query.startDate;d<query.endDate;d=addDays(d,1))if(eventOnDate(e,d,data.timezone))return true;return false;})};
   if(await this.schedulingRangeMatches(run,bounded))continue;
   const expected=structuredClone(run);run.scheduling!.phase='stale';run.scheduling!.draftStale=true;run.scheduling!.followUp={state:'calendar-changed',detail:'The relevant native calendar evidence changed. Replan before using earlier proposed times; your draft is preserved.',checkedAt:new Date(this.now()).toISOString()};run.checkpoint='Calendar changed; replanning required';await this.storage.agent('projectScheduling',{run,expected});await this.publish();
  }
 }
 private async schedulingRangeMatches(run:AgentRun,data:import('../../src/shared/google').CalendarData){
  const facts=run.scheduling!.planner!;
  if(calendarRangeRevision(data)===facts.rangeRevision)return true;
  if(!run.calendarProposalId||!facts.relatedEvent?.event||!facts.otherEventsRevision||!this.calendarActions)return false;
  const action=(await this.calendarActions.command({action:'list'})).actions.find(a=>a.id===run.calendarProposalId&&a.status==='succeeded'&&a.workflow?.contextHash===run.context.hash);
  const current=data.events.find(e=>e.id===facts.relatedEvent!.id),original=facts.relatedEvent.event;
  if(!action||!current||action.draft.time.kind!=='timed'||current.time.kind!=='timed'||Date.parse(current.time.start)!==Date.parse(action.draft.time.start)||Date.parse(current.time.end)!==Date.parse(action.draft.time.end))return false;
  const restored={...current,time:original.time,...(original.etag?{etag:original.etag}:{})};if(!original.etag)delete restored.etag;
  return hash(restored)===hash(original)&&calendarRangeRevision({...data,events:data.events.filter(e=>e.id!==current.id)})===facts.otherEventsRevision;
 }
 /** The existing MailService calls this at remote save, prepare-send and approve-send. */
 async validateSchedulingDraft(draft:LocalMailDraft):Promise<()=>boolean>{
  if(draft.provenance?.workflow!=='inbox-planner-v1')return()=>true;
  const epoch=this.schedulingAuthorityEpoch;
  const raw=await this.storage.agent('get',draft.provenance.runId);
  const run=raw?agentRunSchema.parse(raw):null;
  if(!run?.scheduling||run.localDraftId!==draft.id||run.event.accountId!==draft.accountId||run.event.resourceId!==draft.sourceMessageId||run.event.scheduling?.threadId!==draft.threadId||run.scheduling.phase!=='awaiting-owner'||run.scheduling.draftStale||run.scheduling.followUp?.state==='completed'||run.status!=='complete'||this.cancelledScheduling.has(run.id))throw new AppError('permission_denied','This scheduling workflow is cancelled, incomplete or no longer retained. Review its source before sending.');
  const current=await this.state(),policy=this.policy(current,run.event),settings=(await this.storage.get()).values;
  if(policy.version!==run.policy.version||JSON.stringify(current.config)!==JSON.stringify(run.config)||settings.timezone!==run.context.timezone||settings.disabledModules.some(m=>m==='inbox'||m==='planner'))throw new AppError('permission_denied','Scheduling permissions or settings changed. Prepare a new proposal.');
  await this.account(draft.accountId);await this.revalidateScheduling(run);await this.account(draft.accountId);
  const checkedAt=this.now();
  return()=>epoch===this.schedulingAuthorityEpoch&&!this.cancelledScheduling.has(run.id)&&this.now()-checkedAt<schedulingFreshMs&&run.scheduling!.planner!.candidates.every(c=>Date.parse(c.start)>this.now());
 }

 private async executeScheduling(run:AgentRun,signal:AbortSignal,model:(kind:'interpret'|'reply',prompt:string)=>Promise<unknown>){
  const state=run.scheduling!;
  if(state.contextHistory.length>=6&&!run.context.schedulingInterpretation?.scope)throw new AppError('conflict','The six-revision scheduling limit was reached.');
  if(!run.context.schedulingInterpretation?.scope&&!run.event.scheduling?.confirmed){const candidate=await model('interpret','Extract all scheduling constraints from the exact current message.');signal.throwIfAborted();if(candidate)await this.stageScheduling(run,schedulingInterpretationSchema.parse(candidate));}
  const team=run.team!,root=team.items[0],initial=specialist(run);
  const check=async()=>{signal.throwIfAborted();if(this.cancelledScheduling.has(run.id))throw new AppError('cancelled','Scheduling was cancelled.');await this.authority(run);signal.throwIfAborted();};
  const finish=async()=>{await check();run.finishedAt=new Date(this.now()).toISOString();await this.save(run);};
  const source=run.context.items.find(s=>s.resourceId===run.event.resourceId&&s.kind==='email')!;
  assertWorkItem(initial,run,this.now(),signal);
  state.inbox=run.context.schedulingInterpretation??interpretScheduling(run.event,source.text,source.id,run.context.timezone,Date.parse(run.createdAt),this.now());
  initial.status='complete';initial.resultSummary=state.inbox.intent==='uncertain'?'Scheduling intent needs owner clarification.':`Scheduling intent: ${state.inbox.intent}.`;
  run.decision={answers:{},questionSet:'native-scheduling-v1',questionHash:hash({intent:state.inbox.intent}),routingVersion:'routing-v1',thresholds,requestedModel:run.config.jevModel,reportedModel:null,route:run.calls.some(c=>c.purpose==='scheduling-interpret')?'CALENDAR_REASONING':'NO_LLM',reasons:['BOUNDED_SCHEDULING_WORKFLOW'],priority:'normal',preferenceVersion:null,degraded:false};
  if(!state.inbox.scope||['uncertain','not-scheduling'].includes(state.inbox.intent)){
   state.phase='needs-information';run.status='review';run.error=state.inbox.uncertainty.join(' ').slice(0,240);run.checkpoint='Owner scheduling details required';
   run.result={text:run.error,draft:null,clarification:run.error,evidence:[source.id],reminders:[]};await finish();return;
  }
  state.phase='checking-calendar';run.checkpoint='Checking the requested calendar window';await this.save(run);await check();
  const bindings=root.context.bindings.filter(b=>b.evidenceId==='E1');
  const planner=handoff(team,root,'planner','Check the bounded primary-calendar window',this.now(),{expectedResult:'planner-availability-v1',permission:{...root.permission,actions:[]},sources:bindings.map(b=>b.delivery.ref),context:{...root.context,bindings},revisionBindings:root.revisionBindings.filter(b=>bindings.some(c=>resourceKey(c.delivery.ref)===b.key)),requiredEvidenceIds:['E1'],deliverables:['conflicts']});
  team.specialistId=planner.id;planner.status='running';assertWorkItem(planner,run,this.now(),signal);
  const calendar=run.context.items.find(s=>s.id==='E1');
  if(!calendar||calendar.delivery?.mode!=='FULL')throw new AppError('permission_denied','Planner evidence is missing from the permitted context.');
  state.planner=plannerAvailabilitySchema.parse(JSON.parse(calendar.text));
  if(state.planner.accountId!==run.event.accountId||state.planner.rangeRevision!==calendar.revision||hash(state.planner.scope)!==hash(state.inbox.scope))throw new AppError('permission_denied','Planner result is not bound to this scheduling request.');
  await this.revalidateScheduling(run);await check();planner.status='complete';planner.resultSummary=`${state.planner.candidates.length} candidate windows; ${state.planner.coverage} primary-calendar coverage.`;
  if(state.planner.coverage!=='complete'||!state.planner.candidates.length||state.planner.meetingAmbiguous){
   state.phase=state.planner.coverage==='complete'?'needs-information':'calendar-unavailable';run.status='review';run.checkpoint='Calendar facts need owner attention';
   run.error=state.planner.meetingAmbiguous?'Several native events match. Confirm the exact original event ID.':state.planner.coverage==='complete'?'No candidate windows were established. Review the calendar facts and confirm another search window.':'Calendar coverage is incomplete or unavailable. No availability reply was prepared.';
   run.result={text:run.error,draft:null,clarification:run.error,evidence:[source.id,'E1'],reminders:[]};await finish();return;
  }
  const reply=handoff(team,root,'inbox','Prepare a reply using the source message and verified Planner windows',this.now(),{expectedResult:'processing-v1',deliverables:['reply-or-clarification'],requiredEvidenceIds:run.context.items.map(s=>s.id)});
  team.specialistId=reply.id;reply.status='running';assertWorkItem(reply,run,this.now(),signal);
  state.phase='preparing-reply';run.checkpoint='Preparing the linked scheduling reply';await this.save(run);await check();
  const generated=await model('reply','Choose natural reply phrasing and verified candidate IDs from E1.');
  if(generated)state.replyPlan=schedulingReplyPlanSchema.parse(generated);
  run.result={text:`${state.planner.candidates.length} candidate windows found in the requested primary-calendar range. Owner review is required.`,draft:schedulingReply(state.inbox,state.planner,state.replyPlan),evidence:run.context.items.map(s=>s.id),reminders:[]};
  state.draftHash=hash(run.result.draft);reply.status='complete';reply.resultSummary='Local reply prepared from exact source and native calendar facts.';
  const review=handoff(team,root,'review','Verify the consequential scheduling reply before owner review',this.now(),{requiredEvidenceIds:run.context.items.map(s=>s.id)});
  review.status='running';state.phase='reviewing';run.checkpoint='Verifying the scheduling proposal';await this.save(run);await check();
  await this.revalidateScheduling(run);await check();
  team.ledger=evidenceLedger(run,reply,run.result,this.now());
  team.ledger.checks.push({code:'PLANNER_REPLY_BINDING',status:run.result.draft===schedulingReply(state.inbox,state.planner,state.replyPlan)?'pass':'reject',detail:'Reply windows, timezone and wording match the bounded native Planner result.'});
  team.ledger.passed=team.ledger.checks.every(c=>c.status!=='reject');
  if(!team.ledger.passed)throw new AppError('permission_denied','The scheduling proposal failed native evidence checks.');
  review.status='complete';review.resultSummary='Source binding, calendar range revision, timezone and proposed times verified. No action authorized.';
  await check();
  const response=await this.mail!.command({action:'compose',id:run.id,accountId:run.event.accountId!,mode:'reply',sourceMessageId:run.event.resourceId!,body:run.result.draft!,grounding:{runId:run.id,threadId:run.event.scheduling!.threadId,threadRevision:run.event.scheduling!.threadRevision,workflow:'inbox-planner-v1'}},async()=>{await check();await this.revalidateScheduling(run);await check();});
  if(!response.drafts.some(d=>d.id===run.id))throw new AppError('unavailable','The local reply could not be confirmed. Inspect Local drafts before retrying.');
  run.localDraftId=run.id;state.phase='awaiting-owner';run.status='complete';run.checkpoint='Scheduling proposal ready for owner review';await finish();
 }

 private async makeProposals(run:AgentRun):Promise<LocalProposal[]>{if(!run.event.accountId||!run.result!.reminders.length)return[];const titles=new Set((await this.storage.workspace()).tasks.filter(t=>t.accountId===run.event.accountId&&t.status==='open').map(t=>t.title.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'')));if(run.result!.reminders.some(r=>titles.has(r.title.toLowerCase().replace(/[^\p{L}\p{N}]/gu,''))))throw new AppError('conflict','This task already exists in the selected account.');return run.result!.reminders.slice(0,1).map(r=>{const source=run.context.items.find(s=>s.id===r.sourceId)!;const date=addDays(dateInZone(new Date(this.now()),run.context.timezone),1);const base={id:randomUUID(),taskId:randomUUID(),accountId:run.event.accountId!,draft:{title:r.title,due:{kind:'date' as const,date,timezone:run.context.timezone}},sourceId:r.sourceId,sourceRevision:source.revision,expiresAt:new Date(this.now()+900000).toISOString(),policyVersion:run.policy.version,status:'pending' as const,authorization:'none' as const};return{...base,hash:proposalHash(base)};});}
 private async applyLocal(run:AgentRun,p:LocalProposal,authorization:'explicit'|'L2'){
  if(p.status!=='pending'||p.hash!==proposalHash(p)||+new Date(p.expiresAt)<=this.now())throw new AppError('permission_denied','This exact reminder proposal expired, changed, or was already handled.');await this.authority(run);const source=run.context.items.find(s=>s.id===p.sourceId);if(!source||source.revision!==p.sourceRevision)throw new AppError('permission_denied','Source changed.');
  if(run.event.replyTo)await this.revalidateEvidence(run);if(source.kind==='email'&&!run.event.replyTo){const data=await this.google.summary({accountId:p.accountId,id:source.resourceId},true);const mail=data.messages.find(m=>m.id===source.resourceId);if(!mail||hash({title:mail.subject.slice(0,240),text:`From: ${mail.from.slice(0,120)}; Date: ${mail.receivedAt}; ${mail.snippet.slice(0,600)}`})!==p.sourceRevision)throw new AppError('permission_denied','The email changed. Run the workflow again.');}
  if(source.kind==='task'){const task=(await this.storage.workspace()).tasks.find(t=>t.id===source.resourceId&&t.accountId===p.accountId);if(!task||hash(task)!==p.sourceRevision)throw new AppError('permission_denied','The task changed. Run the workflow again.');}
  if(source.kind==='calendar'){const today=dateInZone(new Date(this.now()),run.context.timezone);const data=await this.google.calendar({accountId:p.accountId,startDate:today,endDate:addDays(today,7),timezone:run.context.timezone,refresh:true},true);const e=data.events.find(e=>e.id===source.resourceId);if(data.truncated||data.skipped||!e||hash({title:e.title.slice(0,240),text:JSON.stringify({time:e.time,status:e.status,recurringEventId:e.recurringEventId})})!==p.sourceRevision)throw new AppError('permission_denied','Calendar preconditions changed. Run the workflow again.');}
  if(authorization==='L2'){const applied=Number(await this.storage.agent('localCount',{accountId:p.accountId,family:run.event.family,at:new Date(this.now()).toISOString()}));if(run.policy.level!=='L2'||applied>=run.policy.maxLocalPerDay)throw new AppError('permission_denied','Local automation daily limit reached. Review the reminder manually.');}
  await this.authority(run);const applied=agentRunSchema.parse(await this.storage.agent('applyLocal',{runId:run.id,proposalId:p.id,hash:p.hash,authorization,at:new Date(this.now()).toISOString()}));Object.assign(run,applied);await this.publish();
 }
 private async collectBackground(refresh:boolean){
  const state=await this.state(),settings=(await this.storage.get()).values,google=await this.google.state(),accountId=google.activeAccountId;
  if(!accountId)throw new AppError('permission_denied','Select a connected account to prepare intelligence.');await this.account(accountId);
  this.policy(state,{family:'briefing',accountId} as AgentIntake);
  const authority=await this.situationAuthority(settings,state,google),snapshot=await this.collectBriefing('view',refresh,true);
  const inbox=state.config.shareGoogle&&backgroundSourceEnabled(state,settings,accountId,'email')?await this.google.inbox({accountId,refresh}).catch(()=>undefined):undefined;
  if(inbox&&(inbox.accountId!==accountId||Math.abs(this.now()-Date.parse(inbox.fetchedAt))>freshMs))throw new AppError('permission_denied','Inbox scope or freshness changed.');
  if(authority!==await this.situationAuthority((await this.storage.get()).values,await this.state(),await this.google.state()))throw new AppError('permission_denied','Background permissions changed during source loading.');
  return{state,settings,accountId,authority,snapshot,context:backgroundContext(snapshot,inbox)};
 }
 private async startBackground(trigger:BackgroundTrigger,providerCalls=2){
  await this.ready;const settings=(await this.storage.get()).values,options=settings.backgroundIntelligence??backgroundDefaults;
  if(trigger!=='manual'&&(!options.enabled||['startup','resume'].includes(trigger)&&!options.startupResume))return;
  const state=await this.state(),accountId=(await this.google.state()).activeAccountId;
  if(!state.config.enabled||state.config.paused||!accountId){if(trigger==='manual')throw new AppError('permission_denied','Select a connected account and enable workflow processing.');return;}
  const existing=(await this.runs()).find(r=>r.background&&r.event.accountId===accountId&&['queued','running'].includes(r.status));if(existing)return existing;
  const latest=(await this.runs()).find(r=>r.background&&r.event.accountId===accountId);
  if(trigger==='schedule'&&latest&&this.now()-Date.parse(latest.createdAt)<options.cadenceMinutes*60000)return;
  const input=await this.collectBackground(trigger==='manual'||trigger==='schedule');
  const event:AgentIntake={id:randomUUID(),family:'briefing',accountId,prompt:'Prepare read-only background intelligence, source changes, Inbox attention, calendar/task conflicts and bounded context. Unknown attendance, duration and commitments remain unknown.',trigger:trigger==='manual'?'manual':trigger==='schedule'?'schedule':'source',origin:trigger==='manual'?'user':'connector',depth:0,causationId:null};
  const selected=selectWorkflowContext(input.context,event,input.state,input.settings,this.now(),true,true);
  const background=backgroundMetadata(trigger,input.authority,input.context,input.snapshot,input.settings,Math.min(backgroundLimits.providerCalls,providerCalls));
  const dedup=hash({background:1,accountId,authority:input.authority,sources:background.sourceRevision,bucket:Math.floor(this.now()/(options.cadenceMinutes*60000))});
  const same=(await this.runs()).find(r=>r.dedup===dedup);if(same)return same;
  const run=agentRunSchema.parse({id:event.id,definition:'workflow-v1',event,dedup,background,accountingPurpose:sessionAccountingPurpose(),context:selected.context,contextSelection:selected.selection,policy:this.policy(input.state,event),config:input.state.config,profileRevision:input.state.revision,createdAt:new Date(this.now()).toISOString(),finishedAt:null,status:'queued',checkpoint:'Background intelligence queued',attempt:0,decision:null,result:null,findings:[],proposals:[],calls:[],error:null,shadow:null});
  run.team=createTeam(run,selected.selection.budget);run.team.items.forEach(w=>{w.deadline=new Date(this.now()+backgroundLimits.seconds*1000).toISOString();});
  await this.backgrounds.invalidate(accountId,input.authority,this.now(),revisionSet(input.context));
  const previous=await this.briefings.get(accountId);if(previous?.snapshot.revision!==input.snapshot.revision||this.now()-Date.parse(previous.snapshot.createdAt)>=freshMs)await this.briefings.put({snapshot:input.snapshot,synthesis:{snapshotId:input.snapshot.id,snapshotRevision:input.snapshot.revision,runId:null,updatedAt:input.snapshot.createdAt,status:'not-requested',reason:'Daily facts prepared in the background. AI summary has not been requested.',text:null}});
  const queued=agentRunSchema.parse(await this.storage.agent('enqueue',run));await this.publish();this.kick();return queued;
 }
 /** Reuses the executive command queue and existing timer. No independent scheduler. */
 async requestBackground(trigger:Exclude<BackgroundTrigger,'manual'>){
  if(this.closed||process.argv.includes('--no-background-work'))return;if(this.backgroundRequest)return this.backgroundRequest;
  const task=this.commandQueue.then(async()=>{try{await this.startBackground(trigger);}catch{/* Unavailable scope produces no inference or retry loop. Manual refresh reports errors. */}});
  this.commandQueue=task.catch(()=>{});this.backgroundRequest=task.finally(()=>{this.backgroundRequest=null;});return this.backgroundRequest;
 }
 private async prepareBackgroundResult(run:AgentRun,micro:JevMicroDecisions,signal:AbortSignal){
  const root=run.team!.items[0];
  for(const [role,kind] of [['inbox','email'],['planner','calendar']] as const){const sources=run.context.items.filter(s=>role==='planner'?['calendar','task'].includes(s.kind):s.kind===kind);if(!sources.length)continue;
   const ids=new Set(sources.map(s=>s.id)),bindings=root.context.bindings.filter(b=>ids.has(b.evidenceId));
   const child=handoff(run.team!,root,role,role==='inbox'?'Prepare attention candidates from permitted Inbox evidence':'Inspect known calendar/task conflicts and missing information',this.now(),{sources:bindings.map(b=>b.delivery.ref),context:{...root.context,bindings},revisionBindings:root.revisionBindings.filter(b=>bindings.some(c=>resourceKey(c.delivery.ref)===b.key))});
   contextRequest(run,child,sources.map(s=>s.id),this.now(),signal);child.status='complete';child.resultSummary='Read-only candidates prepared; no action authorized.';
  }
  const prior=await this.backgrounds.all(),signals=new Map<string,MicroDecisionResult[]>(),state=await this.state();
  const nativeCandidates=deriveInsights(run,prior,this.now());
  const mails=run.context.items.filter(s=>s.kind==='email'&&s.delivery?.mode==='FULL'&&nativeCandidates.some(i=>i.category==='inbox'&&i.sources.some(r=>r.id===s.resourceId&&r.revision===s.revision))&&!prior.some(i=>i.accountId===run.event.accountId&&i.sources.some(r=>r.id===s.resourceId&&r.revision===s.revision)));
  if(run.background!.providerLimit>0&&inferenceAllowed())for(let offset=0;offset<Math.min(mails.length,6);offset+=3){
   signal.throwIfAborted();const batch=mails.slice(offset,offset+3),requests=batch.flatMap(s=>inboxSignals.map(q=>({...q,id:s.id+'_'+q.id})));
   try{const advice=await micro.assess(requests,{purpose:'background-inbox',sources:batch},signal);await this.authority(run);for(const s of batch)signals.set(s.id,advice.filter(a=>a.id.startsWith(s.id+'_')).map(a=>({...a,id:a.id.slice(s.id.length+1)})));}
   catch{signal.throwIfAborted();await this.authority(run);run.findings.push({code:'BACKGROUND_ADVICE_UNAVAILABLE',severity:'info'});break;}
  }
  const insights=deriveInsights(run,prior,this.now(),signals).map(i=>({...i,id:nativeCandidates.find(c=>c.identity===i.identity)?.id??i.id,provenance:{...i.provenance,method:i.advisory.length?'advisory' as const:'deterministic' as const}})).filter(i=>!i.sources.some(ref=>ref.type==='email'&&state.feedback.some(f=>f.accountId===ref.accountId&&f.resourceId===ref.id&&f.sourceRevision===ref.revision&&['dismissed','resolved'].includes(f.kind))));
  this.pendingInsights.set(run.id,insights);run.background!.deterministicOperations=run.context.items.length+insights.length;run.background!.preparedContext=run.context.items.map(s=>s.delivery!);
  return{text:`Read-only intelligence prepared from ${run.context.items.length} selected sources. ${insights.filter(i=>i.ownerAttention).length} potential attention findings. Daily facts and bounded context are ready. Coverage: ${run.context.limitations.join(' ')}`,draft:null,evidence:run.context.items.filter(s=>s.delivery?.mode!=='REFERENCE_ONLY').map(s=>s.id),reminders:[]};
 }
 private async commitBackground(run:AgentRun,signal:AbortSignal){
  signal.throwIfAborted();await this.authority(run);signal.throwIfAborted();
  const values=this.pendingInsights.get(run.id)??[];await this.backgrounds.commit(values,run.event.accountId!,run.background!.authorityRevision,this.now(),new Map(run.background!.sourceGrants.map(r=>[resourceKey(r),r.revision])));
  this.pendingInsights.delete(run.id);run.background!.insightIds=(await this.backgrounds.all()).filter(i=>values.some(v=>v.revisionIdentity===i.revisionIdentity)).map(i=>i.id).slice(0,60);
 }
 async situationChanged(){
  const accountId=(await this.google.state()).activeAccountId,view=await this.situation?.snapshot().catch(()=>undefined),evidence=situationEvidence(view,accountId,this.now());
  const refs=new Map(evidence.entries.map(e=>[resourceKey(e.ref),e.ref.revision]));
  const sources=(await this.backgrounds.all()).filter(i=>i.accountId===accountId&&i.status==='active').flatMap(i=>i.sources).filter(r=>r.module==='situation');
  for(const type of ['weather','traffic','aircraft'])await this.backgrounds.sourceRefresh(type,accountId,sources.filter(r=>r.type===type).map(r=>({id:r.id,revision:refs.get(resourceKey(r))??'unavailable'})),this.now());
  await this.scopeChanged();
 }
 async scopeChanged(){this.schedulingAuthorityEpoch++;const run=this.active?(await this.runs()).find(r=>r.id===this.active!.id):undefined;if(run?.background&&await this.situationAuthority((await this.storage.get()).values,await this.state(),await this.google.state())!==run.background.authorityRevision)this.cancel(run.id);await this.publish();}
 async sourceRefresh(type:string,accountId:string|null,revisions:{id:string;revision:string}[]){
  await this.backgrounds.sourceRefresh(type,accountId,revisions,this.now());let changed=false;
  for(const run of (await this.runs()).filter(r=>r.background&&r.event.accountId===accountId&&['queued','running'].includes(r.status))){
   if(!run.background!.sourceGrants.some(r=>r.type===type&&revisions.some(v=>v.id===r.id&&v.revision!==r.revision)))continue;changed=true;
   if(run.status==='running')this.cancel(run.id);else{run.status='cancelled';run.error='Superseded by a newer source revision.';run.finishedAt=new Date(this.now()).toISOString();await this.save(run);}
  }
  await this.publish();if(changed)void this.idle().then(()=>this.requestBackground('revision'));else void this.requestBackground('source-refresh');
 }
 async tick(includeBackground=true){if(this.closed)return;await this.inspectProactive();if(includeBackground)await this.requestBackground('schedule');const now=this.now();if(now-this.lastTick<30000)return;this.lastTick=now;if(now-this.lastPrune>=86400000){await this.storage.agent('prune',now);this.lastPrune=now;await this.publish();}const state=await this.state();if(!state.config.enabled||state.config.paused)return;
  for(const p of state.policies.filter(p=>p.enabled&&p.family==='briefing'&&p.schedule.enabled)){
   if(p.accountId!==(await this.google.state()).activeAccountId||!scheduledWindow(p,await this.runs(),now).eligible)continue;
   const work=this.commandQueue.then(async()=>{const current=await this.state(),policy=current.policies.find(v=>v.id===p.id);if(!current.config.enabled||current.config.paused||!policy?.enabled||!policy.schedule.enabled||policy.accountId!==(await this.google.state()).activeAccountId||!scheduledWindow(policy,await this.runs(),this.now()).eligible)return;const previous=await this.briefings.get(p.accountId);if(previous?.scheduleReceipt?.policyId===policy.id&&previous.scheduleReceipt.date===dateInZone(new Date(this.now()),policy.schedule.timezone))return;await this.dailyBriefing(true,true,'schedule');});this.commandQueue=work.catch(()=>{});
   try{await work;}catch{/* Disabled/disconnected accounts are not silently retried with another identity. */}
  }
 }
 command(raw:AgentCommand):Promise<AgentSnapshot>{const command=agentCommandSchema.parse(raw);if(command.action==='snapshot')return this.snapshot();if(command.action==='checkBriefing')return this.snapshot(true);if(command.action==='cancel')this.cancel(command.id);const result=this.commandQueue.then(()=>this.mutate(command));this.commandQueue=result.catch(()=>{});return result;}
 private async mutate(command:AgentCommand):Promise<AgentSnapshot>{
  if(command.action==='watchWork'){const old=agentRunSchema.parse(await this.storage.agent('get',command.id));await this.account(old.event.accountId);const next=approveProactive(old,command,await this.state(),(await this.storage.get()).values,this.now());await this.storage.agent('proactiveUpdate',{expected:old,next});void this.observeNative(taskEvents((await this.storage.workspace()).tasks,old.event.accountId,this.now()));await this.publish();return this.snapshot(true);}
  if(command.action==='cancel'){const run=await this.storage.agent('get',command.id) as AgentRun|null;if(run?.desktopResponsibility?.proactive)return this.mutate({action:'changeDesktopResponsibility',id:run.id,expectedRevision:run.desktopResponsibility.revision,change:'cancel'});}

  if(command.action==='createDesktopResponsibility'){
   const task=(await this.storage.workspace()).tasks.find(t=>t.id===command.taskId);if(!task)throw new AppError('unavailable','Select an existing local task.');
   await this.account(task.accountId??null);
   await this.storage.agent('enqueue',desktopResponsibility(command,task,await this.state(),(await this.storage.get()).values,this.now()));
   await this.publish();return this.snapshot(true);
  }
  if(command.action==='changeDesktopResponsibility'){
   const raw=await this.storage.agent('get',command.id);if(!raw)throw new AppError('unavailable','Responsibility unavailable.');const run=agentRunSchema.parse(raw);
   await this.account(run.event.accountId);
   if(run.desktopResponsibility?.proactive){
    const next=structuredClone(run),r=next.desktopResponsibility!,p=r.proactive!;if(r.revision!==command.expectedRevision)throw new AppError('conflict','Responsibility changed. Refresh first.');if(['cancelled','completed','expired'].includes(r.status))throw new AppError('permission_denied','This responsibility is closed.');
    if(command.change==='resume'){const reason=proactivePermitted(next,await this.state(),(await this.storage.get()).values,run.event.accountId,this.now());if(reason)throw new AppError('permission_denied',reason);if(next.localDraftId||next.calendarProposalId||next.executive?.proposals?.length&&next.executive.state!=='completed')throw new AppError('conflict','Review the existing proposed actions before resuming.');p.paused=false;r.status='waiting';p.waitingReason='Watching for the next meaningful change. Earlier events are not replayed.';next.status='complete';next.error=null;r.lastResumedAt=new Date(this.now()).toISOString();if(next.executive){next.executive.state='waiting';next.executive.nextStep=p.waitingReason;next.executive.revision++;}}
    else if(command.change==='pause'){p.paused=true;p.waitingReason='Paused by you. Events will not wake Mo. Existing proposals still require review.';if(!next.executive||['working','assigned','ready-for-mo','completed','waiting'].includes(next.executive.state)){r.status='waiting';next.status='complete';if(next.executive){next.executive.state='waiting';next.executive.nextStep=p.waitingReason;next.executive.revision++;}}}
    else{r.status=command.change==='cancel'?'cancelled':'completed';next.status=command.change==='cancel'?'cancelled':'complete';p.waitingReason=command.change==='cancel'?'Tracking cancelled by you.':'Responsibility closed by you; action outcomes remain separately recorded.';if(next.executive){next.executive.state=command.change==='cancel'?'cancelled':'completed';next.executive.nextStep=p.waitingReason;next.executive.revision++;}}
    p.pending=null;r.revision++;next.checkpoint=p.waitingReason.slice(0,100);await this.storage.agent('proactiveUpdate',{expected:run,next});if(run.executive)this.moAssistant?.cancel(run.executive.assistantRunId);await this.publish();return this.snapshot(true);
   }
   await this.storage.agent('desktopResponsibilityChange',{...command,now:this.now()});await this.publish();return this.snapshot(true);
  }
  if(command.action==='handleWork'){
   const run=agentRunSchema.parse(await this.storage.agent('get',command.id));await this.account(run.event.accountId);
   // Existing claims and outcomes are reopened, never replayed, even after restart.
   if(run.executive||run.scheduling||run.responsibility||run.desktopResponsibility||['queued','running'].includes(run.status)||run.localDraftId||run.calendarProposalId||run.proposals.some(p=>p.status==='pending'))return this.snapshot(true);
   if(!this.moAssistant)throw new AppError('unavailable','Mo work control is unavailable.');
   const refs=workSource(run),state=await this.state(),settings=(await this.storage.get()).values;
   if(!refs.length||run.workControl?.closedAs||run.status==='cancelled')throw new AppError('permission_denied','This work is closed or its source is unavailable.');
   if(refs.some(r=>r.accountId!==run.event.accountId||settings.disabledModules.includes(r.module)))throw new AppError('permission_denied','The original source account or workspace is unavailable.');
   const google=refs.some(r=>r.connector==='google'),local=refs.some(r=>r.connector==='local'),weather=refs.some(r=>r.type==='weather');
   if(google&&!state.config.shareGoogle||local&&!state.config.shareTasks||weather)throw new AppError('permission_denied','Review the selected source sharing permissions before assigning this work.');
   const mail=refs.filter(r=>r.type==='email');
   await this.moAssistant.start({id:run.id,conversationId:run.id,workId:run.id,mode:'chat',prompt:'Handle this selected attention. Inspect its exact source, choose only the specialists needed, and prepare a useful next step. Ask me when context is missing. No external action is authorized.',accountId:run.event.accountId,includeGoogle:google,includeLocal:state.config.shareTasks,...(mail.length===1?{messageId:mail[0].id}:{})},run.id);
   await this.publish();return this.snapshot(true);
  }
  if(command.action==='workDisposition'){const run=agentRunSchema.parse(await this.storage.agent('get',command.id));await this.account(run.event.accountId);await this.storage.agent('workDisposition',{...command,now:this.now()});await this.publish();return this.snapshot(true);}
  if(command.action==='refreshIntelligence'){await this.startBackground('manual',command.providerCalls);return this.snapshot(true);}
  if(command.action==='insightDisposition'){const accountId=(await this.google.state()).activeAccountId;if(!accountId)throw new AppError('permission_denied','Select the original account.');await this.backgrounds.disposition(command.id,accountId,command.status,this.now());await this.publish();return this.snapshot(true);}
  if(command.action==='dailyBriefing'){await this.dailyBriefing(command.refresh,command.synthesize,'manual');return this.snapshot(true);}
  if(command.action==='previewBudgetBoundary')return {...await this.snapshot(true),budgetPreview:await this.storage.agent('previewBudgetBoundary') as NonNullable<AgentSnapshot['budgetPreview']>};
  if(command.action==='applyBudgetBoundary'){await this.storage.agent('applyBudgetBoundary',command.preview);await this.publish();return this.snapshot(true);}
  if(command.action==='archiveActivity'||command.action==='restoreActivity'){await this.account(command.accountId);await this.storage.agent(command.action,command.action==='archiveActivity'?{accountId:command.accountId,ids:command.ids}:command.accountId);await this.publish();return this.snapshot(true);}
  if(command.action==='start'){await this.start(command.event);return this.snapshot();}const state=await this.state();
  if(command.action==='config'){if(state.revision!==command.expectedRevision)throw new AppError('conflict','Refresh workflow settings first.');this.cancel();state.config=command.config;await this.saveState(state);if(!state.config.paused)this.kick();return this.snapshot();}
  if(command.action==='policy'){if(state.revision!==command.expectedRevision)throw new AppError('conflict','Refresh workflows first.');validatePolicy(command.policy);const previous=state.policies.find(p=>p.id===command.policy.id);if(previous&&(previous.accountId!==command.policy.accountId||previous.family!==command.policy.family))throw new AppError('permission_denied','A workflow cannot change account scope.');if(state.policies.some(p=>p.id!==command.policy.id&&p.accountId===command.policy.accountId&&p.family===command.policy.family))throw new AppError('conflict','This account workflow already exists.');this.cancel();state.policies=state.policies.filter(p=>p.id!==command.policy.id);state.policies.push({...command.policy,version:(previous?.version??0)+1,updatedAt:new Date(this.now()).toISOString()});await this.saveState(state);return this.snapshot();}
  if(command.action==='checkScheduling'){await this.checkScheduling(command.id);return this.snapshot();}
  if(command.action==='replanScheduling'){await this.replanScheduling(command.id,command.confirmed);return this.snapshot();}
  if(command.action==='useReplannedReply'){await this.useReplannedReply(command.id);return this.snapshot();}
  if(command.action==='prepareSchedulingCalendar'){await this.prepareSchedulingCalendar(command.id,command.candidateId);return this.snapshot();}
  if(command.action==='completeScheduling'){const run=await this.schedulingRun(command.id);await this.schedulingPermission(run);if(['queued','running'].includes(run.status))throw new AppError('conflict','Wait for scheduling work to finish.');run.scheduling!.followUp={state:'completed',detail:'Marked complete by the owner. External outcomes remain separately recorded.',checkedAt:new Date(this.now()).toISOString()};run.checkpoint='Workflow completed by owner';await this.save(run);return this.snapshot();}
  if(command.action==='continueScheduling'){await this.continueScheduling(command.id,command.confirmed);return this.snapshot();}
  if(command.action==='retryScheduling'){const run=(await this.runs()).find(r=>r.id===command.id);if(!run?.scheduling||run.localDraftId||['queued','running'].includes(run.status))throw new AppError('conflict','Only an unfinished scheduling proposal without a saved draft can be retried.');await this.authority(run);await this.revalidateScheduling(run);this.cancelledScheduling.delete(run.id);run.status='queued';run.finishedAt=null;run.error=null;run.result=null;run.scheduling.phase='understanding';run.checkpoint='Owner requested scheduling retry';for(const w of run.team!.items)w.status='queued';await this.save(run);this.kick();return this.snapshot();}
  if(command.action==='cancel'){const selected=await this.storage.agent('get',command.id) as AgentRun|null;if(selected?.executive){await this.account(selected.event.accountId);await this.storage.agent('cancelExecutive',selected.id);this.moAssistant?.cancel(selected.executive.assistantRunId);await this.publish();return this.snapshot(true);}const durable=await this.storage.agent('get',command.id) as AgentRun|null;if(durable?.responsibility){await this.storage.agent('relayChange',{id:command.id,revision:durable.responsibility.continuationRevision,action:'cancel',now:this.now()});await this.publish();return this.snapshot();}const run=(await this.runs()).find(r=>r.id===command.id&&(r.status==='queued'||r.scheduling&&r.status!=='running'));if(run){if(run.scheduling)run.scheduling.phase='cancelled';run.status='cancelled';run.finishedAt=new Date(this.now()).toISOString();await this.save(run);}return this.snapshot();}
  if(command.action==='reviseLocal'){const run=(await this.runs()).find(r=>r.proposals.some(p=>p.id===command.id));const p=run?.proposals.find(p=>p.id===command.id);if(!run||!p||p.status!=='pending'||p.hash!==command.hash||p.expiresAt<=new Date(this.now()).toISOString())throw new AppError('conflict','The reminder proposal changed or expired.');await this.authority(run);p.draft=command.draft;p.hash=proposalHash(p);await this.save(run);return this.snapshot();}
  if(command.action==='approveLocal'||command.action==='denyLocal'){const run=(await this.runs()).find(r=>r.proposals.some(p=>p.id===command.id));const p=run?.proposals.find(p=>p.id===command.id);if(!run||!p)throw new AppError('invalid_input','Reminder proposal is unavailable.');if(command.action==='approveLocal'){if(command.hash!==p.hash)throw new AppError('permission_denied','The reviewed reminder changed.');await this.applyLocal(run,p,'explicit');}else{if(p.status!=='pending')throw new AppError('conflict','This reminder was already handled.');p.status='denied';await this.save(run);}return this.snapshot();}
  if(command.action==='feedback'){
   const run=(await this.runs()).find(r=>r.id===command.runId);const source=run?.context.items.find(s=>s.id===command.sourceId);if(!run||!source||source.kind!=='email'||(!source.senderScope&&!['dismissed','resolved'].includes(command.kind)))throw new AppError('invalid_input','Choose an email with an identifiable sender.');await this.account(source.accountId);
   if(command.kind==='priority'&&!['high','normal'].includes(command.value))throw new AppError('invalid_input','Choose high or normal priority.');
   state.feedback.push({id:randomUUID(),runId:run.id,sourceId:source.id,accountId:source.accountId,scope:source.senderScope??hash({account:source.accountId,resource:source.resourceId}),resourceId:source.resourceId,threadId:source.threadId??source.resourceId,createdAt:new Date(this.now()).toISOString(),kind:command.kind,strength:command.kind==='dismissed'?'implicit':'explicit',value:command.value,baseline:run.decision?.priority??'unknown',sourceRevision:source.revision,valid:true});
   if(['dismissed','resolved','priority'].includes(command.kind)){
    if(['queued','running'].includes(run.status))throw new AppError('conflict','Wait for this assessment to finish.');
    const previous=assessmentState(run,state.feedback);run.assessment={...previous,...(command.kind==='priority'?{priority:command.value as 'high'|'normal'}:{status:command.kind as 'dismissed'|'resolved'})};
    await this.storage.agent('recordAssessment',{state:{...state,revision:state.revision+1},run});await this.publish();
   }else await this.saveState(state);return this.snapshot();
  }
  if(command.action==='candidate'){const f=state.feedback.find(f=>f.id===command.feedbackId);if(!f)throw new AppError('invalid_input','Feedback is unavailable.');state.candidates.push(proposeCandidate(state,f,this.now()));}
  else if(command.action==='evaluate'){const index=state.candidates.findIndex(c=>c.id===command.id);if(index<0)throw new AppError('invalid_input','Candidate not found.');state.candidates[index]=evaluateCandidate(state.candidates[index],state,this.now());}
  else if(command.action==='activate'){activateCandidate(state,command.id,this.now());}
  else if(command.action==='rollback'){rollbackCandidate(state,command.id);}
  else if(command.action==='reject'){const c=state.candidates.find(c=>c.id===command.id);if(!c||c.status==='active')throw new AppError('conflict','Roll back an active version before rejecting it.');c.status='rejected';}
  else if(command.action==='forgetRun'){this.cancel(command.id);await this.storage.agent('forget',command.id);await this.publish();return this.snapshot();}
  else if(command.action==='forgetLearning'){state.feedback=[];state.candidates=[];}
  else if(command.action==='grant'){if(command.grant.status!=='proposed'||command.grant.uses!==0||command.grant.expiresAt<=command.grant.notBefore)throw new AppError('permission_denied','External grants can only be proposed, with a valid expiry, in this build.');if(state.grants.some(g=>g.id===command.grant.id))throw new AppError('conflict','Grant ID already exists.');state.grants.push({...command.grant,version:1,createdAt:new Date(this.now()).toISOString()});}
  else if(command.action==='revokeGrant'){const grant=state.grants.find(g=>g.id===command.id);if(!grant)throw new AppError('invalid_input','Grant not found.');grant.status='revoked';grant.version++;this.cancel();}
  else if(command.action==='exportLearning'||command.action==='snapshot')return this.snapshot();
  this.cancel();await this.saveState(state);return this.snapshot();
 }
}
