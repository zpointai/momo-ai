import {workSummary} from './work-copy';
import { MoPortrait } from './MoIdentity';
import { useRelay,relayRef } from './RelayView';
import { relayNeedsDecision } from '../shared/relay';
import { workItems } from '../shared/work';
import { AttentionActions } from './WorkPanel';
import { useInsightTime } from './BackgroundIntelligence';
import type { DailyIntelligence } from '../shared/daily-intelligence';
import { DailyBriefing,FullDailyBriefing } from './DailyBriefing';
import type { EligibilityIssue } from '../shared/briefing';
import { useEffect,useRef,useState,type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight,CalendarDays,ListTodo,MessageCircle,Plus,RefreshCw,ShieldCheck,Zap } from 'lucide-react';
import { DashboardContext,useDashboardSituation,type DashboardSituationOpen,type DashboardSituationSelection } from './DashboardContext';
import { useLocalToday } from './calendarClock';
import { dayLabel } from '../shared/planner';
import { NeedsAttention } from './NeedsAttention';
import { CalendarInstrument,TaskOrganizer } from './DashboardObjects';
import type { DesktopBridge,Snapshot } from '../shared/contracts';
import { addDays,dateInZone,eventOnDate,type CalendarData,type CalendarEvent } from '../shared/google';
import type { ResourceRef } from '../shared/modules';
import { DashboardUsage } from './DashboardUsage';
import type { AssistantController } from './AssistantViews';
import type { OrchestrationController } from './OrchestrationViews';
import { NativeApprovalSummary } from './NativeActivity';
import { agentSourceRef,sourceRef,proposalReview,TaskList,type TaskReviewRequest } from './WorkspaceControls';

