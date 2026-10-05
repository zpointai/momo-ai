// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {executiveFixture} from '../evaluation/mo-executive-fixture';
import {agentStateSchema} from '../src/shared/orchestration';
import {ownerWork} from '../src/shared/executive-work';
import {workItems} from '../src/shared/work';
import {calendarEvents,inboxEvents,taskEvents,filterProactive,correlateEvent,proactivePermitted} from '../electron/agent/proactive';
import {hash} from '../electron/agent/catalogue';
import type {CalendarData,InboxData} from '../src/shared/google';
import {stableTaskId} from '../src/desktop/WorkspaceControls';
import {AgentRepository} from '../electron/agent/store';
const cleaners:(()=>Promise<void>)[]=[];afterEach(async()=>{for(const close of cleaners.splice(0))await close();});
const response=(extra:object={})=>({model:'deepseek-flash',usage:{prompt_tokens:100,completion_tokens:30},choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({answer:'The linked task was reviewed [T1].',citations:['T1'],suggestions:[],...extra})}}]});
const planner=()=>({model:'deepseek-flash',usage:{prompt_tokens:100,completion_tokens:30},choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:randomUUID(),type:'function',function:{name:'delegate_work',arguments:JSON.stringify({specialist:'planner',objective:'Review the approved linked task',sources:['tasks'],sourceId:null,date:null})}}]}}]});
function setup(responses:unknown[]=[planner(),response()]){
 const fetcher=vi.fn(async(..._args:Parameters<typeof fetch>)=>Response.json(responses.shift())),f=executiveFixture(fetcher as typeof fetch);cleaners.push(()=>f.close());Object.defineProperty(f.orchestration,'snapshot',{value:async()=>({state:agentStateSchema.parse(f.db.agent('state')),runs:f.roots()})});return {...f,fetcher};
}
async function watch(f:ReturnType<typeof setup>){
 const taskId=randomUUID();f.db.taskCommand({action:'create',id:taskId,accountId:'accountA',draft:{title:'Synthetic linked task',due:{kind:'none'}}});
 const id=randomUUID(),reviewAt=new Date(Date.now()+86400000).toISOString(),expiresAt=new Date(Date.now()+2*86400000).toISOString();await f.orchestration.command({action:'createDesktopResponsibility',id,conversationId:id,taskId,objective:'Keep the linked task on track',reviewAt,expiresAt});await f.orchestration.command({action:'watchWork',id,expectedRevision:0,triggers:['source-change','task-due','task-completed'],reviewAt,expiresAt});await f.orchestration.observeNative([]);return {id,taskId};
}
function change(f:ReturnType<typeof setup>,id:string,title='Updated synthetic task',status:'open'|'done'='open'){
 const t=f.db.workspace().tasks.find(t=>t.id===id)!;f.db.taskCommand({action:'update',id,expectedRevision:t.revision,status,draft:{title,due:t.due}});return taskEvents(f.db.workspace().tasks,'accountA',Date.now()).find(e=>e.resourceId===id)!;
}
const projection=(f:ReturnType<typeof setup>)=>workItems({state:agentStateSchema.parse(f.db.agent('state')),runs:f.roots()},f.db.workspace(),'accountA');
it('uses native baseline/no-op filtering before one typed Planner handoff on the same approved root',async()=>{
 const f=setup(),{id,taskId}=await watch(f);expect(f.fetcher).not.toHaveBeenCalled();expect(projection(f)[0].group).toBe('Waiting');const event=change(f,taskId);await f.orchestration.observeNative([event,event,event]);await f.service.idle();const run=f.roots()[0];expect(f.roots()).toHaveLength(1);expect(run.id).toBe(id);expect(run.executive?.state).toBe('completed');expect(run.desktopResponsibility?.status).toBe('waiting');expect(run.team?.items.map(w=>w.role)).toEqual(['executive','planner']);expect(f.fetcher).toHaveBeenCalledTimes(2);expect(projection(f)[0]).toMatchObject({attention:false,group:'Waiting'});expect(f.db.workspace().runs[0]).toMatchObject({provider:'deepseek',requestedModel:'deepseek-flash',reportedModel:'deepseek-flash',usage:{input:200,output:60}});
});
it('ignores low-value Inbox unread, Calendar etag/order and task revision/reminder changes',()=>{
 const at=new Date().toISOString(),inbox={accountId:'a',fetchedAt:at,messages:[{id:'m',threadId:'t',subject:'Subject',snippet:'Same body',from:'a',to:'b',receivedAt:at,unread:true}]} as InboxData;
 expect(inboxEvents(inbox)[0].revision).toBe(inboxEvents({...inbox,messages:inbox.messages.map(m=>({...m,unread:false}))})[0].revision);
 const e={id:'e',title:'Meeting',location:'',status:'confirmed',recurringEventId:null,originalStart:null,time:{kind:'allDay',startDate:'2026-10-01',endDate:'2026-10-02'}},calendar={accountId:'a',fetchedAt:at,startDate:'2026-10-01',endDate:'2026-10-02',timezone:'Europe/Amsterdam',events:[e],truncated:false,skipped:0} as CalendarData;
 expect(calendarEvents(calendar)[0].revision).toBe(calendarEvents({...calendar,events:calendar.events.map(e=>({...e,etag:'new'}))})[0].revision);
});
it('suppresses repeated events after the result and records no extra drafts or approvals',async()=>{
 const f=setup(),{taskId}=await watch(f),event=change(f,taskId);await f.orchestration.observeNative([event]);await f.service.idle();await f.orchestration.observeNative([event,{...event,at:new Date().toISOString()}]);expect(f.fetcher).toHaveBeenCalledTimes(2);expect(f.roots()).toHaveLength(1);expect(f.roots()[0].executive?.proposals).toEqual([]);expect(f.db.workspace().runs).toHaveLength(1);
});
it('consolidates a further approved wake into the original Executive root and preserves its previous turn',async()=>{
 const f=setup([planner(),response(),planner(),response()]),{taskId}=await watch(f);await f.orchestration.observeNative([change(f,taskId)]);await f.service.idle();const old=f.roots()[0],next=structuredClone(old);next.desktopResponsibility!.proactive!.lastWakeAt=new Date(Date.now()-16*60000).toISOString();f.db.agent('proactiveUpdate',{expected:old,next});await f.orchestration.observeNative([change(f,taskId,'A second substantive title change')]);await f.service.idle();expect(f.roots()).toHaveLength(1);expect(f.roots()[0].executiveHistory).toHaveLength(1);expect(f.fetcher).toHaveBeenCalledTimes(4);
});
it('holds ambiguous root correlation without invoking a model',async()=>{
 const f=setup([]),{taskId}=await watch(f),first=f.roots()[0],second=structuredClone(first);second.id=randomUUID();second.event.id=second.id;second.dedup=hash(second.id);f.db.agent('enqueue',second);const event=change(f,taskId);expect(correlateEvent(f.roots(),event)).toHaveLength(2);await f.orchestration.observeNative([event]);expect(f.fetcher).not.toHaveBeenCalled();expect(f.roots().every(r=>r.desktopResponsibility?.status==='review')).toBe(true);expect(projection(f).every(i=>i.group==='Needs you')).toBe(true);
});
it('bounds wake frequency and retains the meaningful event for owner review',async()=>{
 const f=setup(),{taskId}=await watch(f);await f.orchestration.observeNative([change(f,taskId)]);await f.service.idle();await f.orchestration.observeNative([change(f,taskId,'Another meaningful change')]);expect(f.fetcher).toHaveBeenCalledTimes(2);expect(f.roots()[0].desktopResponsibility?.proactive?.waitingReason).toContain('wake limit');expect(projection(f)[0].attention).toBe(true);
});
it.each(['pause','cancel'] as const)('owner %s rejects pending and late model output',async action=>{
 const f=setup([]),{id,taskId}=await watch(f);let release!:(r:Response)=>void;f.fetcher.mockImplementation(()=>new Promise(resolve=>{release=resolve;}));await f.orchestration.observeNative([change(f,taskId)]);await vi.waitFor(()=>expect(f.fetcher).toHaveBeenCalledOnce());const run=f.roots()[0];await f.orchestration.command({action:'changeDesktopResponsibility',id,expectedRevision:run.desktopResponsibility!.revision,change:action});release(Response.json(response()));await f.service.idle();expect(f.db.workspace().runs[0].result).toBeNull();expect(f.roots()[0].desktopResponsibility?.proactive?.pending).toBeNull();expect(ownerWork(f.roots()[0]).state).toBe(action==='pause'?'waiting':'cancelled');
});
it('supersedes an in-flight source revision without reviving or duplicating work',async()=>{
 const f=setup([]),{taskId}=await watch(f);let release!:(r:Response)=>void;f.fetcher.mockImplementation(()=>new Promise(resolve=>{release=resolve;}));await f.orchestration.observeNative([change(f,taskId)]);await vi.waitFor(()=>expect(f.fetcher).toHaveBeenCalledOnce());await f.orchestration.observeNative([change(f,taskId,'Newer source while pending')]);release(Response.json(response()));await f.service.idle();expect(f.db.workspace().runs[0].result).toBeNull();expect(f.roots()[0].executive?.state).toBe('stale');expect(f.fetcher).toHaveBeenCalledOnce();
});
it('rejects source sharing revoked mid-work before saving a current result',async()=>{
 const f=setup([]),{taskId}=await watch(f);let release!:(r:Response)=>void;f.fetcher.mockImplementation(()=>new Promise(resolve=>{release=resolve;}));await f.orchestration.observeNative([change(f,taskId)]);await vi.waitFor(()=>expect(f.fetcher).toHaveBeenCalledOnce());const state=agentStateSchema.parse(f.db.agent('state'));state.revision++;state.config.shareTasks=false;f.db.agent('saveState',state);release(Response.json(response()));await f.service.idle();expect(f.db.workspace().runs[0].result).toBeNull();expect(projection(f)[0].attention).toBe(true);
});
it('rejects stale events before waking Mo',async()=>{
 const f=setup([]),{taskId}=await watch(f),event=change(f,taskId);await f.orchestration.observeNative([{...event,expiresAt:new Date(Date.now()-1).toISOString()}]);expect(f.fetcher).not.toHaveBeenCalled();expect(f.roots()[0].desktopResponsibility?.status).toBe('waiting');
});
it('confirms linked-task completion natively and clears attention on the original root',async()=>{
 const f=setup([]),{id,taskId}=await watch(f);await f.orchestration.observeNative([change(f,taskId,'Completed task','done')]);expect(f.fetcher).not.toHaveBeenCalled();expect(projection(f)[0]).toMatchObject({attention:false,group:'Recently completed',run:{id},view:{state:'completed'}});
});
it('expires and pauses through existing controls; resume watches future changes without replay',async()=>{
 const f=setup([]),{id,taskId}=await watch(f);let r=f.roots()[0];await f.orchestration.command({action:'changeDesktopResponsibility',id,expectedRevision:r.desktopResponsibility!.revision,change:'pause'});await f.orchestration.observeNative([change(f,taskId)]);expect(f.fetcher).not.toHaveBeenCalled();r=f.roots()[0];await f.orchestration.command({action:'changeDesktopResponsibility',id,expectedRevision:r.desktopResponsibility!.revision,change:'resume'});expect(f.fetcher).not.toHaveBeenCalled();r=f.roots()[0];expect(proactivePermitted(r,agentStateSchema.parse(f.db.agent('state')),f.db.get().values,'accountA',Date.parse(r.desktopResponsibility!.expiresAt)+1)).toContain('expired');
});
it('refuses capabilities and local tasks outside the approved source set',async()=>{
 const f=setup([]),{id}=await watch(f),other=randomUUID();f.db.taskCommand({action:'create',id:other,accountId:'accountA',draft:{title:'Unrelated private task',due:{kind:'none'}}});const read=await f.native.read({...f.input,workId:id},{sources:['tasks'],date:null,sourceId:null},[],new AbortController().signal);expect(read.sources).toHaveLength(1);expect(JSON.stringify(read.sources)).not.toContain('Unrelated private task');await expect(f.native.read({...f.input,workId:id},{sources:['weather'],date:null,sourceId:null},[],new AbortController().signal)).rejects.toThrow('approved scope');
});
it('only records baseline when an equivalent event already exists, including out-of-order input',async()=>{
 const f=setup([]),{taskId}=await watch(f),run=f.roots()[0],event=taskEvents(f.db.workspace().tasks,'accountA',Date.now()).find(e=>e.resourceId===taskId)!;expect(filterProactive(run,event,[run],Date.now())).toBe('ignore');expect(filterProactive(run,{...event,revision:hash('old'),at:new Date(Date.now()-60000).toISOString()},[run],Date.now())).toBe('ignore');
});
it('keeps a prepared decision visible when tracking is paused, and clears it only after its receipt',async()=>{
 const f=setup([planner(),response({suggestions:[{title:'Review the changed task',sourceIds:['T1']}]})]),{id,taskId}=await watch(f);await f.orchestration.observeNative([change(f,taskId)]);await f.service.idle();let r=f.roots()[0];expect(projection(f)[0]).toMatchObject({attention:true,group:'Needs you',view:{state:'prepared'}});
 await f.orchestration.command({action:'changeDesktopResponsibility',id,expectedRevision:r.desktopResponsibility!.revision,change:'pause'});expect(projection(f)[0].attention).toBe(true);r=f.roots()[0];
 const created=await stableTaskId(r.executive!.assistantRunId+':0');f.db.taskCommand({action:'create',id:created,accountId:'accountA',draft:{title:'Review the changed task',due:{kind:'none'}}});f.db.agent('projectExecutiveOutcomes');expect(projection(f)[0]).toMatchObject({attention:false,group:'Waiting'});
});
it('holds a deleted linked source and permits an explicit renewed scope review without replay',async()=>{
 const f=setup([]),{id,taskId}=await watch(f),event=change(f,taskId);await f.orchestration.observeNative([{...event,removed:true}]);expect(projection(f)[0]).toMatchObject({attention:true,group:'Needs you',view:{state:'needs-owner'}});const r=f.roots()[0];
 await f.orchestration.command({action:'watchWork',id,expectedRevision:r.desktopResponsibility!.revision,triggers:['source-change'],reviewAt:new Date(Date.now()+86400000).toISOString(),expiresAt:new Date(Date.now()+2*86400000).toISOString()});expect(f.fetcher).not.toHaveBeenCalled();expect(projection(f)[0].group).toBe('Waiting');
});
it('rejects capability expansion and expired or changed-policy approval before model dispatch',async()=>{
 const f=setup([]),{taskId}=await watch(f),r=f.roots()[0];const state=agentStateSchema.parse(f.db.agent('state'));state.revision++;f.db.agent('saveState',state);await f.orchestration.observeNative([change(f,taskId)]);expect(f.fetcher).not.toHaveBeenCalled();expect(projection(f)[0]).toMatchObject({attention:true,group:'Needs you'});expect(proactivePermitted(r,state,f.db.get().values,'accountA',Date.parse(r.desktopResponsibility!.reviewAt)+1)).toContain('review is due');
});
it('rejects an unapproved specialist rather than adding another provider or role',async()=>{
 const tool=planner();tool.choices[0].message.tool_calls[0].function.arguments=JSON.stringify({specialist:'briefing',objective:'Read more',sources:['tasks'],sourceId:null,date:null});const f=setup([tool]),{taskId}=await watch(f);await f.orchestration.observeNative([change(f,taskId)]);await f.service.idle();expect(f.fetcher).toHaveBeenCalledOnce();expect(f.db.workspace().runs[0].result).toBeNull();expect(f.roots()[0].team?.items).toHaveLength(1);expect(projection(f)[0].group).toBe('Needs you');
});
it('recovers an interrupted wake to owner review without replaying it',async()=>{
 const f=setup([]),{taskId}=await watch(f),old=f.roots()[0],next=structuredClone(old),at=new Date().toISOString(),assistantRunId=randomUUID();next.status='running';next.executive={assistantRunId,conversationId:next.id,revision:0,state:'working',nextStep:'Synthetic crash checkpoint'};next.desktopResponsibility!.proactive!.pending={id:hash('interrupted'),assistantRunId,at,trigger:'source-change',detail:'Interrupted native change'};f.db.agent('proactiveUpdate',{expected:old,next});
 // Exercise the same repository recovery invoked by SettingsDatabase on startup.
 new AgentRepository((f.db as unknown as {db:ConstructorParameters<typeof AgentRepository>[0]}).db).recover();expect(ownerWork(f.roots()[0]).state).toBe('blocked');await f.orchestration.observeNative([change(f,taskId)]);expect(f.fetcher).not.toHaveBeenCalled();expect(f.roots()).toHaveLength(1);expect(projection(f)[0].group).toBe('Needs you');
});
it('correlates new mail only to a verified approved thread and rejects a different calendar window',async()=>{
 const f=setup([]);await watch(f);const run=structuredClone(f.roots()[0]),p=run.desktopResponsibility!.proactive!,now=Date.now();p.approvedAt=new Date(now-60000).toISOString();p.resources=[{...p.resources[0],type:'email',id:'mail1',module:'inbox',connector:'google'}];p.mailThreads=[{sourceId:'mail1',threadId:'thread1'}];p.observations=[];p.events=[];
 const data={accountId:'accountA',fetchedAt:new Date(now).toISOString(),messages:[{id:'mail2',threadId:'thread1',subject:'New reply',from:'a',to:'b',snippet:'New detail',receivedAt:new Date(now).toISOString(),unread:true}]} as InboxData,event=inboxEvents(data)[0];expect(correlateEvent([run],event)).toEqual([run]);expect(filterProactive(run,event,[run],now)).toBe('wake');expect(correlateEvent([run],{...event,threadId:'other'})).toEqual([]);
 p.resources=[{...p.resources[0],type:'calendarRange',id:'2026-10-01',module:'planner'}];p.calendarWindows=[{sourceId:'2026-10-01',startDate:'2026-10-01',endDate:'2026-10-08',timezone:'Europe/Amsterdam'}];const calendar={...event,type:'calendarRange' as const,resourceId:'2026-10-01',endDate:'2026-10-02',timezone:'Europe/Amsterdam'};expect(correlateEvent([run],calendar)).toEqual([]);expect(correlateEvent([run],{...calendar,endDate:'2026-10-08'})).toHaveLength(1);
});
it('filters task bookkeeping and retains daily/global/lifetime bounds before any model call',async()=>{
 const f=setup([]),{taskId}=await watch(f),tasks=f.db.workspace().tasks;expect(taskEvents(tasks,'accountA',Date.now())[0].revision).toBe(taskEvents(tasks.map(t=>({...t,revision:t.revision+1,remindedAt:new Date().toISOString()})),'accountA',Date.now())[0].revision);
 const base=f.roots()[0],event=change(f,taskId);for(const limit of ['daily','global','lifetime']){const run=structuredClone(base),p=run.desktopResponsibility!.proactive!,now=Date.now(),count=limit==='daily'?4:limit==='global'?6:12;p.lastWakeAt=null;p.events=Array.from({length:count},(_,i)=>({id:hash('wake'+i),at:new Date(now-(limit==='lifetime'?2*86400000:limit==='daily'?2*3600000:1000)).toISOString(),trigger:'source-change',sourceKey:'task:'+taskId,revision:hash('prior'+i),detail:'Earlier wake',outcome:'wake'}));expect(filterProactive(run,event,[run],now)).toBe('save');expect(p.waitingReason).toContain('wake limit');}expect(f.fetcher).not.toHaveBeenCalled();
});
