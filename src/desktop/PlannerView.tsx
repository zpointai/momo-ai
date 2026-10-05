import { useEffect,useRef,useState,type CSSProperties,type ReactNode } from 'react';
import { CalendarDays,ChevronLeft,ChevronRight,Clock3,History,ListTodo,MapPin,Plus,RefreshCw,X } from 'lucide-react';
import type { DesktopBridge,Snapshot } from '../shared/contracts';
import { addDays,dateInZone,dateSchema,eventOnDate,type CalendarData,type CalendarEvent } from '../shared/google';
import { dayLabel,layoutDay,movePlanner,plannerRange,restorePlannerPreference,type PlannerMode } from '../shared/planner';
import type { ResourceRef } from '../shared/modules';
import type { AssistantController } from './AssistantViews';
import { TaskList,type TaskReviewRequest } from './WorkspaceControls';
import { CalendarActions } from './CalendarActions';
import { calendarClock,useLocalToday } from './calendarClock';
import './planner.css';

type Panel='tasks'|'event'|'editor'|'history';
type Selection={event:CalendarEvent;source:CalendarData};
const modes=['day','week','month','agenda'] as const;
const shortDate=(date:string)=>dayLabel(date,{day:'numeric',month:'short'});
function rangeTitle(date:string,mode:PlannerMode,start:string,end:string){
 if(mode==='month')return dayLabel(date,{month:'long',year:'numeric'});
 if(mode==='day')return dayLabel(date,{weekday:'long',day:'numeric',month:'long'});
 return `${shortDate(start)} – ${dayLabel(addDays(end,-1),{day:'numeric',month:'short',year:'numeric'})}`;
}
function eventTime(event:CalendarEvent,zone:string){
 if(event.time.kind==='allDay')return 'All day';
 const fmt=new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit'});
 return `${fmt.format(new Date(event.time.start))}–${fmt.format(new Date(event.time.end))}`;
}

