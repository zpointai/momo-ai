import { useEffect,useRef,useState } from 'react';
import { ArrowRight,BookOpen,CalendarDays,CheckSquare,Clock3,FileText,Mail,RefreshCw,Sparkles } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import type { DesktopBridge,Snapshot } from '../shared/contracts';
import { briefingContentEntries,type BriefingEntry,type DailyIntelligence } from '../shared/daily-intelligence';
import type { ResourceRef } from '../shared/modules';
import type { OrchestrationController } from './OrchestrationViews';
import { sourceStateLabel } from '../shared/situation';
import { dateInZone } from '../shared/google';
import { useLocalToday } from './calendarClock';
import { BriefingPages } from './DashboardObjects';
import type { EligibilityIssue } from '../shared/briefing';

function availabilityLabel(issue?:EligibilityIssue){
 if(!issue)return 'AI summary unavailable';
 if(issue.code==='session_no_inference')return 'Review session · AI summaries are off';
 if(issue.code==='provider')return 'Connect an AI provider to prepare a summary';
 if(issue.code==='account')return 'Connect your account to prepare a summary';
 if(issue.code==='sharing')return 'Briefing context sharing is off';
 if(issue.code==='queue')return 'Workflow queue is full';
 if(issue.target==='usage'||issue.target==='limits')return 'AI usage controls need review';
 if(issue.target==='automation')return 'Briefing workflow needs review';
 return 'AI summary setup needs review';
}

