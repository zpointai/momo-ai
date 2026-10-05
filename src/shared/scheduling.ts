import { z } from 'zod';
import { calendarEventSchema, dateSchema, timezoneSchema } from './google';
import type { AgentRun } from './orchestration';
import type { MailResult } from './mail';
import type { CalendarAction } from './calendar-actions';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const clock = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const schedulingIntentSchema = z.enum(['arrange', 'reschedule', 'availability', 'uncertain', 'not-scheduling']);
export const schedulingScopeSchema = z.object({
  date: dateSchema, from: clock, to: clock, timezone: timezoneSchema,
  endDate: dateSchema.optional(), weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
  referenceDate: dateSchema.optional(),
  durationMinutes: z.number().int().min(5).max(240),
}).strict().refine(s => s.from < s.to && (!s.endDate || s.endDate >= s.date && Date.parse(s.endDate)-Date.parse(s.date)<14*86400000) && (!s.referenceDate || Math.abs(Date.parse(s.referenceDate)-Date.parse(s.date))<=28*86400000), 'Choose a window of at most fourteen days; the meeting reference must be within four weeks.');
export type SchedulingScope = z.infer<typeof schedulingScopeSchema>;
// Candidates contain source spans, never availability, event existence or authority.
export const schedulingInterpretationSchema = z.object({
  intent: schedulingIntentSchema,
  dateText: z.string().max(200), timeText: z.string().max(200), durationText: z.string().max(100),
  timezoneText: z.string().max(100), meetingText: z.string().max(500),
  ambiguity: z.array(z.string().max(200)).max(5),
}).strict();
export type SchedulingInterpretation = z.infer<typeof schedulingInterpretationSchema>;
export const meetingReferenceSchema = z.object({eventId:z.string().max(1024).optional(),title:z.string().max(240).optional(),date:dateSchema.optional(),time:clock.optional()}).strict();
export const replyOpenings = ['Thanks for reaching out.', 'Thanks for suggesting a meeting.', 'Thanks for checking about another time.', 'Happy to look for a time that works.'] as const;
export const replyQuestions = ['Would any of these times work for you?', 'Which of these options would suit you best?', 'Please let me know whether one of these works for you.'] as const;
export const schedulingReplyPlanSchema = z.object({opening:z.enum(replyOpenings),question:z.enum(replyQuestions),candidateIds:z.array(digest).min(1).max(3),style:z.enum(['compact','conversational'])}).strict();
export type SchedulingReplyPlan = z.infer<typeof schedulingReplyPlanSchema>;
export const schedulingRequestSchema = z.object({
  threadId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/), threadRevision: digest,
  confirmed: z.object({ intent: z.enum(['arrange', 'reschedule', 'availability']), scope: schedulingScopeSchema, reference:meetingReferenceSchema.optional() }).strict().optional(),
}).strict();
export const inboxSchedulingSchema = z.object({
  schema: z.literal('inbox-scheduling-v1'), intent: schedulingIntentSchema,
  sourceId: z.string(), quote: z.string().max(500), scope: schedulingScopeSchema.nullable(),
  basis: z.enum(['source', 'owner-confirmed']), uncertainty: z.array(z.string().max(240)).max(5),
  candidate: schedulingInterpretationSchema.optional(), reference:meetingReferenceSchema.optional(),
  policy: z.array(z.string().max(240)).max(5).optional(), anchorDate:dateSchema.optional(),
}).strict();
export type InboxScheduling = z.infer<typeof inboxSchedulingSchema>;
export const schedulingCandidateSchema = z.object({ id: digest, start: z.string().datetime(), end: z.string().datetime(), timezone: timezoneSchema }).strict();
export const plannerAvailabilitySchema = z.object({
  schema: z.literal('planner-availability-v1'), scope: schedulingScopeSchema,
  accountId: z.string(), calendarId: z.literal('primary'), rangeRevision: digest,
  fetchedAt: z.string().datetime(), coverage: z.enum(['complete', 'partial', 'unavailable']),
  eventCount: z.number().int().nonnegative(), candidates: z.array(schedulingCandidateSchema).max(3),
  conflicts: z.array(z.object({ id: z.string().max(1024), revision: digest, start: z.string().max(40), end: z.string().max(40) }).strict()).max(8),
  relatedEvent: z.object({ id: z.string().max(1024), revision: digest, date: dateSchema, event:calendarEventSchema.optional() }).strict().nullable(),
  otherEventsRevision:digest.optional(), meetingAmbiguous:z.boolean().optional(),
  limitations: z.array(z.string().max(240)).max(6),
}).strict();
export type PlannerAvailability = z.infer<typeof plannerAvailabilitySchema>;
export const coordinatedSchedulingSchema = z.object({
  version: z.literal(1), phase: z.enum(['understanding', 'needs-information', 'checking-calendar', 'calendar-unavailable', 'preparing-reply', 'reviewing', 'awaiting-owner', 'cancelled', 'stale', 'partial', 'failed']),
  inbox: inboxSchedulingSchema.nullable(), planner: plannerAvailabilitySchema.nullable(),
  draftHash: digest.nullable(),
  sentMessageIds:z.array(z.string().max(128)).max(12).optional(),
  calendarReplyActionId:z.string().uuid().optional(),
  replyPlan:schedulingReplyPlanSchema.optional(), draftStale:z.boolean().optional(), replacementPending:z.boolean().optional(),
  previousDraftIds:z.array(z.string().uuid()).max(6).optional(), selectedCandidateId:digest.optional(),
  followUp:z.object({state:z.enum(['waiting-owner','waiting-recipient','recipient-responded','calendar-changed','replanning-suggested','action-approved','partially-completed','completed','cancelled']),checkedAt:z.string().datetime(),detail:z.string().max(240),observedThreadRevision:digest.optional()}).strict().optional(),
  calendarDelivery:z.object({actionId:z.string().uuid(),state:z.enum(['pending','denied','expired','dispatching','succeeded','failed','unknown']),approvedAt:z.string().datetime().nullable()}).strict().optional(),
  contextHistory: z.array(z.object({ hash: digest, phase: z.string().max(40), at: z.string().datetime() }).strict()).max(6).default([]),
  // Projected from the existing mail store; never an independent action or approval.
  delivery: z.object({ state: z.enum(['local', 'owner-edited', 'discarded', 'pending', 'denied', 'expired', 'sent', 'failed', 'unknown', 'sending', 'remote']), actionId: z.string().uuid().nullable(), draftRevision: z.number().int().nullable() }).strict().optional(),
}).strict();
export type CoordinatedScheduling = z.infer<typeof coordinatedSchedulingSchema>;

