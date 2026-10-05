import { randomUUID } from 'node:crypto';
import { backgroundDefaults,insightSchema,type BackgroundInsight,type BackgroundRun } from '../../src/shared/background';
import type { Settings } from '../../src/shared/contracts';
import type { AgentContext,AgentRun,AgentState } from '../../src/shared/orchestration';
import type { BriefingSnapshot } from '../../src/shared/daily-intelligence';
import type { GoogleState,InboxData } from '../../src/shared/google';
import type { MicroDecisionResult } from './micro-decisions';
import { hash } from './catalogue';
import { sourceRef } from '../context/adapters';
import { resourceKey } from '../context/manager';

export const backgroundLimits={sourceItems:46,contextItems:20,providerCalls:2,seconds:60,workItems:12} as const;
export function backgroundAuthority(settings:Settings,state:AgentState,google:GoogleState,situationRevision?:number){return hash({situationRevision,account:google.activeAccountId,accounts:google.accounts,config:state.config,policies:state.policies,disabled:settings.disabledModules,timezone:settings.timezone,context:settings.contextBudgets,background:settings.backgroundIntelligence??backgroundDefaults});}
export function backgroundSourceEnabled(state:AgentState,settings:Settings,accountId:string,family:'email'|'task'){
 return state.config.enabled&&!state.config.paused&&!settings.disabledModules.includes(family==='email'?'inbox':'planner')&&state.policies.some(p=>p.accountId===accountId&&p.family===family&&p.enabled);
}
export function backgroundContext(snapshot:BriefingSnapshot,inbox?:InboxData):AgentContext{
 const items:AgentContext['items']=[];const count={email:0,calendar:0,task:0,workflow:0,situation:0};
 for(const entry of snapshot.entries){if(items.length>=backgroundLimits.contextItems-6)break;if(entry.ref.accountId!==snapshot.accountId||!['calendar','task','approval','workflow','situation'].includes(entry.kind))continue;const kind=entry.kind==='situation'?'situation':entry.kind==='calendar'?'calendar':entry.kind==='task'?'task':'workflow';if(count[kind]>=(kind==='calendar'?6:4))continue;
  items.push({...(kind==='situation'?{delivery:{contextId:hash([entry.ref.id,entry.ref.revision]),mode:'FULL' as const,coverage:{status:'complete' as const,suppliedCharacters:entry.detail.length,omittedCharacters:0,sourcePartial:false,method:'source' as const},ref:entry.ref}}:{}),id:({calendar:'E',task:'T',workflow:'W',situation:'S'}[kind])+(++count[kind]),kind,accountId:snapshot.accountId!,resourceId:entry.ref.id,revision:kind==='workflow'?hash({revision:entry.ref.revision,detail:entry.detail,title:entry.title}):entry.ref.revision,title:entry.title,text:entry.detail,fetchedAt:snapshot.createdAt,trust:'untrusted-source',senderScope:null,threadId:null});
 }
 for(const m of inbox?.messages.slice(0,6)??[]){const title=m.subject.slice(0,240),text=`From: ${m.from.slice(0,120)}; Date: ${m.receivedAt}; ${m.snippet.slice(0,600)}`;items.push({id:'M'+(++count.email),kind:'email',accountId:inbox!.accountId,resourceId:m.id,revision:hash({title,text}),title,text,fetchedAt:inbox!.fetchedAt,trust:'untrusted-source',senderScope:null,threadId:m.threadId});}
 const limitations=snapshot.coverage.map(c=>(c.source+': '+c.status+'. '+c.detail).slice(0,240));limitations.push(inbox?'Only the first six permitted Inbox snippets are inspected; complete threads are not available.':'Inbox unavailable, disabled or not shared.');
 return{id:randomUUID(),hash:hash(items.map(({fetchedAt:_at,...v})=>v)),createdAt:snapshot.createdAt,timezone:snapshot.timezone,items,limitations,available:{calendar:snapshot.coverage[0].status==='available'&&snapshot.coverage[0].included===count.calendar,tasks:snapshot.coverage[1].status==='available'&&snapshot.coverage[1].included===count.task,thread:false},sharing:{google:items.some(s=>s.kind==='email'||s.kind==='calendar'),tasks:items.some(s=>s.kind==='task')}};
}
export function revisionSet(context:AgentContext){return new Map(context.items.map(s=>[resourceKey(s.delivery?.ref??sourceRef(s)),s.revision]));}
export function sourceDigest(context:AgentContext){return hash([...revisionSet(context)].sort(([a],[b])=>a.localeCompare(b)));}
/** Presentation ends at a known event boundary; untimed observations follow source lifecycle.
 * This is never evidence freshness. New work still requires the native five-minute checks. */
