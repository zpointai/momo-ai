// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { executiveFixture } from '../evaluation/mo-executive-fixture';
import { CalendarActionService } from '../electron/calendar/service';
import { VoiceCalendarConfirmation, normalizeVoiceCalendar, voiceCalendarReadback } from '../electron/ai/voice-calendar';
import { VoiceTaskConfirmation, type VoiceActionBinding } from '../electron/ai/voice-confirmation';
import { emptyVoiceCallContext } from '../electron/ai/voice-context';
import { addDays, dateInZone } from '../src/shared/google';
import { voiceConfigSchema, type VoiceSession } from '../src/shared/voice';
import type { AssistantRun } from '../src/shared/assistant';
import { AppError } from '../electron/errors';

const close:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const fn of close.splice(0))await fn();vi.restoreAllMocks();});
const day=()=>addDays(dateInZone(new Date(),'Europe/Amsterdam'),1);
const event=()=>({title:'Synthetic calendar block',startDate:day(),startTime:'10:00',endDate:day(),endTime:'10:30'});
const tool=(value:unknown)=>({model:'deepseek-flash',usage:{prompt_tokens:120,completion_tokens:40},choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:randomUUID(),type:'function',function:{name:'request_calendar_event',arguments:JSON.stringify(value)}}]}}]});
function fixture(responses:unknown[]=[tool(event())]){
  const bodies:unknown[]=[],fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{bodies.push(JSON.parse(String(init?.body)));return Response.json(responses.shift());});
  const f=executiveFixture(fetcher as typeof fetch);close.push(()=>f.close());
  let epoch=1,generation=0,history:AssistantRun[]=[];const base=f.google.state;
  vi.spyOn(f.google,'state').mockImplementation(async()=>{const s=await base();return {...s,accounts:s.accounts.map(a=>({...a,calendarWrite:true}))};});
  const insert=vi.fn(async(_account:string,body:object,expected:number,valid:()=>boolean,before?:()=>Promise<void>)=>{await before?.();if(expected!==epoch||!valid())throw new AppError('permission_denied','Synthetic authority revoked');return {...body,status:'confirmed'};});
  const calendar=new CalendarActionService(f.db,{state:f.google.state,calendarEpoch:()=>epoch,insertApprovedEvent:insert,findApprovedEvent:vi.fn()});
  f.service.setVoiceCalendar(calendar,()=>epoch);
  const calendarConfirmation=new VoiceCalendarConfirmation(),confirmation=new VoiceTaskConfirmation(),context=emptyVoiceCallContext();
  const session:VoiceSession={id:randomUUID(),conversationId:randomUUID(),callSid:'CA'+'c'.repeat(32),ownerId:randomUUID(),startedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+600000).toISOString(),scope:'read-prepare',authentication:'caller-and-pin'};
  const guard=vi.fn(async()=>{});
  return {...f,calendar,insert,fetcher,bodies,calendarConfirmation,guard,bumpEpoch:()=>{epoch++;},async voice(prompt:string,allowCalendarCreate=true){const run=await f.service.start({...f.input,id:randomUUID(),conversationId:session.conversationId,prompt},undefined,undefined,{session,retainHistory:false,history,context,confirmation,calendarConfirmation,generation:++generation,allowCalendarCreate,guard});await f.service.idle();history=[run,...history].slice(0,3);return run;}};
}
const prompt=()=>`Create a calendar event called Synthetic calendar block on ${day()} from 10:00 to 10:30`;
const patch=(fields:object)=>({title:null,startDate:null,startTime:null,endDate:null,endTime:null,intent:'details',clearFields:[],...fields});

