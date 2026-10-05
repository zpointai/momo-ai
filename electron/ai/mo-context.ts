import { ownerWork } from '../../src/shared/executive-work';
import type { AssistantSource, RunRequest } from '../../src/shared/assistant';
import type { MoRead } from '../../src/shared/mo';
import type { ResourceRef } from '../../src/shared/modules';
import type { StorageClient } from '../storage/client';
import type { GoogleService } from '../google/service';
import type { SituationService } from '../situation/service';
import { agentStateSchema, agentRunSchema } from '../../src/shared/orchestration';
import { addDays, dateInZone } from '../../src/shared/google';
import { freshnessState, weatherCondition } from '../../src/shared/situation';
import { hash } from '../agent/catalogue';
import { threadRevision } from '../mail/thread';
import { AppError } from '../errors';
import type { MailSearchOutcome } from '../../src/shared/voice';
import { explicitWeatherRefresh } from './weather-intent';

export interface MoReadResult {sources:AssistantSource[];warnings:string[];mailSearch?:MailSearchOutcome}

export class MoContext {
  constructor(private storage:Pick<StorageClient,'get'|'workspace'|'agent'>,private google:Pick<GoogleService,'inbox'|'summary'|'calendar'|'readMailThread'|'state'>,private situation:Pick<SituationService,'snapshot'>&Partial<Pick<SituationService,'command'>>){}
  async isProactive(input:RunRequest){if(!input.workId)return false;const run=agentRunSchema.parse(await this.storage.agent('get',input.workId));if(run.event.accountId!==input.accountId)throw new AppError('permission_denied','The selected work belongs to another account.');return !!run.desktopResponsibility?.proactive;}
  async authority(input:RunRequest){
    const settings=(await this.storage.get()).values,state=agentStateSchema.parse(await this.storage.agent('state'));
    if(state.config.paused||settings.disabledModules.includes('dashboard'))throw new AppError('permission_denied','Mo is paused or Dashboard is disabled. Review Settings.');
    if(input.accountId!==null){const google=await this.google.state();if(google.activeAccountId!==input.accountId||input.includeGoogle&&!google.accounts.some(a=>a.id===input.accountId&&a.status==='connected'))throw new AppError('cancelled','The selected account changed or needs reconnecting.');}
    return {settings,state};
  }
  async selectedWork(input:RunRequest){
    if(!input.workId)return null;const {state}=await this.authority(input);
    const run=agentRunSchema.parse(await this.storage.agent('get',input.workId));
    if(run.event.accountId!==input.accountId)throw new AppError('permission_denied','The selected work belongs to another account.');
    if(!input.includeLocal||!state.config.shareTasks)return {id:run.id,notice:'Selected work status is not shared. Ask the owner to include local workflow context.'};
    const w=ownerWork(run),sources=[...run.context.items,...run.executiveOrigin?.context.items??[]];
    // Summaries, blockers and objectives can quote source content too. A local
    // workflow grant must not bypass a revoked Google grant through those fields.
    if(sources.some(s=>s.kind==='email'||s.kind==='calendar'||s.delivery?.ref.connector==='google')&&(!input.includeGoogle||!state.config.shareGoogle))return {id:run.id,state:w.state,owner:w.owner,notice:'Source-derived work details are not shared. Include Inbox & calendar and enable its saved sharing grant to inspect them.'};
    return {id:run.id,objective:w.objective,state:w.state,owner:w.owner,nextStep:w.nextStep,blockers:w.blockers,proactive:run.desktopResponsibility?.proactive?{trigger:run.desktopResponsibility.proactive.pending?.detail??run.desktopResponsibility.proactive.events.at(-1)?.detail,paused:run.desktopResponsibility.proactive.paused,waitingReason:run.desktopResponsibility.proactive.waitingReason,reviewAt:run.desktopResponsibility.reviewAt,expiresAt:run.desktopResponsibility.expiresAt,specialists:run.desktopResponsibility.specialistScope}:undefined,assigned:run.team?.items.filter(i=>i.parentWorkItemId).map(i=>({specialist:i.role,status:i.status,result:i.resultSummary})),sources:(run.executiveOrigin?.context??run.context).items.map(s=>({type:s.kind,id:s.resourceId,label:s.title}))};
  }
  async read(input:RunRequest,request:MoRead,known:AssistantSource[],signal:AbortSignal):Promise<MoReadResult>{
    if(input.messageId&&request.sources.includes('inbox')){if(request.search||request.sourceId&&request.sourceId!==input.messageId)throw new AppError('permission_denied','This request is bound to its exact selected email.');request={...request,sourceId:input.messageId};}
    const {settings,state}=await this.authority(input),sources:AssistantSource[]=[],warnings:string[]=[];
    let mailSearch:MailSearchOutcome|undefined;
    if(request.refreshWeather&&(!request.sources.includes('weather')||input.mode!=='chat'||input.workId||!explicitWeatherRefresh(input.prompt)))throw new AppError('permission_denied','Weather refresh needs an explicit current owner request to refresh or check weather.');
    if(request.search&&(!request.sources.includes('inbox')||request.sourceId||input.workId||!request.search.sender&&!request.search.topic))throw new AppError('permission_denied','Search requires an explicit Inbox scope without an existing work binding.');
    const work=input.workId?agentRunSchema.parse(await this.storage.agent('get',input.workId)):null,scope=work?.desktopResponsibility?.proactive;
    if(scope){
     const permitted=new Set<string>(scope.resources.map(r=>r.type==='email'?'inbox':r.type==='task'?'tasks':r.type==='weather'?'weather':'agenda'));permitted.add('workflows');
     if(request.sources.some(s=>!permitted.has(s)))throw new AppError('permission_denied','That source is outside this responsibility’s approved scope.');
     if(request.sources.includes('inbox')&&request.sourceId&&!scope.resources.some(r=>r.type==='email'&&r.id===request.sourceId))throw new AppError('permission_denied','This email is outside the approved responsibility.');
     if(request.sources.includes('inbox')&&!request.sourceId){const refs=scope.resources.filter(r=>r.type==='email');if(refs.length!==1)throw new AppError('permission_denied','Choose an exact approved email.');request={...request,sourceId:refs[0].id};}
     if(request.sources.includes('agenda')){const refs=scope.resources.filter(r=>r.type==='calendarRange'||r.type==='calendar');const date=request.date??refs[0]?.date??refs[0]?.id;if(!refs.some(r=>(r.date??r.id)===date))throw new AppError('permission_denied','This date is outside the approved calendar source.');request={...request,date};}
    }
    const at=new Date().toISOString(),accountId=input.accountId??'local';
    const add=(kind:AssistantSource['kind'],id:string,label:string,detail:string,revision:string,fetchedAt=at,cached=false,ref?:ResourceRef)=>{
      const prefix={mail:'M',calendar:'E',task:'T',workflow:'W',weather:'S'}[kind];
      const existing=known.find(s=>s.kind===kind&&s.resourceId===id);
      const n=known.concat(sources).filter(s=>s.kind===kind).reduce((max,s)=>Math.max(max,Number(s.id.slice(1))),0)+1;
      const type=kind==='mail'?'email':kind==='workflow'?'briefing':kind;
      const nativeRef:ResourceRef=ref??{module:kind==='mail'?'inbox':kind==='workflow'?'dashboard':'planner',connector:kind==='mail'||kind==='calendar'?'google':'local',type,id,accountId:input.accountId,profile:'local',revision,label:label.slice(0,240),provenance:{kind:kind==='workflow'?'workflow':'connector',runId:null,fetchedAt},access:'read',retention:{kind:'transient',expiresAt:null}};
      sources.push({id:existing?.id??prefix+n,kind,accountId,resourceId:id,label:label.slice(0,240),detail:detail.slice(0,6000),fetchedAt,cached,ref:nativeRef});
    };
    for(const source of new Set(request.sources)){
      signal.throwIfAborted();
      const module=source==='agenda'||source==='tasks'?'planner':source==='weather'?'situation':source==='inbox'?'inbox':'dashboard';
      if(settings.disabledModules.includes(module)){warnings.push(`${source} is disabled. Open Settings to recover access.`);continue;}
      if(source==='inbox'||source==='agenda'){
        if(!input.includeGoogle||!input.accountId||!state.config.shareGoogle){warnings.push(`${source} was not read. Include Inbox & calendar and enable its saved sharing grant first.`);continue;}
        if(source==='inbox'){
          if(request.sourceId){
            const binding=known.find(s=>s.kind==='mail'&&s.resourceId===request.sourceId&&s.accountId===input.accountId);
            if(!binding&&input.messageId!==request.sourceId&&!scope?.resources.some(r=>r.type==='email'&&r.id===request.sourceId)){warnings.push('That message is not bound to this conversation. Read recent Inbox or select its exact source first.');continue;}
            const page=await this.google.summary({accountId:input.accountId,id:request.sourceId});
            const mail=page.messages.find(m=>m.id===request.sourceId);
            if(page.accountId!==input.accountId||!mail)throw new AppError('permission_denied','The message binding changed.');
            if(binding){let threadId:unknown;try{threadId=JSON.parse(binding.detail).threadId;}catch{/* Budgeted references may no longer contain the complete binding. */}if(threadId!==mail.threadId)throw new AppError('conflict','The selected thread binding is unavailable or changed. Search again.');}
            if(!binding&&!scope){add('mail',mail.id,mail.subject,JSON.stringify({from:mail.from,receivedAt:mail.receivedAt,snippet:mail.snippet,threadId:mail.threadId,partial:true}),hash(mail),page.fetchedAt,page.cached);warnings.push('Only the explicitly selected message snippet is included.');continue;}
            const thread=await this.google.readMailThread(input.accountId,mail.threadId);
            if(thread.accountId!==input.accountId||thread.id!==mail.threadId)throw new AppError('permission_denied','The thread binding changed.');
            if(scope?.pending&&Date.parse(thread.fetchedAt)<Date.parse(scope.pending.at))throw new AppError('conflict','The thread evidence predates the triggering change. Refresh the source before continuing.');
            const detail=JSON.stringify({threadId:thread.id,messages:thread.messages.map(m=>({from:m.message.from,at:m.message.receivedAt,text:m.text})),partial:thread.truncated||thread.messages.some(m=>m.truncated||!m.textAvailable)});
            if(detail.length>5600||thread.truncated||thread.messages.some(m=>m.truncated||!m.textAvailable)){warnings.push('The complete thread exceeds this conversation’s bound or is incomplete. Open Inbox for a grounded reply.');continue;}
            add('mail',mail.id,mail.subject,detail,threadRevision(thread),thread.fetchedAt);
          }else{
            const search=request.search;
            const literal=(value:string)=>{if(/["\\:{}\[\]\r\n]/.test(value))throw new AppError('invalid_input','Use a sender name or ordinary topic, not search operators.');return '"'+value+'"';};
            const query=search?[search.sender?'from:'+literal(search.sender):'',search.topic?literal(search.topic):''].filter(Boolean).join(' '):undefined;
            let inbox=await this.google.inbox({accountId:input.accountId,...(query?{folder:'all' as const,query,refresh:true}:{})});if(inbox.accountId!==input.accountId)throw new AppError('permission_denied','The Inbox account changed.');
            let senderOnly=false;
            // A translated topic may not occur literally in the original subject.
            // Keep the sender bound and return candidates, never a guessed match.
            if(search?.sender&&search.topic&&!inbox.messages.length&&!inbox.failed&&!inbox.nextPageToken){
              signal.throwIfAborted();const current=await this.authority(input);
              if(!current.state.config.shareGoogle||current.settings.disabledModules.includes('inbox'))throw new AppError('permission_denied','Inbox sharing changed during search.');
              inbox=await this.google.inbox({accountId:input.accountId,folder:'all',query:'from:'+literal(search.sender),refresh:true});
              if(inbox.accountId!==input.accountId)throw new AppError('permission_denied','The Inbox account changed.');
              senderOnly=true;
              warnings.push('The exact sender/topic search had no matches. These are sender-only candidates, not confirmed topic matches. Ask the owner which subject they mean before reading or preparing a reply.');
            }
            const sorted=[...inbox.messages].sort((a,b)=>Date.parse(b.receivedAt)-Date.parse(a.receivedAt));
            const senders=new Set(sorted.map(m=>(/<([^>]+)>/.exec(m.from)?.[1]??m.from).toLowerCase()));
            const ambiguousSender=!!search?.sender&&!search.sender.includes('@')&&senders.size>1;
            const selected=sorted.slice(0,search?.latest&&!ambiguousSender&&!senderOnly?1:8);
            if(search)mailSearch=senderOnly&&selected.length?'sender-candidates':inbox.failed||inbox.nextPageToken?'partial':!selected.length?'no-matches':'matched';
            for(const m of selected)add('mail',m.id,m.subject,JSON.stringify({from:m.from,receivedAt:m.receivedAt,snippet:m.snippet,threadId:m.threadId,partial:true}),hash(m),inbox.fetchedAt,inbox.cached);
            warnings.push(`${search?'Mail search':'Inbox'}: ${selected.length} snippets from one bounded page (up to 25 matches); no whole-mailbox certainty.${inbox.nextPageToken?' More results exist.':''}${inbox.failed?' Some messages failed to load.':''}${ambiguousSender?' Multiple sender identities match; ask which sender before selecting or reading a thread.':''}`);
            if(search&&!selected.length&&!inbox.failed&&!inbox.nextPageToken)warnings.push('No matching email was returned, not an access failure. Ask for the sender spelling or an original subject word; do not claim the email does not exist or repeat the same search.');
          }
        }else{
          const today=dateInZone(new Date(),settings.timezone),date=request.date??today;
          if(Math.abs(Date.parse(date)-Date.parse(today))>31*86400000||Number.isNaN(Date.parse(date)))throw new AppError('invalid_input','Choose an agenda date within 31 days.');
          const approvedEnd=scope?.calendarWindows.find(w=>w.startDate===date)?.endDate;
          const endDate=request.endDate??approvedEnd??addDays(date,request.date?1:7);
          if(!Number.isFinite(Date.parse(endDate))||endDate<=date||Date.parse(endDate)-Date.parse(date)>7*86400000||approvedEnd&&endDate!==approvedEnd)throw new AppError('permission_denied','Choose a permitted agenda range of up to seven days.');
          const calendar=await this.google.calendar({accountId:input.accountId,startDate:date,endDate,timezone:settings.timezone});
          if(calendar.accountId!==input.accountId)throw new AppError('permission_denied','The calendar account changed.');
          if(scope?.pending&&Date.parse(calendar.fetchedAt)<Date.parse(scope.pending.at))throw new AppError('conflict','Calendar evidence predates the triggering change. Refresh before continuing.');
          // The range itself is evidence, including an honestly empty calendar response.
          const partial=calendar.truncated||calendar.skipped>0||calendar.events.length>8;
          add('calendar','range:'+date,`Agenda ${date} to ${endDate}`,JSON.stringify({startDate:date,endDate,timezone:settings.timezone,events:calendar.events.slice(0,8).map(e=>({id:e.id,title:e.title,time:e.time,status:e.status})),partial,allDayEnd:'exclusive'}),hash(calendar),calendar.fetchedAt,calendar.cached,{module:'planner',connector:'google',type:'calendarRange',id:date,accountId:input.accountId,profile:'local',revision:hash(calendar),label:'Agenda '+date,provenance:{kind:'connector',runId:null,fetchedAt:calendar.fetchedAt},access:'read',retention:{kind:'transient',expiresAt:null},date,timezone:settings.timezone});
          warnings.push(`Primary calendar only; ${date} to ${endDate} in ${settings.timezone}.${partial?' Partial coverage; do not infer free time.':''}`);
        }
      }else if(source==='tasks'||source==='workflows'){
        if(!input.includeLocal||!state.config.shareTasks){warnings.push('Local context was not shared. Review Mo context and task sharing in Automations.');continue;}
        if(source==='tasks'){
          const tasks=(await this.storage.workspace()).tasks.filter(t=>(t.accountId??null)===input.accountId&&(!scope||scope.resources.some(r=>r.type==='task'&&r.id===t.id)));
          for(const t of tasks.slice(0,8))add('task',t.id,t.title,JSON.stringify({title:t.title,status:t.status,due:t.due,revision:t.revision}),hash(t));
          warnings.push(`Local tasks: ${Math.min(tasks.length,8)} of ${tasks.length} in this account scope.`);
        }else{
          const runs=agentRunSchema.array().parse(await this.storage.agent('runs')).filter(r=>r.event.accountId===input.accountId&&(input.workId?r.id===input.workId:r.id!==input.id)).filter(r=>input.includeGoogle&&state.config.shareGoogle||![...r.context.items,...r.executiveOrigin?.context.items??[]].some(s=>s.kind==='email'||s.kind==='calendar'||s.delivery?.ref.connector==='google'));
          for(const r of runs.slice(0,6))add('workflow',r.id,'Workflow status',JSON.stringify({work:(({objective,owner,state,nextStep,blockers,linkedActions,revision})=>({objective,owner,state,nextStep,blockers,linkedActions,revision}))(ownerWork(r)),status:r.status,stage:r.checkpoint,createdAt:r.createdAt,finishedAt:r.finishedAt,responsibility:r.desktopResponsibility?{objective:r.desktopResponsibility.objective,status:r.desktopResponsibility.status,trigger:r.desktopResponsibility.trigger,reviewAt:r.desktopResponsibility.reviewAt,expiresAt:r.desktopResponsibility.expiresAt,proactive:r.desktopResponsibility.proactive?{paused:r.desktopResponsibility.proactive.paused,waitingReason:r.desktopResponsibility.proactive.waitingReason,latestEvent:r.desktopResponsibility.proactive.events.at(-1)}:undefined}:r.responsibility?{status:r.responsibility.status,reviewAt:r.responsibility.reviewAt,expiresAt:r.responsibility.expiresAt}:null}),hash([r.status,r.checkpoint,r.finishedAt,r.desktopResponsibility?.revision,r.responsibility?.authorityRevision,r.executive?.revision]));
          warnings.push('Up to six workflow statuses; no email bodies, SMS text or workflow results are shared.');
        }
      }else{
        let snapshot=await this.situation.snapshot();
        if(!input.includeWeather||!snapshot.config.shareWithAI){warnings.push('Weather sharing is off. Review Mo context and Situation View permissions.');continue;}
        if(request.refreshWeather){
          const place=snapshot.config.locations.find(p=>p.id===snapshot.config.defaultLocationId);
          if(snapshot.reviewBlocked){warnings.push('Fresh weather requests are disabled for this review session. You cannot refresh weather during this call; do not offer to do so or ask for confirmation.');continue;}
          if(!snapshot.config.weatherEnabled||!place){warnings.push('Choose an explicit default saved place and enable Weather in Situation View before refreshing. Do not infer a place.');continue;}
          if(!this.situation.command){warnings.push('Weather refresh is unavailable in this session. Do not offer a refresh.');continue;}
          signal.throwIfAborted();const current=await this.authority(input);
          if(current.settings.disabledModules.includes('situation'))throw new AppError('permission_denied','Situation View is disabled.');
          snapshot=await this.situation.command({action:'refresh',source:'weather',locationId:place.id});
          signal.throwIfAborted();
          if(!snapshot.config.shareWithAI||snapshot.config.defaultLocationId!==place.id||!snapshot.config.locations.some(p=>p.id===place.id&&p.revision===place.revision))throw new AppError('conflict','Weather sharing or the saved place changed during refresh.');
        }
        const weather=snapshot.weather,status=snapshot.statuses.find(s=>s.source==='weather');
        if(request.refreshWeather&&weather&&weather.locationId!==snapshot.config.defaultLocationId)throw new AppError('conflict','Weather does not match the requested saved place.');
        if(!weather||!['available','partial'].includes(status?.state??'')||freshnessState(weather.freshness,Date.now())!=='current'){
          warnings.push(`Weather ${status?.state??'unavailable'}${weather?'; last fetched '+weather.freshness.fetchedAt:''}. No current conditions supplied.`);
          warnings.push(snapshot.reviewBlocked?'Fresh weather requests are disabled for this review session; do not offer to refresh or ask for confirmation.':request.refreshWeather?'The refresh did not return current weather. Do not claim success or retry automatically.':'The owner can explicitly ask to refresh weather for the default saved place. Do not claim it was refreshed.');continue;
        }
        const place=snapshot.config.locations.find(l=>l.id===weather.locationId&&l.revision===weather.locationRevision);
        if(!place){warnings.push('No explicit saved place matches this Weather evidence. Configure it in Situation View.');continue;}
        const label=place.label;
        const ref:ResourceRef={module:'situation',connector:'situation',type:'weather',id:weather.locationId,accountId:input.accountId,profile:'local',revision:hash([snapshot.config.revision,weather.freshness.revision]),label:'Weather · '+label,provenance:{kind:'connector',runId:null,fetchedAt:weather.freshness.fetchedAt},access:'read',retention:{kind:'transient',expiresAt:weather.freshness.freshUntil}};
        add('weather',weather.locationId,ref.label,JSON.stringify({place:label,timezone:place.timezone,temperatureC:weather.temperatureC,condition:weatherCondition(weather.code),precipitationMm:weather.precipitationMm,forecast:weather.forecast.map(f=>({...f,condition:weatherCondition(f.code)})),fetchedAt:weather.freshness.fetchedAt,ageMinutes:Math.floor((Date.now()-Date.parse(weather.freshness.fetchedAt))/60000),freshUntil:weather.freshness.freshUntil,partial:weather.partial,source:weather.freshness.attribution}),ref.revision,weather.freshness.fetchedAt,true,ref);
      }
    }
    signal.throwIfAborted();await this.authority(input);return {sources,warnings,...(mailSearch?{mailSearch}:{})};
  }
  async validate(input:RunRequest,sources:AssistantSource[],signal:AbortSignal){
    const {settings,state}=await this.authority(input);signal.throwIfAborted();
    for(const source of sources){
      if(source.ref?.accountId!==input.accountId||source.ref.profile!=='local'||source.accountId!==(input.accountId??'local'))throw new AppError('permission_denied','The source account or profile changed.');
      if(['mail','calendar'].includes(source.kind)&&(!input.includeGoogle||!state.config.shareGoogle))throw new AppError('permission_denied','Google context is no longer shared.');
      if(!source.ref||settings.disabledModules.includes(source.ref.module))throw new AppError('permission_denied','A source is no longer enabled.');
      if(['task','workflow'].includes(source.kind)&&(!input.includeLocal||!state.config.shareTasks))throw new AppError('permission_denied','Local sharing changed.');
      if(source.kind==='task'){const task=(await this.storage.workspace()).tasks.find(t=>t.id===source.resourceId);if(!task||hash(task)!==source.ref.revision)throw new AppError('conflict','The task changed during this request.');}
      if(source.kind==='workflow'){const run=agentRunSchema.array().parse(await this.storage.agent('runs')).find(r=>r.id===source.resourceId&&r.event.accountId===input.accountId);if(!run||hash([run.status,run.checkpoint,run.finishedAt,run.desktopResponsibility?.revision,run.responsibility?.authorityRevision,run.executive?.revision])!==source.ref.revision)throw new AppError('conflict','Workflow status changed during this request.');}
      if(source.kind==='weather'){const snapshot=await this.situation.snapshot();if(!snapshot.config.shareWithAI||!snapshot.weather||hash([snapshot.config.revision,snapshot.weather.freshness.revision])!==source.ref.revision||!['available','partial'].includes(snapshot.statuses.find(s=>s.source==='weather')?.state??'')||Date.parse(source.ref.retention.expiresAt??'')<=Date.now())throw new AppError('permission_denied','Weather evidence or sharing changed.');}
      else if(Date.now()-Date.parse(source.fetchedAt)>300000)throw new AppError('unavailable','Source evidence expired. Ask again to refresh it.');
    }
  }
}
