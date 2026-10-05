// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SettingsDatabase } from '../electron/storage/database';
import { OrchestrationService } from '../electron/agent/service';
import { initialAgentState, type AgentRun } from '../src/shared/orchestration';
import { relayEventSchema, commsResultSchema, relayNeedsDecision, type RelayEvent, type RelayReceipt } from '../src/shared/relay';
import { assertSmsApproval, consumeSmsApproval, smsActionHash } from '../electron/agent/relay-store';
import { hash } from '../electron/agent/catalogue';
import type { ProcessingOptions } from '../electron/agent/providers';
import { modules, resolveRoute } from '../src/shared/modules';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function fixture(filename = ':memory:', model = true) {
  const db = new SettingsDatabase(filename); let now = Date.now(); const at = () => new Date(now).toISOString();
  const state = initialAgentState(); state.revision = 1; Object.assign(state.config, { enabled: true, shareTasks: true, dailyCalls: 100 });
  state.policies.push({ id: randomUUID(), family: 'task', accountId: null, level: 'L1', enabled: true, version: 1, maxLocalPerDay: 1, schedule: { enabled: false, hour: 9, minute: 0, timezone: 'UTC' }, updatedAt: at() });
  db.agent('saveState', state); db.update({ expectedRevision: 0, patch: { deepseekEnabled: model, dailyCallLimit: 100 } });
  const taskId = randomUUID(); db.taskCommand({ action: 'create', id: taskId, accountId: null, draft: { title: 'SYNTHETIC equipment handover', due: { kind: 'none' } } });
  let hook: (op: string, input?: unknown) => Promise<void> = async () => {}, modelHook = async () => {};
  let output: unknown = { schema: 'comms-v1', intent: 'update', claimQuote: 'Done', evidence: ['R1', 'T1'], reply: 'acknowledge' };
  const storage = { agent: async (op: string, input?: unknown) => { await hook(op, input); return db.agent(op, input); }, get: async () => db.get(), workspace: async () => { await hook('workspace'); return db.workspace(); }, taskCommand: vi.fn() };
  const google = { state: vi.fn(async () => ({ configuration: 'missing' as const, activeAccountId: null, connecting: false, accounts: [] })), inbox: vi.fn(), summary: vi.fn(), calendar: vi.fn() };
  const coordinate = vi.fn(async (o: ProcessingOptions, kind: string) => { expect(kind).toBe('comms'); expect(o.model).toBe('deepseek-flash'); expect(o.allowedTools).toEqual([]); await o.checkAuthority(); await o.beforeRound(); await modelHook(); await o.usage('deepseek-v4.1-flash', { input: 80, output: 20 }); return output; });
  const service = new OrchestrationService(storage, { status: async () => model ? 'configured' : 'missing', read: vi.fn(async () => 'SYNTHETIC_NO_NETWORK') }, google, vi.fn(), { decide: vi.fn() }, { process: vi.fn(), coordinate }, () => now, undefined, undefined, undefined, undefined, undefined, true);
  cleanup.push(async () => { await service.close(); db.close(); });
  const binding = { provider: 'synthetic' as const, providerAccount: 'isolated-account', channel: 'sms' as const, receiver: 'synthetic-receiver', sender: 'synthetic-sender', kind: 'message' as const };
  const create = async () => { const id = randomUUID(); await service.relayCommand({ action: 'create', id, taskId, objective: 'Follow up on the handover; prepare acknowledgements only.', binding, disclosure: 'acknowledgement-only', reviewAt: new Date(now + 7 * 86400000).toISOString(), expiresAt: new Date(now + 14 * 86400000).toISOString() }); return id; };
  const event = (patch: Partial<RelayEvent> = {}): RelayEvent => ({ version: 1, eventId: randomUUID(), ...binding, providerTimestamp: at(), providerMessageId: randomUUID(), content: 'Done', authentication: { intakeId: randomUUID(), mode: 'synthetic', verifiedAt: at() }, ...patch });
  const run = (id: string) => db.agent('get', id) as AgentRun;
  const receipt = (id: string) => db.agent('relayGet', id) as RelayReceipt;
  return { db, service, storage, google, coordinate, taskId, binding, create, event, run, receipt, now: () => now, advance: (ms: number) => { now += ms; }, hook: (fn: typeof hook) => { hook = fn; }, modelHook: (fn: typeof modelHook) => { modelHook = fn; }, output: (v: unknown) => { output = v; } };
}
function barrier() { let enter!: () => void, release!: () => void; const entered = new Promise<void>(r => { enter = r; }), wait = new Promise<void>(r => { release = r; }); return { entered, release, pause: async () => { enter(); await wait; } }; }