it('keeps date and times through missing-title and corrected-title follow-ups, then requires a fresh confirmation',async()=>{
  const f=fixture([tool({...event(),title:null,startTime:'12:30',endTime:'12:45'}),tool(patch({title:'Call My Wife'})),tool(patch({title:'My Wife'}))]);
  const first=await f.voice(`Create a calendar event on ${day()} from 12:30 till 12:45`);
  expect(first.result?.clarification).toBe('What title should I use for the event?');
  const second=await f.voice('The title is called Call My Wife.');
  expect(second.result?.answer).toContain('event titled "Call My Wife"');
  expect(second.result?.answer).toContain('12:30');expect(second.result?.answer).toContain('12:45');
  const third=await f.voice('No, the title of the event is My Wife.');
  expect(third.result?.answer).toContain('event titled "My Wife"');expect(third.result?.answer).toContain('12:30');expect(third.result?.answer).toContain('12:45');
  expect(third.voiceDiagnostics?.calendarAction?.id).not.toBe(second.voiceDiagnostics?.calendarAction?.id);
  expect(f.insert).not.toHaveBeenCalled();expect(f.db.calendarActions()).toEqual([]);
  const bodies=f.bodies as {messages:{role:string;content:string}[];tool_choice:object}[];
  expect(JSON.parse(bodies[2].messages.filter(m=>m.role==='user').at(-1)!.content).calendarBeingPrepared).toMatchObject({title:'Call My Wife',startDate:day(),startTime:'12:30',endTime:'12:45'});
  expect(bodies.every(b=>JSON.stringify(b.tool_choice).includes('request_calendar_event'))).toBe(true);
  expect((await f.voice('Yes')).voiceDiagnostics?.calendarAction?.status).toBe('succeeded');
  expect(f.insert).toHaveBeenCalledOnce();expect(f.insert.mock.calls[0][1]).toMatchObject({summary:'My Wife'});expect(f.fetcher).toHaveBeenCalledTimes(3);
});

it('retains event data, but not approval, after interruption',async()=>{
  const f=fixture([tool(event()),tool(patch({title:'Corrected title'}))]);await f.voice(prompt());
  f.calendarConfirmation.invalidateConfirmation();
  const r=await f.voice('Change the title to Corrected title');expect(r.voiceDiagnostics?.calendarAction?.status).toBe('awaiting-confirmation');
  expect(r.result?.answer).toContain('10:30');expect(f.insert).not.toHaveBeenCalled();
  await f.voice('Yes');expect(f.insert).toHaveBeenCalledOnce();
});

it('explicitly withdrawn time is clarified without forgetting the other details',async()=>{
  const f=fixture([tool(event()),tool(patch({clearFields:['endTime']})),tool(patch({endTime:'10:45'}))]);
  await f.voice(prompt());const r=await f.voice('Actually, I am not sure about the end time');
  expect(r.result?.clarification).toBe('What end time should I use for the event?');expect(f.calendarConfirmation.hasPending()).toBe(false);
  const fixed=await f.voice('10:45');expect(fixed.result?.answer).toContain(event().title);expect(fixed.result?.answer).toContain('10:00');expect(fixed.result?.answer).toContain('10:45');expect(f.insert).not.toHaveBeenCalled();
});

it('clarifies uncertain date and split end time even when the model supplies plausible guesses',async()=>{
 const f=fixture([tool({...event(),title:'Call My Wife',startTime:'12:30',endTime:'12:45',uncertainFields:['startDate','endDate','endTime']}),tool(patch({startDate:day(),endDate:day(),endTime:'12:45'}))]);
 const first=await f.voice('Create a calendar event for a power 5th called call my wife. From 12 30 to 12 4. 5.');
 expect(first.result?.clarification).toBe('What date and end time should I use for the event?');
 expect(f.calendarConfirmation.hasPending()).toBe(false);expect(f.insert).not.toHaveBeenCalled();expect(f.db.calendarActions()).toEqual([]);
 const fixed=await f.voice(`The date is ${day()} and the end time is 12:45`);
 expect(fixed.voiceDiagnostics?.calendarAction?.status).toBe('awaiting-confirmation');
 expect(fixed.result?.answer).toContain('"Call My Wife"');expect(fixed.result?.answer).toContain('12:30');expect(fixed.result?.answer).toContain('12:45');
 expect(f.insert).not.toHaveBeenCalled();await f.voice('Yes');expect(f.insert).toHaveBeenCalledOnce();
});

