import { RelayReceipts, sameContinuation } from './relay-store';
import {activityArchives,archiveActivity,restoreActivity} from './presentation';
import {previewBudgetBoundary,applyBudgetBoundary} from './usage';
import type Database from 'better-sqlite3';
import { agentRunSchema,agentStateSchema,initialAgentState,type AgentRun,type AgentState } from '../../src/shared/orchestration';
import { reserveAgentUsage,usageSummary,costSummary,settleCost,dispatchEligibility,type UsageReservation } from './usage';
import { AppError } from '../errors';
import { finishTeam } from './team';
import { emptyWorkControl } from '../../src/shared/work-control';
import { createHash } from 'node:crypto';
function proposalId(key:string){const bytes=createHash('sha256').update(key).digest().subarray(0,16);bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;const h=bytes.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}
export class AgentRepository {
 private relay:RelayReceipts;
 constructor(private db:Database.Database){this.relay=new RelayReceipts(db);}
 state():AgentState {const row=this.db.prepare('SELECT payload FROM agent_state WHERE id=1').get() as {payload:string}|undefined;return row?agentStateSchema.parse(JSON.parse(row.payload)):initialAgentState();}
 saveState(raw:unknown){const next=agentStateSchema.parse(raw);return this.db.transaction(()=>{const current=this.state();if(next.revision!==current.revision+1)throw new AppError('conflict','Workflow settings changed. Refresh before trying again.');this.db.prepare('INSERT INTO agent_state VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(next));return next;})();}
 runs():AgentRun[]{return(this.db.prepare('SELECT payload FROM agent_runs ORDER BY created_at DESC,rowid DESC LIMIT 100').all() as {payload:string}[]).map(r=>agentRunSchema.parse(JSON.parse(r.payload)));}
 next():AgentRun|null{const row=this.db.prepare("SELECT payload FROM agent_runs WHERE json_extract(payload,'$.status')='queued' ORDER BY created_at,rowid LIMIT 1").get() as {payload:string}|undefined;return row?agentRunSchema.parse(JSON.parse(row.payload)):null;}
 localCount(accountId:string,family:string,at:string):number{return (this.db.prepare("SELECT COUNT(*) AS n FROM agent_runs r,json_each(r.payload,'$.proposals') p WHERE r.created_at>=? AND json_extract(r.payload,'$.event.accountId')=? AND json_extract(r.payload,'$.event.family')=? AND json_extract(p.value,'$.status')='applied' AND json_extract(p.value,'$.authorization')='L2'").get(at.slice(0,10),accountId,family) as {n:number}).n;}
 get(id:string):AgentRun|null{const row=this.db.prepare('SELECT payload FROM agent_runs WHERE id=?').get(id) as {payload:string}|undefined;return row?agentRunSchema.parse(JSON.parse(row.payload)):null;}
 enqueue(raw:unknown){const run=agentRunSchema.parse(raw);return this.db.transaction(()=>{
  const prior=this.get(run.id);if(prior){if(prior.dedup!==run.dedup)throw new AppError('conflict','Event ID was already used with different content.');return prior;}
  const receipt=this.db.prepare('SELECT run_id FROM agent_receipts WHERE dedup=?').get(run.dedup) as {run_id:string}|undefined;if(receipt){const previous=this.get(receipt.run_id);if(previous)return previous;throw new AppError('conflict','This event was previously handled. Its retained content is no longer available.');}
  const pending=(this.db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE json_extract(payload,'$.status') IN ('queued','running')").get() as {n:number}).n;if(pending>=25)throw new AppError('unavailable','Workflow queue is full.');
  this.db.prepare('INSERT INTO agent_runs VALUES (?, ?, ?)').run(run.id,run.createdAt,JSON.stringify(run));this.db.prepare('INSERT INTO agent_receipts VALUES (?, ?, ?)').run(run.dedup,run.id,run.createdAt);return run;
 })();}
 update(raw:unknown,assessmentChange=false){const run=agentRunSchema.parse(raw);const old=this.get(run.id);if(!old||old.dedup!==run.dedup||JSON.stringify(old.context)!==JSON.stringify(run.context)||JSON.stringify(old.event)!==JSON.stringify(run.event))throw new AppError('conflict','The immutable workflow context changed.');if(old.workControl?.revision!==run.workControl?.revision)throw new AppError('conflict','Owner work choices changed.');if(old.executive&&(old.executive.revision!==run.executive?.revision||old.status!=='running'&&old.status!==run.status))throw new AppError('conflict','Executive work changed. Late work cannot revive it.');if(old.responsibility&&(!sameContinuation(old,run)||['cancelled','expired','archived','completed'].includes(old.responsibility.status)&&old.responsibility.status!==run.responsibility?.status))throw new AppError('conflict','Relay authority changed. Late work cannot revive it.');if(old.desktopResponsibility&&(old.desktopResponsibility.revision!==run.desktopResponsibility?.revision||JSON.stringify(old.desktopResponsibility)!==JSON.stringify(run.desktopResponsibility)))throw new AppError('conflict','Desktop responsibility authority changed. Late work cannot revive it.');if(!assessmentChange)run.assessment=old.assessment;this.db.transaction(()=>{this.db.prepare('UPDATE agent_runs SET payload=? WHERE id=?').run(JSON.stringify(run),run.id);for(const c of run.calls)settleCost(this.db,c.id,{usage:c.usage,model:c.reportedModel,outcome:c.status==='complete'?run.status:c.status,dispatched:true,terminal:!['queued','running'].includes(run.status)});})();return run;}
 reserve(input:UsageReservation){return this.db.transaction(()=>{
  const run=this.get(input.runId);if(!run||run.status!=='running')throw new AppError('conflict','Workflow is no longer running.');
  return reserveAgentUsage(this.db,input);
 }).immediate();}
 forget(id:string){const run=this.get(id);if(run?.desktopResponsibility&&!['completed','cancelled','expired'].includes(run.desktopResponsibility.status)&&Date.parse(run.desktopResponsibility.expiresAt)>Date.now())throw new AppError('conflict','Close the desktop responsibility before deleting its record.');if(run?.responsibility&&!['cancelled','completed','expired','archived'].includes(run.responsibility.status))throw new AppError('conflict','Close or archive the active responsibility before forgetting its content.');this.db.prepare('DELETE FROM agent_runs WHERE id=?').run(id);const state=this.state();for(const f of state.feedback)if(f.runId===id)f.valid=false;this.invalidate(state);this.saveState({...state,revision:state.revision+1});}
 invalidate(state:AgentState){for(const candidate of state.candidates)if(candidate.evidenceIds.some(id=>!state.feedback.some(f=>f.id===id&&f.valid)))candidate.status='invalidated';}
 recover(){const rows=this.db.prepare("SELECT payload FROM agent_runs WHERE json_extract(payload,'$.status')='running'").all() as {payload:string}[];for(const row of rows){const run=agentRunSchema.parse(JSON.parse(row.payload));const recovered:AgentRun={...run,status:'interrupted',checkpoint:'Restart: review required',finishedAt:new Date().toISOString(),error:'MoMo stopped during processing. Reserved provider use may be unknown. No paid request or external action was replayed.',calls:run.calls.map(c=>c.status==='reserved'?{...c,status:'unknown'}:c)};if(recovered.responsibility){recovered.responsibility.status='needs-decision';recovered.responsibility.waitingReason='Interrupted; review required. No automatic replay.';recovered.responsibility.nextStage='owner-review';const receipt=recovered.responsibility.activeEventId?this.relay.get(recovered.responsibility.activeEventId):null;if(receipt){receipt.disposition='held';receipt.reason='interrupted';this.relay.put(receipt);}}finishTeam(recovered);this.update(recovered);}}
 prune(now:number){this.relay.prune(now);const cutoff=new Date(now-7*86400000).toISOString();const expired=this.db.prepare('SELECT id FROM agent_runs WHERE created_at<?').all(cutoff) as {id:string}[];for(const row of expired){const run=this.get(row.id);if(run?.executive&&(!['completed','cancelled'].includes(run.executive.state)||Date.parse(run.finishedAt??run.createdAt)>now-90*86400000))continue;if(run?.desktopResponsibility&&Date.parse(run.desktopResponsibility.expiresAt)>now-90*86400000)continue;if(run?.responsibility&&Date.parse(run.responsibility.expiresAt)>now-90*86400000)continue;if(run?.scheduling&&!['completed','cancelled'].includes(run.scheduling.followUp?.state??'')&&Date.parse(run.createdAt)>now-90*86400000)continue;this.forget(row.id);}const state=this.state();const previous=state.feedback.length;state.feedback=state.feedback.filter(f=>+new Date(f.createdAt)>now-90*86400000);if(previous!==state.feedback.length){this.invalidate(state);this.saveState({...state,revision:state.revision+1});}}
 execute(operation:string,input:unknown):unknown{
  if(operation==='proactiveUpdate')return this.db.transaction(()=>{
   const {expected,next}=input as {expected:AgentRun;next:AgentRun},old=this.get(expected.id),run=agentRunSchema.parse(next);
   if(!old||run.id!==old.id||JSON.stringify(old)!==JSON.stringify(expected)||run.dedup!==old.dedup||JSON.stringify(run.event)!==JSON.stringify(old.event)||JSON.stringify(run.context)!==JSON.stringify(old.context))throw new AppError('conflict','Work changed during native event filtering.');
   this.db.prepare('UPDATE agent_runs SET payload=? WHERE id=?').run(JSON.stringify(run),run.id);return run;
  }).immediate();
  if(operation==='cancelExecutive')return this.db.transaction(()=>{
   const run=this.get(String(input));if(!run?.executive)throw new AppError('unavailable','Executive work is unavailable.');
   if(['completed','cancelled'].includes(run.executive.state))return run;
   run.status='cancelled';run.executive.state='cancelled';run.executive.nextStep='Work cancelled. Existing exact-action records retain their own outcomes.';run.executive.revision++;run.finishedAt=new Date().toISOString();run.checkpoint='Work cancelled by owner';if(run.team)for(const item of run.team.items)if(['queued','running','held'].includes(item.status))item.status='cancelled';
   this.db.prepare('UPDATE agent_runs SET payload=? WHERE id=?').run(JSON.stringify(agentRunSchema.parse(run)),run.id);return run;
  }).immediate();
  if(operation==='projectExecutiveOutcomes')return this.db.transaction(()=>{
   for(const run of this.runs()){
    const e=run.executive;if(!e||!['prepared','approval-required','blocked'].includes(e.state)||!e.proposals?.length)continue;
    let complete=true,state:'prepared'|'approval-required'|'blocked'|'completed'='prepared',next='Review the prepared proposal in Work';
    for(const p of e.proposals){
     if(p.kind==='task-proposal'){if(!this.db.prepare('SELECT id FROM task_receipts WHERE id=? AND account_id IS ?').get(proposalId(p.id),run.event.accountId))complete=false;}
     else if(p.kind==='responsibility-proposal'){const responsibility=this.get(proposalId(p.id+':responsibility'));if(!responsibility||responsibility.event.accountId!==run.event.accountId)complete=false;}
     else{
      const id=proposalId(p.id+':reply'),row=this.db.prepare('SELECT payload FROM mail_drafts WHERE id=? AND account_id=?').get(id,run.event.accountId) as {payload:string}|undefined;
      if(!row){complete=false;continue;}
      run.localDraftId=id;
      const actions=(this.db.prepare('SELECT payload FROM mail_actions WHERE account_id=?').all(run.event.accountId) as {payload:string}[]).map(r=>JSON.parse(r.payload) as {draftId?:string;kind:string;status:string;createdAt:string}).filter(a=>a.draftId===id&&a.kind==='send').sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
      if(actions.some(a=>a.status==='succeeded'))continue;
      complete=false;state=actions.some(a=>['unknown','failed'].includes(a.status))?'blocked':'approval-required';next=state==='blocked'?'Inspect the linked mail action; its outcome is not confirmed':'Review the local reply in Inbox; sending requires separate exact approval';
     }
    }
    if(complete){state='completed';next='Reviewed proposals have confirmed local receipts or action outcomes';}
    if(e.state===state&&e.nextStep===next)continue;
    e.state=state;e.nextStep=next;e.revision++;run.status=state==='completed'?'complete':'review';run.checkpoint=next.slice(0,100);
    if(run.team)run.team.items[0].status=state==='completed'?'complete':'held';
    if(run.desktopResponsibility?.proactive){const r=run.desktopResponsibility;r.status=complete?'waiting':'review';r.revision++;r.proactive!.waitingReason=complete?'The reviewed actions have confirmed receipts. Waiting for the next approved change.':next;}
    this.db.prepare('UPDATE agent_runs SET payload=? WHERE id=?').run(JSON.stringify(agentRunSchema.parse(run)),run.id);
   }
   return this.runs();
  }).immediate();
  if(operation==='claimExecutive')return this.db.transaction(()=>{
   const v=input as {run:AgentRun;expected:AgentRun},run=agentRunSchema.parse(v.run),old=this.get(run.id);
   if(!old||old.executive&&!(old.desktopResponsibility?.proactive?.pending?.assistantRunId===run.executive?.assistantRunId||old.executive.state==='needs-owner'&&!old.executive.proposals?.length&&run.executive?.conversationId===old.executive.conversationId&&run.executive.revision===old.executive.revision+1)||JSON.stringify(old)!==JSON.stringify(v.expected)||run.dedup!==old.dedup||JSON.stringify(run.event)!==JSON.stringify(old.event)||JSON.stringify(run.calls)!==JSON.stringify(old.calls)||JSON.stringify(run.proposals)!==JSON.stringify(old.proposals)||!run.executiveOrigin||JSON.stringify(run.executiveOrigin.context)!==JSON.stringify(old.executiveOrigin?.context??old.context))throw new AppError('conflict','This root was already claimed or changed. Reopen the existing work.');
   this.db.prepare('UPDATE agent_runs SET payload=? WHERE id=?').run(JSON.stringify(run),run.id);return run;
  }).immediate();
  if(operation==='workDisposition')return this.db.transaction(()=>{
   const v=input as {id:string;expectedRevision:number;choice:'snooze'|'unsnooze'|'not-relevant'|'resolved-elsewhere';now:number},run=this.get(v.id);
   if(!run)throw new AppError('unavailable','This work is no longer retained.');
   const c=run.workControl??emptyWorkControl();if(c.revision!==v.expectedRevision)throw new AppError('conflict','Work changed. Refresh before choosing again.');
   if(['running','queued'].includes(run.status)||run.proposals.some(p=>p.status==='pending')||run.calendarProposalId||run.localDraftId||run.executive&&['prepared','approval-required','needs-owner'].includes(run.executive.state))throw new AppError('conflict','Review or cancel the active work and its exact proposals first.');
   if(run.desktopResponsibility?.proactive)throw new AppError('conflict','Use tracking pause or stop controls for this approved responsibility.');
   if(c.history.length>=100)throw new AppError('unavailable','The retained owner-choice history is full.');
   c.revision++;c.snoozedUntil=v.choice==='snooze'?new Date(v.now+86400000).toISOString():null;
   c.closedAs=v.choice==='not-relevant'||v.choice==='resolved-elsewhere'?v.choice:null;
   c.history.push({at:new Date(v.now).toISOString(),action:v.choice,detail:v.choice==='resolved-elsewhere'?'Owner reported resolution outside MoMo; no Mo action completion claimed.':v.choice==='snooze'?'Hidden from attention for 24 hours; no processing scheduled.':'Owner changed attention visibility.'});
   run.workControl=c;this.db.prepare('UPDATE agent_runs SET payload=? WHERE id=?').run(JSON.stringify(agentRunSchema.parse(run)),run.id);return run;
  }).immediate();
  if(operation==='executiveUpdate')return this.db.transaction(()=>{
   const v=input as {run:unknown;expectedRevision:number},next=agentRunSchema.parse(v.run),old=this.get(next.id);
   if(!old?.executive||!next.executive||old.status!=='running'||old.executive.revision!==v.expectedRevision||next.executive.revision!==v.expectedRevision+1||next.executive.assistantRunId!==old.executive.assistantRunId||next.executive.conversationId!==old.executive.conversationId||next.dedup!==old.dedup||JSON.stringify(next.event)!==JSON.stringify(old.event)||JSON.stringify(next.policy)!==JSON.stringify(old.policy)||JSON.stringify(next.config)!==JSON.stringify(old.config)||next.profileRevision!==old.profileRevision||JSON.stringify(next.calls)!==JSON.stringify(old.calls)||JSON.stringify(next.proposals)!==JSON.stringify(old.proposals)||JSON.stringify(next.result)!==JSON.stringify(old.result)||JSON.stringify(next.executiveOrigin)!==JSON.stringify(old.executiveOrigin)||next.localDraftId!==old.localDraftId||next.calendarProposalId!==old.calendarProposalId)throw new AppError('conflict','Executive work changed. A late result cannot restore it.');
   this.db.prepare('UPDATE agent_runs SET payload=? WHERE id=?').run(JSON.stringify(next),next.id);return next;
  })();
  if(operation==='desktopResponsibilityChange')return this.db.transaction(()=>{
   const v=input as {id:string;expectedRevision:number;change:'resume'|'pause'|'cancel'|'complete';now:number},run=this.get(v.id),r=run?.desktopResponsibility;
   if(!run||!r||r.revision!==v.expectedRevision)throw new AppError('conflict','Responsibility changed. Refresh before continuing.');
   if(['cancelled','completed','expired'].includes(r.status))throw new AppError('permission_denied','This responsibility is closed. It cannot be revived.');
   if(v.change==='pause')throw new AppError('invalid_input','Use the native event tracking controls to pause this responsibility.');
   if(v.change==='resume'){
    const state=this.state();if(state.config.paused||!state.config.enabled||!state.config.shareTasks||!state.policies.some(p=>p.id===run.policy.id&&p.version===run.policy.version&&p.enabled))throw new AppError('permission_denied','Responsibility permissions changed. Review Automations.');
    if(v.now>=Date.parse(r.reviewAt)||v.now>=Date.parse(r.expiresAt))throw new AppError('permission_denied','Responsibility review or expiry is due. Create a newly reviewed responsibility to continue.');
    r.status='review';r.lastResumedAt=new Date(v.now).toISOString();run.checkpoint='Responsibility resumed · owner review';
   }else{r.status=v.change==='cancel'?'cancelled':'completed';run.status=v.change==='cancel'?'cancelled':'complete';run.checkpoint='Responsibility '+r.status;}
   r.revision++;run.finishedAt=new Date(v.now).toISOString();this.db.prepare('UPDATE agent_runs SET payload=? WHERE id=?').run(JSON.stringify(agentRunSchema.parse(run)),run.id);return run;
  }).immediate();
  if(operation==='relayReserveDispatch'){const v=input as {id:string;approval:import('../../src/shared/relay').SmsApproval;now:number};return this.relay.reserveDispatch(v.id,v.approval,v.now);}
  if(operation==='relayValidateDispatch'){const v=input as {id:string;reservation:string;now:number};return this.relay.validateDispatch(v.id,v.reservation,v.now);}
  if(operation==='relayUpdateDispatch'){const v=input as {id:string;dispatch:import('../../src/shared/relay-transport').SmsDispatch};return this.relay.updateDispatch(v.id,v.dispatch);}
  if(operation==='relayRecoverDispatches'){this.relay.recoverDispatches();return null;}
  if(operation==='relayPrune'){this.relay.prune(Number(input));return null;}
  if(operation==='relaySnapshot')return this.relay.snapshot();
  if(operation==='relayGet')return this.relay.get(String(input));
  if(operation==='relayIntake'){const v=input as {event:unknown;now:number};return this.relay.intake(v.event,v.now);}
  if(operation==='relayChange'){const v=input as {id:string;revision:number;action:'cancel'|'complete'|'archive'|'wait';now:number};return this.relay.change(v.id,v.revision,v.action,v.now);}
  if(operation==='relayStage'){const v=input as {run:AgentRun;expected:AgentRun};return this.relay.stage(v.run,v.expected);}
  if(operation==='relayCommit'){const v=input as {run:AgentRun;receipt:import('../../src/shared/relay').RelayReceipt;now:number};return this.relay.commit(v.run,v.receipt,v.now);}
  if(operation==='relayPutReceipt')return this.relay.put(input as import('../../src/shared/relay').RelayReceipt);
  if(operation==='relayDraft'){const v=input as {id:string;action:'editDraft'|'reviewDraft'|'dismiss';now:number;body?:string;revision?:number};return this.relay.draftCommand(v.id,v.action,v.now,v.body,v.revision);}
  if(operation==='briefingActions')return ['mail_actions','calendar_actions'].flatMap(table=>(this.db.prepare('SELECT payload FROM '+table).all() as {payload:string}[]).map(row=>{const a=JSON.parse(row.payload);return{id:a.id,accountId:a.accountId??a.draft.accountId,kind:table==='mail_actions'?'Mail '+a.kind:a.tool==='calendar.update'?'Calendar update':'Calendar creation',title:table==='mail_actions'?'Mail action awaiting review':a.draft.title,status:a.status,revision:a.hash,createdAt:a.createdAt,expiresAt:a.expiresAt};}));
  if(operation==='activityArchives')return activityArchives(this.db);
  if(operation==='archiveActivity')return archiveActivity(this.db,input as Parameters<typeof archiveActivity>[1],new Date().toISOString());
  if(operation==='restoreActivity')return restoreActivity(this.db,input as string|null);
  if(operation==='previewBudgetBoundary')return previewBudgetBoundary(this.db);
  if(operation==='applyBudgetBoundary')return applyBudgetBoundary(this.db,input);
  if(operation==='recordAssessment')return this.db.transaction(()=>{const v=input as {state:AgentState;run:AgentRun};this.saveState(v.state);this.update(v.run,true);})();
  if(operation==='dispatchEligibility')return dispatchEligibility(this.db,input as UsageReservation);
  if(operation==='usage')return usageSummary(this.db);if(operation==='costs')return costSummary(this.db);
  if(operation==='projectScheduling')return this.db.transaction(()=>{
   const {run,expected}=input as {run:AgentRun;expected:AgentRun};const current=this.get(run.id);
   if(!current?.scheduling||JSON.stringify(current)!==JSON.stringify(expected))return current;
   const follow=run.scheduling?.followUp;if(follow&&follow.state!==current.scheduling.followUp?.state){run.checkpoint='Scheduling: '+follow.state.replaceAll('-',' ');if(run.steps.length<32)run.steps.push({at:follow.checkedAt,checkpoint:run.checkpoint,status:run.status});}
   return this.update(run);
  })();
  if(operation==='schedulingForThread'){const v=input as {accountId:string;threadId:string};const row=this.db.prepare("SELECT payload FROM agent_runs WHERE json_extract(payload,'$.event.accountId')=? AND json_extract(payload,'$.event.scheduling.threadId')=? AND json_extract(payload,'$.status')!='cancelled' AND coalesce(json_extract(payload,'$.scheduling.followUp.state'),'')!='completed' ORDER BY rowid DESC LIMIT 1").get(v.accountId,v.threadId) as {payload:string}|undefined;return row?agentRunSchema.parse(JSON.parse(row.payload)):null;}
  if(operation==='schedulingForSource'){
   const v=input as {accountId:string;resourceId:string;threadRevision:string};const row=this.db.prepare("SELECT payload FROM agent_runs WHERE json_extract(payload,'$.event.accountId')=? AND json_extract(payload,'$.event.resourceId')=? AND json_extract(payload,'$.event.scheduling.threadRevision')=? ORDER BY rowid DESC LIMIT 1").get(v.accountId,v.resourceId,v.threadRevision) as {payload:string}|undefined;return row?agentRunSchema.parse(JSON.parse(row.payload)):null;
  }
  if(operation==='reviseScheduling')return this.db.transaction(()=>{
   const {run:raw,expectedContextHash}=input as {run:unknown;expectedContextHash:string};const next=agentRunSchema.parse(raw),old=this.get(next.id);
   if(!old?.scheduling||!next.scheduling||old.context.hash!==expectedContextHash||old.localDraftId||this.db.prepare('SELECT id FROM mail_drafts WHERE id=?').get(old.id)||['queued','running'].includes(old.status)||next.dedup!==old.dedup||old.event.accountId!==next.event.accountId||old.event.resourceId!==next.event.resourceId||old.event.scheduling?.threadRevision!==next.event.scheduling?.threadRevision||old.event.scheduling?.threadId!==next.event.scheduling?.threadId||JSON.stringify(next.calls)!==JSON.stringify(old.calls)||next.event.family!=='email')throw new AppError('conflict','The scheduling task changed or already has a local draft. Reopen it before continuing.');
   this.db.prepare('UPDATE agent_runs SET payload=? WHERE id=?').run(JSON.stringify(next),next.id);return next;
  })();
  if(operation==='refreshScheduling')return this.db.transaction(()=>{
   const {run:raw,expectedContextHash,stage}=input as {run:unknown;expectedContextHash:string;stage:boolean};const next=agentRunSchema.parse(raw),old=this.get(next.id);
   if(!old?.scheduling||!next.scheduling||old.context.hash!==expectedContextHash||old.event.accountId!==next.event.accountId||old.event.scheduling?.threadId!==next.event.scheduling?.threadId||old.dedup!==next.dedup||JSON.stringify(old.calls)!==JSON.stringify(next.calls)||old.localDraftId!==next.localDraftId||stage&&(old.status!=='running'||next.status!=='running'||JSON.stringify(old.event)!==JSON.stringify(next.event))||!stage&&['queued','running'].includes(old.status)||next.scheduling.contextHistory.length>6)throw new AppError('conflict','The scheduling revision changed. Refresh before continuing.');
   this.db.prepare('UPDATE agent_runs SET payload=? WHERE id=?').run(JSON.stringify(next),next.id);return next;
  })();
  if(operation==='get')return this.get(String(input));if(operation==='next')return this.next();if(operation==='localCount'){const v=input as {accountId:string;family:string;at:string};return this.localCount(v.accountId,v.family,v.at);}
  if(operation==='state')return this.state();if(operation==='runs')return this.runs();if(operation==='saveState')return this.saveState(input);if(operation==='enqueue')return this.enqueue(input);if(operation==='update')return this.update(input);if(operation==='reserve')return this.reserve(input as Parameters<AgentRepository['reserve']>[0]);if(operation==='forget'){this.forget(String(input));return null;}if(operation==='prune'){this.prune(Number(input));return null;}throw new AppError('invalid_input','Unknown workflow storage operation.');
 }
}
