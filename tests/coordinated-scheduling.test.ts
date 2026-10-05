// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SettingsDatabase } from '../electron/storage/database';
import { OrchestrationService } from '../electron/agent/service';
import { MailService } from '../electron/mail/service';
import { CalendarActionService } from '../electron/calendar/service';
import { BriefingStore } from '../electron/agent/briefing-store';
import { threadRevision } from '../electron/mail/thread';
import { hash } from '../electron/agent/catalogue';
import { inspectAvailability, schedulingInstant, calendarRangeRevision } from '../electron/agent/scheduling';
import { assertHandoff, assertWorkItem } from '../electron/agent/team';
import { initialAgentState, type AgentIntake, type AgentRun } from '../src/shared/orchestration';
import { schedulingIntent, projectSchedulingDelivery, type SchedulingScope } from '../src/shared/scheduling';
import { workflowPresentation } from '../src/shared/briefing';
import { archivableWorkflow } from '../src/shared/activity';
import { currentAssessments } from '../src/shared/assessment';
import type { CalendarData, CalendarQuery } from '../src/shared/google';
import type { MailThread } from '../src/shared/mail';

// Entirely isolated fixtures: no owner profile, connector transport or inference provider.
const databases: SettingsDatabase[] = [], services: OrchestrationService[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close(); for (const db of databases.splice(0)) db.close(); });
const scope: SchedulingScope = { date: '2026-10-01', from: '09:00', to: '12:00', timezone: 'Europe/Amsterdam', durationMinutes: 30 };
function fixture(body = 'Could we arrange a meeting for 30 minutes on 2026-10-01 between 09:00-12:00 Europe/Amsterdam?') {
 const db = new SettingsDatabase(':memory:'); databases.push(db);
 let now = Date.parse('2026-09-29T08:00:00Z'), selectedAccount = 'testAccount';
 const at = () => new Date(now).toISOString();
 const state = initialAgentState(); state.revision = 1; Object.assign(state.config, { enabled: true, shareGoogle: true });
 state.policies.push({ id: randomUUID(), family: 'email', accountId: 'testAccount', level: 'L1', enabled: true, version: 1, maxLocalPerDay: 1, schedule: { enabled: false, hour: 9, minute: 0, timezone: scope.timezone }, updatedAt: at() });
 db.agent('saveState', state);
 const thread: MailThread = { accountId: 'testAccount', id: 'thread1', fetchedAt: at(), truncated: false, messages: [{ message: { id: 'message1', threadId: 'thread1', subject: 'Project meeting', from: 'Sender <sender@example.test>', to: 'owner@example.test', snippet: body, receivedAt: at(), unread: true }, text: body, textAvailable: true, truncated: false, headers: { replyTo: 'sender@example.test', cc: '', messageId: '<message1@example.test>', references: '' }, attachments: [], labels: ['INBOX'] }] };
 const calendar: CalendarData = { accountId: 'testAccount', fetchedAt: at(), cached: false, timezone: scope.timezone, startDate: scope.date, endDate: '2026-10-02', truncated: false, skipped: 0, events: [{ id: 'event1', title: 'Project meeting', location: '', status: 'confirmed', recurringEventId: null, originalStart: null, time: { kind: 'timed', start: '2026-10-01T08:00:00Z', end: '2026-10-01T09:00:00Z', startTimezone: scope.timezone, endTimezone: scope.timezone } }] };
 const google = {
  state: vi.fn(async () => ({ configuration: 'configured' as const, connecting: false, activeAccountId: selectedAccount, accounts: [{ id: 'testAccount', email: 'owner@example.test', status: 'connected' as const, mailSend: true, mailCompose: true, calendarWrite: true }] })),
  readMailThread: vi.fn(async () => ({ ...structuredClone(thread), fetchedAt: at() })),
  readMailMessage: vi.fn(async () => structuredClone(thread.messages[0])),
  calendar: vi.fn(async (_q: CalendarQuery) => ({ ...structuredClone(calendar), fetchedAt: at() })),
  summary: vi.fn(), inbox: vi.fn(), calendarEpoch: () => 0,
  writeMail: vi.fn(async (_a: string, _kind: string, _input: unknown, _epoch: number, valid: () => boolean) => { if (!valid()) throw Error('Dispatch rejected'); return { id: 'sent1' }; }),
  findSentMessage: vi.fn(), insertApprovedEvent: vi.fn(), findApprovedEvent: vi.fn(),
 };
 const storage = { agent: async (op: string, input?: unknown) => db.agent(op, input), get: async () => db.get(), workspace: async () => db.workspace(), taskCommand: vi.fn(), mail: async (op: string, input?: unknown) => db.mail(op, input) };
 const mail = new MailService(storage, google, () => true, () => now);
 const process = vi.fn(), decide = vi.fn(), credentials = { status: vi.fn(async () => 'missing' as const), peekStatus: () => 'missing' as const, read: vi.fn() };
 const service = new OrchestrationService(storage, credentials, google, () => {}, { decide }, { process }, () => now, mail, new BriefingStore(), new CalendarActionService(db, google, () => now)); services.push(service);
 mail.setWorkflowValidator(draft => service.validateSchedulingDraft(draft));
 const event = (): AgentIntake => ({ id: randomUUID(), family: 'email', accountId: 'testAccount', resourceId: 'message1', prompt: 'Check this scheduling request', scheduling: { threadId: thread.id, threadRevision: threadRevision(thread) }, origin: 'user', trigger: 'manual', depth: 0, causationId: null });
 const get = (id: string) => db.agent('get', id) as AgentRun;
 const run = async (request = event()) => { const started = await service.start(request); await service.idle(); return get(started.id); };
 return { db, service, google, mail, calendar, thread, run, event, get, process, decide, credentials, now: () => now, advance: (ms: number) => { now += ms; }, account: (value: string) => { selectedAccount = value; } };
}

