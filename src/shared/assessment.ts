import type { AgentFeedback,AgentRun } from './orchestration';

/** One projection of the retained assessment and its exact-source corrections. */
export function assessmentState(run:AgentRun,feedback:readonly AgentFeedback[]=[]){
 const source=(run.executiveOrigin?.context??run.context).items.find(s=>s.kind==='email'&&s.resourceId===run.event.resourceId);
 let status:'active'|'dismissed'|'resolved'='active',priority=run.decision?.priority??'unknown';
 for(const f of feedback){
  if(!f.valid||!source||f.runId!==run.id||f.accountId!==source.accountId||f.resourceId!==source.resourceId||f.sourceRevision!==source.revision)continue;
  if(f.kind==='dismissed'||f.kind==='resolved')status=f.kind;
  if(f.kind==='priority'&&(f.value==='high'||f.value==='normal'))priority=f.value;
 }
 return run.workControl?.closedAs?{status:run.workControl.closedAs==='not-relevant'?'dismissed' as const:'resolved' as const,priority}:run.assessment??{status,priority};
}
export function currentAssessments(runs:readonly AgentRun[],accountId:string|null){
 const latest=new Map<string,AgentRun>();
 for(const run of [...runs].sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))){
  if(run.event.family!=='email'||run.event.replyTo||run.scheduling||run.event.accountId!==accountId||!run.event.resourceId||latest.has(run.event.resourceId))continue;
  latest.set(run.event.resourceId,run);
 }
 return [...latest.values()];
}
