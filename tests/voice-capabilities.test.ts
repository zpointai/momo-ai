// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { executiveFixture } from '../evaluation/mo-executive-fixture';
import { emptyVoiceCallContext, rememberVoiceMail, voiceMailReference } from '../electron/ai/voice-context';
import { VoiceTaskConfirmation, normalizeVoiceTask, voiceTaskReadback, type VoiceActionBinding } from '../electron/ai/voice-confirmation';
import { voiceCapabilities, moCapabilities } from '../src/shared/mo-capabilities';
import { voiceTrafficLimitation } from '../electron/ai/voice-traffic';
import { agentStateSchema } from '../src/shared/orchestration';
import type { AssistantRun, AssistantSource } from '../src/shared/assistant';
import type { VoiceSession } from '../src/shared/voice';
import { addDays, dateInZone } from '../src/shared/google';
import { MoContext } from '../electron/ai/mo-context';
import { emptySituationConfig, type SituationSnapshot } from '../src/shared/situation';
import { VoiceFailure, voiceFailureCategory } from '../electron/ai/voice-failure';
import { AppError } from '../electron/errors';
import { SessionRequestLimit } from '../electron/ai/session-authority';

const close:(()=>Promise<void>)[]=[];afterEach(async()=>{for(const fn of close.splice(0))await fn();vi.restoreAllMocks();});
const answer=(text='Done.',extra:object={})=>({answer:text,citations:[],suggestions:[],...extra});
const response=(value:object,tool?:string)=>({model:'deepseek-flash',usage:{prompt_tokens:150,completion_tokens:40},choices:[{finish_reason:tool?'tool_calls':'stop',message:{role:'assistant',content:tool?null:JSON.stringify(value),...(tool?{tool_calls:[{id:randomUUID(),type:'function',function:{name:tool,arguments:JSON.stringify(value)}}]}:{})}}]});
const search={specialist:'inbox',objective:'Find the requested message',sources:['inbox'],date:null,endDate:null,sourceId:null,search:{sender:'fixture@example.test',topic:null,latest:true}};
const task={title:'Synthetic owner task',date:'2026-10-03',time:'09:30'};
function fixture(responses:unknown[]=[]){
 const bodies:unknown[]=[];const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{bodies.push(JSON.parse(String(init?.body)));return Response.json(responses.shift());});
 const f=executiveFixture(fetcher as typeof fetch);close.push(()=>f.close());const context=emptyVoiceCallContext(),confirmation=new VoiceTaskConfirmation();let history:AssistantRun[]=[],generation=0;
 const session:VoiceSession={id:randomUUID(),conversationId:randomUUID(),callSid:'CA'+'b'.repeat(32),ownerId:randomUUID(),startedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+600000).toISOString(),scope:'read-prepare',authentication:'caller-and-pin'};
 const guard=vi.fn(async()=>{});
 return {...f,fetcher,bodies,context,confirmation,session,guard,async voice(prompt:string,allow=true){const run=await f.service.start({...f.input,id:randomUUID(),conversationId:session.conversationId,prompt},undefined,undefined,{session,retainHistory:false,history,context,confirmation,generation:++generation,allowLocalTaskCreate:allow,guard});await f.service.idle();history=[run,...history].slice(0,3);return run;}};
}
function binding():VoiceActionBinding{return {sessionId:randomUUID(),callSid:'CA'+'a'.repeat(32),accountId:'accountA',profile:'local',generation:1,authorityHash:'hash',authorityRevision:1,settingsRevision:1,expiresAt:Date.now()+600000};}