it('uncertain correction removes stale approval while retaining unrelated event details',async()=>{
 const f=fixture([tool(event()),tool(patch({endTime:'10:45',uncertainFields:['endTime']}))]);await f.voice(prompt());
 const correction=await f.voice('Change the end time to 10 4. 5.');
 expect(correction.result?.clarification).toBe('What end time should I use for the event?');
 expect(f.calendarConfirmation.hasPending()).toBe(false);
 expect((await f.voice('Yes')).voiceDiagnostics?.failureCategory).toBe('confirmation-expired');
 expect(f.insert).not.toHaveBeenCalled();expect(f.db.calendarActions()).toEqual([]);
 const body=JSON.stringify(f.bodies[1]);expect(body).toContain('uncertainFields');expect(body).toContain('Do not silently repair');
});

it('clears collection on cancellation or topic change without executing an action',async()=>{
  const f=fixture();await f.voice(prompt());const r=await f.voice('Cancel the event');expect(r.result?.answer).toContain('cancelled');expect(f.fetcher).toHaveBeenCalledOnce();
  expect((await f.voice('Yes')).voiceDiagnostics?.failureCategory).toBe('confirmation-expired');expect(f.insert).not.toHaveBeenCalled();
  const g=fixture([tool({...event(),title:null}),tool(patch({intent:'other'}))]);await g.voice(prompt());
  expect((await g.voice('What is the weather?')).result?.answer).toContain('set the event aside');
  expect(g.calendarConfirmation.hasPending()).toBe(false);expect(g.insert).not.toHaveBeenCalled();
});

it('expires collection and discards it on account, session, settings, scope and epoch changes',()=>{
  const c=new VoiceCalendarConfirmation(),now=Date.now(),b:VoiceActionBinding={sessionId:randomUUID(),callSid:'CA'+'a'.repeat(32),accountId:'accountA',profile:'local',generation:1,authorityHash:'hash',authorityRevision:1,settingsRevision:1,expiresAt:now+600000};
  for(const change of [{sessionId:randomUUID()},{callSid:'CA'+'b'.repeat(32)},{accountId:'accountB'},{authorityHash:'revoked'},{authorityRevision:2},{settingsRevision:2},{generation:0}]){
    c.collect(event(),b,1,now);expect(c.context({...b,generation:2,...change},1,now)).toBeNull();
  }
  c.collect(event(),b,1,now);expect(c.context({...b,generation:2},2,now)).toBeNull();
  c.collect(event(),b,1,now);expect(c.context({...b,generation:2},1,now+180001)).toBeNull();
  c.collect(event(),b,1,now);c.clear();expect(c.context(b,1,now)).toBeNull();
});