it('registers a top-level Relay route with an honestly disconnected native snapshot', async () => {
  const f = fixture(); expect(modules.find(m => m.id === 'relay')?.routes).toContain('/relay'); expect(resolveRoute('relay')).toEqual({ page: 'relay' });
  expect(await f.service.relaySnapshot()).toMatchObject({ connection: 'not-configured', provider: 'twilio', lastSync: null, receipts: [], responsibilities: [] });
});
it('continues the same Executive/root once, preserves the original event and attributes Done without changing the task', async () => {
  const f = fixture(), id = await f.create(), original = f.run(id), rootId = original.team!.items[0].id;
  const accepted = await f.service.receiveRelay(f.event()); await f.service.idle(); const run = f.run(id), receipt = f.receipt(accepted.id);
  expect(run.status, run.error ?? '').toBe('review'); expect(run.responsibility?.status).toBe('needs-decision'); expect(run.id).toBe(id); expect(run.event).toEqual(original.event); expect(run.team!.items[0].id).toBe(rootId);
  expect(run.team!.items.some(w => w.role === 'comms' && w.expectedResult === 'comms-v1')).toBe(true); expect(run.team!.items.every(w => !w.permission.externalWrites)).toBe(true);
  expect(run.result,run.error??'missing result').not.toBeNull(); expect(run.result?.text).toContain('Sender reports: “Done”'); expect(run.result?.text).toContain('status remains open'); expect(f.db.workspace().tasks[0].status).toBe('open'); expect(f.storage.taskCommand).not.toHaveBeenCalled(); expect(f.google.calendar).not.toHaveBeenCalled();
  expect(receipt.draft?.body).not.toContain('equipment'); expect(receipt.draft?.body).toContain('confirmation is still pending'); expect(receipt.reason).toBe('prepared'); expect(relayNeedsDecision(receipt)).toBe(true); expect(f.coordinate).toHaveBeenCalledTimes(1);
});
it('deduplicates repeated delivery and reconnect identities and rejects payload collisions', async () => {
  const f = fixture(), id = await f.create(), event = f.event(); const a = await f.service.receiveRelay(event); await f.service.idle();
  const b = await f.service.receiveRelay({ ...event, eventId: randomUUID(), authentication: { ...event.authentication, intakeId: randomUUID() } });
  expect(b.id).toBe(a.id); expect(b.duplicateCount).toBe(1); expect(f.run(id).responsibility?.continuationRevision).toBe(1); expect(f.coordinate).toHaveBeenCalledTimes(1);
  await expect(f.service.receiveRelay({ ...event, content: 'changed payload' })).rejects.toThrow('different content');
});
it.each(['sender', 'receiver', 'providerAccount'] as const)('holds an unbound %s without any specialist work', async field => {
  const f = fixture(); await f.create(); const receipt = await f.service.receiveRelay(f.event({ [field]: 'unknown' })); await f.service.idle(); expect(receipt.reason).toBe('unknown-sender'); expect(receipt.rootRunId).toBeNull(); expect(f.coordinate).not.toHaveBeenCalled();
});
it('rejects unsupported channels, excessive content and injected authority keys', () => {
  const f = fixture(), e = f.event(); expect(relayEventSchema.safeParse({ ...e, channel: 'voice' }).success).toBe(false); expect(relayEventSchema.safeParse({ ...e, content: 'x'.repeat(1601) }).success).toBe(false); expect(relayEventSchema.safeParse({ ...e, authorized: true }).success).toBe(false);
});
it('holds ambiguous bindings and expired or revoked responsibilities', async () => {
  const f = fixture(), a = await f.create(), b = await f.create(); expect((await f.service.receiveRelay(f.event())).reason).toBe('ambiguous');
  await f.service.relayCommand({ action: 'cancel', id: b, expectedRevision: 0 }); await f.service.relayCommand({ action: 'cancel', id: a, expectedRevision: 0 }); expect((await f.service.receiveRelay(f.event())).reason).toBe('revoked-authority');
  await f.create(); f.advance(15 * 86400000); expect((await f.service.receiveRelay(f.event())).reason).toBe('expired-authority'); expect(f.coordinate).not.toHaveBeenCalled();
});
it('holds stale timestamps and unsupported delivery events independently of workflow completion', async () => {
  const f = fixture(); await f.create(); expect((await f.service.receiveRelay(f.event({ providerTimestamp: new Date(f.now() - 2 * 86400000).toISOString() }))).reason).toBe('stale-event');
  expect((await f.service.receiveRelay(f.event({ kind: 'delivery', content: '', delivery: { status: 'delivered', relatedMessageId: 'outbound' } }))).reason).toBe('unsupported-event');
});
it.each(['context', 'stage', 'model', 'commit'] as const)('fences cancellation during %s and rejects late asynchronous work', async phase => {
  const f = fixture(), id = await f.create(), gate = barrier(); let once = false;
  if (phase === 'model') f.modelHook(gate.pause); else f.hook(async op => { if (!once && op === ({ context: 'workspace', stage: 'relayStage', commit: 'relayCommit' }[phase])) { once = true; await gate.pause(); } });
  const receipt = await f.service.receiveRelay(f.event()); await gate.entered;
  await f.service.relayCommand({ action: 'cancel', id, expectedRevision: 1 }); gate.release(); await f.service.idle();
  expect(f.run(id).responsibility?.status).toBe('cancelled'); expect(f.run(id).status).toBe('cancelled'); expect(f.receipt(receipt.id).draft).toBeNull(); expect(f.receipt(receipt.id).disposition).toBe('cancelled');
});
it('fences revocation immediately after native event acceptance and before dispatch', async () => {
  const f = fixture(), id = await f.create(), e = f.event(); const receipt = f.db.agent('relayIntake', { event: e, now: f.now() }) as RelayReceipt;
  await f.service.relayCommand({ action: 'cancel', id, expectedRevision: 1 }); await f.service.receiveRelay(e); await f.service.idle(); expect(f.coordinate).not.toHaveBeenCalled(); expect(f.receipt(receipt.id).disposition).toBe('cancelled');
});
it.each(['policy', 'task', 'expiry'])('holds a continuation if %s changes during model preparation', async field => {
  const f = fixture(), id = await f.create(); f.modelHook(async () => {
    if (field === 'task') { const task = f.db.workspace().tasks[0]; f.db.taskCommand({ action: 'update', id: task.id, expectedRevision: task.revision, draft: { title: 'Changed by owner', due: { kind: 'none' } }, status: 'open' }); }
    if (field === 'policy') { const s = structuredClone(f.db.agent('state')) as ReturnType<typeof initialAgentState>; s.revision++; s.config.shareTasks = false; f.db.agent('saveState', s); }
    if (field === 'expiry') f.advance(8 * 86400000);
  }); const receipt = await f.service.receiveRelay(f.event()); await f.service.idle(); expect(f.receipt(receipt.id).draft).toBeNull(); expect(f.run(id).responsibility?.status).toBe('needs-decision');
});
it('validates the typed Comms result and exact source quote rather than accepting freeform action claims', async () => {
  const f = fixture(); await f.create(); expect(commsResultSchema.safeParse({ schema: 'comms-v1', text: 'Task completed' }).success).toBe(false);
  f.output({ schema: 'comms-v1', intent: 'update', claimQuote: 'Task was independently verified', evidence: ['R1', 'T1'], reply: 'acknowledge' }); const receipt = await f.service.receiveRelay(f.event()); await f.service.idle(); expect(f.receipt(receipt.id).draft).toBeNull();
});
it('uses a labelled local clarification when inference is unavailable, without pretending a model ran', async () => {
  const f = fixture(':memory:', false), id = await f.create(); const receipt = await f.service.receiveRelay(f.event()); await f.service.idle(); expect(f.receipt(receipt.id).draft?.body).toContain('Could you clarify'); expect(f.coordinate).not.toHaveBeenCalled(); expect(f.run(id).calls).toEqual([]); expect(f.run(id).findings[0].code).toBe('LOCAL_CLARIFICATION_ONLY_NO_MODEL');
});
it('binds exact SMS review identity and invalidates nonces on edit, expiry and cancellation', async () => {
  const f = fixture(), id = await f.create(), e = f.event(); const receipt = await f.service.receiveRelay(e); await f.service.idle();
  await f.service.relayCommand({ action: 'reviewDraft', id: receipt.id }); const reviewed = f.receipt(receipt.id), draft = reviewed.draft!, approval = reviewed.approval!;
  expect(() => assertSmsApproval(draft, approval, approval, f.now())).not.toThrow(); const consumed=structuredClone(reviewed);consumeSmsApproval(consumed,approval,f.now());expect(()=>consumeSmsApproval(consumed,approval,f.now())).toThrow();
  for (const patch of [{ to: 'other' }, { from: 'other' }, { body: 'Edited' }, { providerAccount: 'other' }, { authorityRevision: 99 }, { eventId: randomUUID() }, { rootRunId: randomUUID() }]) expect(smsActionHash({ ...draft, ...patch })).not.toBe(draft.hash);
  expect(() => assertSmsApproval(draft, { ...approval, nonce: randomUUID() }, approval, f.now())).toThrow(); expect(() => assertSmsApproval(draft, approval, null, f.now())).toThrow(); expect(() => assertSmsApproval(draft, approval, approval, f.now() + 300001)).toThrow();
  await f.service.relayCommand({ action: 'editDraft', id: receipt.id, expectedRevision: 0, body: 'Owner-edited reply retained locally.' }); expect(f.receipt(receipt.id).approval).toBeNull();
  await f.service.receiveRelay(e); expect(f.receipt(receipt.id).draft?.body).toBe('Owner-edited reply retained locally.');
  await f.service.relayCommand({ action: 'cancel', id, expectedRevision: 1 }); await expect(f.service.relayCommand({ action: 'reviewDraft', id: receipt.id })).rejects.toThrow(); expect(f.receipt(receipt.id).draft?.body).toBe('Owner-edited reply retained locally.');
});
it('resumes waiting on the same identity after explicit review without overwriting old drafts', async () => {
  const f = fixture(), id = await f.create(); const first = await f.service.receiveRelay(f.event()); await f.service.idle();
  await f.service.relayCommand({ action: 'editDraft', id: first.id, expectedRevision: 0, body: 'Preserve this owner edit.' }); await f.service.relayCommand({ action: 'wait', id, expectedRevision: 1 }); f.advance(1000);
  const second = await f.service.receiveRelay(f.event()); await f.service.idle(); expect(f.run(id).responsibility?.continuationRevision).toBe(2); expect(f.receipt(second.id).rootRunId).toBe(id); expect(f.receipt(first.id).draft?.body).toBe('Preserve this owner edit.');
});
it('matches durable roots outside Activity’s latest hundred and retains active roots past generic pruning', async () => {
  const f = fixture(), id = await f.create(), root = f.run(id);
  for (let i = 0; i < 101; i++) { const copy = structuredClone(root); delete copy.responsibility; copy.id = randomUUID(); copy.event.id = copy.id; copy.dedup = hash(copy.id); copy.createdAt = new Date(f.now() + i + 1).toISOString(); f.db.agent('enqueue', copy); }
  expect((f.db.agent('runs') as AgentRun[]).some(r => r.id === id)).toBe(false); const receipt = await f.service.receiveRelay(f.event()); await f.service.idle(); expect(f.receipt(receipt.id).rootRunId).toBe(id);
  f.advance(8 * 86400000); f.db.agent('prune', f.now()); expect(f.run(id).responsibility?.status).toBe('needs-decision');
  const revision = f.run(id).responsibility!.authorityRevision; f.db.agent('relayPrune', f.now()); expect(f.run(id).responsibility!.authorityRevision).toBe(revision);
  f.advance(100 * 86400000); f.db.agent('prune', f.now()); expect(f.db.agent('get', id)).toBeNull(); expect(f.receipt(receipt.id).event).toBeNull(); expect(f.receipt(receipt.id).draft).toBeNull();
});
it('recovers interrupted work without replay and keeps content-free dedup receipts after restart', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'momo-relay-test-')), file = path.join(directory, 'test.sqlite');
  const f = fixture(file), id = await f.create(), e = f.event(); const receipt = f.db.agent('relayIntake', { event: e, now: f.now() }) as RelayReceipt;
  const root = f.run(id); root.status = 'running'; root.responsibility!.status = 'processing'; f.db.agent('update', root);
  await cleanup.pop()!(); const db = new SettingsDatabase(file);
  try { expect((db.agent('get', id) as AgentRun).status).toBe('interrupted'); expect((db.agent('relayGet', receipt.id) as RelayReceipt).reason).toBe('interrupted'); expect((db.agent('relayIntake', { event: e, now: f.now() }) as RelayReceipt).id).toBe(receipt.id); expect(db.agent('next')).toBeNull(); } finally { db.close(); rmSync(directory, { recursive: true }); }
});