it.each([
 ['Could we meet next week?', 'arrange'], ['Please reschedule our meeting.', 'reschedule'], ['Are you available for a call?', 'availability'],
 ['Meeting notes for your records', 'uncertain'], ['The receipt is attached.', 'not-scheduling'], ['Please do not schedule the meeting.', 'uncertain'],
 ['Thank you.\nOn Monday, Alex wrote:\nCould we meet?', 'not-scheduling'],
 ['Could you send the meeting notes?', 'uncertain'],
])('classifies only bounded scheduling language: %s', (text, intent) => { expect(schedulingIntent(text)).toBe(intent); });

it('coordinates one persisted Executive task with typed domain handoffs and a grounded local reply', async () => {
 const f = fixture(), run = await f.run();
 expect(run.error).toBeNull(); expect(run.status).toBe('complete'); expect(run.scheduling?.phase).toBe('awaiting-owner');
 expect(run.team!.items.map(w => w.role)).toEqual(['executive', 'inbox', 'planner', 'inbox', 'review']);
 expect(run.team!.items.slice(1).every(w => w.parentWorkItemId === run.team!.items[0].id)).toBe(true);
 expect(run.team!.items[1].expectedResult).toBe('inbox-scheduling-v1'); expect(run.team!.items[2].expectedResult).toBe('planner-availability-v1');
 expect(run.team!.items[2].sources.map(s => s.type)).toEqual(['calendarRange']);
 expect(run.team!.items[1].sources.every(s => s.module === 'inbox')).toBe(true);
 expect(run.team!.items[2].permission.actions).toEqual([]);
 expect(run.team!.ledger!.passed).toBe(true);
 expect(run.result!.draft).toContain('1 October 2026 at 09:00'); expect(run.result!.draft).toContain('Europe/Amsterdam'); expect(run.result!.draft).toContain('no meeting has been booked or changed');
 const saved = await f.mail.command({ action: 'list', accountId: 'testAccount' });
 expect(saved.drafts).toHaveLength(1); expect(saved.drafts[0].fields.to).toBe('sender@example.test'); expect(saved.drafts[0].provenance?.workflow).toBe('inbox-planner-v1');
 expect(f.process).not.toHaveBeenCalled(); expect(f.decide).not.toHaveBeenCalled(); expect(f.credentials.read).not.toHaveBeenCalled(); expect(f.google.writeMail).not.toHaveBeenCalled(); expect(f.google.insertApprovedEvent).not.toHaveBeenCalled();
 expect(currentAssessments([run], 'testAccount')).toEqual([]);
});