export function PlannerView({snapshot,bridge,controller,review,newTask,settings,resource,eventRequest,calendarAction}:{snapshot:Snapshot;bridge:DesktopBridge;controller:AssistantController;review(request:TaskReviewRequest):void;newTask():void;settings():void;resource?:ResourceRef;eventRequest?:string;calendarAction?:string}){
 const accountId=snapshot.google.activeAccountId!;
 const account=snapshot.google.accounts.find(a=>a.id===accountId)!;
 const zone=snapshot.settings.values.timezone,today=useLocalToday(zone);
 const saved=()=>{try{return JSON.parse(localStorage.getItem('momo.planner.'+accountId)??'{}');}catch{return{};}};
 const [initial]=useState(()=>restorePlannerPreference(saved(),today));
 const [mode,setMode]=useState<PlannerMode>(initial.mode);
 const [browsing,setBrowsing]=useState({date:initial.date,followToday:initial.followToday});
 const date=browsing.followToday?today:browsing.date;
 const setDate=(value:string)=>setBrowsing({date:value,followToday:false});
 const followToday=()=>{calendarClock.refresh();setBrowsing({date:calendarClock.today(zone),followToday:true});};
 const [data,setData]=useState<CalendarData>();
 const [error,setError]=useState(''),[loading,setLoading]=useState(false),[refresh,setRefresh]=useState(0);
 const [selection,setSelection]=useState<Selection>(),[sourceMissing,setSourceMissing]=useState('');
 const [panel,setPanel]=useState<Panel>('tasks'),[panelOpen,setPanelOpen]=useState(false),[composeRequest,setComposeRequest]=useState<string>();
 const [actionBusy,setActionBusy]=useState(false),[reviewing,setReviewing]=useState(false);
 const grid=useRef<HTMLDivElement>(null),pane=useRef<HTMLElement>(null),returnTo=useRef<HTMLElement|null>(null),taskToggle=useRef<HTMLButtonElement>(null);
 const seen=useRef<ResourceRef|undefined>(undefined),refreshRead=useRef(0);
 const range=plannerRange(date,mode);
 // Never paint an old account/range result during the render before effect cleanup.
 const current=data?.accountId===accountId&&data.timezone===zone&&data.startDate===range.start&&data.endDate===range.end?data:undefined;
 const events=current?.events??[],partial=!!current&&(current.truncated||current.skipped>0);
 const reload=()=>setRefresh(n=>n+1);
 function openPanel(kind:Panel,origin=document.activeElement as HTMLElement|null){returnTo.current=origin;setPanel(kind);setPanelOpen(true);}
 function closePanel(){if(actionBusy)return;setPanel('tasks');setPanelOpen(false);queueMicrotask(()=>{const target=returnTo.current;if(target?.isConnected&&target.getClientRects().length)target.focus();else taskToggle.current?.focus();});}
 function inspect(event:CalendarEvent){if(!current)return;setSelection({event,source:current});openPanel('event');}
 function createEvent(){if(actionBusy||reviewing)return;setComposeRequest(crypto.randomUUID());openPanel('editor');}
 useEffect(()=>{if(panelOpen)pane.current?.querySelector<HTMLElement>('.planner-pane-heading')?.focus();},[panel,panelOpen]);
 useEffect(()=>{if(eventRequest){setComposeRequest(eventRequest);openPanel('editor');}},[eventRequest]);
 useEffect(()=>{if(calendarAction)openPanel('history');},[calendarAction]);
 useEffect(()=>{try{localStorage.setItem('momo.planner.'+accountId,JSON.stringify({mode,date,followToday:browsing.followToday}));}catch{/* Keep calendar usable if preference storage is unavailable. */}},[accountId,mode,date,browsing.followToday]);
 useEffect(()=>{
  let active=true;const force=refreshRead.current!==refresh;refreshRead.current=refresh;
  setLoading(true);setError('');setData(undefined);
  void bridge.readCalendar({accountId,startDate:range.start,endDate:range.end,timezone:zone,refresh:force}).then(r=>{
   if(!active)return;
   if(r.ok){if(r.value.accountId===accountId&&r.value.timezone===zone&&r.value.startDate===range.start&&r.value.endDate===range.end)setData(r.value);else setError('The returned calendar did not match this range. Refresh to try again.');}
   else setError(r.error.message);
  }).catch(()=>{if(active)setError('The calendar could not be loaded. Refresh to try again.');}).finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;};
 },[bridge,accountId,range.start,range.end,zone,refresh]);
 useEffect(()=>{if(resource?.module!=='planner'||resource.accountId&&resource.accountId!==accountId||seen.current===resource)return;
  seen.current=resource;setSourceMissing(resource.type==='calendarRange'&&resource.timezone!==zone?'Scheduling was checked in '+resource.timezone+'. This Planner view uses '+zone+'.':'');
  if(['calendar','calendarRange'].includes(resource.type)&&resource.date)setDate(resource.date);
  if(resource.type==='task'){const task=controller.workspace.tasks.find(t=>t.id===resource.id&&(t.accountId??null)===resource.accountId);if(task)review({id:task.id,accountId:task.accountId??null,draft:{title:task.title,due:task.due},task});else setSourceMissing('This exact task is unavailable or has been removed.');}
 },[resource,accountId,controller.workspace.tasks]);
 useEffect(()=>{if(!current||resource?.module!=='planner'||resource.type!=='calendar'||resource.accountId!==accountId)return;
  if(resource.date&&(resource.date<range.start||resource.date>=range.end))return;
  const selected=current.events.find(e=>e.id===resource.id);
  if(selected){setSelection({event:selected,source:current});openPanel('event');setSourceMissing('');}
  else setSourceMissing('This exact source event is unavailable in the loaded range. It may have changed or been removed.');
 },[current,resource,accountId,range.start,range.end]);
 useEffect(()=>{if(grid.current)grid.current.scrollTop=7*60;},[mode]);
 const selectedTasks=controller.workspace.tasks.filter(t=>((t.accountId??null)===accountId||!t.accountId)&&t.status==='open'&&(t.due.kind==='none'||t.due.kind==='date'&&t.due.date<=date||t.due.kind==='instant'&&dateInZone(new Date(t.due.at),zone)<=date));
 const selectedId=selection?.event.id;
 const eventButton=(event:CalendarEvent,content?:ReactNode)=><button type="button" key={event.id} data-status={event.status} className={'planner-event-chip'+(selectedId===event.id&&panel==='event'?' is-selected':'')} title={`${event.title} · ${eventTime(event,zone)}`} aria-label={`${event.title} · ${eventTime(event,zone)}${event.status==='tentative'?' · Tentative':''}`} onClick={()=>inspect(event)}>{content??<><time>{eventTime(event,zone)}</time><strong>{event.title}</strong>{event.status==='tentative'&&<small>Tentative</small>}</>}</button>;
 const days=range.days.map(day=>({day,allDay:events.filter(e=>e.time.kind==='allDay'&&eventOnDate(e,day,zone)),timed:layoutDay(events,day,zone)}));
 const compact=days.flatMap(d=>d.timed.filter(e=>e.end-e.start<38||e.clockChange).map(e=>({...e,day:d.day})));
 const title=panel==='event'?'Event details':panel==='editor'?(reviewing?'Review event':'New event'):panel==='history'?'Calendar actions':'Local tasks';
 return <div className="planner-workspace">
  <div className="planner-commandbar" aria-label="Planner controls">
   <div className="planner-date-controls"><button className="secondary small" onClick={followToday} aria-pressed={browsing.followToday}>Today</button><button className="icon-button" aria-label="Previous calendar range" title="Previous range" onClick={()=>setDate(movePlanner(date,mode,-1))}><ChevronLeft size={18}/></button><button className="icon-button" aria-label="Next calendar range" title="Next range" onClick={()=>setDate(movePlanner(date,mode,1))}><ChevronRight size={18}/></button><input type="date" aria-label="Calendar date" title="Selected browsing date" value={date} onChange={e=>{if(dateSchema.safeParse(e.target.value).success)setDate(e.target.value);}}/></div>
   <div className="segmented planner-modes" aria-label="Calendar view">{modes.map(v=><button key={v} aria-pressed={v===mode} onClick={()=>setMode(v)}>{v[0].toUpperCase()+v.slice(1)}</button>)}</div>
   <div className="planner-command-actions"><button className="secondary small planner-tasks-toggle" ref={taskToggle} onClick={()=>{if(panel==='tasks'&&panelOpen)closePanel();else openPanel('tasks');}}><ListTodo size={16}/>Local tasks</button><button className="icon-button" aria-label="Calendar action history" title="Calendar action history" onClick={()=>openPanel('history')}><History size={17}/></button><button className="secondary small" disabled={loading} onClick={reload}><RefreshCw size={15}/>Refresh</button><button className="primary small" disabled={actionBusy||reviewing} onClick={createEvent}><Plus size={17}/>New event</button></div>
  </div>
  <header className="planner-rangebar"><div className="planner-orientation"><div className="planner-date-tile" aria-hidden="true"><span>{dayLabel(date,{month:'short'})}</span><strong>{Number(date.slice(-2))}</strong></div><div><h1>{rangeTitle(date,mode,range.start,range.end)}</h1><p>Primary calendar <span>·</span> {zone}<span>·</span><span className="planner-date-intent">{browsing.followToday?'Following today':`Selected ${shortDate(date)} · Today ${shortDate(today)}`}</span></p></div></div><div className="planner-coverage" role="status"><strong>{loading?'Loading selected range…':current?`${events.length} ${events.length===1?'event':'events'} loaded${partial?' · Partial results':''}`:'Calendar unavailable'}</strong><span>{shortDate(range.start)} – {shortDate(addDays(range.end,-1))}{current&&<> · {current.cached?'Cached':'Fetched'} {new Intl.DateTimeFormat('en-GB',{timeZone:zone,day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(current.fetchedAt))}</>}</span></div></header>
  {error&&<p role="alert" className="banner error planner-notice">{error}</p>}{sourceMissing&&<p role="status" className="banner planner-notice">{sourceMissing}</p>}{partial&&<p className="banner planner-notice">Partial results — {current!.truncated?'the 1,000-event limit was reached. ':''}{current!.skipped>0?`${current!.skipped} invalid events were skipped. `:''}Other events may be missing.</p>}
  <div className="planner-body">
   <section className="planner-calendar" aria-label={`${mode[0].toUpperCase()+mode.slice(1)} calendar`} aria-busy={loading}>
    {(mode==='day'||mode==='week')&&<>
     {compact.length>0&&<details className="planner-compact-events"><summary><Clock3 size={14}/>Short events & clock changes · {compact.length}<span>Full titles</span></summary><div>{compact.map(item=><div key={item.day+item.event.id}><small>{shortDate(item.day)}{item.clockChange?' · Clock change; see exact times':''}</small>{eventButton(item.event)}</div>)}</div></details>}
     <div className={'planner-time-scroll '+mode} ref={grid} tabIndex={0} aria-label="Calendar time grid; scroll for other hours" style={{'--calendar-days':range.days.length} as CSSProperties}>
      <div className="planner-time-head"><div className="planner-dayhead"><span className="planner-zone-label">Time</span>{days.map(({day})=><button key={day} className={(day===today?'is-today ':'')+(day===date?'is-date':'')} aria-label={`Select ${dayLabel(day)}`} aria-pressed={day===date} onClick={()=>setDate(day)}><span>{dayLabel(day,{weekday:'short'})}</span><strong>{Number(day.slice(-2))}</strong></button>)}</div><div className="planner-all-day"><small>All day</small>{days.map(({day,allDay})=><div key={day}>{allDay.map(e=>eventButton(e,<><strong>{e.title}</strong>{e.status==='tentative'&&<small>Tentative</small>}</>))}</div>)}</div></div>
      <div className="planner-time-grid"><div className="planner-hours">{Array.from({length:24},(_,i)=><time key={i} style={{top:i*60}}>{String(i).padStart(2,'0')}:00</time>)}</div>{days.map(({day,timed})=><div className={'planner-time-column'+(day===today?' is-today':'')} key={day} aria-label={dayLabel(day)}>{timed.map(item=><button key={item.event.id} data-status={item.event.status} className={'planner-timed-event'+(item.end-item.start<38?' is-compact':'')+(item.clockChange?' clock-change':'')+(selectedId===item.event.id&&panel==='event'?' is-selected':'')} style={{top:item.start,height:Math.max(1,item.end-item.start),left:`${item.column/item.columns*100}%`,width:`${100/item.columns}%`}} title={`${item.event.title} · ${eventTime(item.event,zone)}`} aria-label={`${item.event.title} · ${eventTime(item.event,zone)}${item.clockChange?' · Clock change; open exact times':''}`} onClick={()=>inspect(item.event)}><strong>{item.event.title}</strong><time>{eventTime(item.event,zone)}</time>{item.event.status==='tentative'&&<small>Tentative</small>}</button>)}</div>)}</div>
     </div>
    </>}
    {mode==='month'&&<div className="planner-month-scroll" tabIndex={0} aria-label="Month calendar; scroll for later weeks"><div className="planner-month"><div className="planner-weekdays">{['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].map(d=><span key={d}>{d}</span>)}</div><div className="planner-month-days">{range.days.map(day=>{const values=events.filter(e=>eventOnDate(e,day,zone));return <div className={'planner-month-day'+(day.slice(0,7)!==date.slice(0,7)?' outside-month':'')+(day===today?' is-today':'')+(day===date?' is-date':'')} key={day}><button className="planner-date-number" aria-label={`Open ${dayLabel(day)}`} onClick={()=>{setDate(day);setMode('day');}}>{Number(day.slice(-2))}{day.endsWith('01')&&<span>{dayLabel(day,{month:'short'})}</span>}</button>{values.slice(0,3).map(e=>eventButton(e))}{values.length>3&&<button className="planner-more-events" aria-label={`Show ${values.length-3} more events on ${dayLabel(day)}`} onClick={()=>{setDate(day);setMode('day');}}>+{values.length-3} more events</button>}</div>;})}</div></div></div>}
    {mode==='agenda'&&<div className="planner-agenda-scroll" tabIndex={0} aria-label="Agenda events">{range.days.map(day=>{const values=events.filter(e=>eventOnDate(e,day,zone));if(!values.length)return null;return <section className="planner-agenda-day" key={day}><h2><strong>{Number(day.slice(-2))}</strong><span>{dayLabel(day,{weekday:'short',month:'short'})}</span></h2><div>{values.map(e=><button data-status={e.status} className={'planner-agenda-row'+(selectedId===e.id&&panel==='event'?' is-selected':'')} key={e.id} onClick={()=>inspect(e)}><time>{eventTime(e,zone)}</time><span><strong>{e.title}</strong>{e.location&&<small><MapPin size={13}/>{e.location}</small>}{e.status==='tentative'&&<small>Tentative</small>}</span><ChevronRight size={16}/></button>)}</div></section>;})}{current&&!events.length&&<div className="planner-empty"><CalendarDays size={30}/><h2>{partial?'No events in the returned results':'No events in this range'}</h2><p>{partial?'Calendar coverage is partial; other events may be missing.':'The loaded 30-day range has no events.'}</p><button className="secondary small" onClick={createEvent}>New event</button></div>}{!current&&<div className="planner-empty"><CalendarDays size={30}/><h2>{loading?'Loading your agenda…':'Agenda unavailable'}</h2><p>{loading?'Reading only the selected range.':'Use Refresh to try this range again.'}</p></div>}</div>}
   </section>
   <aside ref={pane} className="planner-context" data-kind={panel} data-open={panelOpen} aria-label={title} onKeyDown={e=>{if(e.key==='Escape'&&!actionBusy){e.stopPropagation();closePanel();}}}>
    <header><h2 className="planner-pane-heading" tabIndex={-1}>{panel==='tasks'?<ListTodo size={18}/>:panel==='history'?<History size={18}/>:<CalendarDays size={18}/>} {title}</h2><button className="icon-button planner-pane-close" aria-label={`Close ${title.toLowerCase()}`} disabled={actionBusy} onClick={closePanel}><X size={18}/></button></header>
    {panel==='tasks'&&<div className="planner-context-scroll"><div className="planner-task-scope"><span>On this computer</span><p>Open tasks due by {shortDate(date)}, plus tasks without dates. These are not Calendar bookings.</p></div>{selectedTasks.length?<TaskList tasks={selectedTasks} controller={controller} review={review} showReviewAction/>:<div className="planner-task-empty"><ListTodo size={26}/><h3>No open tasks in this view</h3><p>Add a local task, or choose another date to see what is due.</p></div>}<button className="secondary small" onClick={newTask}><Plus size={16}/>New task</button></div>}
    {panel==='event'&&selection&&<EventDetails selection={selection} email={account.email} close={closePanel}/>}
    <CalendarActions bridge={bridge} accountId={accountId} email={account.email} timezone={zone} canWrite={!!account.calendarWrite} settings={settings} created={reload} eventRequest={composeRequest} actionId={calendarAction} presentation={panel==='editor'?'editor':panel==='history'?'history':null} close={closePanel} showReview={()=>{setPanel('editor');setPanelOpen(true);}} showHistory={()=>{setPanel('history');setPanelOpen(true);}} busyChanged={setActionBusy} reviewChanged={setReviewing}/>
   </aside>
  </div>
 </div>;
}

function EventDetails({selection,email,close}:{selection:Selection;email:string;close():void}){
 const {event,source}=selection,zone=source.timezone;
 const format=(value:string)=>new Intl.DateTimeFormat('en-GB',{timeZone:zone,dateStyle:'full',timeStyle:'long'}).format(new Date(value));
 return <div className="planner-context-scroll planner-event-details"><div className="planner-event-summary" data-status={event.status}><span className="planner-event-status">{event.status==='tentative'?'Tentative':'Confirmed'}{event.recurringEventId?' · Recurring occurrence':''}</span><h3>{event.title}</h3></div><dl><dt><Clock3 size={16}/>When</dt><dd>{event.time.kind==='allDay'?<>{dayLabel(event.time.startDate)}{addDays(event.time.endDate,-1)!==event.time.startDate&&<> – {dayLabel(addDays(event.time.endDate,-1))}</>}<br/>All day</>:<><span>{format(event.time.start)}</span><span>{format(event.time.end)}</span></>}</dd><dt>Time zone</dt><dd>{zone}{event.time.kind==='timed'&&event.time.startTimezone&&event.time.startTimezone!==zone&&<small>Original start zone: {event.time.startTimezone}</small>}{event.time.kind==='timed'&&event.time.endTimezone&&event.time.endTimezone!==zone&&<small>Original end zone: {event.time.endTimezone}</small>}</dd><dt><CalendarDays size={16}/>Calendar</dt><dd>Primary calendar<small>{email}</small></dd>{event.location&&<><dt><MapPin size={16}/>Location</dt><dd>{event.location}</dd></>}</dl><p className="fine-print">{source.cached?'Cached snapshot':'Loaded'} {new Date(source.fetchedAt).toLocaleString()}{source.truncated||source.skipped?' · Partial range coverage':''}. Exact event details from this read.</p><button className="secondary small" onClick={close}>Done</button></div>;
}