export function eventRef(event:CalendarEvent,accountId:string,fetchedAt:string,timezone:string):ResourceRef{return{module:'planner',connector:'google',type:'calendar',id:event.id,accountId,profile:'local',revision:fetchedAt,label:event.title,provenance:{kind:'connector',runId:null,fetchedAt},access:'read',retention:{kind:'transient',expiresAt:null},date:event.time.kind==='allDay'?event.time.startDate:dateInZone(new Date(event.time.start),timezone)};}
function CardTitle({icon,title,aside}:{icon:ReactNode;title:string;aside?:ReactNode}){return <header className="pane-heading"><h2>{icon}{title}</h2>{aside}</header>;}
export function DashboardView({snapshot,bridge,controller,orchestration,review,newTask,newEvent,activity,openWork,settings,usageSettings,recover,openSource,openPlanner,active,openAssistant,detailHost,openDetails,closeDetails,situationSelection,openSituation}:{snapshot:Snapshot;bridge:DesktopBridge;controller:AssistantController;orchestration:OrchestrationController;review(request:TaskReviewRequest):void;newTask():void;newEvent():void;activity():void;openWork?(id?:string):void;settings():void;usageSettings():void;openSource(ref:ResourceRef):void;brief():Promise<boolean>;recover(issue:EligibilityIssue):void;openPlanner():void;active:boolean;openAssistant():void;detailHost:HTMLDivElement|null;openDetails():void;closeDetails():void;situationSelection?:DashboardSituationSelection;openSituation:DashboardSituationOpen}){
 const relay=useRelay(bridge),relayAttention=relay.data?.receipts.filter(relayNeedsDecision)??[];
 const [calendar,setCalendar]=useState<CalendarData>();const [error,setError]=useState('');const [loading,setLoading]=useState(false);const [refresh,setRefresh]=useState(0);const [detail,setDetail]=useState<'coverage'|'briefing'|'approvals'|string|null>(null);
 const [fullBriefing,setFullBriefing]=useState<DailyIntelligence>();
 const detailOrigin=useRef<HTMLElement|null>(null),refreshRead=useRef(0);
 const openDetail=(next:string)=>{if(!detail)detailOrigin.current=document.activeElement as HTMLElement;setDetail(next);openDetails();};
 const closeDetail=()=>{closeDetails();requestAnimationFrame(()=>detailOrigin.current?.focus({preventScroll:true}));};
 const situation=useDashboardSituation(bridge,active&&!snapshot.settings.values.disabledModules.includes('situation'),situationSelection);
 const plannerDisabled=snapshot.settings.values.disabledModules.includes('planner');
 const accountId=snapshot.google.activeAccountId,zone=snapshot.settings.values.timezone,today=useLocalToday(zone),account=snapshot.google.accounts.find(a=>a.id===accountId);
 useEffect(()=>{let active=true;const force=refreshRead.current!==refresh;refreshRead.current=refresh;setCalendar(undefined);setError('');setLoading(false);setDetail(null);if(!accountId||account?.status!=='connected'||plannerDisabled)return;setLoading(true);void bridge.readCalendar({accountId,startDate:today,endDate:addDays(today,7),timezone:zone,refresh:force}).then(r=>{if(active){if(r.ok)setCalendar(r.value);else setError(r.error.message);}}).catch(()=>{if(active)setError('Calendar could not be loaded.');}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[accountId,account?.status,bridge,zone,today,refresh,plannerDisabled]);
 const runs=orchestration.data.runs.filter(r=>r.event.accountId===accountId);
 const insightTime=useInsightTime(orchestration.data.background?.insights),entries=workItems(orchestration.data,controller.workspace,accountId,insightTime),attention=entries.filter(i=>i.attention);
 const work=(id?:string)=>openWork?openWork(id):activity();
 const handle=(id:string)=>{work(id);void orchestration.command({action:'handleWork',id});};
 const moWorking=entries.some(i=>i.group==='Mo is working'),needsOwner=entries.filter(i=>i.group==='Needs you');
 const proposals=runs.flatMap(run=>run.proposals.filter(p=>p.status==='pending'&&+new Date(p.expiresAt)>Date.now()).map(p=>({run,p})));
 const tasks=controller.workspace.tasks.filter(t=>((t.accountId??null)===accountId||!t.accountId)&&t.status==='open');
 const briefing=runs.find(r=>r.event.family==='briefing'&&!r.background&&r.result);const prior=controller.workspace.runs.find(r=>r.mode==='briefing'&&r.accountId===accountId&&r.result);
 const briefingText=briefing?.result?.text??prior?.result?.answer;const briefingAt=briefing?.createdAt??prior?.createdAt;const held=briefing?briefing.status!=='complete':prior?.status!=='succeeded';const stale=!!briefingAt&&dateInZone(new Date(briefingAt),zone)!==today;
 // Excerpts preserve stored wording. Display never calls a model or certifies a held result.
 const agenda=calendar?.events.filter(e=>eventOnDate(e,today,zone)||(e.time.kind==='timed'?+new Date(e.time.end)>Date.now():e.time.endDate>today))??[];const selectedEvent=calendar?.events.find(e=>'event:'+e.id===detail);
 const costs=orchestration.data.costs;
 const time=(e:CalendarEvent)=>e.time.kind==='allDay'?'All day':new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit'}).format(new Date(e.time.start));
 return <div className="desktop-dashboard dashboard-refined dashboard-evolved">
  <div className="dashboard-body" role="region" aria-label="Dashboard cards" tabIndex={0}>
  <header className="workspace-toolbar dashboard-toolbar"><div className="dashboard-title"><h1>Your day, in focus.</h1><time dateTime={today}>{dayLabel(today,{weekday:'long',day:'numeric',month:'long'})}</time></div><DashboardContext timezone={zone} snapshot={situation} open={openSituation}/></header>
  {(!account||account.status==='reconnect')&&<div className="setup-notice"><span>{account?'Reconnect to refresh Inbox and calendar.':'Connect an account for Inbox and calendar.'}</span><button className="text-button" onClick={settings}>Review setup</button></div>}
  <div className="dashboard-reading">
   <div className="dashboard-columns">
    <div className="dashboard-main-column">
     <NeedsAttention compact={!attention.length&&!relayAttention.length} available={true} expanded={false} openCoverage={()=>work()} footer={<><button className="text-button" onClick={()=>openDetail('approvals')}><ShieldCheck size={15}/>{proposals.length>0?`${proposals.length} task approvals`:'Task approvals'}</button><NativeApprovalSummary bridge={bridge} accountId={accountId} open={()=>work()}/></>}>
      {attention.slice(0,2).map(item=><div className="attention-work-item" data-attention-work-id={item.run.id} key={item.run.id}><button className="attention-row" onClick={()=>work(item.run.id)}><span className="attention-dot"/><span><strong>{item.title}</strong><small>{workSummary(item)}</small></span><ArrowRight size={16}/></button><AttentionActions item={item} orchestration={orchestration} handle={()=>handle(item.run.id)} review={()=>work(item.run.id)}/></div>)}
      {relayAttention.slice(0,1).map(receipt=><button className="attention-row" key={receipt.id} onClick={()=>receipt.rootRunId?work(receipt.rootRunId):openSource(relayRef(receipt))}><span className="attention-dot"/><span><strong>Relay · Owner decision needed</strong><small>Review the exact communication</small></span><ArrowRight size={16}/></button>)}
      {!attention.length&&!relayAttention.length&&<div className="pane-empty"><h3>{moWorking?'Mo is handling your work':'No current attention items'}</h3><p>{moWorking?'Open Work to follow progress and review the next decision.':'This reflects available observations and work. Other mail may still need attention.'}</p></div>}
      {attention.length>2&&<p className="attention-scope">{attention.length-2} more in Work.</p>}
     </NeedsAttention>
     <section className="work-pane briefing-pane editorial-briefing"><DailyBriefing previewLimit={3} snapshot={snapshot} bridge={bridge} orchestration={orchestration} openSource={openSource} activity={activity} usageSettings={usageSettings} recover={recover} openFull={record=>{setFullBriefing(record);openDetail('daily');}}/></section>
    <div className="dashboard-execution-row">
     <section className="work-pane agenda-pane calendar-agenda"><CardTitle icon={<CalendarDays/>} title="Agenda" aside={<button className="text-button" onClick={openPlanner}>View all<ArrowRight size={15}/></button>}/><div className="pane-scroll"><p className="pane-meta agenda-range">Today & next seven days <span>{zone}</span></p>
      {loading?<p role="status">Loading calendar…</p>:agenda.length?agenda.slice(0,3).map(e=>{const date=e.time.kind==='allDay'?e.time.startDate:dateInZone(new Date(e.time.start),zone),day=new Date(date+'T12:00:00Z');return <button className="agenda-entry" key={e.id} onClick={()=>openDetail('event:'+e.id)} aria-pressed={detail==='event:'+e.id}><CalendarInstrument date={date}/><span><strong>{e.title}</strong><small>{new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',day:'numeric',month:'short'}).format(day)} · {time(e)}{e.location?' · '+e.location:''}{e.status==='tentative'?' · Tentative':''}</small></span><ArrowRight size={15}/></button>;}):<div className="pane-empty"><h3>{error?'Calendar unavailable':calendar?'No upcoming events':'Calendar not loaded'}</h3><p>{error?'Availability is unknown. Refresh to retry.':calendar?'No events in the loaded seven days.':'Connect your calendar to see upcoming events.'}</p></div>}
     </div><footer className="pane-footer pane-meta"><span>{calendar&&<>{calendar.cached?'Cached':'Updated'} {new Date(calendar.fetchedAt).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}{calendar.truncated||calendar.skipped?' · Partial coverage':''}{agenda.length>3?` · ${agenda.length-3} more loaded`:''}</>}</span><button className="text-button" disabled={loading} onClick={()=>setRefresh(v=>v+1)}><RefreshCw size={14}/>Refresh</button></footer></section>
     <section className="work-pane tasks-pane organized-tasks"><CardTitle icon={<ListTodo/>} title="Tasks" aside={<button className="text-button" onClick={openPlanner}>View all{tasks.length>0?` · ${tasks.length}`:''}<ArrowRight size={15}/></button>}/><div className="pane-scroll">{tasks.length?<TaskList tasks={tasks.slice(0,3)} controller={controller} review={review} showReviewAction/>:<div className="pane-empty task-organizer-empty"><div><h3>No open tasks</h3><p>Add a task to keep your next step here.</p></div><TaskOrganizer/></div>}</div><footer className="pane-footer"><button className="text-button" onClick={newTask}><Plus size={15}/> Add task</button></footer></section>
    </div>
    </div>
    <aside className="dashboard-utility-rail" aria-label="Dashboard utilities">
     <section className="work-pane dashboard-quick-actions"><CardTitle icon={<Zap/>} title="Quick actions"/><div className="dashboard-quick-buttons"><button className="secondary" onClick={newTask}><Plus size={17}/>New task</button><button className="secondary" onClick={newEvent}><CalendarDays size={17}/>New event</button></div></section>
     <section className="work-pane dashboard-assistant-entry"><CardTitle icon={<MessageCircle/>} title="Mo"/><div className="dashboard-assistant-copy"><MoPortrait welcome state={controller.workspace.runs.some(r=>r.status==='running')||moWorking?'processing':needsOwner.length?'waiting':'idle'} onActivate={()=>needsOwner.length===1?work(needsOwner[0].run.id):openAssistant()} label="Open Mo conversation"/><p>Your personal agent</p><button className="primary" onClick={openAssistant}>Ask Mo<ArrowRight size={17}/></button><small>Continue in your shared workpane.</small></div></section>
     <DashboardUsage costs={costs} openSettings={usageSettings}/>
    </aside>
   </div>
  </div></div>
   {detail&&detailHost&&createPortal(<aside id="dashboard-details" className="dashboard-details" aria-label="Dashboard details" onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();closeDetail();}}}><header className="pane-heading"><h2>{detail==='daily'?'Full briefing':detail==='briefing'?'Stored briefing':detail==='approvals'?'Task approvals':selectedEvent?'Event details':'Work detail'}</h2></header><div className="pane-scroll">
    {detail==='daily'&&fullBriefing&&<><FullDailyBriefing record={fullBriefing} openSource={openSource} activity={activity} settings={settings}/>{briefingText&&<button className="text-button" onClick={()=>openDetail('briefing')}>Earlier AI briefing & sources <ArrowRight size={15}/></button>}</>}
    {selectedEvent&&<><h3>{selectedEvent.title}</h3><p>{time(selectedEvent)} · {selectedEvent.time.kind==='allDay'?selectedEvent.time.startDate:new Intl.DateTimeFormat('en-GB',{timeZone:zone,dateStyle:'full'}).format(new Date(selectedEvent.time.start))}</p><p>{selectedEvent.time.kind==='timed'&&'Until '+new Intl.DateTimeFormat('en-GB',{timeZone:zone,timeStyle:'short'}).format(new Date(selectedEvent.time.end))+' · '}{zone}</p><p>{selectedEvent.location||'No location added'}</p><p>{selectedEvent.status==='tentative'?'Tentative':'Confirmed'}{calendar?.truncated?' · Partial calendar coverage':''}</p><button className="secondary" onClick={()=>openSource(eventRef(selectedEvent,accountId!,calendar!.fetchedAt,zone))}>Open in Planner <ArrowRight size={16}/></button></>}
    {detail==='approvals'&&(proposals.length?proposals.map(({run,p})=><button className="resource-row" key={p.id} onClick={()=>review(proposalReview(run,p))}><span>{p.draft.title}</span><span>Review exact proposal <ArrowRight size={15}/></span></button>):<p>No current task proposals await approval.</p>)}
    {detail==='briefing'&&<><p className="pane-meta">{briefingAt&&new Date(briefingAt).toLocaleString()} · {held?'Held for review':stale?'Earlier briefing':'Stored briefing'}</p><p className="stored-text">{briefingText}</p><h3>Scope and sources</h3><p>{briefing?.context.limitations.join(' ')??prior?.warnings.join(' ')}</p>{briefing?briefing.context.items.map(s=><button className="resource-row" key={s.id} onClick={()=>openSource(agentSourceRef(briefing,s.id)!)}>{s.title}<ArrowRight size={15}/></button>):prior?.sources.map(s=><button className="resource-row" key={s.id} onClick={()=>openSource(sourceRef(s,prior.id))}>{s.label}</button>)}</>}
   </div></aside>,detailHost)}

 </div>;
}