it('requires a distinct Google-sharing calendar opt-in, off for old configurations',()=>{
  const base={enabled:true,accountId:'accountA',includeGoogle:true,includeLocal:false,includeWeather:false,retainHistory:false};
  expect(voiceConfigSchema.parse(base).allowCalendarCreate).toBeUndefined();
  expect(voiceConfigSchema.safeParse({...base,includeGoogle:false,allowCalendarCreate:true}).success).toBe(false);
});
it('creates exactly one private event through durable approval after native readback and immediate confirmation',async()=>{
  const f=fixture(),prepared=await f.voice(prompt());
  expect(prepared.error).toBeNull();expect(prepared.result?.answer).toContain('owner@example.test');expect(prepared.result?.answer).toContain('Europe/Amsterdam');
  expect(prepared.voiceDiagnostics?.calendarAction?.status).toBe('awaiting-confirmation');expect(f.insert).not.toHaveBeenCalled();expect(f.db.calendarActions()).toEqual([]);
  const result=await f.voice('Yes');expect(result.error).toBeNull();expect(result.voiceDiagnostics?.calendarAction?.status).toBe('succeeded');expect(f.fetcher).toHaveBeenCalledOnce();expect(f.insert).toHaveBeenCalledOnce();
  expect(f.insert.mock.calls[0][1]).toMatchObject({summary:event().title,visibility:'private',reminders:{useDefault:false}});expect(f.insert.mock.calls[0][1]).not.toHaveProperty('attendees');
  expect(f.db.calendarActions()[0]).toMatchObject({status:'succeeded',voice:{channel:'voice',capability:'calendar.create',generation:2}});expect(f.db.workspace().tasks).toEqual([]);expect(f.db.getRun(result.id)?.result).toBeNull();
  expect((await f.voice('Yes')).voiceDiagnostics?.failureCategory).toBe('confirmation-expired');expect(f.insert).toHaveBeenCalledOnce();
});
it('blocks expired, changed, replayed and cross-session confirmation',()=>{
  const c=new VoiceCalendarConfirmation(),now=Date.now(),b:VoiceActionBinding={sessionId:randomUUID(),callSid:'CA'+'a'.repeat(32),accountId:'accountA',profile:'local',generation:1,authorityHash:'hash',authorityRevision:1,settingsRevision:1,expiresAt:now+600000};
  const draft=normalizeVoiceCalendar(event(),'accountA','Europe/Amsterdam');
  for(const patch of [{sessionId:randomUUID()},{generation:3},{authorityHash:'changed'},{settingsRevision:2},{accountId:'accountB'}]){c.prepare(draft,b,1,now);expect(()=>c.consume('Yes',{...b,generation:2,...patch},1,now)).toThrow();}
  c.prepare(draft,b,1,now);expect(()=>c.consume('Yes',{...b,generation:2},2,now)).toThrow();
  c.prepare(draft,b,1,now);expect(()=>c.consume('Yes',{...b,generation:2},1,now+45001)).toThrow();
  c.prepare(draft,b,1,now);expect(c.consume('Yes, but tomorrow',{...b,generation:2},1,now)).toBeNull();expect(()=>c.consume('Yes',{...b,generation:3},1,now)).toThrow();
  c.prepare(draft,b,1,now);c.consume('Yes',{...b,generation:2},1,now);expect(()=>c.prepare(draft,b,1,now)).toThrow('already submitted');
});
it('rejects missing, invalid and DST-ambiguous event times instead of inventing duration',()=>{
  expect(()=>normalizeVoiceCalendar({...event(),endTime:null},'accountA','Europe/Amsterdam')).toThrow();
  expect(()=>normalizeVoiceCalendar({...event(),endTime:'09:30'},'accountA','Europe/Amsterdam')).toThrow();
  expect(()=>normalizeVoiceCalendar({...event(),startDate:'2026-10-25',startTime:'02:30',endDate:'2026-10-25',endTime:'03:30'},'accountA','Europe/Amsterdam',Date.parse('2026-10-01'))).toThrow('daylight saving');
  expect(voiceCalendarReadback(normalizeVoiceCalendar(event(),'accountA','Europe/Amsterdam'),'owner@example.test')).toContain('no invitations or reminders');
});
it('asks for missing event fields without persisting an action',async()=>{
  const f=fixture([tool({...event(),endTime:null})]),r=await f.voice('Create a calendar event tomorrow at 10');expect(r.result?.clarification).toContain('end time');expect(f.db.calendarActions()).toEqual([]);expect(f.insert).not.toHaveBeenCalled();
});
it('routes explicit calendar preparation to one required tool rather than optional chat or task review',async()=>{
  const f=fixture();await f.voice(prompt());
  expect(f.bodies[0]).toMatchObject({tool_choice:{type:'function',function:{name:'request_calendar_event'}}});
  const body=f.bodies[0] as {tools:{function:{name:string}}[];messages:{content:string}[]};
  expect(body.tools.map(t=>t.function.name)).toEqual(['request_calendar_event']);
  expect(body.messages[0].content).not.toContain('No external execution');
  expect(body.messages[0].content).toContain('Calendar creation is enabled');
  expect(f.fetcher).toHaveBeenCalledOnce();expect(f.insert).not.toHaveBeenCalled();
});
it('does not speak a model-only refusal or phantom review promise when preparation failed',async()=>{
  for(const answer of ['I cannot create calendar events.','I have saved an event for your review.']){
    const f=fixture([{model:'deepseek-flash',usage:{prompt_tokens:120,completion_tokens:40},choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({answer,citations:[],suggestions:[]})}}]}]);
    const r=await f.voice(prompt());expect(r.result?.answer).toContain('Nothing has been created or saved');
    expect(r.voiceDiagnostics?.failureCategory).toBe('output-schema');expect(f.calendarConfirmation.hasPending()).toBe(false);
    expect(f.fetcher).toHaveBeenCalledOnce();expect(f.insert).not.toHaveBeenCalled();expect(f.db.calendarActions()).toEqual([]);
  }
});
it('blocks absent opt-in, unsupported actions and model-only intent without task substitution',async()=>{
  for(const [text,allow] of [[prompt(),false],['Create a recurring calendar event every Tuesday',true],['Create an event and invite a guest',true]] as const){const f=fixture();const r=await f.voice(text,allow);expect(r.result?.clarification).toBeTruthy();expect(f.fetcher).not.toHaveBeenCalled();expect(f.insert).not.toHaveBeenCalled();}
  const f=fixture(),r=await f.voice('Read my agenda',false);expect(r.status).toBe('failed');expect(f.insert).not.toHaveBeenCalled();expect(f.db.calendarActions()).toEqual([]);
});