/** Conservative hints only. The native interpreter repeats this against the exact full message. */
export function schedulingIntent(text: string): InboxScheduling['intent'] {
  const current = text.split(/\n(?:On .{1,180}wrote:|From:|_{3,}|-{3,}\s*Original Message)/i)[0].replace(/^>.*$/gm, '');
  if (/\b(?:no need to|do not|don't|cancel(?:led)?)\s+(?:the\s+)?(?:meet|meeting|schedule|call)\b/i.test(current)) return 'uncertain';
  const request = /\b(?:can|could|shall|would)\s+(?:we|you|I)\s+(?:(?:please|possibly)\s+)?(?:meet|reschedule|move|arrange|schedule|book|set up|propose)\b|\bplease\s+(?:reschedule|move|arrange|schedule|propose|confirm)\b|\blet['’]s\s+(?:meet|reschedule|arrange|schedule)\b|\b(?:are|would|will)\s+you\s+(?:be\s+)?(?:available|free)\b/i.test(current);
  if (request && /\b(?:meet(?:ing)?|call|appointment|availability|available|reschedule)\b/i.test(current)) {
    if (/\b(?:reschedule|move|another|different)\b/i.test(current)) return 'reschedule';
    if (/\b(?:available|availability|free)\b/i.test(current)) return 'availability';
    return 'arrange';
  }
  return /\b(?:meeting|scheduling|appointment|reschedule|availability)\b/i.test(current) ? 'uncertain' : 'not-scheduling';
}

export function schedulingStatus(run: AgentRun) {
  const s = run.scheduling!;
  if (run.status === 'cancelled' || s.phase === 'cancelled') return { label: 'Cancelled', group: 'history' as const, detail: 'Scheduling work cancelled. Linked draft actions are blocked.' };
  if (['queued', 'running'].includes(run.status)) return { label: 'In progress', group: 'progress' as const, detail: run.checkpoint };
  const follow=s.followUp;
  if(follow&&follow.state!=='waiting-owner'){
    const labels={'waiting-recipient':'Waiting for recipient','recipient-responded':'Recipient responded','calendar-changed':'Proposed times are stale','replanning-suggested':'Replanning required','action-approved':'Action approved','partially-completed':'Partially completed','completed':'Completed','cancelled':'Cancelled'};
    return {label:labels[follow.state],group:['waiting-recipient','completed','cancelled'].includes(follow.state)?'history' as const:'review' as const,detail:follow.detail};
  }
  const d = s.delivery?.state;
  if (d === 'sent') return { label: 'Reply sent', group: 'history' as const, detail: 'Gmail confirmed the separately approved reply. No calendar change was made.' };
  if (d === 'sending' || d === 'unknown') return { label: 'Check send outcome', group: 'review' as const, detail: 'Inspect the linked mail action. It will not be retried automatically.' };
  if (d === 'denied' || d === 'discarded') return { label: d === 'denied' ? 'Send declined' : 'Draft discarded', group: 'history' as const, detail: 'No calendar change was made.' };
  if (s.phase === 'awaiting-owner') return { label: d === 'owner-edited' ? 'Edited reply needs review' : d === 'failed' ? 'Send failed' : d === 'expired' ? 'Send review expired' : 'Scheduling reply ready', group: 'review' as const, detail: d === 'owner-edited' ? 'Your edits replace the reviewed wording. Review the current draft before sending.' : 'Review the local reply in Inbox. Calendar facts are checked again before send approval.' };
  return { label: s.phase === 'stale' ? 'Sources changed' : s.phase === 'partial' ? 'Partly prepared' : 'Scheduling needs attention', group: 'review' as const, detail: run.error ?? s.inbox?.uncertainty.join(' ') ?? 'Open the source message to continue.' };
}

/** Both action stores remain authoritative; this is a persisted projection on the same root run. */
export function projectSchedulingActions(run:AgentRun,actions:CalendarAction[],now:number):AgentRun{
  if(!run.scheduling)return run;
  const s={...run.scheduling}, action=actions.find(a=>a.id===run.calendarProposalId&&a.draft.accountId===run.event.accountId);
  if(action)s.calendarDelivery={actionId:action.id,state:action.status==='pending'&&Date.parse(action.expiresAt)<=now?'expired':action.status,approvedAt:action.approvedAt};
  if(action?.status==='succeeded'&&s.calendarReplyActionId!==action.id&&s.delivery?.state!=='sent')s.draftStale=true;
  let state:NonNullable<CoordinatedScheduling['followUp']>['state']='waiting-owner',detail='Scheduling reply waiting for owner review.';
  const mail=s.delivery?.state,calendar=s.calendarDelivery?.state;
  if(s.phase==='cancelled'||run.status==='cancelled'){state='cancelled';detail='Workflow cancelled. Previously confirmed external outcomes remain recorded.';}
  else if(['recipient-responded','calendar-changed','replanning-suggested','completed'].includes(s.followUp?.state??'')){state=s.followUp!.state;detail=s.followUp!.detail;}
  else if(calendar==='succeeded'&&mail!=='sent'){state='partially-completed';detail='Calendar update completed; prepare and separately approve the confirmation reply.';}
  else if(s.phase==='stale'||s.draftStale){state='replanning-suggested';detail='Earlier proposed times are stale. Replan explicitly; your existing draft is preserved.';}
  else if(calendar==='succeeded'&&mail==='sent'){state='completed';detail='Google confirmed both the separately approved calendar update and reply.';}
  else if(calendar==='succeeded'){state='partially-completed';detail='Calendar update completed; the email reply still needs its own review and approval.';}
  else if(mail==='failed'||mail==='unknown'||calendar==='failed'||calendar==='unknown'||s.phase==='partial'){state='partially-completed';detail='A linked action or preparation needs attention. Inspect its outcome; no automatic retry will occur.';}
  else if(mail==='sending'||calendar==='dispatching'){state='action-approved';detail='An exact approval was consumed. Waiting for the recorded external outcome.';}
  else if(mail==='sent'&&calendar){state='partially-completed';detail='Reply sent; calendar update is '+calendar+' and requires its own owner decision.';}
  else if(mail==='sent'){state='waiting-recipient';detail='The separately approved reply was sent. Waiting for the recipient; no further action is automatic.';}
  if(s.followUp?.state!==state||s.followUp.detail!==detail)s.followUp={state,detail,checkedAt:new Date(now).toISOString(),...(s.followUp?.observedThreadRevision?{observedThreadRevision:s.followUp.observedThreadRevision}:{})};
  return {...run,scheduling:s};
}

export function projectSchedulingDelivery(run: AgentRun, mail: MailResult, now: number): AgentRun {
  if (!run.scheduling || !run.localDraftId) return run;
  const draft = mail.drafts.find(d => d.id === run.localDraftId && d.accountId === run.event.accountId);
  const actions = mail.actions.filter(a => a.draftId === run.localDraftId && a.accountId === run.event.accountId && a.kind === 'send');
  const action = actions.find(a => a.status === 'succeeded') ?? actions.find(a => ['unknown', 'dispatching'].includes(a.status)) ?? actions.filter(a => !draft || a.draft?.contentRevision === draft.contentRevision).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  let state: NonNullable<CoordinatedScheduling['delivery']>['state'] = !draft ? 'discarded' : draft.contentRevision > 0 ? 'owner-edited' : draft.status;
  if (action) state = action.status === 'succeeded' ? 'sent' : action.status === 'dispatching' ? 'sending' : action.status === 'pending' && Date.parse(action.expiresAt) <= now ? 'expired' : action.status;
  const sentMessageIds=[...new Set([...(run.scheduling.sentMessageIds??[]),...mail.actions.filter(a=>a.kind==='send'&&a.status==='succeeded'&&a.resultId&&[run.localDraftId,...(run.scheduling!.previousDraftIds??[])].includes(a.draftId??'')).map(a=>a.resultId!)])].slice(-12);
  return { ...run, scheduling: { ...run.scheduling, sentMessageIds, delivery: { state, actionId: action?.id ?? null, draftRevision: draft?.revision ?? null } } };
}
