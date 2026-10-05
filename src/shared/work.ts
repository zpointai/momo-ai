import type { AgentSnapshot,AgentRun } from './orchestration';
import type { AssistantWorkspace } from './assistant';
import { assessmentState,currentAssessments } from './assessment';
import { ownerWork,type OwnerWorkState } from './executive-work';
import { roleNames } from './agent-team';
import type { ResourceRef } from './modules';

export const workGroups=['Needs you','Mo is working','Waiting','Recently completed'] as const;
export function workGroup(state:OwnerWorkState):typeof workGroups[number]{
 return ['needs-owner','prepared','approval-required','blocked','failed'].includes(state)?'Needs you':['ready-for-mo','assigned','working'].includes(state)?'Mo is working':['waiting','stale'].includes(state)?'Waiting':'Recently completed';
}
export function workSource(run:AgentRun):ResourceRef[]{
 const context=run.executiveOrigin?.context??run.context;
 return context.items.map(s=>s.delivery?.ref??({module:s.kind==='email'?'inbox':s.kind==='workflow'?'dashboard':'planner',connector:s.kind==='email'||s.kind==='calendar'?'google':'local',type:s.kind==='workflow'?'briefing':s.kind==='email'?'email':s.kind==='calendar'?'calendar':'task',id:s.resourceId,accountId:s.accountId,profile:'local',revision:s.revision,label:s.title,provenance:{kind:'workflow',runId:run.id,fetchedAt:s.fetchedAt},access:'read',retention:{kind:'retained',expiresAt:null}} as ResourceRef));
}
export function workProvenance(run:AgentRun){
 const explicitlyCreated=!!run.desktopResponsibility&&!run.desktopResponsibility.proactive?.attachedToExistingWork,background=run.background,role=run.team?.items.find(w=>w.parentWorkItemId)?.role;
 return {createdBy:explicitlyCreated?'You':background?'MoMo background intelligence':run.event.family==='email'?'Inbox Mo':role?roleNames[role]:'Mo',origin:explicitlyCreated?'Explicitly approved responsibility':background?`${background.trigger} check`:run.event.origin==='user'?'Owner-requested workflow':`${run.event.origin} workflow`,at:run.createdAt,ownerSaved:explicitlyCreated};
}
/** Both Dashboard and Work consume these exact root projections; no persisted grouping. */
export function workItems(data:AgentSnapshot,workspace:AssistantWorkspace,accountId:string|null,now=Date.now()){
 const assessments=new Set(currentAssessments(data.runs,accountId).map(r=>r.id));
 return data.runs.filter(r=>r.event.accountId===accountId).map(run=>{
  const observations=(data.background?.insights??[]).filter(i=>i.runId===run.id&&i.accountId===accountId);
  const live=observations.filter(i=>i.status==='active'&&i.ownerAttention&&(i.expiresAt===null||Date.parse(i.expiresAt)>now));
  const assessment=assessmentState(run,data.state.feedback);
  const candidate=assessments.has(run.id)&&!!run.decision&&assessment.status==='active'&&assessment.priority!=='normal';
  const assistant=workspace.runs.find(r=>r.id===run.executive?.assistantRunId);
  const view=ownerWork(run,undefined,{attention:candidate||live.length>0,assessment,now});
  const group=run.desktopResponsibility?.proactive&&view.state==='stale'?'Needs you':workGroup(view.state),sources=workSource(run);
  const title=run.desktopResponsibility?.objective??run.responsibility?.objective??(run.event.family==='email'?sources.find(r=>r.type==='email')?.label:undefined)??(live.length===1?live[0].title:live.length>1?`${live.length} observations to review`:run.executiveOrigin?'Handle the selected attention':run.event.prompt||'Review native work');
  const reason=live.map(i=>i.summary).join(' ')||(candidate?(assessment.priority==='high'?'Inbox Mo identified this message as high priority.':'Inbox Mo could not establish a priority. Your review is needed.'):'This work was requested from its source or workflow.');
  const closed=!!run.workControl?.closedAs,snoozed=!!run.workControl?.snoozedUntil&&Date.parse(run.workControl.snoozedUntil)>now;
  const attention=!closed&&!snoozed&&(run.executive||run.desktopResponsibility?.proactive?group==='Needs you'||view.state==='stale':candidate||live.length>0||group==='Needs you');
  const eligible=!run.executive&&!run.scheduling&&!run.responsibility&&!run.desktopResponsibility&&!['queued','running','cancelled'].includes(run.status)&&!run.localDraftId&&!run.calendarProposalId&&!run.proposals.some(p=>p.status==='pending')&&sources.length>0&&!sources.some(s=>s.type==='weather')&&!closed;
  return {run,view,group,title,reason,sources,assistant,observations,provenance:workProvenance(run),attention,eligible};
 }).sort((a,b)=>Date.parse(b.run.createdAt)-Date.parse(a.run.createdAt));
}
export type WorkItemView=ReturnType<typeof workItems>[number];