it('offers permitted calendar preparation for natural requests outside the keyword fast path',async()=>{
  const f=fixture(),r=await f.voice(`Pencil in Call My Wife on ${day()}, 10:00 to 10:30, please.`);
  expect(r.voiceDiagnostics?.calendarRouting).toEqual({available:true,explicitIntent:false,continuation:false,toolOffered:true,toolCalled:true});
  expect(r.voiceDiagnostics?.calendarAction?.status).toBe('awaiting-confirmation');expect(f.insert).not.toHaveBeenCalled();
  expect(f.db.calendarActions()).toEqual([]);expect(f.bodies[0]).toMatchObject({tool_choice:'auto'});
});
it('revoking Voice opt-in or changing Google epoch invalidates prepared authority',async()=>{
  const f=fixture();await f.voice(prompt());f.bumpEpoch();expect((await f.voice('Yes')).voiceDiagnostics?.failureCategory).toBe('confirmation-expired');expect(f.insert).not.toHaveBeenCalled();
  const g=fixture();await g.voice(prompt());expect((await g.voice('Yes',false)).status).toBe('failed');expect(g.insert).not.toHaveBeenCalled();
});
it('disconnecting before confirmation leaves no calendar proposal or external write',async()=>{
  const f=fixture();await f.voice(prompt());f.calendarConfirmation.clear();expect((await f.voice('Yes')).voiceDiagnostics?.failureCategory).toBe('confirmation-expired');expect(f.insert).not.toHaveBeenCalled();expect(f.db.calendarActions()).toEqual([]);
});
it('unknown outcomes remain durable, are not reported as created, and block another phone submission',async()=>{
  const f=fixture([tool(event()),tool({...event(),title:'Second synthetic event'})]);f.insert.mockRejectedValueOnce(new Error('Synthetic transport lost after dispatch'));
  await f.voice(prompt());const r=await f.voice('Yes');expect(r.voiceDiagnostics?.calendarAction?.status).toBe('unknown');expect(r.result?.answer).toContain('uncertain');expect(f.db.calendarActions()[0].status).toBe('unknown');
  await f.voice(prompt());await f.voice('Yes');expect(f.insert).toHaveBeenCalledOnce();expect(f.db.calendarActions()).toHaveLength(1);
});
it('does not allow the ordinary desktop approval command to replay a Voice action',async()=>{
  const f=fixture();await f.voice(prompt());await f.voice('Yes');const a=f.db.calendarActions()[0];await expect(f.calendar.command({action:'approve',id:a.id,hash:a.hash,nonce:randomUUID()})).rejects.toThrow('exact live Voice');expect(f.insert).toHaveBeenCalledOnce();
});