function entryDetail(entry:BriefingEntry,timezone:string,today:string){
 if(entry.kind==='situation'){try{return JSON.parse(entry.detail).summary;}catch{return 'Situation detail unavailable.';}}
 if(entry.kind==='calendar'){const {time,status}=JSON.parse(entry.detail);const format=(at:string)=>new Intl.DateTimeFormat('en-GB',{timeZone:timezone,day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}).format(new Date(at));return(time.kind==='allDay'?new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',day:'numeric',month:'short'}).format(new Date(time.startDate+'T12:00:00Z'))+' · All day':format(time.start)+(time.end?' – '+new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',minute:'2-digit'}).format(new Date(time.end)):' · End unknown'))+(status==='tentative'?' · Tentative':'');}
 if(entry.kind==='task'){const {due}=JSON.parse(entry.detail);if(due.kind==='none')return 'Open · No due date';const date=due.kind==='date'?due.date:dateInZone(new Date(due.at),due.timezone);return(date<today?'Overdue · ':date===today?'Due today · ':'Due · ')+(due.kind==='date'?due.date:new Intl.DateTimeFormat('en-GB',{timeZone:due.timezone,dateStyle:'medium',timeStyle:'short'}).format(new Date(due.at)));}
 return entry.detail;
}
/** View grouping only; the source-backed snapshot stays unchanged. */
export function briefingSections(entries:BriefingEntry[],today:string){
 const groups:{label:string;entries:BriefingEntry[]}[]=[{label:'Today',entries:[]},{label:'Prepare',entries:[]},{label:'Upcoming',entries:[]},{label:'Recent updates',entries:[]}];
 for(const e of briefingContentEntries(entries)){let index=e.section==='today'||e.section==='attention'?0:e.section==='ahead'?2:1;
  if(e.kind==='situation')index=3;
  if(e.kind==='task'){const {due}=JSON.parse(e.detail);const date=due.kind==='date'?due.date:due.kind==='instant'?dateInZone(new Date(due.at),due.timezone):null;index=date?(date<=today?0:2):1;}
  groups[index].entries.push(e);
 }
 return groups.filter(g=>g.entries.length);
}
function EntryStamp({entry,timezone,today}:{entry:BriefingEntry;timezone:string;today:string}){
 if(entry.kind!=='calendar')return <span className="daily-entry-stamp" aria-hidden="true">{entry.kind==='task'?<CheckSquare size={19}/>:entry.kind==='attention'?<Mail size={19}/>:<FileText size={19}/>}</span>;
 const {time}=JSON.parse(entry.detail),date=time.kind==='allDay'?time.startDate:dateInZone(new Date(time.start),timezone),at=new Date(time.kind==='allDay'?date+'T12:00:00Z':time.start),zone=time.kind==='allDay'?'UTC':timezone;
 return <span className="daily-entry-stamp" aria-hidden="true"><strong>{date===today&&time.kind!=='allDay'?new Intl.DateTimeFormat('en-GB',{timeZone:timezone,hour:'2-digit',minute:'2-digit'}).format(at):new Intl.DateTimeFormat('en-GB',{timeZone:zone,day:'numeric',month:'short'}).format(at)}</strong><small>{time.kind==='allDay'?'All day':date===today?'Today':new Intl.DateTimeFormat('en-GB',{timeZone:zone,weekday:'short'}).format(at)}</small></span>;
}
function SummaryText({text,preview=false}:{text:string;preview?:boolean}){
 const inline=({children}:{children?:React.ReactNode})=><span>{children}{' '}</span>;
 return <ReactMarkdown components={preview?{p:inline,ul:inline,ol:inline,li:inline,h1:inline,h2:inline,h3:inline,h4:inline,h5:inline,h6:inline,blockquote:inline,pre:inline}:undefined} allowedElements={['p','strong','em','ul','ol','li','h1','h2','h3','h4','h5','h6','blockquote','code','pre','br']} unwrapDisallowed>{text}</ReactMarkdown>;
}
function Facts({record,limit,openSource,openFull}:{record:DailyIntelligence;limit?:number;openSource(ref:ResourceRef):void;openFull?():void}){
 const daily=record.snapshot;
 return <div className={'daily-sections'+(limit!==undefined?' daily-preview-sections':'')}>{briefingSections(daily.entries,daily.date).map(section=><section key={section.label} aria-label={section.label} data-section={section.label}><header className="daily-section-heading"><h3>{limit!==undefined&&(section.label==='Today'?<CalendarDays size={16}/>:section.label==='Upcoming'?<Clock3 size={16}/>:<CheckSquare size={16}/>)}{section.label}</h3>{limit!==undefined&&<span>{section.entries.length} {section.entries.length===1?'item':'items'}</span>}</header>{section.entries.slice(0,limit).map(entry=><button className="daily-source" key={entry.id} onClick={()=>openSource(entry.ref)}>{limit!==undefined&&<EntryStamp entry={entry} timezone={daily.timezone} today={daily.date}/>}<span className="daily-entry-copy"><strong>{entry.title}</strong><small>{entryDetail(entry,daily.timezone,daily.date)}</small></span><ArrowRight className="daily-source-arrow" size={14}/></button>)}{limit!==undefined&&section.entries.length>limit&&openFull&&<button className="text-button daily-more" onClick={openFull}>View all {section.entries.length} <ArrowRight size={14}/></button>}</section>)}</div>;
}
export function FullDailyBriefing({record,openSource,activity,settings}:{record:DailyIntelligence;openSource(ref:ResourceRef):void;activity():void;settings():void}){
 const {snapshot:daily,synthesis:ai}=record;
 return <div className="daily-full"><p className="pane-meta">{daily.date} · {daily.timezone} · Updated {new Date(daily.createdAt).toLocaleString('en-GB',{timeZone:daily.timezone})}</p>
  {ai.status==='complete'&&ai.snapshotId===daily.id&&ai.snapshotRevision===daily.revision&&<section className="daily-summary"><h3>AI summary</h3><div className="daily-summary-text"><SummaryText text={ai.text??''}/></div></section>}
  <Facts record={record} openSource={openSource}/>
  <details className="daily-coverage"><summary>Sources & coverage</summary>{daily.coverage.filter(c=>c.source!=='approvals').map(c=><section key={c.source}><h4>{c.source} · {c.status}</h4><p>{c.detail} {c.included} included{c.total!==null?' of '+c.total:''}.{c.fetchedAt&&' Checked '+new Date(c.fetchedAt).toLocaleString()}.</p></section>)}<p>Source titles and bounded facts only. All entries are private. Opening a source does not authorize an action.</p>{briefingContentEntries(daily.entries).map(e=><details key={e.id}><summary>{e.title}</summary><p>{e.ref.connector} · {e.ref.type} · {e.freshness} · {e.sharing}</p><p>Revision: {e.ref.revision}</p><p>Source: {e.ref.id} · Account: {e.ref.accountId??'Unassigned local'} · {e.ref.profile} profile</p><p>Provenance: {e.ref.provenance.kind} · {e.ref.provenance.fetchedAt}</p></details>)}</details>
  <div className="daily-connectors"><span>Weather · {sourceStateLabel(daily.connectors.weather)}</span><span>Traffic · {sourceStateLabel(daily.connectors.traffic)}</span><button className="text-button" onClick={settings}>Review connections <ArrowRight size={14}/></button></div>
  {ai.runId&&<button className="text-button" onClick={activity}>Inspect summary activity <ArrowRight size={14}/></button>}
 </div>;
}
export function DailyBriefing({snapshot,bridge,orchestration,openSource,usageSettings,recover,openFull,previewLimit=2}:{snapshot:Snapshot;bridge:DesktopBridge;orchestration:OrchestrationController;openSource(ref:ResourceRef):void;activity():void;usageSettings():void;recover?(issue:EligibilityIssue):void;openFull(record:DailyIntelligence):void;previewLimit?:number}){
 const [local,setLocal]=useState<DailyIntelligence>(),[busy,setBusy]=useState(false),[error,setError]=useState('');const sequence=useRef(0),locked=useRef(false),pending=useRef(false),taskKey=useRef('');
 const accountId=snapshot.google.activeAccountId,zone=snapshot.settings.values.timezone,today=useLocalToday(zone);
 const runKey=orchestration.data.runs.filter(r=>r.event.family==='email').map(r=>r.id+r.status+JSON.stringify(r.assessment)).join();
 const key=[accountId,zone,today,snapshot.settings.revision,orchestration.data.state.revision,runKey].join(':');
 async function rebuild(refresh:boolean,synthesize=false){if(locked.current){pending.current=true;return;}locked.current=true;setBusy(true);setError('');const request=++sequence.current;try{const result=await bridge.agentCommand({action:'dailyBriefing',refresh,synthesize});if(request!==sequence.current)return;if(result.ok)setLocal(result.value.dailyIntelligence);else setError('Daily facts could not be refreshed. Please try again.');}catch{if(request===sequence.current)setError('Daily sources could not be refreshed. Try again.');}finally{locked.current=false;if(request===sequence.current)setBusy(false);if(pending.current){pending.current=false;void rebuild(false);}}}
 useEffect(()=>{setLocal(undefined);void rebuild(false);return()=>{sequence.current++;};},[key,bridge]);
 useEffect(()=>{const off=bridge.onWorkspaceChanged?.(workspace=>{const next=JSON.stringify(workspace.tasks);if(taskKey.current!==next){taskKey.current=next;void rebuild(false);}});return()=>off?.();},[bridge,key]);
 const streamed=orchestration.data.dailyIntelligence;
 const candidates=[local,streamed].filter((r):r is DailyIntelligence=>!!r&&r.snapshot.accountId===accountId&&r.snapshot.timezone===zone&&r.snapshot.date===today);
 const record=candidates.sort((a,b)=>b.synthesis.updatedAt.localeCompare(a.synthesis.updatedAt)||b.snapshot.createdAt.localeCompare(a.snapshot.createdAt))[0],daily=record?.snapshot,ai=record?.synthesis;
 const eligibility=orchestration.data.briefingEligibility,matchingEligibility=eligibility?.accountId===accountId?eligibility:undefined,issue=matchingEligibility?.issues.find(i=>i.code!=='active');
 const summary=ai?.status==='complete'&&ai.snapshotId===daily?.id&&ai.snapshotRevision===daily.revision?ai.text:null;
 const unavailable=!!issue||!!ai&&['blocked','failed','stale','held'].includes(ai.status),reviewSession=issue?.code==='session_no_inference';
 const running=ai?.status==='running'||!!matchingEligibility?.activeRunId||!!matchingEligibility?.issues.some(i=>i.code==='active');
 return <div className="daily-intelligence" aria-busy={busy}>
  <header className="pane-heading daily-heading"><div><h2><BookOpen/>Briefing</h2><p className="pane-meta">{new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',weekday:'long',day:'numeric',month:'long'}).format(new Date(today+'T12:00:00Z'))}{daily&&' · Updated '+new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit'}).format(new Date(daily.createdAt))}</p></div><div className="daily-header-actions"><button className="text-button" disabled={busy} onClick={()=>void rebuild(true)}><RefreshCw size={14}/>Refresh facts</button><div className="briefing-art"><BriefingPages/></div></div></header>
  <div className="daily-content" role="region" aria-label="Daily briefing facts">
   {record?<><Facts record={record} limit={previewLimit} openSource={openSource} openFull={()=>openFull(record)}/>{!briefingContentEntries(daily!.entries).length&&<p className="daily-empty">No current items in Briefing.</p>}{daily!.coverage.some(c=>c.source!=='approvals'&&(c.status==='unavailable'||c.status==='disabled'))&&<p className="fine-print">Some sources are unavailable. View the full briefing for coverage.</p>}</>:<p role="status">{busy?'Preparing daily facts…':'Daily sources have not loaded yet.'}</p>}
   {summary&&record&&<section className="daily-summary-preview" aria-label="AI summary preview"><header><h3>AI summary</h3><span className="pane-meta">Preview</span></header><div className="daily-narrative daily-summary-text"><SummaryText text={summary} preview/></div><button className="text-button daily-summary-link" onClick={()=>openFull(record)}>Read full summary <ArrowRight size={14}/></button></section>}
  </div>
  <footer className="daily-actions"><div className="daily-brief-action"><button className="primary" disabled={busy||running||!!issue||!record} aria-describedby="briefing-availability" onClick={()=>void rebuild(true,true)}><Sparkles size={16}/>{running?'Preparing summary…':'Brief me'}</button><div className="daily-ai-status" id="briefing-availability" role="status">{unavailable?<><span>{availabilityLabel(issue)}</span><small>Your daily facts are still available.</small></>:<span>{running?'A summary is already in progress.':summary?'Summary prepared from your daily facts.':'An optional summary of your day.'}</span>}{issue&&!reviewSession&&(recover?<button className="text-button" onClick={()=>recover(issue)}>{issue.label}</button>:(issue.target==='usage'||issue.target==='limits')&&<button className="text-button" onClick={usageSettings}>Review AI usage</button>)}</div></div>
   {record&&<button className="text-button daily-full-link" onClick={()=>openFull(record)}>View full briefing <ArrowRight size={15}/></button>}
   {ai?.status==='running'&&ai.runId&&<button className="text-button" onClick={()=>void orchestration.command({action:'cancel',id:ai.runId!})}>Cancel processing</button>}{error&&<p role="alert">{error}</p>}
  </footer>
 </div>;
}