export function insightExpiry(sources:AgentContext['items']):string|null{
 const boundaries=sources.flatMap(s=>{if(s.kind==='situation'&&s.delivery?.ref.retention.expiresAt)return[Date.parse(s.delivery.ref.retention.expiresAt)];if(s.kind!=='calendar')return[];try{const {time}=JSON.parse(s.text);const at=time?.kind==='timed'?(time.end??time.start):null;return at&&Number.isFinite(Date.parse(at))?[Date.parse(at)]:[];}catch{return[];}});
 return boundaries.length?new Date(Math.min(...boundaries)).toISOString():null;
}
export function observation(run:AgentRun,category:BackgroundInsight['category'],sources:AgentContext['items'],title:string,summary:string,attention:boolean,now:number,patch:Partial<BackgroundInsight>={}):BackgroundInsight{
 const refs=sources.map(s=>s.delivery?.ref??sourceRef(s));const sourceRevisions=refs.map(r=>({key:resourceKey(r),revision:r.revision})).sort((a,b)=>a.key.localeCompare(b.key));
 const identity=hash({accountId:run.event.accountId,category,keys:sourceRevisions.map(s=>s.key)});
 const roles=category==='inbox'||category==='classification'?'inbox':category==='conflict'||category==='missing-information'?'planner':'briefing';
 return insightSchema.parse({version:1,id:randomUUID(),runId:run.id,workItemId:run.team!.items.find(w=>w.role===roles)?.id??run.team!.specialistId,accountId:run.event.accountId,profile:'local',category,title:title.slice(0,240),summary:summary.slice(0,1000),sources:refs,sourceRevisions,provenance:{trigger:run.background!.trigger,authorityRevision:run.background!.authorityRevision,method:'deterministic',reason:run.background!.reason},observedAt:new Date(now).toISOString(),lastCheckedAt:new Date(now).toISOString(),expiresAt:insightExpiry(sources),priority:attention?'high':'normal',significance:attention?'attention':'informational',advisory:[],unresolvedQuestions:[],suggestedNextStep:attention?'Review the supporting source.':null,ownerAttention:attention,actionProposal:null,status:'active',identity,revisionIdentity:hash({identity,sourceRevisions}),supersedes:null,transitions:[],...patch});
}
/** Deterministic candidates exist before advice; neither these records nor advice can execute actions. */
export function deriveInsights(run:AgentRun,prior:BackgroundInsight[],now:number,signals:Map<string,MicroDecisionResult[]>=new Map()):BackgroundInsight[]{
 const result:BackgroundInsight[]=[];const sources=run.context.items.filter(s=>s.delivery?.mode==='FULL');
 const add=(...args:Parameters<typeof observation> extends [AgentRun,...infer P]?P:never)=>result.push(observation(run,...args));
 for(const s of sources){
  const old=prior.find(i=>i.accountId===run.event.accountId&&i.sources.some(r=>resourceKey(r)===resourceKey(s.delivery!.ref)&&r.revision!==s.revision));
  if(old&&s.kind!=='situation')add('source-change',[s],s.title,'Source revision changed; earlier observations require fresh evidence.',false,now);
  if(s.kind==='situation'){try{const fact=JSON.parse(s.text);if(['weather-change','commute-delay','traffic-incident','flight-change','situation-source-unavailable'].includes(fact.category))add(fact.category,[s],s.title,fact.summary,!!fact.attention,now);}catch{/* Structured evidence omitted. */}}else if(s.kind==='email'){
   const text=s.title+' '+s.text,request=/\b(please (?:reply|respond|confirm|review)|could you|can you|response requested)\b/i.test(text),deadline=/\b(deadline|due (?:by|on)|by (?:monday|tuesday|wednesday|thursday|friday|tomorrow|today))\b/i.test(text),urgent=/\b(urgent|action required|overdue)\b/i.test(text);
   const advice=signals.get(s.id)??[],value=(id:string)=>advice.find(a=>a.id===id)?.selected;
   const attention=request||urgent||deadline||value('needs_reply')==='yes'||value('priority')==='high';
   add('inbox',[s],s.title,[(request||value('needs_reply')==='yes')?'Potential reply request.':'Reply need is not established.',(deadline||value('deadline_present')==='yes')?'A deadline may be mentioned; verify the full thread.':'No explicit deadline identified in this snippet.','Snippet only; requests are not accepted owner commitments.'].join(' '),attention,now,{advisory:advice.map(a=>({id:a.id,selected:a.selected,confidence:a.confidence,probabilities:a.probabilities})),priority:urgent||value('priority')==='high'?'high':attention?'normal':'unknown',unresolvedQuestions:['Full thread context and owner intent may be needed.']});
  }else if(s.kind==='workflow')add('attention',[s],s.title,s.text,true,now,{suggestedNextStep:'Inspect Activity & approvals. No action has been authorized.'});
  else if(s.kind==='task'){
   try{const data=JSON.parse(s.text),due=data.due??data;const late=due.kind==='date'?due.date<new Intl.DateTimeFormat('en-CA',{timeZone:run.context.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(now):due.kind==='instant'&&Date.parse(due.at)<now;
    if(late)add('attention',[s],s.title,'The saved task due date has passed. Completion is not inferred.',true,now);
   }catch{/* Omitted structured detail is not evidence. */}
  }
 }
 const events=sources.filter(s=>s.kind==='calendar').flatMap(source=>{try{const d=JSON.parse(source.text);return d.status==='cancelled'?[]:[{source,time:d.time as {kind:string;start?:string;end?:string;startDate?:string;endDate?:string}}];}catch{return[];}});
 for(const e of events){if(e.time.kind==='timed'&&!e.time.end)add('missing-information',[e.source],e.source.title,'Event duration is unknown. Attendance, availability and travel time are not established.',true,now,{unresolvedQuestions:['What is the event end time?']});}
 for(let a=0;a<events.length;a++)for(const b of events.slice(a+1)){const x=events[a];if(x.time.kind!=='timed'||b.time.kind!=='timed')continue;const start=Date.parse(x.time.start??''),end=Date.parse(x.time.end??''),bs=Date.parse(b.time.start??''),be=Date.parse(b.time.end??'');if(start<be&&bs<end)add('conflict',[x.source,b.source],'Possible calendar overlap',`${x.source.title} and ${b.source.title} overlap in the supplied calendar. Attendance and a resolution are not established.`,true,now);}
 for(const t of sources.filter(s=>s.kind==='task')){try{const d=JSON.parse(t.text),due=d.due??d;if(due.kind!=='instant')continue;const time=Date.parse(due.at);const near=events.find(e=>e.time.kind==='timed'&&time>=Date.parse(e.time.start??'')&&time<=Date.parse(e.time.end??''));if(near)add('conflict',[t,near.source],'Task deadline near an event','The saved task deadline falls inside this event’s known time range. Task duration and attendance remain unknown.',true,now);}catch{/* No inferred due dates. */}}
 return result.slice(0,60);
}
export function backgroundMetadata(trigger:BackgroundRun['trigger'],authorityRevision:string,context:AgentContext,snapshot:BriefingSnapshot,settings:Settings,providerLimit:number):BackgroundRun{
 return{version:1,trigger,authorityRevision,sourceRevision:sourceDigest(context),reason:'Prepare bounded read-only insights from existing permitted sources.',snapshotId:snapshot.id,snapshotRevision:snapshot.revision,sourceGrants:context.items.map(s=>s.delivery?.ref??sourceRef(s)),settings:settings.backgroundIntelligence??backgroundDefaults,providerLimit,itemsInspected:Math.min(46,snapshot.entries.length+context.items.filter(s=>s.kind==='email').length),deterministicOperations:0,categories:['source-change','inbox','attention','conflict','briefing','context','classification'],insightIds:[],preparedContext:[],coverage:context.limitations};
}
