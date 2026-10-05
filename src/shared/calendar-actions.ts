import { z } from 'zod';
import { accountIdSchema, dateSchema, timezoneSchema } from './google';
import { voiceCalendarProvenanceSchema } from './voice';
export const calendarWriteScope = 'https://www.googleapis.com/auth/calendar.events.owned';
const id = z.string().uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const eventDraftSchema = z.object({
  accountId: accountIdSchema, title: z.string().trim().min(1).max(240), timezone: timezoneSchema,
  time: z.discriminatedUnion('kind', [
    z.object({kind:z.literal('allDay'),startDate:dateSchema,endDate:dateSchema}).strict(),
    z.object({kind:z.literal('timed'),start:z.string().datetime(),end:z.string().datetime()}).strict(),
  ]),
}).strict().refine(d => { const t=d.time; const duration=t.kind==='allDay' ? +new Date(t.endDate)-+new Date(t.startDate) : +new Date(t.end)-+new Date(t.start); return duration>0 && duration<=35*86400000; }, 'End must follow start, within 35 days.');
export type EventDraft = z.infer<typeof eventDraftSchema>;
export const calendarActionSchema = z.object({
  voice:voiceCalendarProvenanceSchema.optional(),
  id, version:z.literal(1), tool:z.enum(['calendar.create','calendar.update']), draft:eventDraftSchema,
  accountEmail:z.string().max(320), calendar:z.literal('primary'), hash,
  eventId:z.string().regex(/^[A-Za-z0-9_-]{1,1024}$/), createdAt:z.string().datetime(), expiresAt:z.string().datetime(),
  target:z.object({revision:hash,etag:z.string().min(1).max(240),start:z.string().datetime({offset:true}),end:z.string().datetime({offset:true})}).strict().optional(),
  workflow:z.object({runId:id,contextHash:hash,candidateId:hash}).strict().optional(),
  status:z.enum(['pending','denied','expired','dispatching','succeeded','failed','unknown']),
  approvedAt:z.string().datetime().nullable(), finishedAt:z.string().datetime().nullable(),
  detail:z.string().max(500),
}).strict().refine(a=>a.tool==='calendar.create'?/^momo[a-f0-9]{32}$/.test(a.eventId)&&!a.target&&!a.workflow:!!a.target&&!!a.workflow&&a.draft.time.kind==='timed','An update requires an exact native target and linked workflow.');
export type CalendarAction = z.infer<typeof calendarActionSchema>;
export const calendarActionsSchema = z.array(calendarActionSchema).max(200);
export const calendarReviewSchema = z.object({action:calendarActionSchema,nonce:id}).strict();
export type CalendarReview = z.infer<typeof calendarReviewSchema>;
export const calendarActionCommandSchema = z.discriminatedUnion('action',[
  z.object({action:z.literal('list')}).strict(),
  z.object({action:z.literal('prepare'),draft:eventDraftSchema}).strict(),
  z.object({action:z.literal('prepareUpdate'),draft:eventDraftSchema,eventId:z.string().regex(/^[A-Za-z0-9_-]{1,1024}$/),expectedRevision:hash,workflow:z.object({runId:id,contextHash:hash,candidateId:hash}).strict()}).strict(),
  z.object({action:z.enum(['review','deny','reconcile']),id}).strict(),
  z.object({action:z.literal('approve'),id,hash,nonce:id}).strict(),
]);
export type CalendarActionCommand = z.infer<typeof calendarActionCommandSchema>;
export const calendarActionResultSchema = z.object({actions:calendarActionsSchema,review:calendarReviewSchema.nullable()}).strict();
export type CalendarActionResult = z.infer<typeof calendarActionResultSchema>;

// Resolve wall time explicitly in the chosen IANA zone, independent of Windows' zone.
// Reject nonexistent and ambiguous DST times instead of silently shifting a meeting.
export function wallTimeToInstant(value:string, timezone:string):string {
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('Choose a start and end time.');
  const wall=+new Date(value+':00Z'); if(!Number.isFinite(wall)) throw new Error('Invalid date.');
  const format=new Intl.DateTimeFormat('sv-SE',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const local=(time:number)=>format.format(new Date(time)).replace(' ','T');
  const offsets=new Set<number>();
  for(const hours of [-36,0,36]) { const sample=wall+hours*3600000; offsets.add(+new Date(local(sample)+':00Z')-sample); }
  const candidates=[...offsets].map(offset=>wall-offset).filter(time=>local(time)===value);
  if(candidates.length!==1) throw new Error('This local time is skipped or repeated by daylight saving. Choose an unambiguous time.');
  return new Date(candidates[0]).toISOString();
}
