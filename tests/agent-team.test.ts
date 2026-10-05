// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SettingsDatabase } from '../electron/storage/database';
import { OrchestrationService } from '../electron/agent/service';
import { assertHandoff, assertWorkItem, contextRequest, handoff, specialist } from '../electron/agent/team';
import { evidenceLedger } from '../electron/agent/review';
import { decodeMicro, microQuestions, roundedDistribution, type MicroDecision } from '../electron/agent/micro-decisions';
import { initialAgentState, type AgentIntake, type AgentRun, type JevAnswer, type JevQuestion, type ProcessingResult } from '../src/shared/orchestration';
import { hash } from '../electron/agent/catalogue';
import { type ProcessingOptions } from '../electron/agent/providers';
import { MailService } from '../electron/mail/service';
import { CalendarActionService } from '../electron/calendar/service';
import { BriefingStore } from '../electron/agent/briefing-store';
import { threadRevision } from '../electron/mail/thread';
import type { MailThread } from '../src/shared/mail';

const dbs: SettingsDatabase[] = [];
const services: OrchestrationService[] = [];
afterEach(async () => { for (const s of services.splice(0)) await s.close(); for (const db of dbs.splice(0)) db.close(); vi.useRealTimers(); });
function fixture() {
  const db = new SettingsDatabase(':memory:'); dbs.push(db);
  let now = Date.parse('2026-09-27T09:00:00Z'), account = 'accountA', failure = '', question = false, useTool = false, mutate = () => {};
  const at = () => new Date(now).toISOString();
  db.update({ expectedRevision: 0, patch: { deepseekEnabled: true, jevEnabled: true, dailyCallLimit: 100 } });
  const state = initialAgentState(); state.revision = 1; Object.assign(state.config, { enabled: true, shareGoogle: true, shareTasks: true, dailyCalls: 100 });
  for (const family of ['email', 'task', 'briefing', 'chat'] as const) state.policies.push({ id: randomUUID(), family, accountId: account, level: 'L2', enabled: true, version: 1, maxLocalPerDay: 1, schedule: { enabled: false, hour: 9, minute: 0, timezone: 'Europe/Amsterdam' }, updatedAt: at() });
  db.agent('saveState', state);
  const message = { id: 'mail1', threadId: 'thread1', subject: 'Project review', from: 'Sender <sender@example.test>', to: 'owner@example.test', snippet: 'Please review the project.', receivedAt: at(), unread: true };
  const thread: MailThread = { id: 'thread1', accountId: account, fetchedAt: at(), truncated: false, messages: [{ message, text: 'Please review the project. Which option should we use?', textAvailable: true, truncated: false, attachments: [], headers: { replyTo: 'sender@example.test', cc: '', messageId: '<mail1@example.test>', references: '' }, labels: ['INBOX'] }] };
  const events = [
    { id: 'event1', title: 'Project review', location: '', status: 'confirmed' as const, recurringEventId: null, originalStart: null, time: { kind: 'timed' as const, start: '2026-09-27T10:00:00.000Z', end: '2026-09-27T11:00:00.000Z', timezone: 'Europe/Amsterdam' } },
    { id: 'event2', title: 'Design review', location: '', status: 'confirmed' as const, recurringEventId: null, originalStart: null, time: { kind: 'timed' as const, start: '2026-09-27T10:30:00.000Z', end: '2026-09-27T11:30:00.000Z', timezone: 'Europe/Amsterdam' } },
  ];
  const google = {
    state: vi.fn(async () => ({ configuration: 'configured' as const, connecting: false, activeAccountId: account, accounts: [{ id: account, email: 'owner@example.test', status: 'connected' as const, calendarWrite: false, mailSend: false, mailCompose: false, mailModify: false }] })),
    summary: vi.fn(async () => ({ accountId: account, fetchedAt: at(), cached: false, messages: [message], nextPageToken: null, failed: 0 })),
    inbox: vi.fn(async () => google.summary()),
    calendar: vi.fn(async () => ({ accountId: account, fetchedAt: at(), cached: false, timezone: 'Europe/Amsterdam', startDate: '2026-09-27', endDate: '2026-10-04', events, truncated: false, skipped: 0 })),
    readMailThread: vi.fn(async () => structuredClone(thread)), readMailMessage: vi.fn(async () => structuredClone(thread.messages[0])),
    calendarEpoch: () => 0, writeMail: vi.fn(), findSentMessage: vi.fn(), insertApprovedEvent: vi.fn(), findApprovedEvent: vi.fn(),
  };
  const storage = { agent: async (op: string, input?: unknown) => db.agent(op, input), get: async () => db.get(), workspace: async () => db.workspace(), taskCommand: vi.fn(), mail: async (op: string, input?: unknown) => db.mail(op, input) };
  const mail = new MailService(storage, google);
  const calendar = new CalendarActionService(db, google, () => now);
  const decide = vi.fn(async (_key: string, _model: string, _evidence: unknown, questions: Record<string, JevQuestion>) => {
    if (failure === 'jev') throw new Error('Isolated provider unavailable');
    const answers: Record<string, JevAnswer> = {};
    for (const [id, q] of Object.entries(questions)) { if (q.type !== 'choice') throw Error('Only atomic Choice expected'); const choice = id === 'priority' ? 'normal' : 'no'; answers[id] = { type: 'choice', choice, confidence: .5, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === choice ? 1 : 0])) }; }
    return { answers, reportedModel: 'jev-test', usage: { input: 20, output: 5 } };
  });
  let result: ProcessingResult | null = null;
  const process = vi.fn(async (o: ProcessingOptions) => {
    await o.checkAuthority(); await o.beforeRound();
    if (failure === 'deepseek') throw new Error('Isolated provider unavailable');
    if (useTool) await o.readContext!([o.context.items[0].id]);
    await o.usage('deepseek-flash', { input: 100, output: 30 }); mutate();
    return result ?? { text: 'The supplied project request needs review.', draft: o.route === 'DRAFT_REPLY' && !question ? 'Thank you for the project details.' : null, clarification: question ? 'Which option should I include?' : null, evidence: o.context.items.map(s => s.id), reminders: [] };
  });
  const store = new BriefingStore();
  const service = new OrchestrationService(storage, { status: async () => 'configured', peekStatus: () => 'configured', read: async () => 'ISOLATED_TEST_KEY' }, google, () => {}, { decide }, { process }, () => now, mail, store, calendar); services.push(service);
  const event = (family: AgentIntake['family'] = 'email', prompt = 'Assess this project request'): AgentIntake => ({ id: randomUUID(), family, accountId: account, ...(family === 'email' ? { resourceId: 'mail1' } : {}), prompt, trigger: 'manual', causationId: null, depth: 0, origin: 'user' });
  const run = async (input = event()) => { const started = await service.start(input); await service.idle(); return (db.agent('runs') as AgentRun[]).find(r => r.id === started.id)!; };
  const reply = async () => { const original = await run(); return run({ ...event('email', 'Prepare a grounded reply'), replyTo: { runId: original.id, sourceRevision: original.context.items.find(s => s.id === 'M1')!.revision, threadId: thread.id, threadRevision: threadRevision(thread) } }); };
  return { db, service, google, run, reply, event, decide, process, store, events, at, now: () => now, setTime: (v: number) => { now = v; }, setAccount: (v: string) => { account = v; }, outage: (v: string) => { failure = v; }, clarify: () => { question = true; }, tool: () => { useTool = true; }, output: (v: ProcessingResult) => { result = v; }, afterProcess: (fn: () => void) => { mutate = fn; } };
}

