import { useState } from 'react';
import { CalendarDays, ArrowUpRight } from 'lucide-react';
import type { MailResult } from '../shared/mail';
import type { Mail } from '../shared/google';
import { schedulingIntent, schedulingStatus, schedulingScopeSchema } from '../shared/scheduling';
import type { ResourceRef } from '../shared/modules';
import type { OrchestrationController } from './OrchestrationViews';
import { agentEvent } from './OrchestrationViews';
import { agentSourceRef } from './WorkspaceControls';
import './scheduling.css';

export function SchedulingPanel({accountId,message,thread,timezone,controller,blocked,openDraft,openSource,openCalendar}:{accountId:string;message:Mail;thread:NonNullable<MailResult['thread']>;timezone:string;controller:OrchestrationController;blocked:string;openDraft(id:string):void;openSource(ref:ResourceRef):void;openCalendar?(id:string):void}){
 const saved=controller.data.runs.find(r=>r.scheduling&&r.event.accountId===accountId&&r.event.scheduling?.threadId===thread.id);
 const run=saved;
 const [expanded,setExpanded]=useState(!!run),[editing,setEditing]=useState(false),[error,setError]=useState('');
 const [intent,setIntent]=useState<'arrange'|'reschedule'|'availability'>('arrange'),[date,setDate]=useState(''),[from,setFrom]=useState(''),[to,setTo]=useState(''),[duration,setDuration]=useState(''),[zone,setZone]=useState(timezone);
 const [endDate,setEndDate]=useState(''),[eventId,setEventId]=useState(''),[originalDate,setOriginalDate]=useState('');
 const original=thread.messages.find(m=>m.message.id===message.id);
 const hint=schedulingIntent(original?.text??'');
 const active=!!run&&['queued','running'].includes(run.status),stale=!!run&&run.event.scheduling?.threadRevision!==thread.revision;
 const busy=controller.busy||active;
 const view=run?schedulingStatus(run):undefined;
 async function start(){if(!thread.revision)return;setExpanded(true);setError('');await controller.command({action:'start',event:{...agentEvent('email',accountId,'Check this scheduling request and prepare a source-bound local reply for owner review.',message.id),scheduling:{threadId:thread.id,threadRevision:thread.revision}}});}
 async function confirm(){
  const parsed=schedulingScopeSchema.safeParse({date,...(endDate?{endDate}:{}),from,to,timezone:zone,durationMinutes:Number(duration)});
  if(!parsed.success){setError('Enter a valid date, start and end time, timezone, and duration of 5–240 minutes.');return;}
  if(!run||stale)return;
  setError('');await controller.command({action:run.localDraftId?'replanScheduling':'continueScheduling',id:run.id,confirmed:{intent,scope:parsed.data,...(eventId&&originalDate?{reference:{eventId,date:originalDate}}:{})}});setEditing(false);
 }
 const facts=run?.scheduling?.planner;
 const format=(at:string)=>new Intl.DateTimeFormat('en-GB',{timeZone:facts!.scope.timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(at));
 return <section className="scheduling-panel" aria-label="MoMo scheduling">
  <button className="scheduling-heading text-button" aria-expanded={expanded} onClick={()=>setExpanded(v=>!v)}><CalendarDays size={17}/><strong>MoMo scheduling</strong></button>
  {!expanded&&<p>{view?.label??(hint==='uncertain'?'Possible scheduling reference':hint==='not-scheduling'?'Check scheduling when this message needs it.':'Scheduling request to review')}</p>}
  {expanded&&<div className="scheduling-content">
   <p role="status">{view?.label??'Check this message for scheduling details, then prepare a local reply using the primary calendar.'}</p>
   {view&&<p>{view.detail}</p>}
   {blocked&&<p>{blocked}</p>}{stale&&<p role="alert">This thread changed. The saved proposal is stale. Replan from the current thread; your existing draft is preserved.</p>}
   {!run&&<button className="secondary small" disabled={!!blocked||!thread.revision||busy} onClick={()=>void start()}>Check scheduling request</button>}
   {run?.scheduling?.inbox&&<p>{run.scheduling.inbox.basis==='owner-confirmed'?'Using your confirmed scheduling details.':`Understood: ${run.scheduling.inbox.intent.replace('-',' ')}.`}</p>}
   {run?.scheduling?.inbox?.uncertainty.map(text=><p key={text}>{text}</p>)}
   {!!run?.scheduling?.inbox?.policy?.length&&<details><summary>How the request was interpreted</summary>{run.scheduling.inbox.policy.map(text=><p key={text}>{text}</p>)}</details>}
   {run?.scheduling?.draftStale&&<p className="scheduling-stale" role="status">Earlier proposed times are stale. Your saved draft is preserved and cannot be sent from this workflow until a current reply is prepared.</p>}
   {run?.localDraftId&&<><p>Prepared by Inbox Mo · {run.team?.ledger?.passed?'checked by Review Mo':'review incomplete'}. Edits need your own review.</p><button className="primary small" onClick={()=>openDraft(run.localDraftId!)}>{run.scheduling?.draftStale?'Open preserved draft':'Review local reply'}</button></>}
   {facts&&<div className="scheduling-facts"><strong>Calendar checked by Planner Mo</strong><p>{facts.scope.date}{facts.scope.endDate&&facts.scope.endDate!==facts.scope.date?` – ${facts.scope.endDate}`:''} · {facts.scope.from}–{facts.scope.to} · {facts.scope.timezone}<br/>{facts.scope.durationMinutes} minutes · {facts.coverage} primary-calendar coverage</p>{facts.candidates.length>0&&<ul>{facts.candidates.map(c=><li key={c.id}>{format(c.start)}–{new Intl.DateTimeFormat('en-GB',{timeZone:c.timezone,timeStyle:'short'}).format(new Date(c.end))}</li>)}</ul>}{facts.limitations.map(text=><p key={text}>{text}</p>)}<button className="text-button" onClick={()=>{const ref=agentSourceRef(run!,'E1');if(ref)openSource(ref);}}>View date in Planner <ArrowUpRight size={14}/></button>{facts.relatedEvent&&<button className="text-button" onClick={()=>{const ref=agentSourceRef(run!,'E1');if(ref)openSource({...ref,type:'calendar',id:facts.relatedEvent!.id,revision:facts.relatedEvent!.revision,date:facts.relatedEvent!.date,label:'Linked native event'});}}>Open linked event</button>}</div>}
   {run?.scheduling?.replacementPending&&run.result?.draft&&<details open><summary>Replanned reply · awaiting your choice</summary><p className="scheduling-reply-preview">{run.result.draft}</p><button className="primary small" disabled={busy||!!blocked} onClick={()=>void controller.command({action:'useReplannedReply',id:run.id})}>Prepare as a new local reply</button><p>The previous draft and your edits remain in Local drafts.</p></details>}
   {run?.scheduling?.calendarDelivery?.state==='succeeded'&&run.scheduling.draftStale&&<button className="primary small" disabled={busy||!!blocked} onClick={()=>void controller.command({action:'useReplannedReply',id:run.id})}>Prepare confirmation reply</button>}
   {run?.calendarProposalId&&<><p>Calendar update: {run.scheduling?.calendarDelivery?.state??'pending'}. Email and calendar approvals are separate.</p><button className="secondary small" disabled={!openCalendar} onClick={()=>openCalendar?.(run.calendarProposalId!)}>Review update in Planner <ArrowUpRight size={14}/></button></>}
   {facts?.relatedEvent?.event&&run?.scheduling?.inbox?.intent==='reschedule'&&!run.calendarProposalId&&facts.coverage==='complete'&&!run.scheduling.draftStale&&!stale&&<details><summary>Prepare an update to the linked event</summary><p>Choose one verified time. This prepares a separate calendar action for your approval.</p>{facts.candidates.map(c=><button className="secondary small" key={c.id} disabled={busy||!!blocked} onClick={()=>void controller.command({action:'prepareSchedulingCalendar',id:run.id,candidateId:c.id})}>Prepare {format(c.start)}</button>)}</details>}
   {run&&!active&&run.status!=='cancelled'&&<div className="scheduling-followup"><button className="text-button" disabled={busy||!!blocked} onClick={()=>void controller.command({action:'checkScheduling',id:run.id})}>Check follow-through</button><button className="secondary small" disabled={busy||!!blocked||['succeeded','unknown','dispatching'].includes(run.scheduling?.calendarDelivery?.state??'')} onClick={()=>void controller.command({action:'replanScheduling',id:run.id})}>Replan from current thread</button><button className="text-button" disabled={busy||!!blocked} onClick={()=>void controller.command({action:'completeScheduling',id:run.id})}>Mark workflow complete</button></div>}
   {run&&!active&&!stale&&<button className="secondary small" disabled={!!blocked||busy} onClick={()=>setEditing(v=>!v)}>Confirm scheduling details</button>}
   {editing&&run&&!stale&&<form className="scheduling-form" onSubmit={e=>{e.preventDefault();void confirm();}}><p>Confirm the intended search window. These details guide a proposal; they do not book or move a meeting.</p><label>Intent<select value={intent} onChange={e=>setIntent(e.target.value as typeof intent)}><option value="arrange">Arrange a meeting</option><option value="reschedule">Propose a new meeting time</option><option value="availability">Confirm candidate availability</option></select></label><label>Date<input type="date" required value={date} onChange={e=>setDate(e.target.value)}/></label><label>Through date (optional)<input type="date" value={endDate} onChange={e=>setEndDate(e.target.value)}/></label><div className="scheduling-clock-fields"><label>From<input type="time" required value={from} onChange={e=>setFrom(e.target.value)}/></label><label>Until<input type="time" required value={to} onChange={e=>setTo(e.target.value)}/></label></div><label>Duration in minutes<input type="number" min={5} max={240} required value={duration} onChange={e=>setDuration(e.target.value)}/></label><label>Timezone<input required value={zone} maxLength={80} onChange={e=>setZone(e.target.value)}/></label><>{intent==='reschedule'&&<><label>Original event ID (optional)<input value={eventId} onChange={e=>setEventId(e.target.value)} maxLength={1024}/></label><label>Original event date<input type="date" value={originalDate} onChange={e=>setOriginalDate(e.target.value)} required={!!eventId}/></label></>}</><button className="primary small" disabled={busy||!!blocked}>Check confirmed window</button></form>}
   {run&&!['cancelled'].includes(run.status)&&run.scheduling?.delivery?.state!=='sent'&&<button className="text-button" disabled={controller.busy} onClick={()=>void controller.command({action:'cancel',id:run.id})}>Cancel scheduling work</button>}
   {(error||controller.error)&&<p role="alert">{error||controller.error}</p>}
  </div>}
 </section>;
}
