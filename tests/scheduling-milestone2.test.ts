// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { schedulingFixture } from './helpers/scheduling-fixture';
import { understandScheduling } from '../electron/agent/scheduling-language';
import { inspectAvailability, schedulingReply } from '../electron/agent/scheduling';
import { schedulingInterpretationSchema, schedulingStatus, type SchedulingScope } from '../src/shared/scheduling';
import { threadRevision } from '../electron/mail/thread';
import { normalizeEvent } from '../electron/google/normalize';
import { GoogleHttpError } from '../electron/google/http';

const fixtures:ReturnType<typeof schedulingFixture>[]=[];
const fixture=(body?:string)=>{const f=schedulingFixture(body);fixtures.push(f);return f;};
afterEach(async()=>{for(const f of fixtures.splice(0))await f.close();});
const reschedule='Please move our meeting "Planning review", currently 2026-09-30 at 10:00 Europe/Amsterdam, by one week.';

it.each([
 ['next Thursday','2026-10-01',undefined,'09:00','17:00'],
 ['sometime next week','2026-10-05','2026-10-09','09:00','17:00'],
 ['Tuesday afternoon','2026-10-06',undefined,'13:00','17:00'],
 ['next Thursday before 16:00','2026-10-01',undefined,'09:00','16:00'],
 ['either Thursday or Friday','2026-10-01','2026-10-02','09:00','17:00'],
 ['any morning except Wednesday','2026-09-30','2026-10-06','09:00','12:00'],
])('resolves %s from the source date with visible native policy',async(phrase,date,endDate,from,to)=>{
 const f=fixture(`Could we meet for 30 minutes ${phrase}?`),run=await f.run();
 expect(run.status).toBe('complete');expect(run.scheduling!.inbox!.scope).toMatchObject({date,from,to});expect(run.scheduling!.inbox!.scope!.endDate).toBe(endDate);
 expect(run.scheduling!.inbox!.policy?.length).toBeGreaterThan(0);expect(run.scheduling!.planner!.candidates.length).toBeGreaterThan(0);
 if(phrase.includes('except'))expect(run.scheduling!.planner!.candidates.every(c=>new Date(c.start).getUTCDay()!==3)).toBe(true);
 expect(f.google.writeMail).not.toHaveBeenCalled();expect(f.google.updateApprovedEvent).not.toHaveBeenCalled();
});