it('Executive creates an Inbox WorkItem, invokes context and persists bounded typed handoffs', async () => {
  const f = fixture(), run = await f.run(), work = specialist(run);
  expect(run.status).toBe('complete'); expect(work.role).toBe('inbox'); expect(run.team!.items.map(w => w.role)).toEqual(['executive', 'inbox', 'context', 'review', 'context']);
  expect(work.sources.length).toBeGreaterThan(0); expect(work.permission.externalWrites).toBe(false); expect(run.team!.ledger!.passed).toBe(true);
  expect(f.decide.mock.calls.every(c => !('profile' in c[3]) && !('addressed' in c[3]))).toBe(true);
});
it('Inbox requests complete current-thread context and reuses the native local reply lifecycle', async () => {
  const f = fixture(), run = await f.reply(); expect(run.status).toBe('complete'); expect(run.localDraftId).toBe(run.id);
  expect(run.context.items.every(s => s.delivery?.mode === 'FULL' && s.kind === 'email')).toBe(true);
  expect(run.team!.items.some(w => w.role === 'context' && w.parentWorkItemId === run.team!.specialistId)).toBe(true);
  expect(f.google.writeMail).not.toHaveBeenCalled();
});
it('missing reply information returns a clarification and never produces a draft', async () => {
  const f = fixture(); f.clarify(); const run = await f.reply(); expect(run.status).toBe('review'); expect(specialist(run).status).toBe('clarification'); expect(run.localDraftId).toBeUndefined();
});
it('Executive Planner checks conflicts without either provider and preserves attendance uncertainty', async () => {
  const f = fixture(), run = await f.run(f.event('task', 'check conflicts'));
  expect(run.status).toBe('complete'); expect(specialist(run).role).toBe('planner'); expect(run.result!.text).toContain('Possible conflict'); expect(run.result!.text).toContain('Attendance is unknown'); expect(run.calls).toEqual([]);
});
it('Briefing keeps a deterministic snapshot useful with no provider and binds optional synthesis to it', async () => {
  const f = fixture(); await f.service.command({ action: 'dailyBriefing', refresh: false, synthesize: false });
  const daily = await f.store.get('accountA'); expect(daily!.snapshot.entries).toHaveLength(2); expect(daily!.snapshot.connectors).toEqual({ weather: 'not-configured', traffic: 'not-configured' }); expect(f.process).not.toHaveBeenCalled();
  const run = await f.run(f.event('briefing')); expect(specialist(run).role).toBe('briefing'); expect(run.briefingBinding).toBeDefined(); expect(run.team!.ledger!.passed).toBe(true);
});
it('Context filters an unauthorized candidate before advisory relevance, retaining only permitted references', async () => {
  const f = fixture(), run = await f.run(), work = specialist(run), advisor = { assess: vi.fn(() => [{ id: 'unauthorized', signal: 'relevant' as const }]) };
  const request = contextRequest(run, work, ['M1'], f.now(), undefined, advisor);
  expect(request.refs).toHaveLength(1); expect(request.refs[0].accountId).toBe('accountA'); expect(advisor.assess).toHaveBeenCalled(); expect(request.sources[0].id).toBe('M1');
  expect(() => contextRequest(run, work, ['OTHER_ACCOUNT'], f.now(), undefined, advisor)).toThrow('unauthorized'); expect(advisor.assess).toHaveBeenCalledTimes(1);
});
it('Review rejects unsupported evidence before optional semantic review', async () => {
  const f = fixture(); f.output({ text: 'Unsupported', draft: null, evidence: ['M99'], reminders: [] }); const run = await f.run();
  expect(run.status).toBe('review'); expect(run.team!.ledger!.checks).toContainEqual(expect.objectContaining({ code: 'EVIDENCE_IDS', status: 'reject' })); expect(f.decide).toHaveBeenCalledTimes(1);
});
it('rejects cross-account WorkItems independently of high confidence', async () => {
  const f = fixture(), run = await f.run(), work = structuredClone(specialist(run)); work.accountId = 'accountB'; expect(() => assertWorkItem(work, run, f.now())).toThrow('scope');
});
it('rejects stale revisions and rejects real source changes during generation', async () => {
  const f = fixture(), run = await f.run(), work = structuredClone(specialist(run)); work.sources[0].revision = hash('stale'); expect(() => assertWorkItem(work, run, f.now())).toThrow('revision');
  const other = fixture(); other.afterProcess(() => { other.events[0].title = 'Changed'; }); const stale = await other.run(other.event('task', 'Explain scheduling')); expect(stale.status).not.toBe('complete'); expect(stale.error).toContain('changed');
});
it('rejects unauthorized tools and prevents a handoff from expanding every authority dimension', async () => {
  const f = fixture(), run = await f.run(), parent = specialist(run), child = structuredClone(run.team!.items.find(w => w.role === 'context')!);
  for (const mutate of [(w: typeof child) => { w.allowedTools = ['send_mail'] as never; }, (w: typeof child) => { w.permission.externalWrites = true as never; }, (w: typeof child) => { w.accountId = 'other'; }, (w: typeof child) => { w.sources.push({ ...w.sources[0], id: 'unpermitted' }); }, (w: typeof child) => { w.contextBudget.maxBytes = parent.contextBudget.maxBytes + 1; }]) { const v = structuredClone(child); mutate(v); expect(() => assertHandoff(parent, v, run.team!)).toThrow(); }
  const v = structuredClone(parent); v.allowedTools = [];
  expect(() => contextRequest(run, v, ['M1'], f.now())).toThrow('not permitted');
});
it('REFERENCE_ONLY cannot become FULL during handoff or context retrieval', async () => {
  const f = fixture(), run = await f.run(); for (const s of run.context.items) s.delivery!.mode = 'REFERENCE_ONLY'; for (const w of run.team!.items) for (const b of w.context.bindings) b.delivery.mode = 'REFERENCE_ONLY';
  const parent = specialist(run), child = structuredClone(run.team!.items.find(w => w.role === 'context')!); child.context.bindings[0].delivery.mode = 'FULL'; expect(() => assertHandoff(parent, child, run.team!)).toThrow('upgrade');
  const selected = contextRequest(run, parent, ['M1'], f.now()); expect(selected.sources[0].delivery!.mode).toBe('REFERENCE_ONLY');
});
it('enforces maximum handoff depth, maximum steps and duplicate suppression', async () => {
  const f = fixture(), run = await f.run(), team = run.team!, parent = specialist(run);
  const a = handoff(team, parent, 'context', 'Narrow evidence', f.now()); expect(handoff(team, parent, 'context', 'Narrow evidence', f.now()).id).toBe(a.id);
  const b = handoff(team, a, 'context', 'One more bounded request', f.now()); expect(() => handoff(team, b, 'context', 'Too deep', f.now())).toThrow('depth');
  team.limits.maxSteps = team.items.length; expect(() => handoff(team, parent, 'context', 'Too many', f.now())).toThrow('steps');
  const count = f.process.mock.calls.length; const duplicate = await f.run(); expect(duplicate.id).toBe(run.id); expect(f.process.mock.calls).toHaveLength(count);
});
it('cancellation and timeout reject late results without action', async () => {
  for (const cancel of [true, false]) { const f = fixture(); f.afterProcess(() => cancel ? f.service.cancel() : f.setTime(f.now() + 301000)); const run = await f.run(); expect(run.status).not.toBe('complete'); expect(run.proposals).toEqual([]); expect(specialist(run).status).toBe(cancel ? 'cancelled' : 'timed-out'); }
});
it('Jev disagreement cannot choose an impossible role or tool', async () => {
  const f = fixture(); f.decide.mockImplementation(async () => ({ reportedModel: 'jev-test', usage: { input: 20, output: 5 }, answers: { profile: { type: 'choice', choice: 'DOCUMENT_ANALYSIS', confidence: 1, probabilities: { DOCUMENT_ANALYSIS: 1 } } } }));
  const run = await f.run(); expect(run.decision!.route).toBe('EXTRACT_ACTIONS'); expect(run.status).toBe('complete'); expect(specialist(run).allowedTools).toEqual(['read_context']);
});
it('Jev unavailable leaves deterministic policy and generation intact; DeepSeek unavailable never invents a result', async () => {
  const a = fixture(); a.outage('jev'); const run = await a.run(); expect(run.status).toBe('complete'); expect(run.team!.ledger!.semantic).toBe('unavailable'); expect(run.proposals).toEqual([]);
  const b = fixture(); b.outage('deepseek'); const failed = await b.run(); expect(failed.status).toBe('failed'); expect(failed.result).toBeNull(); expect(failed.proposals).toEqual([]);
});
it('task and exact calendar proposals require existing owner approval even under L2', async () => {
  const f = fixture(); f.output({ text: 'Consider preparing notes.', draft: null, evidence: ['M1'], reminders: [{ title: 'Prepare project notes', sourceId: 'M1' }] }); const run = await f.run();
  expect(run.proposals[0].authorization).toBe('none'); expect(f.db.workspace().tasks).toEqual([]); await f.service.command({ action: 'approveLocal', id: run.proposals[0].id, hash: run.proposals[0].hash }); expect(f.db.workspace().tasks).toHaveLength(1);
  const p = fixture(); p.output({ text: 'Proposed meeting.', draft: null, evidence: ['E1'], reminders: [], calendarProposal: { draft: { accountId: 'accountA', title: 'Review follow-up', timezone: 'Europe/Amsterdam', time: { kind: 'timed', start: p.events[0].time.start, end: p.events[0].time.end } }, evidence: ['E1'] } }); const proposed = await p.run(p.event('task', 'Propose a meeting'));
  expect(proposed.status).toBe('complete'); expect(proposed.calendarProposalId).toBeDefined(); expect(p.db.calendarActions()[0].status).toBe('pending'); expect(p.google.insertApprovedEvent).not.toHaveBeenCalled();
});
it('ledger checks required tools, exact commitment quotes, duplicate tasks and unknown scheduling duration', async () => {
  const f = fixture(), run = await f.run(), work = specialist(run); work.requiredTools = ['read_context']; const output = { text: 'Result', draft: null, evidence: ['M1'], reminders: [], commitments: [{ text: 'I will attend', sourceId: 'M1', quote: 'Invented quote' }] };
  const ledger = evidenceLedger(run, work, output, f.now()); expect(ledger.passed).toBe(false); expect(ledger.checks.filter(c => c.status === 'reject').map(c => c.code)).toEqual(expect.arrayContaining(['TOOL_COMPLETION', 'EXPLICIT_COMMITMENTS']));
});
it('records actual read_context completion and only returns permitted evidence', async () => {
  const f = fixture(); f.tool(); const run = await f.run(); expect(run.status).toBe('complete'); expect(run.team!.toolCompletions).toHaveLength(1); expect(run.team!.toolCompletions[0].evidenceIds).toEqual(['M1']);
});
it('preserves raw rounded mass/confidence and uses replaceable bounded micro operations', () => {
  const requests: MicroDecision[] = [{ id: 'relevance', operation: 'relevance', question: 'Relevant?', candidates: ['yes', 'no', 'unknown'].map(id => ({ id, description: id })) }];
  const raw: JevAnswer = { type: 'choice', choice: 'yes', confidence: .35, probabilities: { yes: .34, no: .33, unknown: .32 } };
  expect(roundedDistribution(['yes', 'no', 'unknown'], raw.probabilities, 'yes').rawSum).toBe(.99);
  expect(decodeMicro(requests, { relevance: raw })[0]).toMatchObject({ raw, confidence: .35, probabilities: raw.probabilities, distribution: { renormalized: false } }); expect(microQuestions(requests).relevance.type).toBe('choice');
  expect(() => roundedDistribution(['yes', 'no'], { yes: .6, no: .1 }, 'yes')).toThrow(); expect(() => roundedDistribution(['yes', 'no'], { yes: .4, no: .6 }, 'yes')).toThrow();
});
it('the single Assistant workflow can deterministically select Planner without a separate chatbot', async () => {
  const f = fixture(); f.db.update({ expectedRevision: 1, patch: { deepseekEnabled: false, jevEnabled: false } });
  const run = await f.run(f.event('chat', 'check conflicts')); expect(specialist(run).role).toBe('planner'); expect(run.status).toBe('complete'); expect(run.calls).toEqual([]); expect(run.result!.text).toContain('Possible conflict');
});
it('an empty task list completes without unrelated calendar retrieval or any provider', async () => {
  const f = fixture(); const run = await f.run(f.event('task', 'list my tasks'));
  expect(run.status).toBe('complete'); expect(run.result!.text).toContain('No account-scoped tasks'); expect(run.calls).toEqual([]); expect(f.google.calendar).not.toHaveBeenCalled();
});
it('a long clarification remains readable while its persisted failure reason stays bounded', async () => {
  const f = fixture(); f.output({ text: 'Need owner information', draft: null, clarification: 'Which detail? '.repeat(40), evidence: ['M1'], reminders: [] });
  const run = await f.run(); expect(run.status).toBe('review'); expect(run.error!.length).toBeLessThanOrEqual(240); expect(specialist(run).unresolvedQuestions[0].length).toBeGreaterThan(240);
});
it('a proposal duplicating a native task outside the delivered context cannot create another object', async () => {
  const f = fixture(); const state = initialAgentState(); Object.assign(state, f.db.agent('state')); state.revision++; state.config.shareTasks = false; f.db.agent('saveState', state);
  f.db.taskCommand({ action: 'create', id: randomUUID(), accountId: 'accountA', draft: { title: 'Review the project', due: { kind: 'none' } } });
  f.output({ text: 'Preparation', draft: null, evidence: ['M1'], reminders: [{ title: 'Review the project', sourceId: 'M1' }] });
  const run = await f.run(); expect(run.status).not.toBe('complete'); expect(run.error).toContain('already exists'); expect(run.proposals).toEqual([]); expect(f.db.workspace().tasks).toHaveLength(1);
});
it('a disabled source workspace cannot be used after context selection or by advisory choice', async () => {
  const f = fixture(); f.afterProcess(() => { f.db.update({ expectedRevision: 1, patch: { disabledModules: ['planner'] } }); });
  const run = await f.run(f.event('task', 'Explain availability')); expect(run.status).not.toBe('complete'); expect(run.error).toContain('workspace'); expect(run.proposals).toEqual([]);
});
it('native review holds an explicit unsupplied owner promise even when semantic advice would pass', async () => {
  const f = fixture(); const original = await f.run();
  f.output({ text: 'A reply', draft: 'I will attend.', evidence: ['M1'], reminders: [] });
  const work = structuredClone(specialist(original)); work.permission.actions.push('local-reply');
  const ledger = evidenceLedger(original, work, { text: 'A reply', draft: 'I will attend.', evidence: ['M1'], reminders: [] }, f.now());
  expect(ledger.checks).toContainEqual(expect.objectContaining({ code: 'OWNER_COMMITMENT', status: 'reject' }));
});