it('keeps ambiguous dates as uncertainty without invoking Planner or Review, then continues the same task', async () => {
 const f = fixture('Could we meet tomorrow afternoon?'), run = await f.run(), root = run.team!.items[0].id;
 expect(run.scheduling?.phase).toBe('needs-information'); expect(f.google.calendar).not.toHaveBeenCalled(); expect(run.team!.items.map(w => w.role)).toEqual(['executive', 'inbox']);
 await f.service.command({ action: 'continueScheduling', id: run.id, confirmed: { intent: 'arrange', scope } }); await f.service.idle();
 const continued = f.get(run.id); expect(continued.status).toBe('complete'); expect(continued.team!.items[0].id).toBe(root); expect(continued.scheduling!.contextHistory).toHaveLength(1); expect(f.db.agent('runs')).toHaveLength(1);
});

it('reuses repeated requests and cannot continue or retry over an owner-edited draft', async () => {
 const f = fixture(), request = f.event(), first = await f.run(request), again = await f.run({ ...request, id: randomUUID() });
 expect(first.id).toBe(again.id); expect(f.db.agent('runs')).toHaveLength(1);
 const draft = (await f.mail.command({ action: 'list', accountId: 'testAccount' })).drafts[0];
 const edited = await f.mail.command({ action: 'saveLocal', accountId: draft.accountId, id: draft.id, expectedRevision: draft.revision, fields: { ...draft.fields, body: 'Owner edited wording.' } });
 expect(projectSchedulingDelivery(first, edited, f.now()).scheduling?.delivery?.state).toBe('owner-edited');
 await expect(f.service.command({ action: 'retryScheduling', id: first.id })).rejects.toThrow('without a saved draft');
 await expect(f.service.command({ action: 'continueScheduling', id: first.id, confirmed: { intent: 'arrange', scope } })).rejects.toThrow('already has a draft');
 expect((await f.mail.command({ action: 'list', accountId: draft.accountId })).drafts[0].fields.body).toBe('Owner edited wording.');
});

it('deduplicates against durable source identity even outside the latest hundred Activity records', async () => {
 const f = fixture(), event = f.event(), run = await f.run(event);
 for (let i = 0; i < 101; i++) { const id = randomUUID(); f.db.agent('enqueue', { ...run, id, dedup: hash(id), event: { ...run.event, id, resourceId: 'unrelated' + i } }); }
 expect((f.db.agent('runs') as AgentRun[]).some(r => r.id === run.id)).toBe(false);
 expect((await f.service.start({ ...event, id: randomUUID() })).id).toBe(run.id);
 expect((await f.mail.command({ action: 'list', accountId: 'testAccount' })).drafts).toHaveLength(1);
});

it.each(['partial', 'unavailable'] as const)('holds %s calendar coverage without inventing free time or a reply', async coverage => {
 const f = fixture(); if (coverage === 'partial') f.calendar.truncated = true; else f.google.calendar.mockRejectedValue(new Error('offline'));
 const run = await f.run(); expect(run.scheduling?.phase).toBe('calendar-unavailable'); expect(run.result!.draft).toBeNull(); expect(run.scheduling!.planner!.candidates).toEqual([]); expect(run.localDraftId).toBeUndefined(); expect(run.team!.items.some(w => w.role === 'review')).toBe(false);
});

it('rejects changed source threads before starting', async () => {
 const f = fixture(), event = f.event(); f.thread.messages[0].text += ' Actually, another day.';
 await expect(f.run(event)).rejects.toThrow('changed'); expect(f.google.calendar).not.toHaveBeenCalled();
});

it('detects a newly inserted conflicting calendar event, not just changes to old events', async () => {
 const f = fixture(); let calls = 0;
 f.google.calendar.mockImplementation(async () => { const data = structuredClone(f.calendar); if (++calls > 1) data.events.push({ ...data.events[0], id: 'new-event', time: { kind: 'timed', start: '2026-10-01T07:00:00Z', end: '2026-10-01T07:30:00Z', startTimezone: scope.timezone, endTimezone: scope.timezone } }); return data; });
 const run = await f.run(); expect(run.scheduling?.phase).toBe('stale'); expect(run.localDraftId).toBeUndefined();
});

it('cancels while a native read is pending and rejects its late result', async () => {
 const f = fixture(); let release!: () => void, entered!: () => void;
 const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
 let reads = 0; f.google.calendar.mockImplementation(async () => { if (++reads === 2) { entered(); await gate; } return structuredClone(f.calendar); });
 const started = await f.service.start(f.event()); await waiting;
 await f.service.command({ action: 'cancel', id: started.id }); release(); await f.service.idle();
 const run = f.get(started.id); expect(run.status).toBe('cancelled'); expect(run.scheduling?.phase).toBe('cancelled'); expect(run.localDraftId).toBeUndefined(); expect(f.google.writeMail).not.toHaveBeenCalled();
});