it.each(['Could we meet next week?','Could we meet for 30 minutes next Thursday after lunch?','Could we meet for 30 minutes next Thursday at 2pm?','Could we meet for 30 minutes next Thursday PST?'])('asks about material ambiguity: %s',async body=>{
 const f=fixture(body),run=await f.run();expect(run.scheduling!.phase).toBe('needs-information');expect(run.localDraftId).toBeUndefined();expect(run.team!.items.some(w=>w.role==='review')).toBe(false);
});
it('uses a fourteen-day maximum, rejects reversed and distant meeting-reference ranges',()=>{
 const f=fixture(),event=f.event();event.scheduling!.confirmed={intent:'arrange',scope:{date:'2026-10-01',endDate:'2026-11-01',from:'09:00',to:'17:00',durationMinutes:30,timezone:'UTC'}};
 expect(()=>understandScheduling(event,'Could we meet?','M1','UTC',f.now(),f.now())).toThrow();
});
it('requires strict source spans; model authority and fabricated source quotes are rejected',()=>{
 expect(schedulingInterpretationSchema.safeParse({intent:'arrange',dateText:'next week',timeText:'',durationText:'30 minutes',timezoneText:'',meetingText:'',ambiguity:[],available:true}).success).toBe(false);
 const f=fixture();expect(()=>understandScheduling(f.event(),f.thread.messages[0].text,'M1','UTC',f.now(),f.now(),{intent:'arrange',dateText:'2030-01-01',timeText:'',durationText:'30 minutes',timezoneText:'',meetingText:'',ambiguity:[]})).toThrow('outside');
});
it('DeepSeek uses the existing reservation/usage path and a closed factual reply contract',async()=>{
 const f=fixture();f.provider(undefined);const run=await f.run();expect(run.status,JSON.stringify(run.team?.ledger?.checks.filter(c=>c.status==='reject'))).toBe('complete');expect(run.result!.draft).toContain('Which of these options would suit you best?');expect(run.calls).toHaveLength(1);expect(run.calls[0]).toMatchObject({provider:'deepseek',purpose:'scheduling-reply',status:'complete',requestedModel:'deepseek-flash'});expect(f.coordinate).toHaveBeenCalledTimes(1);expect(run.team!.ledger!.passed).toBe(true);
});
it('binds every reply candidate and refuses invented times or arbitrary claims',async()=>{
 const f=fixture(),run=await f.run(),facts=run.scheduling!.planner!;
 expect(()=>schedulingReply(run.scheduling!.inbox!,facts,{opening:'Thanks for reaching out.',question:'Would any of these times work for you?',style:'compact',candidateIds:['f'.repeat(64)]})).toThrow('unverified');
 f.provider({opening:'Thanks for reaching out.',question:'Would any of these times work for you?',style:'compact',candidateIds:['f'.repeat(64)]});
 await f.service.command({action:'replanScheduling',id:run.id});await f.service.idle();expect(f.get(run.id).status).not.toBe('complete');
 expect((await f.mail.command({action:'list',accountId:'fixtureAccount'})).drafts).toHaveLength(1);
});
it('uses a strictly typed DeepSeek interpretation for a paraphrase, then native Planner evidence in the same root',async()=>{
 const f=fixture('A meeting next week for 30 minutes would be great.');
 f.provider({intent:'arrange',dateText:'next week',timeText:'',durationText:'30 minutes',timezoneText:'',meetingText:'',ambiguity:[]});
 const run=await f.run();expect(run.status,run.error??'').toBe('complete');expect(run.calls.map(c=>c.purpose)).toEqual(['scheduling-interpret','scheduling-reply']);expect(run.scheduling!.contextHistory).toHaveLength(1);expect(run.team!.items.map(w=>w.role)).toEqual(['executive','inbox','planner','inbox','review']);expect(run.scheduling!.planner!.scope.date).toBe('2026-10-05');
});
it('keeps named weekdays within next week and excludes material omitted model constraints',async()=>{
 const f=fixture('Could we meet for 30 minutes next week on Tuesday afternoon?'),run=await f.run();expect(run.scheduling!.planner!.candidates).toHaveLength(1);expect(run.scheduling!.planner!.candidates[0].start).toContain('2026-10-06');
 const text='Could we meet for 30 minutes between 2026-10-01 and 2026-10-03?';const parsed=understandScheduling(f.event(),text,'M1','UTC',f.now(),f.now(),{intent:'arrange',dateText:'2026-10-01',timeText:'',durationText:'30 minutes',timezoneText:'',meetingText:'',ambiguity:[]});expect(parsed.scope).toBeNull();
});
it.each(['by one week','same time next week'])('binds the original native event and preserves duration for %s',async phrase=>{
 const f=fixture(reschedule.replace('by one week',phrase)),run=await f.run();expect(run.error).toBeNull();expect(run.status).toBe('complete');expect(run.scheduling!.planner!.relatedEvent).toMatchObject({id:'event1'});expect(run.scheduling!.inbox!.scope).toMatchObject({date:'2026-10-07',from:'10:00',to:'10:30',durationMinutes:30});expect(run.scheduling!.planner!.candidates[0].start).toBe('2026-10-07T08:00:00.000Z');
});
it('never chooses a meeting from title similarity or multiple native matches',async()=>{
 const f=fixture('Please reschedule "Planning review" for 30 minutes next Thursday.'),run=await f.run();expect(run.scheduling!.planner!.relatedEvent).toBeNull();
 const g=fixture(reschedule);g.rawEvents.push({...g.rawEvents[0],id:'duplicateEvent'});const ambiguous=await g.run();expect(ambiguous.localDraftId).toBeUndefined();expect(ambiguous.scheduling!.phase).toBe('needs-information');
});
it('all-day coverage only blocks its own day and partial ranges never imply availability',async()=>{
 const f=fixture(),run=await f.run(),scope=run.scheduling!.inbox!.scope!;const data=await f.google.calendar({accountId:'fixtureAccount',startDate:scope.date,endDate:'2026-10-10',timezone:scope.timezone});
 data.events=[{id:'allDay',title:'Away',location:'',status:'confirmed',recurringEventId:null,originalStart:null,time:{kind:'allDay',startDate:'2026-10-05',endDate:'2026-10-06'}}];
 expect(inspectAvailability('fixtureAccount',scope,data,f.now()).candidates[0].start).toContain('2026-10-06');data.truncated=true;expect(inspectAvailability('fixtureAccount',scope,data,f.now()).candidates).toEqual([]);
});
it('preserves owner edits while replanning the same root and creates a replacement only on explicit choice',async()=>{
 const f=fixture(),run=await f.run(),root=run.team!.items[0].id,draft=(await f.mail.command({action:'list',accountId:'fixtureAccount'})).drafts[0];
 await f.mail.command({action:'saveLocal',accountId:draft.accountId,id:draft.id,expectedRevision:draft.revision,fields:{...draft.fields,body:'My own careful wording.'}});
 f.rawEvents.push({...f.rawEvents[0],id:'newConflict',start:{dateTime:'2026-10-05T07:00:00.000Z',timeZone:'Europe/Amsterdam'},end:{dateTime:'2026-10-05T08:00:00.000Z',timeZone:'Europe/Amsterdam'}});
 await f.service.command({action:'checkScheduling',id:run.id});expect(f.get(run.id).scheduling!.followUp!.state).toBe('calendar-changed');
 await f.service.command({action:'replanScheduling',id:run.id});await f.service.idle();const replanned=f.get(run.id);expect(replanned.status).toBe('complete');expect(replanned.team!.items[0].id).toBe(root);expect(replanned.scheduling!.replacementPending).toBe(true);expect(replanned.scheduling!.planner!.candidates[0].start).toBe('2026-10-05T08:00:00.000Z');
 let drafts=(await f.mail.command({action:'list',accountId:draft.accountId})).drafts;expect(drafts).toHaveLength(1);expect(drafts[0].fields.body).toBe('My own careful wording.');
 await expect(f.mail.command({action:'prepareSend',accountId:draft.accountId,id:draft.id,expectedRevision:drafts[0].revision})).rejects.toThrow();
 await f.service.command({action:'useReplannedReply',id:run.id});drafts=(await f.mail.command({action:'list',accountId:draft.accountId})).drafts;expect(drafts).toHaveLength(2);expect(drafts.find(d=>d.id===draft.id)!.fields.body).toBe('My own careful wording.');expect(f.get(run.id).localDraftId).not.toBe(draft.id);expect(f.db.agent('runs')).toHaveLength(1);
});
it('recognizes a recipient response and replans from that message within the same workflow',async()=>{
 const f=fixture(),run=await f.run();const next=structuredClone(f.thread.messages[0]);next.message.id='message2';next.message.receivedAt=new Date(f.now()+1000).toISOString();next.text='Could we meet for 30 minutes next Friday afternoon?';f.thread.messages.push(next);
 await f.service.observeSchedulingThread(f.thread);expect(f.get(run.id).scheduling!.followUp!.state).toBe('recipient-responded');expect(schedulingStatus(f.get(run.id)).group).toBe('review');
 await f.service.command({action:'replanScheduling',id:run.id});await f.service.idle();expect(f.get(run.id).event.resourceId).toBe('message2');expect(f.get(run.id).event.scheduling!.threadRevision).toBe(threadRevision(f.thread));expect(f.db.agent('runs')).toHaveLength(1);
});

