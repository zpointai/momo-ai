import { randomUUID } from 'node:crypto';
import { addDays, dateInZone, type CalendarData, eventOnDate, type CalendarQuery } from '../../src/shared/google';
import { plannerAvailabilitySchema, schedulingReplyPlanSchema, type InboxScheduling, type PlannerAvailability, type SchedulingScope, type SchedulingInterpretation, type SchedulingReplyPlan } from '../../src/shared/scheduling';
import type { AgentContext, AgentIntake } from '../../src/shared/orchestration';
import type { MailThread } from '../../src/shared/mail';
import type { ResourceRef } from '../../src/shared/modules';
import { understandScheduling, identifyMeeting } from './scheduling-language';
import { AppError } from '../errors';
import { threadRevision } from '../mail/thread';
import { hash } from './catalogue';

export const schedulingFreshMs = 300000;
export function schedulingQuery(accountId: string, scope: SchedulingScope): CalendarQuery {
  return { accountId, startDate: scope.referenceDate && scope.referenceDate < scope.date ? scope.referenceDate : scope.date, endDate: addDays(scope.referenceDate && scope.referenceDate > (scope.endDate??scope.date) ? scope.referenceDate : scope.endDate??scope.date, 1), timezone: scope.timezone, refresh: true };
}

/** Resolve wall time only when it has exactly one real instant (reject DST gaps and folds). */
export function schedulingInstant(date: string, time: string, timezone: string): number {
  const nominal = Date.parse(`${date}T${time}:00Z`), offsets = new Set<number>();
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const wall = (at: number) => {
    const p = formatter.formatToParts(new Date(at)), get = (key: string) => p.find(v => v.type === key)!.value;
    return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:00Z`;
  };
  for (const hours of [-36, -12, 0, 12, 36]) { const sample = nominal + hours * 3600000; offsets.add(Date.parse(wall(sample)) - sample); }
  const candidates = [...offsets].map(offset => nominal - offset).filter(at => wall(at) === `${date}T${time}:00Z`);
  if (candidates.length !== 1) throw new AppError('invalid_input', 'This local time is ambiguous or does not exist because of a clock change. Choose another window.');
  return candidates[0];
}

export function interpretScheduling(event: AgentIntake, text: string, sourceId: string, timezone='UTC', anchor=Date.now(), now=Date.now()): InboxScheduling {
  return understandScheduling(event,text,sourceId,timezone,anchor,now);
}

export function calendarRangeRevision(data: CalendarData) {
  return hash({ accountId: data.accountId, timezone: data.timezone, startDate: data.startDate, endDate: data.endDate, truncated: data.truncated, skipped: data.skipped, events: [...data.events].sort((a, b) => a.id.localeCompare(b.id)) });
}

export function inspectAvailability(accountId: string, scope: SchedulingScope, data: CalendarData | null, now: number, subject = ''): PlannerAvailability {
  const query = schedulingQuery(accountId, scope);
  const valid = data && data.accountId === accountId && data.timezone === scope.timezone && data.startDate === query.startDate && data.endDate === query.endDate && Math.abs(now - Date.parse(data.fetchedAt)) <= schedulingFreshMs;
  const base: PlannerAvailability = { schema: 'planner-availability-v1', scope, accountId, calendarId: 'primary', rangeRevision: valid ? calendarRangeRevision(data) : hash({ query, unavailable: true }), fetchedAt: valid ? data.fetchedAt : new Date(now).toISOString(), coverage: !valid ? 'unavailable' : data.truncated || data.skipped ? 'partial' : 'complete', eventCount: valid ? data.events.length : 0, candidates: [], conflicts: [], relatedEvent: null, limitations: ['Primary calendar only. Other calendars and participant availability are not checked.', 'Calendar gaps are candidate windows, not confirmed attendance or a booking.'] };
  if (!valid) { base.limitations.push('Calendar unavailable or its account, range, timezone or freshness could not be verified.'); return base; }
  if (base.coverage !== 'complete') { base.limitations.push('Calendar coverage is partial. No free windows can be established.'); return base; }
  // Validate every returned duration before declaring any gap usable.
  if(data.events.some(e=>e.time.kind==='timed'&&(!Number.isFinite(Date.parse(e.time.start))||Date.parse(e.time.end)<=Date.parse(e.time.start)))) {base.coverage='partial';base.limitations.push('An event duration could not be verified.');return base;}
  const duration=scope.durationMinutes*60000, conflicts=new Map<string,PlannerAvailability['conflicts'][number]>();
  for(let day=scope.date;day<=(scope.endDate??scope.date);day=addDays(day,1)){
    if(scope.weekdays&&!scope.weekdays.includes(new Date(day+'T12:00:00Z').getUTCDay()))continue;
    let start:number,end:number;
    try{start=schedulingInstant(day,scope.from,scope.timezone);end=schedulingInstant(day,scope.to,scope.timezone);}catch{base.coverage='partial';base.candidates=[];base.limitations.push('A requested local time is skipped or repeated by a clock change. Confirm another window.');return base;}
    if(end<=now)continue;
    const busy=data.events.filter(e=>eventOnDate(e,day,scope.timezone)).map(e=>({event:e,start:e.time.kind==='timed'?Date.parse(e.time.start):start,end:e.time.kind==='timed'?Date.parse(e.time.end):end})).filter(e=>e.start<end&&e.end>start).sort((a,b)=>a.start-b.start||a.end-b.end);
    for(const b of busy)conflicts.set(b.event.id,{id:b.event.id,revision:hash(b.event),start:b.event.time.kind==='timed'?b.event.time.start:b.event.time.startDate,end:b.event.time.kind==='timed'?b.event.time.end:b.event.time.endDate});
    let cursor=Math.max(start,Math.ceil((now+1)/60000)*60000);
    // One per day first for multi-day requests; retain three choices for a single-day window.
    const dayLimit=scope.endDate&&scope.endDate!==scope.date?Math.min(3,base.candidates.length+1):3;
    const gap=(until:number)=>{while(cursor+duration<=until&&base.candidates.length<dayLimit){const candidate={start:new Date(cursor).toISOString(),end:new Date(cursor+duration).toISOString(),timezone:scope.timezone};base.candidates.push({id:hash({accountId,revision:base.rangeRevision,...candidate}),...candidate});cursor+=duration;}};
    for(const interval of busy){gap(Math.min(end,interval.start));cursor=Math.max(cursor,interval.end);}gap(end);
  }
  base.conflicts=[...conflicts.values()].slice(0,8);
  if(conflicts.size>8)base.limitations.push('Conflict links are limited to eight; availability checks included every returned event.');
  // The subject is only a hint. Exact identity is bound separately from source date/time or event ID.
  void subject;
  return plannerAvailabilitySchema.parse(base);
}

export function schedulingReply(inbox: InboxScheduling, planner: PlannerAvailability, plan?: SchedulingReplyPlan): string {
  if (!inbox.scope || planner.coverage !== 'complete' || !planner.candidates.length) throw new AppError('unavailable', 'No verified candidate windows are available for a reply.');
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: planner.scope.timezone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: planner.scope.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  if(plan){plan=schedulingReplyPlanSchema.parse(plan);if(new Set(plan.candidateIds).size!==plan.candidateIds.length||plan.candidateIds.some(id=>!planner.candidates.some(c=>c.id===id)))throw new AppError('permission_denied','Reply contains an unverified scheduling claim.');}
  const candidates=plan?plan.candidateIds.map(id=>planner.candidates.find(c=>c.id===id)!):planner.candidates;
  const times = candidates.map(c => `- ${fmt.format(new Date(c.start))}–${clock.format(new Date(c.end))} (${c.timezone})`).join('\n');
  if(plan)return `${plan.opening}\n\n${plan.style==='conversational'?'I found the following options in my primary calendar':'These options have no overlapping primary-calendar entries'} (${planner.scope.durationMinutes} minutes each):\n${times}\n\n${plan.question} Other participants’ availability still needs confirmation.`;
  return `Thank you for your ${inbox.intent === 'reschedule' ? 'request to find another meeting time' : 'scheduling request'}.\n\nThese ${planner.scope.durationMinutes}-minute windows currently have no overlapping entries in my primary calendar:\n${times}\n\nWould one of these work for you? These are proposed times; no meeting has been booked or changed.`;
}

export function schedulingRangeRef(accountId: string, facts: PlannerAvailability): ResourceRef {
  return { module: 'planner', connector: 'google', type: 'calendarRange', id: 'primary:' + facts.scope.date, accountId, profile: 'local', revision: facts.rangeRevision, label: 'Primary calendar · ' + facts.scope.date, provenance: { kind: 'connector', runId: null, fetchedAt: facts.fetchedAt }, access: 'read', retention: { kind: 'transient', expiresAt: null }, date: facts.scope.date, timezone: facts.scope.timezone };
}

export async function loadSchedulingContext(event: AgentIntake, timezone: string, readThread: () => Promise<MailThread>, readCalendar: (query: CalendarQuery) => Promise<CalendarData>, now: () => number, candidate?:SchedulingInterpretation): Promise<AgentContext> {
  const request = event.scheduling!;
  if (event.family !== 'email' || event.origin !== 'user' || event.trigger !== 'manual' || !event.accountId || !event.resourceId || event.replyTo) throw new AppError('permission_denied', 'Scheduling requires an explicit selected-message request.');
  const thread = await readThread();
  const selected = thread.messages.find(m => m.message.id === event.resourceId);
  if (thread.accountId !== event.accountId || thread.id !== request.threadId || threadRevision(thread) !== request.threadRevision || !selected || selected.message.threadId !== thread.id || Math.abs(now() - Date.parse(thread.fetchedAt)) > schedulingFreshMs) throw new AppError('conflict', 'The selected email or thread changed. Refresh the source before scheduling.');
  if (thread.truncated || thread.messages.length > 12 || thread.messages.some(m => m.truncated || !m.textAvailable)) throw new AppError('unavailable', 'The complete bounded thread is required. Refresh the message or prepare a manual reply.');
  let interpretation = understandScheduling(event,selected.text,'M1',timezone,Date.parse(selected.message.receivedAt),now(),candidate);
  let identified:ReturnType<typeof identifyMeeting>={event:null,ambiguous:false};
  if(interpretation.intent==='reschedule'&&interpretation.reference?.date){
    const referenceDate=interpretation.reference.date;
    if(Math.abs(Date.parse(referenceDate)-now())<=90*86400000){
      try{const original=await readCalendar({accountId:event.accountId,startDate:referenceDate,endDate:addDays(referenceDate,1),timezone:interpretation.scope?.timezone??timezone,refresh:true});
        if(original.accountId===event.accountId&&original.startDate===referenceDate&&original.endDate===addDays(referenceDate,1)&&!original.truncated&&!original.skipped&&Math.abs(now()-Date.parse(original.fetchedAt))<=schedulingFreshMs)identified=identifyMeeting(original.events,interpretation,original.timezone);
      }catch{/* Missing original evidence requires clarification. */}
      if(identified.event)interpretation=understandScheduling(event,selected.text,'M1',timezone,Date.parse(selected.message.receivedAt),now(),candidate,identified.event);
    }
  }
  const messages = [selected, ...thread.messages.filter(m => m !== selected)];
  const items: AgentContext['items'] = messages.map((m, i) => ({ id: 'M' + (i + 1), kind: 'email', accountId: event.accountId!, resourceId: m.message.id, revision: request.threadRevision, title: m.message.subject.slice(0, 240), text: m.text, fetchedAt: thread.fetchedAt, trust: 'untrusted-source', senderScope: null, threadId: thread.id }));
  if (items.some(s => s.text.length > 12000)) throw new AppError('unavailable', 'The thread exceeds the bounded scheduling context. Use a manual reply.');
  let facts: PlannerAvailability | null = null;
  if (interpretation.scope && !['uncertain', 'not-scheduling'].includes(interpretation.intent)) {
    let calendar: CalendarData | null = null;
    try { calendar = await readCalendar(schedulingQuery(event.accountId, interpretation.scope)); } catch { /* Retain an honest unavailable result. */ }
    facts = inspectAvailability(event.accountId, interpretation.scope, calendar, now(), selected.message.subject);
    if(interpretation.intent==='reschedule'&&calendar&&facts.coverage==='complete'){
      identified=identifyMeeting(calendar.events,interpretation,interpretation.scope.timezone);
      facts.meetingAmbiguous=identified.ambiguous;
      if(identified.event){const e=identified.event;facts.relatedEvent={id:e.id,revision:hash(e),date:e.time.kind==='timed'?dateInZone(new Date(e.time.start),interpretation.scope.timezone):e.time.startDate,event:e};facts.otherEventsRevision=calendarRangeRevision({...calendar,events:calendar.events.filter(v=>v.id!==e.id)});}
    }
    if(interpretation.intent==='reschedule'&&!facts.relatedEvent){interpretation.uncertainty.push(identified.ambiguous?'Several native events match this reference. Confirm the exact event ID.':'Confirm the original event ID, or its exact title, date and time. Title similarity alone does not identify a meeting.');facts.limitations.push('The original event is not confidently identified. No calendar update can be prepared.');}
    const ref = schedulingRangeRef(event.accountId, facts);
    items.push({ id: 'E1', kind: 'calendar', accountId: event.accountId, resourceId: ref.id, revision: ref.revision, title: ref.label, text: JSON.stringify(facts), fetchedAt: ref.provenance.fetchedAt, trust: 'untrusted-source', senderScope: null, threadId: null, delivery: { contextId: hash(ref), ref, mode: 'FULL', coverage: { status: 'complete', suppliedCharacters: JSON.stringify(facts).length, omittedCharacters: 0, sourcePartial: false, method: 'source' } } });
  }
  const sharing = { google: true, tasks: false };
  return { schedulingInterpretation:interpretation, id: randomUUID(), hash: hash({ items, timezone, sharing, interpretation }), createdAt: new Date(now()).toISOString(), timezone, items, sharing, available: { calendar: facts?.coverage === 'complete', tasks: false, thread: true }, limitations: ['Exact bounded email thread and primary-calendar scheduling facts only. Attachments and other calendars are not included.', 'Calendar facts are derived from native range evidence and must be revalidated before use.'] };
}
