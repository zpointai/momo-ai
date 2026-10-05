import type { AgentRun } from './orchestration';
import type { AgentWorkItem } from './agent-team';
import type { ResourceRef } from './modules';

export type OwnerWorkState='needs-owner'|'ready-for-mo'|'assigned'|'working'|'waiting'|'prepared'|'approval-required'|'blocked'|'stale'|'completed'|'cancelled'|'failed';
export const workStateLabels:Record<OwnerWorkState,string>={'needs-owner':'Needs you','ready-for-mo':'Ready for Mo',assigned:'Assigned',working:'Working',waiting:'Waiting',prepared:'Prepared','approval-required':'Approval required',blocked:'Blocked',stale:'Stale',completed:'Completed',cancelled:'Cancelled',failed:'Failed'};
/** Owner-facing projection only. Existing records and exact action services remain authoritative. */
export function ownerWork(run:AgentRun,item:AgentWorkItem|undefined=run.team?.items[0],options:{attention?:boolean;assessment?:{status:string;priority:string};now?:number}={}){
  const responsibility=run.desktopResponsibility;
  let state:OwnerWorkState;
  if(run.status==='cancelled'||responsibility?.status==='cancelled')state='cancelled';
  else if(run.status==='interrupted')state='blocked';
  else if(responsibility)state=responsibility.status==='expired'||!['cancelled','completed'].includes(responsibility.status)&&Date.parse(responsibility.expiresAt)<=(options.now??Date.now())?'stale':responsibility.status==='completed'?'completed':responsibility.proactive&&run.executive&&run.executive.state!=='completed'?run.executive.state:responsibility.status==='review'?'needs-owner':'waiting';
  else if(run.workControl?.closedAs)state=run.workControl.closedAs==='not-relevant'?'cancelled':'completed';
  else if(run.workControl?.snoozedUntil&&Date.parse(run.workControl.snoozedUntil)>(options.now??Date.now()))state='waiting';
  else if(run.executive)state=run.executive.state;
  else if(run.responsibility)state=run.responsibility.status==='completed'?'completed':['cancelled','archived'].includes(run.responsibility.status)?'cancelled':run.responsibility.status==='expired'?'stale':run.responsibility.status==='needs-decision'?'needs-owner':['queued','processing'].includes(run.responsibility.status)?'working':'waiting';
  else if(run.scheduling)state=run.scheduling.followUp?.state==='completed'?'completed':run.scheduling.phase==='cancelled'?'cancelled':['queued','running'].includes(run.status)?'working':run.scheduling.followUp?.state==='waiting-recipient'?'waiting':run.scheduling.phase==='stale'||run.scheduling.draftStale?'stale':run.scheduling.followUp?.state==='action-approved'?'working':run.scheduling.phase==='awaiting-owner'?'approval-required':'needs-owner';

  else if(run.status==='queued')state=item?.parentWorkItemId?'assigned':'ready-for-mo';
  else if(run.status==='running')state='working';
  else if(run.proposals.some(p=>p.status==='pending'&&Date.parse(p.expiresAt)>(options.now??Date.now())))state='approval-required';
  else if(options.attention)state='needs-owner';
  else if(run.result?.clarification)state='needs-owner';

  else if(run.status==='failed')state=/stale|changed|expired/i.test(run.error??'')?'stale':'failed';
  else if(run.status==='budget_exhausted'||run.status==='partial')state='blocked';
  else if(run.proposals.some(p=>p.status==='pending'))state='approval-required';
  else if(run.status==='review')state=run.result?'prepared':'needs-owner';
  else state='completed';
  if(item?.parentWorkItemId){if(item.status==='running')state='working';else if(item.status==='queued')state='assigned';else if(item.status==='failed'||item.status==='timed-out')state='failed';else if(item.status==='held')state='blocked';else if(item.status==='complete')state='completed';}
  const owner:'owner'|'mo'|AgentWorkItem['role']=run.workControl?.closedAs||run.workControl?.snoozedUntil&&Date.parse(run.workControl.snoozedUntil)>(options.now??Date.now())?'owner':['needs-owner','approval-required','prepared','blocked','stale','failed'].includes(state)?'owner':item?.parentWorkItemId?item.role:'mo';
  const nextStep=run.workControl?.closedAs?(run.workControl.closedAs==='resolved-elsewhere'?'Closed by you as resolved elsewhere; Mo did not complete it':'Closed by you as not relevant'):run.workControl?.snoozedUntil&&Date.parse(run.workControl.snoozedUntil)>(options.now??Date.now())?'Returns to attention after '+new Date(run.workControl.snoozedUntil).toLocaleString():responsibility?.proactive?.waitingReason??run.executive?.nextStep??run.responsibility?.waitingReason??run.scheduling?.followUp?.detail??(responsibility?'Review or resume this responsibility':state==='approval-required'?'Review the exact proposed action':state==='needs-owner'?'Review this item or ask Mo to handle it':state==='waiting'?'Wait for the permitted trigger':state==='completed'||state==='cancelled'?'No further step':run.checkpoint);
  return {id:item?.id??run.id,rootRunId:run.id,objective:item?.objective??responsibility?.objective??run.event.prompt,createdBy:run.event.origin==='user'?'owner':'native',owner,state,label:run.workControl?.closedAs==='resolved-elsewhere'?'Resolved elsewhere':run.workControl?.closedAs==='not-relevant'?'Not relevant':workStateLabels[state],nextStep,blockers:[item?.reason,run.error,...item?.unresolvedQuestions??[]].filter((s):s is string=>!!s),sources:(item?.sources??run.context.items.flatMap(s=>s.delivery?[s.delivery.ref]:[])) as ResourceRef[],linkedActions:[...run.executive?.proposals??[],...run.proposals.map(p=>({id:p.id,kind:'task' as const})),...(run.localDraftId?[{id:run.localDraftId,kind:'reply' as const}]:[]),...(run.calendarProposalId?[{id:run.calendarProposalId,kind:'calendar' as const}]:[])],revision:responsibility?.revision??run.executive?.revision??run.profileRevision,freshness:run.context.createdAt};
}