async function preparedUpdate(){const f=fixture(reschedule),run=await f.run();await f.service.command({action:'prepareSchedulingCalendar',id:run.id,candidateId:run.scheduling!.planner!.candidates[0].id});const current=f.get(run.id),review=(await f.calendar.command({action:'review',id:current.calendarProposalId!})).review!;return{f,run:current,review};}
it('prepares a separate exact calendar update and cannot use the mail nonce to approve it',async()=>{
 const {f,run,review}=await preparedUpdate();expect(f.google.updateApprovedEvent).not.toHaveBeenCalled();expect(review.action.eventId).toBe('event1');expect(review.action.target!.etag).toBe('"revision1"');expect(run.team!.ledger!.checks.some(c=>c.code==='CALENDAR_UPDATE_BINDING')).toBe(true);
 const draft=(await f.mail.command({action:'list',accountId:'fixtureAccount'})).drafts[0],mail=(await f.mail.command({action:'prepareSend',accountId:draft.accountId,id:draft.id,expectedRevision:draft.revision})).review!;
 expect(mail.action.id).not.toBe(review.action.id);await expect(f.calendar.command({action:'approve',id:review.action.id,hash:review.action.hash,nonce:mail.nonce})).rejects.toThrow();expect(f.google.writeMail).not.toHaveBeenCalled();expect(f.google.updateApprovedEvent).not.toHaveBeenCalled();
});
it('after a calendar approval, prepares a confirmation reply without overwriting the earlier draft',async()=>{
 const {f,run,review}=await preparedUpdate();await f.calendar.command({action:'approve',id:review.action.id,hash:review.action.hash,nonce:review.nonce});
 expect(f.google.updateApprovedEvent).toHaveBeenCalledTimes(1);expect(f.rawEvents[0].attendees).toEqual([{email:'sender@example.test'}]);expect(f.rawEvents[0].location).toBe('Retained location');expect(f.google.writeMail).not.toHaveBeenCalled();
 await f.service.schedulingChanged();expect(f.get(run.id).scheduling!.followUp!.state).toBe('partially-completed');
 await f.service.command({action:'useReplannedReply',id:run.id});const ready=f.get(run.id),drafts=(await f.mail.command({action:'list',accountId:'fixtureAccount'})).drafts;expect(drafts).toHaveLength(2);const draft=drafts.find(d=>d.id===ready.localDraftId)!;expect(draft.fields.body).toContain('has been moved');
 const send=(await f.mail.command({action:'prepareSend',accountId:draft.accountId,id:draft.id,expectedRevision:draft.revision})).review!;await f.mail.command({action:'approveSend',accountId:draft.accountId,id:send.action.id,hash:send.action.hash,nonce:send.nonce});await f.service.schedulingChanged();expect(f.get(run.id).scheduling!.followUp!.state).toBe('completed');
 await expect(f.calendar.command({action:'approve',id:review.action.id,hash:review.action.hash,nonce:review.nonce})).rejects.toThrow();
});
it.each(['target','range','cancel','settings'])('blocks the update when %s changes after exact review',async change=>{
 const {f,run,review}=await preparedUpdate();
 if(change==='target')f.rawEvents[0].etag='"changed"';if(change==='range')f.rawEvents.push({...f.rawEvents[0],id:'new',start:{dateTime:'2026-10-07T08:00:00.000Z',timeZone:'Europe/Amsterdam'},end:{dateTime:'2026-10-07T09:00:00.000Z',timeZone:'Europe/Amsterdam'}});if(change==='cancel')await f.service.command({action:'cancel',id:run.id});if(change==='settings')f.db.update({expectedRevision:f.db.get().revision,patch:{timezone:'UTC'}});
 await expect(f.calendar.command({action:'approve',id:review.action.id,hash:review.action.hash,nonce:review.nonce})).rejects.toThrow();expect(f.google.updateApprovedEvent).not.toHaveBeenCalled();
});
it('records a server revision conflict as failed without retry and an uncertain write as unknown',async()=>{
 const {f,run,review}=await preparedUpdate();f.google.updateApprovedEvent.mockRejectedValueOnce(new GoogleHttpError(412,''));const result=await f.calendar.command({action:'approve',id:review.action.id,hash:review.action.hash,nonce:review.nonce});expect(result.actions[0].status).toBe('failed');expect(f.google.updateApprovedEvent).toHaveBeenCalledTimes(1);await f.service.schedulingChanged();expect(f.get(run.id).scheduling!.followUp!.state).toBe('partially-completed');
 const next=await preparedUpdate();next.f.google.updateApprovedEvent.mockRejectedValueOnce(Error('Connection lost'));const unknown=await next.f.calendar.command({action:'approve',id:next.review.action.id,hash:next.review.action.hash,nonce:next.review.nonce});expect(unknown.actions[0].status).toBe('unknown');await expect(next.f.service.command({action:'replanScheduling',id:next.run.id})).rejects.toThrow('outcome');expect(next.f.google.updateApprovedEvent).toHaveBeenCalledTimes(1);
});
it('persists meaningful follow-through without adding agent runs, automatic sends or model calls',async()=>{
 const f=fixture(),run=await f.run(),draft=(await f.mail.command({action:'list',accountId:'fixtureAccount'})).drafts[0],review=(await f.mail.command({action:'prepareSend',accountId:draft.accountId,id:draft.id,expectedRevision:draft.revision})).review!;
 await f.mail.command({action:'approveSend',accountId:draft.accountId,id:review.action.id,hash:review.action.hash,nonce:review.nonce});await f.service.schedulingChanged();expect(f.get(run.id).scheduling!.followUp!.state).toBe('waiting-recipient');expect(f.db.agent('runs')).toHaveLength(1);expect(f.coordinate).not.toHaveBeenCalled();
 await f.service.command({action:'completeScheduling',id:run.id});expect(f.get(run.id).scheduling!.followUp!.state).toBe('completed');
});
it('binds native identity revisions, including the etag, rather than trusting a model ID',async()=>{
 const {f,review}=await preparedUpdate();expect(normalizeEvent(f.rawEvents[0])!.etag).toBe(review.action.target!.etag);expect(()=>f.db.putCalendarAction({...review.action,target:{...review.action.target!,etag:'"forged"'},status:'dispatching'},'pending')).toThrow('cannot be modified');
 await expect(f.service.command({action:'prepareSchedulingCalendar',id:randomUUID(),candidateId:'a'.repeat(64)})).rejects.toThrow('retained');
});
it('rejects ambiguous DST time windows even in an otherwise complete multi-day range',async()=>{
 const f=fixture(),scope:SchedulingScope={date:'2026-10-25',from:'02:00',to:'03:30',durationMinutes:30,timezone:'Europe/Amsterdam'},data=await f.google.calendar({accountId:'fixtureAccount',startDate:scope.date,endDate:'2026-10-26',timezone:scope.timezone});expect(inspectAvailability('fixtureAccount',scope,data,f.now())).toMatchObject({coverage:'partial',candidates:[]});
});
it('keeps mail-first approval independent and ignores only the native confirmed outgoing message',async()=>{
 const {f,run,review}=await preparedUpdate();const draft=(await f.mail.command({action:'list',accountId:'fixtureAccount'})).drafts[0];const mail=(await f.mail.command({action:'prepareSend',accountId:draft.accountId,id:draft.id,expectedRevision:draft.revision})).review!;
 await f.mail.command({action:'approveSend',accountId:draft.accountId,id:mail.action.id,hash:mail.action.hash,nonce:mail.nonce});await f.service.schedulingChanged();
 const outgoing=structuredClone(f.thread.messages[0]);outgoing.message.id='sent1';outgoing.message.from='owner@example.test';outgoing.text=draft.fields.body;f.thread.messages.push(outgoing);await f.service.observeSchedulingThread(f.thread);
 expect(f.get(run.id).scheduling!.phase).toBe('awaiting-owner');await f.calendar.command({action:'approve',id:review.action.id,hash:review.action.hash,nonce:review.nonce});await f.service.schedulingChanged();expect(f.get(run.id).scheduling!.followUp!.state).toBe('completed');expect(f.google.writeMail).toHaveBeenCalledTimes(1);expect(f.google.updateApprovedEvent).toHaveBeenCalledTimes(1);
});
it('marks relevant native calendar refreshes stale and does not react to unrelated date ranges',async()=>{
 const f=fixture(),run=await f.run();f.rawEvents.push({...f.rawEvents[0],id:'conflict',start:{dateTime:'2026-10-05T07:00:00.000Z',timeZone:'Europe/Amsterdam'},end:{dateTime:'2026-10-05T08:00:00.000Z',timeZone:'Europe/Amsterdam'}});
 await f.service.observeSchedulingCalendar(await f.google.calendar({accountId:'fixtureAccount',startDate:'2026-11-01',endDate:'2026-11-02',timezone:'Europe/Amsterdam'}));expect(f.get(run.id).scheduling!.draftStale).not.toBe(true);
 await f.service.observeSchedulingCalendar(await f.google.calendar({accountId:'fixtureAccount',startDate:'2026-10-01',endDate:'2026-10-15',timezone:'Europe/Amsterdam'}));expect(f.get(run.id).scheduling!.followUp!.state).toBe('calendar-changed');expect(f.coordinate).not.toHaveBeenCalled();
});
it('preserves model usage through explicit replanning and retains one workflow for a changed source',async()=>{
 const f=fixture();f.provider(undefined);const run=await f.run();const calls=run.calls.map(c=>c.id);
 f.thread.messages[0].text+=' Please let me know.';const again=await f.service.start(f.event());expect(again.id).toBe(run.id);await f.service.command({action:'replanScheduling',id:run.id});await f.service.idle();expect(f.get(run.id).calls.map(c=>c.id).slice(0,calls.length)).toEqual(calls);expect(f.db.agent('runs')).toHaveLength(1);
});
it('rejects a stale status projection rather than overwriting a newer cancellation or stale marker',async()=>{
 const f=fixture(),run=await f.run(),expected=structuredClone(run);
 await f.service.command({action:'cancel',id:run.id});
 const projected={...run,scheduling:{...run.scheduling!,followUp:{state:'waiting-owner' as const,checkedAt:new Date(f.now()).toISOString(),detail:'Earlier projection'}}};
 f.db.agent('projectScheduling',{run:projected,expected});expect(f.get(run.id).status).toBe('cancelled');expect(f.get(run.id).scheduling!.phase).toBe('cancelled');
});
it('forces native calendar reads at loading, follow-through and approval boundaries, bypassing the UI refresh cache',async()=>{
 const f=fixture(),run=await f.run();expect(f.google.calendar.mock.calls.every(call=>(call as unknown[])[1]===true)).toBe(true);
 f.google.calendar.mockClear();await f.service.command({action:'checkScheduling',id:run.id});expect(f.google.calendar.mock.calls.length).toBeGreaterThan(0);expect(f.google.calendar.mock.calls.every(call=>(call as unknown[])[1]===true)).toBe(true);
});