it('does not turn cross-account context or disabled Planner into scheduling authority', async () => {
 const f = fixture(); f.account('differentAccount'); await expect(f.run()).rejects.toThrow('original connected account');
 f.account('testAccount'); f.db.update({ expectedRevision: f.db.get().revision, patch: { disabledModules: ['planner'] } }); await expect(f.run()).rejects.toThrow('Planner must be available');
});

it('rejects a typed handoff that expands sources or grants writes', async () => {
 const f = fixture(), run = await f.run(), root = run.team!.items[0], planner = structuredClone(run.team!.items[2]);
 planner.permission.externalWrites = true as never; expect(() => assertHandoff(root, planner, run.team!)).toThrow('permissions');
 const changed = structuredClone(run.team!.items[2]); changed.sources[0].revision = hash('different'); expect(() => assertWorkItem(changed, run, f.now())).toThrow('revision');
});

it('keeps separate exact send approval and never creates a calendar action', async () => {
 const f = fixture(), run = await f.run(), draft = (await f.mail.command({ action: 'list', accountId: 'testAccount' })).drafts[0];
 const review = (await f.mail.command({ action: 'prepareSend', accountId: draft.accountId, id: draft.id, expectedRevision: draft.revision })).review!;
 expect(f.google.writeMail).not.toHaveBeenCalled(); expect(f.db.calendarActions()).toEqual([]);
 await expect(f.mail.command({ action: 'approveSend', accountId: draft.accountId, id: review.action.id, hash: review.action.hash, nonce: randomUUID() })).rejects.toThrow('exact send review');
 const second = (await f.mail.command({ action: 'prepareSend', accountId: draft.accountId, id: draft.id, expectedRevision: draft.revision })).review!;
 const outcome = await f.mail.command({ action: 'approveSend', accountId: draft.accountId, id: second.action.id, hash: second.action.hash, nonce: second.nonce });
 expect(f.google.writeMail).toHaveBeenCalledTimes(1); expect(projectSchedulingDelivery(run, outcome, f.now()).scheduling?.delivery?.state).toBe('sent'); expect(f.google.insertApprovedEvent).not.toHaveBeenCalled();
 await expect(f.mail.command({ action: 'approveSend', accountId: draft.accountId, id: second.action.id, hash: second.action.hash, nonce: second.nonce })).rejects.toThrow('already used'); expect(f.google.writeMail).toHaveBeenCalledTimes(1);
});

it.each(['thread', 'calendar', 'cancelled', 'settings'] as const)('revalidates %s at the existing send boundary', async change => {
 const f = fixture(), run = await f.run(), draft = (await f.mail.command({ action: 'list', accountId: 'testAccount' })).drafts[0];
 const review = (await f.mail.command({ action: 'prepareSend', accountId: draft.accountId, id: draft.id, expectedRevision: draft.revision })).review!;
 if (change === 'thread') f.thread.messages[0].text += ' Updated request.';
 if (change === 'calendar') f.calendar.events[0].title = 'Updated meeting';
 if (change === 'cancelled') await f.service.command({ action: 'cancel', id: run.id });
 if (change === 'settings') f.db.update({ expectedRevision: f.db.get().revision, patch: { timezone: 'UTC' } });
 await expect(f.mail.command({ action: 'approveSend', accountId: draft.accountId, id: review.action.id, hash: review.action.hash, nonce: review.nonce })).rejects.toThrow(); expect(f.google.writeMail).not.toHaveBeenCalled();
});

it('retains Planner facts if local reply saving fails and retries within the same task', async () => {
 const f = fixture(), original = f.mail.command.bind(f.mail); let fail = true;
 vi.spyOn(f.mail, 'command').mockImplementation((command, authority) => { if (fail && command.action === 'compose') return Promise.reject(new Error('isolated local write failure')); return original(command, authority); });
 const run = await f.run(); expect(run.scheduling?.phase).toBe('partial'); expect(run.scheduling?.planner?.candidates.length).toBeGreaterThan(0); expect(run.localDraftId).toBeUndefined();
 fail = false; await f.service.command({ action: 'retryScheduling', id: run.id }); await f.service.idle(); expect(f.get(run.id).localDraftId).toBe(run.id); expect(f.db.agent('runs')).toHaveLength(1); expect(f.get(run.id).team!.items.length).toBe(5);
});