it('shares a typed capability registry with only confirmed calendar creation as a Voice external action',()=>{
 expect(new Set(moCapabilities.map(c=>c.id)).size).toBe(moCapabilities.length);
 expect(voiceCapabilities().filter(c=>c.actionClass==='LOCAL_ACTION').map(c=>c.id)).toEqual(['task.create']);
 expect(voiceCapabilities().filter(c=>c.actionClass==='EXTERNAL_ACTION').map(c=>c.id)).toEqual(['calendar.create']);
 expect(voiceCapabilities().some(c=>c.id==='traffic.read')).toBe(false);
 for(const c of moCapabilities)for(const field of ['native','grant','freshness','confirmation','output','retention'] as const)expect(c[field].length).toBeGreaterThan(3);
});
it('searches a bounded literal sender/topic through the existing Gmail service',async()=>{
 const f=fixture(),read=vi.spyOn(f.google,'inbox');const out=await f.native.read(f.input,{sources:['inbox'],date:null,sourceId:null,search:{sender:'fixture@example.test',topic:'Review meeting',latest:true}},[],new AbortController().signal);
 expect(read).toHaveBeenCalledWith({accountId:'accountA',folder:'all',query:'from:"fixture@example.test" "Review meeting"',refresh:true});expect(out.sources).toHaveLength(1);expect(out.warnings.join(' ')).toContain('bounded page');
 await expect(f.native.read(f.input,{sources:['inbox'],date:null,sourceId:null,search:{sender:'from:other',topic:null,latest:true}},[],new AbortController().signal)).rejects.toThrow('search operators');
});
it('binds exact follow-ups and prepared replies to refreshed native thread evidence with history off',async()=>{
 const f=fixture([response(search,'delegate_work'),response(answer('One message [M1]',{citations:['M1']})),response(answer('It asks to meet [M1]',{citations:['M1']})),response(answer('Prepared [M1]',{citations:['M1'],reply:{sourceId:'M1',body:'I will review the meeting.'}})),response(answer('Shortened [M1]',{citations:['M1'],reply:{sourceId:'M1',body:'I will review it.'}}))]);
 expect((await f.voice('Find the latest email from fixture@example.test')).status).toBe('succeeded');
 const follow=await f.voice('What is that email about?');expect(follow.error).toBeNull();expect(follow.sources[0].resourceId).toBe('mail1');expect(follow.sources[0].detail).toContain('"threadId":"thread1"');
 const reply=await f.voice('Prepare a reply');expect(reply.error).toBeNull();expect(reply.result?.reply?.body).toContain('meeting');
 const shorter=await f.voice('Make it shorter');expect(shorter.error).toBeNull();expect(shorter.result?.reply?.sourceId).toBe('M1');expect(f.reads.filter(s=>s==='thread')).toHaveLength(3);
 expect(JSON.stringify(f.bodies[4])).toContain('I will review the meeting.');expect(follow.voiceDiagnostics?.capabilities).toEqual(['inbox.thread']);
 expect(f.db.getRun(follow.id)?.result).toBeNull();expect(f.db.getRun(follow.id)?.sources).toEqual([]);expect(f.db.workspace().tasks).toEqual([]);
});
it('recovers translated-topic misses with one sender-only page and requires a candidate choice',async()=>{
 const f=fixture([response({...search,search:{sender:'voorbeeld.test',topic:'Appointment confirmation',latest:true}},'delegate_work'),response(answer('I found a Dutch appointment message. Is that the one?',{clarification:'Which message do you mean?',citations:['M1']})),response(answer('It confirms your appointment.',{citations:['M1']}))]);
 const page=await f.google.inbox(),mail={...page.messages[0],subject:'Bevestiging afspraak',from:'Voorbeeld <noreply@voorbeeld.test>'};
 const read=vi.spyOn(f.google,'inbox').mockResolvedValueOnce({...page,messages:[]}).mockResolvedValueOnce({...page,messages:[mail,{...mail,id:'mail2',threadId:'thread2',subject:'Herinnering afspraak'}]});
 const run=await f.voice('Find the appointment confirmation from voorbeeld.test');
 expect(run.status).toBe('succeeded');expect(run.voiceDiagnostics?.mailSearch).toBe('sender-candidates');expect(read).toHaveBeenCalledTimes(2);
 expect(read).toHaveBeenNthCalledWith(1,{accountId:'accountA',folder:'all',query:'from:"voorbeeld.test" "Appointment confirmation"',refresh:true});
 expect(read).toHaveBeenNthCalledWith(2,{accountId:'accountA',folder:'all',query:'from:"voorbeeld.test"',refresh:true});
 expect(f.context.mailCandidates).toHaveLength(2);expect(voiceMailReference('Prepare a reply',f.context).clarify).toBe(true);
 expect(f.context.mailCandidates[0].label).toBe('Bevestiging afspraak');expect(JSON.stringify(f.bodies.at(-1))).toContain('not confirmed topic matches');
 expect((await f.voice('Read the first one')).status).toBe('succeeded');expect(f.context.selectedMail?.resourceId).toBe('mail1');
});
it('does not silently select a lone sender-only fallback candidate',()=>{
 const context=emptyVoiceCallContext();rememberVoiceMail(context,[{id:'M1',kind:'mail',resourceId:'mail1',accountId:'accountA'} as AssistantSource],true,null,true);
 expect(voiceMailReference('Write a reply',context).clarify).toBe(true);expect(voiceMailReference('Read the first one',context).source?.resourceId).toBe('mail1');
});
it('blocks a model from reading an unconfirmed fallback candidate in the same turn',async()=>{
 const f=fixture([response({...search,search:{sender:'voorbeeld.test',topic:'Appointment',latest:true}},'delegate_work'),response({...search,sourceId:'mail1',search:null},'delegate_work')]);
 const page=await f.google.inbox();vi.spyOn(f.google,'inbox').mockResolvedValueOnce({...page,messages:[]}).mockResolvedValueOnce(page);const thread=vi.spyOn(f.google,'readMailThread');
 const searched=await f.voice('Find the appointment email from voorbeeld.test');
 expect(searched.result?.clarification).toBeTruthy();expect(thread).not.toHaveBeenCalled();expect(searched.result?.reply).toBeUndefined();expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it('records no matches separately from source access failure without retaining search text',async()=>{
 const f=fixture([response(search,'delegate_work'),response(answer('Could you spell the sender name?',{clarification:'Could you spell the sender name?'}))]);
 const page=await f.google.inbox(),read=vi.spyOn(f.google,'inbox').mockResolvedValue({...page,messages:[]});
 const run=await f.voice('Find the latest email from fixture@example.test');
 expect(read).toHaveBeenCalledOnce();expect(run.voiceDiagnostics?.mailSearch).toBe('no-matches');expect(run.voiceDiagnostics?.failureCategory).toBeUndefined();
 expect(f.db.getRun(run.id)?.voiceDiagnostics?.mailSearch).toBe('no-matches');expect(JSON.stringify(f.db.getRun(run.id))).not.toContain('fixture@example.test');
 expect(JSON.stringify(f.bodies.at(-1))).toContain('not an access failure');
});
it('does not broaden failed, incomplete, invalid or topic-only searches',async()=>{
 const f=fixture(),page=await f.google.inbox(),read=vi.spyOn(f.google,'inbox'),request={sources:['inbox'] as ['inbox'],date:null,sourceId:null,search:{sender:'voorbeeld.test',topic:'Appointment',latest:true}},signal=new AbortController().signal;
 for(const patch of [{failed:1},{nextPageToken:'next'}]){read.mockClear();read.mockResolvedValue({...page,messages:[],...patch});const out=await f.native.read(f.input,request,[],signal);expect(out.mailSearch).toBe('partial');expect(read).toHaveBeenCalledOnce();}
 read.mockClear();read.mockRejectedValueOnce(new AppError('unavailable','Synthetic outage'));await expect(f.native.read(f.input,request,[],signal)).rejects.toThrow('Synthetic outage');expect(read).toHaveBeenCalledOnce();
 read.mockClear();read.mockResolvedValue({...page,messages:[]});await f.native.read(f.input,{...request,search:{...request.search,sender:null}},[],signal);expect(read).toHaveBeenCalledOnce();
 read.mockClear();await expect(f.native.read(f.input,{...request,search:{...request.search,sender:'from:other'}},[],signal)).rejects.toThrow('search operators');expect(read).not.toHaveBeenCalled();
});
it('rechecks cancellation, sharing and account binding before accepting a fallback page',async()=>{
 for(const change of ['cancel','sharing','account'] as const){
  const f=fixture(),page=await f.google.inbox(),controller=new AbortController(),read=vi.spyOn(f.google,'inbox');
  read.mockImplementationOnce(async()=>{if(change==='cancel')controller.abort();if(change==='sharing'){const s=agentStateSchema.parse(f.db.agent('state'));s.revision++;s.config.shareGoogle=false;f.db.agent('saveState',s);}return {...page,messages:[]};}).mockResolvedValueOnce({...page,accountId:'accountB'});
  await expect(f.native.read(f.input,{sources:['inbox'],date:null,sourceId:null,search:{sender:'voorbeeld.test',topic:'Appointment',latest:true}},[],controller.signal)).rejects.toThrow();
  expect(read).toHaveBeenCalledTimes(change==='account'?2:1);
 }
});
it('does not answer a follow-up from prior history when the current thread is incomplete',async()=>{
 const f=fixture([response(search,'delegate_work'),response(answer('One message [M1]',{citations:['M1']}))]);await f.voice('Find the latest email from fixture@example.test');
 const thread=await f.google.readMailThread();vi.spyOn(f.google,'readMailThread').mockResolvedValue({...thread,truncated:true});const run=await f.voice('What is it about?');
 expect(run.result?.answer).toContain('could not read the complete current thread');expect(run.voiceDiagnostics?.failureCategory).toBe('source-unavailable');expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it('recognizes ordinary reply wording, reads the exact thread and retains a reviewable reply with JSON mode enabled',async()=>{
 const f=fixture([response(search,'delegate_work'),response(answer('One match [M1]',{citations:['M1']})),response(answer('It asks whether Tuesday works.',{citations:['M1'],reply:{sourceId:'M1',body:'Does Tuesday work?'}}))]);
 await f.voice('Find my latest email from fixture@example.test');
 for(const prompt of ['Write a reply','Compose a response','Reply to them','Write back to him'])expect(voiceMailReference(prompt,f.context).source?.resourceId).toBe('mail1');
 const reply=await f.voice('Write a reply',false);expect(reply.status).toBe('succeeded');expect(reply.result?.reply?.body).toBe('Does Tuesday work?');
 expect(f.db.getRun(reply.id)?.result?.reply?.body).toBe('Does Tuesday work?');expect(f.roots().find(r=>r.id===reply.executiveRunId)?.executive?.proposals).toEqual([{id:reply.id,kind:'reply-proposal'}]);
 expect(f.bodies.every(b=>(b as {response_format?:{type:string}}).response_format?.type==='json_object')).toBe(true);
 expect(JSON.stringify(f.bodies.at(-1))).toContain('Speak like a thoughtful conversational partner');expect(f.db.workspace().tasks).toHaveLength(0);
});
it('never substitutes a task-review proposal for an email reply request',async()=>{
 const f=fixture([response(search,'delegate_work'),response(answer('One match [M1]',{citations:['M1']})),response(answer('I prepared a task to reply.',{citations:['M1'],suggestions:[{title:'Reply to the email',sourceIds:['M1']}]}))]);
 await f.voice('Find my latest email from fixture@example.test');const run=await f.voice('Prepare a reply',false);
 expect(run.result?.suggestions).toEqual([]);expect(run.result?.reply).toBeUndefined();expect(run.result?.answer).toContain("haven't prepared the email reply");expect(run.result?.clarification).toBeTruthy();
 expect(f.roots().flatMap(r=>r.executive?.proposals??[])).toEqual([]);expect(f.db.workspace().tasks).toEqual([]);
});
it('distinguishes the bounded acceptance request limit from a source-permission failure',()=>{
 expect(voiceFailureCategory(new SessionRequestLimit())).toBe('session-limit');
 expect(voiceFailureCategory(new AppError('permission_denied','Source not shared'))).toBe('permission-source-denied');
});
it('treats yes as ordinary conversation in a read-only call with no pending local task',async()=>{
 const f=fixture([response(answer('Weather refresh is disabled for this test session.'))]);
 const run=await f.voice('Yes',false);expect(run.status).toBe('succeeded');expect(run.voiceDiagnostics?.failureCategory).toBeUndefined();expect(f.fetcher).toHaveBeenCalledOnce();expect(f.db.workspace().tasks).toEqual([]);
});
it('asks for an ambiguous referent before inference and ordinal selection is exact',async()=>{
 const f=fixture();const run=await f.voice('Prepare a reply');expect(run.result?.clarification).toContain('Which email');expect(f.fetcher).not.toHaveBeenCalled();
 const sources=['one','two'].map((resourceId,i)=>({id:'M'+(i+1),kind:'mail',resourceId,accountId:'accountA'} as AssistantSource));rememberVoiceMail(f.context,sources,true);
 expect(voiceMailReference('What is that email about?',f.context).clarify).toBe(true);expect(voiceMailReference('Read the second one',f.context).source?.resourceId).toBe('two');
});
it('uses an explicit timezone and exclusive bounded Planner range',async()=>{
 const f=fixture(),calendar=vi.spyOn(f.google,'calendar'),timezone=f.db.get().values.timezone,today=dateInZone(new Date(),timezone);
 const out=await f.native.read(f.input,{sources:['agenda'],date:addDays(today,1),endDate:addDays(today,3),sourceId:null},[],new AbortController().signal);
 expect(calendar).toHaveBeenCalledWith({accountId:'accountA',startDate:addDays(today,1),endDate:addDays(today,3),timezone});expect(out.warnings.join(' ')).toContain(timezone);
 await expect(f.native.read(f.input,{sources:['agenda'],date:today,endDate:addDays(today,8),sourceId:null},[],new AbortController().signal)).rejects.toThrow('seven days');
});
it('normalizes dates and reminders using the native timezone conversion',()=>{
 const draft=normalizeVoiceTask(task,'Europe/Amsterdam');expect(draft.due).toEqual({kind:'instant',at:'2026-10-03T07:30:00.000Z',timezone:'Europe/Amsterdam'});expect(voiceTaskReadback(draft)).toContain('09:30');expect(voiceTaskReadback(draft)).toContain(task.title);
 expect(()=>normalizeVoiceTask({...task,date:null},'Europe/Amsterdam')).toThrow();expect(()=>normalizeVoiceTask({...task,time:'28:00'},'Europe/Amsterdam')).toThrow();
});
it('only the exact immediately following confirmation consumes one normalized action',()=>{
 const c=new VoiceTaskConfirmation(),b=binding(),draft=normalizeVoiceTask(task,'Europe/Amsterdam');const pending=c.prepare(draft,b);
 draft.title='Mutated elsewhere';const used=c.consume('Yes.',{...b,generation:2});expect(used?.nonce).toBe(pending.nonce);expect(used?.draft.title).toBe(task.title);expect(()=>c.consume('Yes',{...b,generation:3})).toThrow('no pending');
});
for(const change of [{generation:3},{accountId:'accountB'},{sessionId:randomUUID()},{callSid:'CA'+'c'.repeat(32)},{authorityRevision:2},{settingsRevision:2},{authorityHash:'changed'}])it('rejects changed confirmation binding '+Object.keys(change)[0],()=>{
 const c=new VoiceTaskConfirmation(),b=binding();c.prepare(normalizeVoiceTask(task,'Europe/Amsterdam'),b);expect(()=>c.consume('Confirm',{...b,generation:2,...change})).toThrow('no longer valid');
});
it('expiry, clear, subject change and amended wording cancel pending authority',()=>{
 const c=new VoiceTaskConfirmation(),b=binding(),draft=normalizeVoiceTask(task,'Europe/Amsterdam');const now=Date.now();c.prepare(draft,b,now);expect(()=>c.consume('Yes',{...b,generation:2},now+45001)).toThrow();
 for(const text of ['No','What is my agenda?','Yes, but make it tomorrow']){c.prepare(draft,b);expect(c.consume(text,{...b,generation:2})).toBeNull();expect(()=>c.consume('Yes',{...b,generation:3})).toThrow();}
 c.prepare(draft,b);c.clear();expect(()=>c.consume('Do it',{...b,generation:2})).toThrow();
});
it('creates exactly one real native local task and Work receipt only after confirmation, without a second model call',async()=>{
 const f=fixture([response(task,'request_local_task')]);const prepared=await f.voice('Create a task called Synthetic owner task tomorrow at 09:30');
 expect(prepared.error).toBeNull();expect(prepared.voiceDiagnostics?.localAction?.status).toBe('awaiting-confirmation');expect(f.db.workspace().tasks).toEqual([]);expect(f.roots()).toEqual([]);
 const result=await f.voice('Yes');expect(result.error).toBeNull();expect(result.status).toBe('succeeded');expect(result.voiceDiagnostics?.localAction?.status).toBe('created');expect(f.fetcher).toHaveBeenCalledOnce();
 expect(f.db.workspace().tasks).toHaveLength(1);expect(f.db.workspace().tasks[0].title).toBe(task.title);expect(f.roots()[0]).toMatchObject({status:'complete',voiceAction:{status:'created',generation:2},proposals:[{status:'applied',authorization:'explicit'}]});
 expect(f.db.getRun(result.id)?.result).toBeNull();expect(JSON.stringify(f.roots())).not.toContain('tomorrow at');
 expect((await f.voice('Yes')).voiceDiagnostics?.failureCategory).toBe('confirmation-expired');expect(f.db.workspace().tasks).toHaveLength(1);
 expect(()=>f.db.agent('applyVoiceLocal',f.roots()[0])).toThrow();
});
it('revoking native policy or Voice opt-in prevents a previously proposed action',async()=>{
 const f=fixture([response(task,'request_local_task')]);await f.voice('Create a local task');const s=agentStateSchema.parse(f.db.agent('state'));s.revision++;s.config.shareTasks=false;f.db.agent('saveState',s);
 const result=await f.voice('Confirm');expect(result.voiceDiagnostics?.failureCategory).toBe('confirmation-expired');expect(f.db.workspace().tasks).toEqual([]);
 const g=fixture([response(task,'request_local_task')]);await g.voice('Create a local task');expect((await g.voice('Yes',false)).status).toBe('failed');expect(g.db.workspace().tasks).toEqual([]);
});
it('does not offer direct task tools without opt-in or from source instructions',async()=>{
 for(const [prompt,enabled] of [['Create a local task',false],['Read my email',true]] as const){const f=fixture([response(answer())]);await f.voice(prompt,enabled);expect(JSON.stringify(f.bodies[0])).not.toContain('"name":"request_local_task"');}
});
it('does not guess a reminder time from afternoon',async()=>{
 const f=fixture();const run=await f.voice('Remind me to call the dentist Friday afternoon');expect(run.result?.clarification).toContain('exact date and time');expect(f.fetcher).not.toHaveBeenCalled();expect(f.db.workspace().tasks).toEqual([]);
});
it('reads Work through ownerWork and uses the same bounded Briefing delegation',async()=>{
 const f=fixture([response(task,'request_local_task'),response({specialist:'briefing',objective:'Brief the owner for today',sources:['tasks','workflows','agenda'],date:null,sourceId:null},'delegate_work'),response(answer('One local task needs review [T1].',{citations:['T1','W1','E1']}))]);
 await f.voice('Create a local task');await f.voice('Yes');const brief=await f.voice('Brief me for today');expect(brief.error,JSON.stringify({sources:brief.sources.map(s=>({id:s.id,kind:s.kind,mode:s.delivery?.mode})),warnings:brief.warnings,selection:brief.contextSelection,roots:f.roots().map(r=>({id:r.id,status:r.status}))})).toBeNull();expect(brief.sources.map(s=>s.kind).sort()).toEqual(['calendar','task','workflow']);expect(brief.sources.find(s=>s.kind==='workflow')?.detail).toContain('"state":"completed"');expect(brief.voiceDiagnostics?.capabilities).toEqual(['tasks.read','work.read','planner.agenda']);
});
it('retains only a safe failure category, never private provider error text',async()=>{
 const f=fixture();f.fetcher.mockImplementationOnce(async()=>{throw Error('PRIVATE_PROVIDER_DIAGNOSTIC');});const result=await f.voice('PRIVATE_SPOKEN_TEXT');expect(result.voiceDiagnostics?.failureCategory).toBe('provider-model');const stored=JSON.stringify(f.db.getRun(result.id));expect(stored).not.toMatch(/PRIVATE_PROVIDER|PRIVATE_SPOKEN/);
 expect(voiceFailureCategory(new SyntaxError())).toBe('output-schema');expect(voiceFailureCategory(new AppError('permission_denied','No'))).toBe('permission-source-denied');expect(voiceFailureCategory(new AppError('unavailable','Source expired'),'native')).toBe('source-stale');expect(voiceFailureCategory(Error(),'native')).toBe('native-tool');expect(voiceFailureCategory(new VoiceFailure('action-execution-failed','Private'))).toBe('action-execution-failed');expect(voiceFailureCategory(Error())).toBe('unknown');
});
it('routes traffic to an honest deterministic limitation without provider or model requests',async()=>{
 for(const prompt of ['How is traffic home?','How long will the commute take?','Is driving home slower than usual?'])expect(voiceTrafficLimitation(prompt)).toContain('not yet established');
 const f=fixture();const run=await f.voice('How is traffic home?');expect(run.result?.answer).toContain('not looked up traffic');expect(f.fetcher).not.toHaveBeenCalled();expect(f.reads).toEqual([]);expect(run.sources).toEqual([]);expect(f.db.getRun(run.id)?.result).toBeNull();
});
it('reads only fresh explicitly saved Weather including bounded precipitation forecast',async()=>{
 const f=fixture(),id=randomUUID(),at=new Date().toISOString();const snapshot={config:{...emptySituationConfig(),shareWithAI:true,defaultLocationId:id,locations:[{id,label:'Owner saved place',latitude:51,longitude:4,timezone:'Europe/Amsterdam',purpose:'home',revision:'1',updatedAt:at}]},weather:{locationId:id,locationRevision:'1',freshness:{provider:'open-meteo',fetchedAt:at,observedAt:at,freshUntil:new Date(Date.now()+600000).toISOString(),revision:'1',attribution:'Open-Meteo'},partial:false,temperatureC:15,code:3,precipitationMm:1,forecast:[{date:'2026-10-03',code:61,highC:18,lowC:10,precipitationProbability:80,uvIndex:2}]},statuses:[{source:'weather',state:'available'}]} as SituationSnapshot;
 const native=new MoContext(f.storage,f.google,{snapshot:async()=>snapshot}),input={...f.input,includeWeather:true},request={sources:['weather'] as ['weather'],date:null,sourceId:null};
 const out=await native.read(input,request,[],new AbortController().signal);expect(out.sources[0].detail).toContain('precipitationProbability');expect(out.sources[0].detail).toContain('Owner saved place');
 snapshot.weather!.freshness.freshUntil=new Date(Date.now()-1).toISOString();expect((await native.read(input,request,[],new AbortController().signal)).sources).toEqual([]);
 snapshot.weather!.freshness.freshUntil=new Date(Date.now()+600000).toISOString();snapshot.config.locations=[];expect((await native.read(input,request,[],new AbortController().signal)).sources).toEqual([]);
});
