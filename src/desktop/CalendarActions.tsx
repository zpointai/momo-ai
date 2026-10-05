import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { DesktopBridge } from '../shared/contracts';
import { addDays, dateInZone } from '../shared/google';
import { wallTimeToInstant, type CalendarAction, type CalendarActionCommand, type CalendarReview, type EventDraft } from '../shared/calendar-actions';

export function CalendarActions({bridge,accountId,email,timezone,canWrite,settings,created,eventRequest,actionId,presentation,close,showReview,showHistory,busyChanged,reviewChanged}:{bridge:DesktopBridge;accountId:string;email:string;timezone:string;canWrite:boolean;settings():void;created():void;eventRequest?:string;actionId?:string;presentation:'editor'|'history'|null;close():void;showReview():void;showHistory():void;busyChanged(value:boolean):void;reviewChanged(value:boolean):void}) {
  const [actions,setActions]=useState<CalendarAction[]>([]); const [review,setReview]=useState<CalendarReview|null>(null);
  const [editing,setEditing]=useState(false); const [title,setTitle]=useState(''); const [allDay,setAllDay]=useState(false);
  const tomorrow=addDays(dateInZone(new Date(),timezone),1);
  const [start,setStart]=useState(tomorrow+'T10:00'); const [end,setEnd]=useState(tomorrow+'T11:00');
  const [firstDay,setFirstDay]=useState(tomorrow); const [lastDay,setLastDay]=useState(tomorrow);
  const [busy,setBusy]=useState(false); const locked=useRef(false); const [error,setError]=useState('');
  const mounted=useRef(true);
  const opened=useRef(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{busyChanged(busy);reviewChanged(!!review);},[busy,review,busyChanged,reviewChanged]);
  useEffect(()=>{let active=true; void bridge.calendarAction({action:'list'}).then(r=>{if(active){if(r.ok)setActions(r.value.actions);else setError(r.error.message);}}).catch(()=>{if(active)setError('Calendar action history could not be loaded.');});return()=>{active=false;};},[bridge]);
  async function command(input:CalendarActionCommand) {
    if(locked.current)return; locked.current=true; setBusy(true);setError('');
    try {
      const r=await bridge.calendarAction(input);
      if(!mounted.current)return;
      if(!r.ok){setError(r.error.message);return;}
      setActions(r.value.actions);setReview(r.value.review);
      if(r.value.review){setEditing(false);showReview();}
      else if(['approve','deny','reconcile'].includes(input.action))showHistory();
      if((input.action==='approve'||input.action==='reconcile') && r.value.actions.find(a=>a.id===input.id)?.status==='succeeded')created();
    } catch {if(mounted.current)setError('The action could not be confirmed. Refresh history before trying again.');}
    finally {locked.current=false;if(mounted.current)setBusy(false);}
  }
  useEffect(()=>{if(eventRequest){
    // A dormant editor must not open with startup-day defaults. Once opened,
    // its values belong to the user and survive clock/view/pane changes.
    if(!opened.current){const day=addDays(dateInZone(new Date(),timezone),1);setStart(day+'T10:00');setEnd(day+'T11:00');setFirstDay(day);setLastDay(day);opened.current=true;}
    setEditing(true);
  }},[eventRequest]);
  useEffect(()=>{if(actionId&&actions.find(a=>a.id===actionId)?.status==='pending')void command({action:'review',id:actionId});},[actionId,actions.length]);
  function prepare(e:FormEvent) {
    e.preventDefault();
    try {
      const time:EventDraft['time']=allDay?{kind:'allDay',startDate:firstDay,endDate:addDays(lastDay,1)}:{kind:'timed',start:wallTimeToInstant(start,timezone),end:wallTimeToInstant(end,timezone)};
      void command({action:'prepare',draft:{accountId,title,timezone,time}});
    } catch(e) {setError(e instanceof Error?e.message:'Check the event dates.');}
  }
  const owned=actions.filter(a=>a.draft.accountId===accountId);
  const format=(instant:string,zone:string)=>new Intl.DateTimeFormat('en-GB',{timeZone:zone,dateStyle:'medium',timeStyle:'short'}).format(new Date(instant));
  return <section className="planner-context-scroll planner-calendar-actions" hidden={!presentation} aria-label="Calendar actions">
    {presentation==='editor'&&review?.action.tool!=='calendar.update'&&<p className="planner-editor-intro">Prepare locally, then review the exact event. Every Google calendar change requires its own approval.</p>}
    {presentation==='editor'&&!canWrite&&<p className="fine-print">{review?.action.tool==='calendar.update'?'Calendar changes are not enabled.':'Calendar creation is not enabled.'} You can prepare locally. <button className="text-button" onClick={settings}>View connection settings</button></p>}
    {error&&<div className="banner error" role="alert">{error}</div>}
    {editing&&presentation==='editor'&&!review&&<form className="event-draft" onSubmit={prepare}>
      <div className="planner-event-fields">
      <label>Event title<input aria-label="Event title" maxLength={240} required value={title} onChange={e=>setTitle(e.target.value)}/></label>
      <label className="event-check"><input type="checkbox" checked={allDay} onChange={e=>setAllDay(e.target.checked)}/>All day</label>
      <div className="event-dates">{allDay?<><label>First day<input type="date" aria-label="Event first day" value={firstDay} onChange={e=>setFirstDay(e.target.value)} required/></label><label>Last day (included)<input type="date" aria-label="Event last day" value={lastDay} onChange={e=>setLastDay(e.target.value)} required/></label></>:<><label>Starts<input type="datetime-local" aria-label="Event start" value={start} onChange={e=>setStart(e.target.value)} required/></label><label>Ends<input type="datetime-local" aria-label="Event end" value={end} onChange={e=>setEnd(e.target.value)} required/></label></>}</div>
      <dl className="planner-editor-source"><dt>Time zone</dt><dd>{timezone}</dd><dt>Calendar</dt><dd>Primary calendar<small>{email}</small></dd></dl><p className="fine-print">Not saved until you choose Review event. Nothing is created in Google at this step.</p></div><footer><button className="primary small" disabled={busy}>Review event</button><button type="button" className="secondary small" disabled={busy} onClick={close}>Cancel</button></footer>
    </form>}
    {review&&presentation==='editor'&&<section className={'event-review'+(review.action.tool==='calendar.update'?' calendar-update-review':'')} aria-label="Review calendar event"><p>Your approval is required</p><h3>{review.action.draft.title}</h3>
      <dl><dt>Account</dt><dd>{review.action.accountEmail}</dd><dt>Calendar</dt><dd>Primary calendar</dd><dt>When</dt><dd>{review.action.draft.time.kind==='allDay'?`${review.action.draft.time.startDate} through ${addDays(review.action.draft.time.endDate,-1)} · All day`:<>{format(review.action.draft.time.start,review.action.draft.timezone)} → {format(review.action.draft.time.end,review.action.draft.timezone)}</>}</dd><dt>Time zone</dt><dd>{review.action.draft.timezone}</dd>{review.action.tool==='calendar.update'?<><dt>Change</dt><dd>Move this exact event from {format(review.action.target!.start,review.action.draft.timezone)}. Other event details stay as recorded. Email is a separate action.</dd><dt>Event ID</dt><dd>{review.action.eventId}</dd></>:<><dt>Details</dt><dd>Private · Busy · No guests · No reminders</dd></>}</dl>
      <p className="fine-print">{review.action.tool==='calendar.update'?'Updates only the start and end of this event. Participant availability is not established. Google guest notifications are disabled; Google may still send some notices.':'Creates exactly one event.'} This review expires after two minutes; the draft expires after 15 minutes. Changes require a new review.</p>
      <div className="connection-actions"><button className="primary small" disabled={busy||!canWrite} onClick={()=>void command({action:'approve',id:review.action.id,hash:review.action.hash,nonce:review.nonce})}>{busy?'Working…':review.action.tool==='calendar.update'?'Approve & update event':'Approve & create event'}</button><button className="secondary small" disabled={busy} onClick={()=>void command({action:'deny',id:review.action.id})}>Decline</button><button className="text-button" disabled={busy} onClick={()=>void command({action:'review',id:review.action.id})}>Refresh review</button></div>
    </section>}
    {presentation==='history'&&<div className="planner-action-history"><p className="fine-print">Local preparation, exact approvals and recorded outcomes for this account.</p><button className="text-button" disabled={busy} onClick={()=>void command({action:'list'})}>Refresh history</button>{!owned.length&&<p className="empty-state">No Calendar actions recorded for this account.</p>}{owned.map(action=><article key={action.id}><div><strong>{action.draft.title}</strong><span className="tag subtle">{action.status==='pending'&&+new Date(action.expiresAt)<Date.now()?'expired':action.status}</span></div><p role="status">{action.detail}</p>{action.status==='pending'&&+new Date(action.expiresAt)>Date.now()&&!review&&<div className="connection-actions"><button className="secondary small" disabled={busy} onClick={()=>void command({action:'review',id:action.id})}>Review saved draft</button><button className="text-button" disabled={busy} onClick={()=>void command({action:'deny',id:action.id})}>Decline</button></div>}{action.status==='unknown'&&<button className="secondary small" disabled={busy} onClick={()=>void command({action:'reconcile',id:action.id})}>Check outcome · read only</button>}</article>)}</div>}
  </section>;
}
