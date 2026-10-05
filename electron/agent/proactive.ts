/** Deterministic event filtering and responsibility edits. No timer, model or store. */
import {randomUUID} from 'node:crypto';
import type {AgentRun,AgentState,AgentCommand} from '../../src/shared/orchestration';
import type {Settings} from '../../src/shared/contracts';
import type {InboxData,CalendarData} from '../../src/shared/google';
import {dateInZone} from '../../src/shared/google';
import type {LocalTask} from '../../src/shared/assistant';
import type {ResourceRef} from '../../src/shared/modules';
import type {ProactiveTrigger,ProactiveScope} from '../../src/shared/proactive';
import {workSource} from '../../src/shared/work';
import {hash} from './catalogue';
import {AppError} from '../errors';

export type NativeWorkEvent={accountId:string|null;type:'email'|'calendar'|'calendarRange'|'task'|'weather';resourceId:string;revision:string;at:string;expiresAt:string;trigger:ProactiveTrigger;detail:string;removed?:boolean;threadId?:string;receivedAt?:string;endDate?:string;timezone?:string};
export const nativeSourceKey=(r:Pick<ResourceRef,'type'|'id'>)=>r.type+':'+r.id;
export const nativeEventKey=(e:NativeWorkEvent)=>e.type+':'+e.resourceId;
export const proactiveAuthority=(state:AgentState,settings:Settings)=>hash({revision:state.revision,modules:settings.disabledModules,timezone:settings.timezone,budgets:settings.contextBudgets,model:settings.executiveModel});
export function inboxEvents(data:InboxData):NativeWorkEvent[]{return data.messages.map(m=>({accountId:data.accountId,type:'email',resourceId:m.id,threadId:m.threadId,receivedAt:m.receivedAt,revision:hash([m.subject,m.from,m.to,m.snippet,m.receivedAt,m.threadId]),at:data.fetchedAt,expiresAt:new Date(Date.parse(data.fetchedAt)+300000).toISOString(),trigger:'source-change',detail:'The linked email or thread changed. Only the returned Inbox sample was checked.'}));}
export function calendarEvents(data:CalendarData):NativeWorkEvent[]{
 const semantic=(e:CalendarData['events'][number])=>[e.id,e.title,e.time,e.location,e.status,e.recurringEventId,e.originalStart];
 const common={accountId:data.accountId,at:data.fetchedAt,expiresAt:new Date(Date.parse(data.fetchedAt)+300000).toISOString(),trigger:'source-change' as const};
 return [...data.events.map(e=>({...common,type:'calendar' as const,resourceId:e.id,revision:hash(semantic(e)),detail:'The linked calendar event changed.'})),...data.truncated||data.skipped?[]:[{...common,type:'calendarRange' as const,resourceId:data.startDate,endDate:data.endDate,timezone:data.timezone,revision:hash([data.startDate,data.endDate,data.timezone,data.events.map(semantic).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))]),detail:'The approved calendar range changed.'}]];
}
export function taskEvents(tasks:LocalTask[],accountId:string|null,now:number):NativeWorkEvent[]{return tasks.filter(t=>(t.accountId??null)===accountId).map(t=>{
 const due=t.status==='open'&&(t.due.kind==='instant'?Date.parse(t.due.at)<=now:t.due.kind==='date'?t.due.date<=dateInZone(new Date(now),t.due.timezone):false);
 return {accountId,type:'task',resourceId:t.id,revision:hash([t.title,t.status,t.due,due]),at:new Date(now).toISOString(),expiresAt:new Date(now+300000).toISOString(),trigger:t.status==='done'?'task-completed':due?'task-due':'source-change',detail:t.status==='done'?'The linked local task has a native completed record.':due?'The linked local task is now due.':'The linked task title, due date or status changed.'};
});}
export function approveProactive(old:AgentRun,command:Extract<AgentCommand,{action:'watchWork'}>,state:AgentState,settings:Settings,now:number):AgentRun{
 if((old.desktopResponsibility?.revision??old.executive?.revision??old.profileRevision)!==command.expectedRevision)throw new AppError('conflict','Work changed. Review its current scope.');
 if(old.scheduling||old.responsibility||old.workControl?.closedAs||['queued','running','cancelled'].includes(old.status)||old.localDraftId||old.calendarProposalId||old.proposals.some(p=>p.status==='pending')||old.executive?.proposals?.length&&old.executive.state!=='completed')throw new AppError('conflict','Resolve active work or its exact proposals before approving event triggers.');
 if(old.desktopResponsibility&&['cancelled','completed','expired'].includes(old.desktopResponsibility.status))throw new AppError('permission_denied','A closed responsibility cannot be revived.');
 const resources=old.desktopResponsibility?.proactive?.resources??(old.desktopResponsibility?[old.desktopResponsibility.resource]:workSource(old));
 if(!resources.length||resources.length>8||resources.some(r=>!['email','calendar','calendarRange','task'].includes(r.type)||r.profile!=='local'||r.accountId!==old.event.accountId))throw new AppError('permission_denied','Review a work item with bounded Inbox, Calendar or local task sources. Weather and Relay keep their existing native controls.');
 if(command.triggers.some(t=>t!=='source-change'&&!resources.some(r=>r.type==='task')))throw new AppError('invalid_input','Task triggers require a linked task.');
 const policy=state.policies.find(p=>p.family==='chat'&&p.accountId===old.event.accountId&&p.enabled&&['L1','L2'].includes(p.level));
 if(!policy||!state.config.enabled||state.config.paused||!state.config.shareTasks||resources.some(r=>settings.disabledModules.includes(r.module)||r.connector==='google'&&!state.config.shareGoogle))throw new AppError('permission_denied','Enable preparation-level Mo and the existing source sharing grants first.');
 const expires=Date.parse(command.expiresAt),review=Date.parse(command.reviewAt);if(review<=now||review>expires||expires>now+30*86400000)throw new AppError('invalid_input','Choose a future review and expiry within 30 days.');
 const run=structuredClone(old),previous=old.desktopResponsibility?.proactive;
 const context=old.executiveOrigin?.context??old.context;
 const mailThreads=resources.filter(r=>r.type==='email').flatMap(ref=>{const item=context.items.find(i=>i.resourceId===ref.id);let threadId=item?.threadId;try{threadId??=JSON.parse(item?.text??'{}').threadId;}catch{/* Non-JSON source text carries no binding. */}return typeof threadId==='string'?[{sourceId:ref.id,threadId}]:[];});
 const calendarWindows=resources.filter(r=>r.type==='calendarRange'||r.type==='calendar').map(ref=>{const item=context.items.find(i=>i.delivery?.ref.id===ref.id||i.resourceId===ref.id||i.resourceId==='range:'+ref.id);let data:Record<string,unknown>={};try{data=JSON.parse(item?.text??'{}');}catch{/* Require an explicit date below. */}const startDate=ref.date??(ref.type==='calendarRange'?ref.id:undefined),endDate=data.endDate,timezone=ref.timezone??settings.timezone;if(!startDate||!/^\d{4}-\d{2}-\d{2}$/.test(startDate)||typeof endDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(endDate)||Date.parse(endDate)<=Date.parse(startDate)||Date.parse(endDate)-Date.parse(startDate)>31*86400000)throw new AppError('permission_denied','Refresh Calendar work with an explicit bounded range before approving triggers.');return {sourceId:ref.id,startDate,endDate,timezone};});
 run.desktopResponsibility={version:1,owner:'mo',conversationId:old.executive?.conversationId??old.desktopResponsibility?.conversationId??old.id,objective:old.desktopResponsibility?.objective??old.event.prompt,resource:resources[0],trigger:'native-event',reviewAt:command.reviewAt,expiresAt:command.expiresAt,revision:(old.desktopResponsibility?.revision??-1)+1,status:'waiting',lastResumedAt:null,specialistScope:[...new Set(resources.flatMap(r=>r.type==='email'?['inbox' as const,'context' as const,'review' as const]:['planner' as const,'context' as const,'review' as const]))],nextSafeStage:'owner-review',proactive:{attachedToExistingWork:previous?.attachedToExistingWork??!old.desktopResponsibility,approvedAt:new Date(now).toISOString(),mailThreads,calendarWindows,resources,triggers:[...new Set(command.triggers)],paused:false,authorityRevision:proactiveAuthority(state,settings),observations:previous?.observations??[],events:previous?.events??[],pending:null,lastWakeAt:previous?.lastWakeAt??null,waitingReason:'Waiting for a meaningful change in the approved sources. The first observation establishes a baseline.'}};
 run.checkpoint='Owner approved bounded native event triggers';run.error=null;run.status='complete';
 if(run.executive){run.executive.state='waiting';run.executive.nextStep=run.desktopResponsibility!.proactive!.waitingReason;run.executive.revision++;}
 return run;
}
export function holdProactive(run:AgentRun,reason:string,state:'blocked'|'stale'|'needs-owner'='blocked'){
 const r=run.desktopResponsibility!,p=r.proactive!;r.status='review';r.revision++;p.waitingReason=reason;p.pending=null;run.status='review';run.error=reason;run.checkpoint=reason.slice(0,100);
 if(run.executive){run.executive.state=state;run.executive.nextStep=reason;run.executive.revision++;}
}
export function proactivePermitted(run:AgentRun,state:AgentState,settings:Settings,accountId:string|null,now:number){
 const r=run.desktopResponsibility,p=r?.proactive;if(!r||!p||['completed','cancelled','expired'].includes(r.status)||run.status==='cancelled')return 'closed';
 if(now>=Date.parse(r.expiresAt))return 'Responsibility expired. No more events may wake Mo.';
 if(now>=Date.parse(r.reviewAt))return 'Responsibility review is due. Review its scope before continuing.';
 if(run.event.accountId!==accountId)return 'The approved account is no longer selected.';
 if(proactiveAuthority(state,settings)!==p.authorityRevision||!state.config.enabled||state.config.paused||!state.config.shareTasks||p.resources.some(ref=>settings.disabledModules.includes(ref.module)||ref.connector==='google'&&!state.config.shareGoogle))return 'Approved authority changed. Review source sharing and the responsibility scope.';
 return null;
}
export function correlateEvent(runs:AgentRun[],event:NativeWorkEvent){return runs.filter(r=>{const p=r.desktopResponsibility?.proactive;return r.event.accountId===event.accountId&&p&&!['cancelled','completed','expired'].includes(r.desktopResponsibility!.status)&&r.status!=='cancelled'&&(p.resources.some(ref=>nativeSourceKey(ref)===nativeEventKey(event))||event.type==='email'&&p.mailThreads.some(m=>m.threadId===event.threadId))&&(event.type!=='calendarRange'||p.calendarWindows.some(w=>w.sourceId===event.resourceId&&w.endDate===event.endDate&&w.timezone===event.timezone));});}
/** Mutates a cloned existing root. Event audit dispositions are not workflow states. */
export function filterProactive(run:AgentRun,event:NativeWorkEvent,all:AgentRun[],now:number):'ignore'|'save'|'wake'{
 const r=run.desktopResponsibility!,p=r.proactive!,key=nativeEventKey(event),previous=p.observations.find(o=>o.key===key),id=hash([run.id,key,event.revision,event.trigger]);
 if(Date.parse(event.at)>now+60000||Date.parse(event.expiresAt)<=now||previous&&Date.parse(event.at)<Date.parse(previous.at))return 'ignore';
 if(previous?.revision===event.revision||p.events.some(e=>e.id===id))return 'ignore';
 const entry:ProactiveScope['events'][number]={id,at:event.at,trigger:event.trigger,sourceKey:key,revision:event.revision,detail:event.detail,outcome:previous?'held':'baseline'};
 if(p.events.length>=64){holdProactive(run,'Event history reached its retained bound. Review this responsibility.');return 'save';}
 p.observations=[...p.observations.filter(o=>o.key!==key),{key,revision:event.revision,at:event.at}].slice(-24);p.events.push(entry);
 if(event.removed){holdProactive(run,'The approved source is no longer available. Review its source.','stale');return 'save';}
 const arrived=event.type==='email'&&!!event.threadId&&p.mailThreads.some(m=>m.threadId===event.threadId&&m.sourceId!==event.resourceId)&&Date.parse(event.receivedAt??'')>Date.parse(p.approvedAt);
 if(!previous&&!arrived&&event.trigger!=='task-completed')return 'save';
 if(event.trigger==='task-completed'&&p.resources.length===1&&p.resources[0].type==='task'){
  entry.outcome='completed';r.status='completed';r.revision++;p.pending=null;p.waitingReason='The linked task has a confirmed native completed record.';run.status='complete';run.finishedAt=new Date(now).toISOString();run.checkpoint=p.waitingReason;if(run.executive){run.executive.state='completed';run.executive.nextStep=p.waitingReason;run.executive.revision++;}return 'save';
 }
 if(!p.triggers.includes(event.trigger)||p.paused||r.status==='review')return 'save';
 if(correlateEvent(all,event).length!==1){holdProactive(run,'More than one approved objective matches this source. Choose which responsibility should handle it.','needs-owner');return 'save';}
 if(p.pending||run.status==='running'){
  entry.outcome='superseded';holdProactive(run,'The source changed while Mo was preparing work. The older result was superseded; review before resuming.','stale');return 'save';
 }
 if(run.localDraftId||run.calendarProposalId||run.proposals.some(p=>p.status==='pending')||run.executive&&['prepared','approval-required','needs-owner','blocked','failed','stale'].includes(run.executive.state)){holdProactive(run,'Review the existing proposal or decision before preparing more work.');return 'save';}
 const wakes=p.events.filter(e=>e.outcome==='wake'),recent=wakes.filter(e=>now-Date.parse(e.at)<86400000),global=all.flatMap(r=>r.desktopResponsibility?.proactive?.events??[]).filter(e=>e.outcome==='wake'&&now-Date.parse(e.at)<3600000);
 if(p.lastWakeAt&&now-Date.parse(p.lastWakeAt)<15*60000||recent.length>=4||global.length>=6||wakes.length>=12){holdProactive(run,'A meaningful change was retained. Mo reached the bounded wake limit; review before continuing.');return 'save';}
 const assistantRunId=randomUUID();entry.outcome='wake';entry.assistantRunId=assistantRunId;p.pending={id,assistantRunId,at:event.at,trigger:event.trigger,detail:event.detail};p.lastWakeAt=new Date(now).toISOString();p.waitingReason=event.detail;return 'wake';
}