it('rejects send if global authority changes while fresh calendar evidence is being fetched', async () => {
 const f = fixture(); await f.run(); const draft = (await f.mail.command({ action: 'list', accountId: 'testAccount' })).drafts[0];
 const review = (await f.mail.command({ action: 'prepareSend', accountId: draft.accountId, id: draft.id, expectedRevision: draft.revision })).review!;
 let release!: () => void, entered!: () => void;
 const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
 f.google.calendar.mockImplementation(async () => { entered(); await gate; return structuredClone(f.calendar); });
 const pending = f.mail.command({ action: 'approveSend', accountId: draft.accountId, id: review.action.id, hash: review.action.hash, nonce: review.nonce });
 const rejected = expect(pending).rejects.toThrow('cancelled or changed');
 await waiting; f.service.cancel(); release(); await rejected; expect(f.google.writeMail).not.toHaveBeenCalled();
});

it('preserves approval revisions when the owner edits after send preparation', async () => {
 const f = fixture(); await f.run(); const draft = (await f.mail.command({ action: 'list', accountId: 'testAccount' })).drafts[0];
 const review = (await f.mail.command({ action: 'prepareSend', accountId: draft.accountId, id: draft.id, expectedRevision: draft.revision })).review!;
 await f.mail.command({ action: 'saveLocal', accountId: draft.accountId, id: draft.id, expectedRevision: draft.revision, fields: { ...draft.fields, body: draft.fields.body + '\nOwner note.' } });
 await expect(f.mail.command({ action: 'approveSend', accountId: draft.accountId, id: review.action.id, hash: review.action.hash, nonce: review.nonce })).rejects.toThrow('exact send review'); expect(f.google.writeMail).not.toHaveBeenCalled();
});

it('represents one owner-review workflow in Activity and projects decline and expiry honestly', async () => {
 const f = fixture(), run = await f.run(); expect(workflowPresentation(run).group).toBe('review'); expect(archivableWorkflow(run)).toBe(false);
 const draft = (await f.mail.command({ action: 'list', accountId: 'testAccount' })).drafts[0], review = (await f.mail.command({ action: 'prepareSend', accountId: draft.accountId, id: draft.id, expectedRevision: draft.revision })).review!;
 f.advance(121000); expect(projectSchedulingDelivery(run, await f.mail.command({ action: 'list', accountId: draft.accountId }), f.now()).scheduling?.delivery?.state).toBe('expired');
 const result = await f.mail.command({ action: 'deny', accountId: draft.accountId, id: review.action.id }); expect(workflowPresentation(projectSchedulingDelivery(run, result, f.now())).label).toBe('Send declined');
});

it('resolves timezone offsets and rejects nonexistent and repeated wall times', () => {
 expect(new Date(schedulingInstant('2026-10-01', '09:00', 'Europe/Amsterdam')).toISOString()).toBe('2026-10-01T07:00:00.000Z');
 expect(() => schedulingInstant('2026-03-29', '02:30', 'Europe/Amsterdam')).toThrow('clock change'); expect(() => schedulingInstant('2026-10-25', '02:30', 'Europe/Amsterdam')).toThrow('clock change');
});

it('treats all-day and tentative events conservatively, hashes empty ranges and keeps native query scope exact', () => {
 const f = fixture(); f.calendar.events = []; const empty = inspectAvailability('testAccount', scope, f.calendar, f.now()); expect(empty.candidates).toHaveLength(3);
 const revision = calendarRangeRevision(f.calendar); f.calendar.events.push({ id: 'day', title: 'Away', location: '', status: 'tentative', recurringEventId: null, originalStart: null, time: { kind: 'allDay', startDate: scope.date, endDate: '2026-10-02' } });
 expect(calendarRangeRevision(f.calendar)).not.toBe(revision); expect(inspectAvailability('testAccount', scope, f.calendar, f.now()).candidates).toEqual([]);
 f.calendar.accountId = 'other'; expect(inspectAvailability('testAccount', scope, f.calendar, f.now()).coverage).toBe('unavailable');
});
