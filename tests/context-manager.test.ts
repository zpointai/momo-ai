// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { contextChunkSchema, defaultContextBudgets } from '../src/shared/context';
import { defaults, settingsUpdateSchema } from '../src/shared/contracts';
import { initialAgentState, type AgentContext, type AgentIntake } from '../src/shared/orchestration';
import { runSchema, type AssistantSource, type RunRequest } from '../src/shared/assistant';
import type { ResourceRef } from '../src/shared/modules';
import { hash } from '../electron/agent/catalogue';
import { buildBriefing } from '../electron/agent/briefing';
import { makeChunk, measure, resourceKey, selectContext, type ContextCandidate, type ContextWorkItem } from '../electron/context/manager';
import { selectAssistantContext, selectBriefingContext, selectWorkflowContext } from '../electron/context/adapters';

const now = Date.parse('2026-09-26T12:00:00Z'), at = new Date(now).toISOString(), accountId = 'accountA';
function candidate(id: string, options: Partial<ContextCandidate> = {}, patch: Partial<ResourceRef> = {}): ContextCandidate {
  const ref: ResourceRef = { id, type: 'email', module: 'inbox', connector: 'google', accountId, profile: 'local', label: 'Project ' + id, revision: hash(id), provenance: { kind: 'connector', runId: null, fetchedAt: at }, access: 'read', retention: { kind: 'transient', expiresAt: null }, ...patch };
  const text = options.text ?? 'The project review is Thursday; the earlier message specifies the blue version.';
  const chunk = makeChunk({ ref, category: ref.type === 'calendar' ? 'calendar-event' : 'email-thread', descriptor: ref.label, observedAt: at, freshness: 'current', sensitivity: 'private', sharing: 'workflow-permitted', retrieval: { costUSD: null, milliseconds: null }, reuse: { state: 'loaded', cacheKey: null, providerCache: 'unknown' } }, text);
  return { chunk, text, relation: 'candidate', encode: d => ({ ref: d.chunk.ref, mode: d.mode, text: d.text, coverage: d.coverage }), ...options };
}
function work(candidates: ContextCandidate[], patch: Partial<ContextWorkItem> = {}): ContextWorkItem {
  return { id: randomUUID(), workflow: 'assistant', objective: 'Review project details', accountId, profile: 'local', destination: 'provider', enabled: true, budget: { ...defaultContextBudgets.assistant }, now, maxAgeMs: 300000, disabledModules: [], capabilities: ['google.mail.read', 'google.calendar.read', 'context.read'], allowedTools: ['read_context'], references: [], grants: new Map(candidates.map(c => [resourceKey(c.chunk.ref), { revision: c.chunk.ref.revision, provider: true }])), allowRetained: false, ...patch };
}
const select = (candidates: ContextCandidate[], patch: Partial<ContextWorkItem> = {}) => selectContext(work(candidates, patch), candidates);

describe('Phase-4 offline validation corpus', () => {
  it('reply requires only the current complete thread, including the prior message', () => {
    const current = candidate('current', { relation: 'current-thread', required: true, fineDetail: true });
    const prior = candidate('prior', { relation: 'current-thread', required: true, fineDetail: true, text: 'Use the blue version discussed earlier.' });
    const result = select([current, prior], { workflow: 'grounded-reply' });
    expect(result.deliveries.map(d => d.mode)).toEqual(['FULL', 'FULL']);
    expect(result.deliveries[1].text).toContain('blue version');
    expect(result.diagnostics.blocked).toBe(false);
  });
  it('excludes unrelated email even when an advisory model recommends it', () => {
    const unrelated = candidate('newsletter', {}, { label: 'Sale coupons' });
    const advisor = { assess: vi.fn(() => [{ id: unrelated.chunk.id, signal: 'relevant' as const }]) };
    const result = selectContext(work([unrelated]), [unrelated], advisor);
    expect(result.deliveries).toEqual([]);
    expect(result.diagnostics.candidates[0]).toMatchObject({ reason: 'UNRELATED_SOURCE', advisory: 'relevant' });
  });
  it('includes an explicitly selected calendar event and excludes unrelated events', () => {
    const chosen = candidate('event1', {}, { type: 'calendar', module: 'planner', label: 'Dentist appointment' });
    const other = candidate('event2', {}, { type: 'calendar', module: 'planner', label: 'Train booking' });
    const result = select([other, chosen], { references: [resourceKey(chosen.chunk.ref)] });
    expect(result.deliveries.map(d => d.chunk.ref.id)).toEqual(['event1']);
    expect(result.diagnostics.candidates[0].reason).toBe('EXPLICIT_REFERENCE');
  });
  it('rejects stale and revision-mismatched references before advice', () => {
    const stale = candidate('stale'), changed = candidate('changed');
    stale.chunk.observedAt = '2026-09-25T12:00:00Z';
    const w = work([stale, changed]);
    w.grants = new Map([...w.grants, [resourceKey(changed.chunk.ref), { revision: hash('new'), provider: true }]]);
    const advisor = { assess: vi.fn(() => []) };
    const r = selectContext(w, [stale, changed], advisor);
    expect(advisor.assess.mock.calls[0][1]).toEqual([]);
    expect(r.diagnostics.candidates.map(c => c.reason)).toEqual(['SOURCE_STALE', 'REVISION_MISMATCH']);
  });
  it('rejects cross-account and inaccessible context even for explicit references', () => {
    const foreign = candidate('foreign', {}, { accountId: 'accountB' }), missing = candidate('missing');
    const r = select([foreign, missing], { grants: new Map(), references: [resourceKey(foreign.chunk.ref), resourceKey(missing.chunk.ref)] });
    expect(r.deliveries).toEqual([]);
    expect(r.diagnostics.candidates.map(c => c.reason)).toEqual(['ACCOUNT_MISMATCH', 'INACCESSIBLE_SOURCE']);
  });
  it('never shares local-only or restricted sources, including reference labels', () => {
    const local = candidate('local', { preferredMode: 'REFERENCE_ONLY' }), restricted = candidate('restricted');
    local.chunk.sharing = 'local-only'; restricted.chunk.sensitivity = 'restricted';
    const advisor = { assess: vi.fn(() => [{ id: local.chunk.id, signal: 'relevant' as const }]) };
    const r = selectContext(work([local, restricted]), [local, restricted], advisor);
    expect(r.deliveries).toEqual([]); expect(advisor.assess.mock.calls[0][1]).toEqual([]);
    expect(r.diagnostics.candidates.every(c => c.reason === 'DISCLOSURE_DENIED')).toBe(true);
    expect(select([local], { destination: 'local' }).deliveries[0].mode).toBe('REFERENCE_ONLY');
  });
  it('selects BriefingSnapshot entries while keeping local approvals out of provider input', () => {
    const state = initialAgentState(); state.config = { ...state.config, enabled: true, shareTasks: true };
    const snapshot = buildBriefing({ accountId, now, timezone: 'Europe/Amsterdam', trigger: 'manual', authorityRevision: hash('authority'), state, plannerEnabled: true, inboxEnabled: true, runs: [], tasks: [{ id: randomUUID(), accountId, title: 'Review project', due: { kind: 'none' }, status: 'open', revision: 0, createdAt: at, remindedAt: null }], actions: [{ id: 'approval', accountId, kind: 'mail.send', title: 'PRIVATE APPROVAL CANARY', status: 'pending', revision: hash('approval'), createdAt: at, expiresAt: '2026-09-26T12:05:00Z' }] });
    const { context, selection } = selectBriefingContext(snapshot, randomUUID(), state, defaults, now);
    expect(context.items.map(s => s.title)).toEqual(['Review project']);
    expect(context.items[0].delivery?.ref).toEqual(snapshot.entries[0].ref);
    expect(JSON.stringify({ context, selection })).not.toContain('PRIVATE APPROVAL CANARY');
    expect(selection.counts).toMatchObject({ FULL: 1, EXCLUDE: 0 }); expect(selection.reused).toBe(1);
    expect(snapshot.entries.some(e => e.title === 'PRIVATE APPROVAL CANARY')).toBe(false);
  });
  it('labels partial sources and rejects unavailable or incomplete required thread text', () => {
    const partial = candidate('partial', { partial: true }), unavailable = candidate('unavailable');
    unavailable.chunk.freshness = 'unavailable';
    const r = select([partial, unavailable]);
    expect(r.deliveries[0].coverage).toMatchObject({ status: 'partial', sourcePartial: true });
    expect(r.diagnostics.candidates[1].reason).toBe('SOURCE_UNAVAILABLE');
    expect(select([{ ...partial, required: true, fineDetail: true }]).diagnostics.blocked).toBe(true);
  });
  it('uses FULL below budget and SUMMARY only when needed, with provenance and omissions', () => {
    const c = candidate('long', { text: 'Retained exact source words. '.repeat(90) });
    expect(select([c]).deliveries[0].mode).toBe('FULL');
    const budget = { ...defaultContextBudgets.assistant, maxBytes: 1400, maxEstimatedTokens: 350, summaryCharacters: 150 };
    const d = select([c], { budget }).deliveries[0];
    expect(d.mode).toBe('SUMMARY'); expect(c.text.startsWith(d.text)).toBe(true);
    expect(d.coverage.omittedCharacters).toBe(c.text.length - d.text.length);
    expect(d.chunk.ref).toEqual(c.chunk.ref); expect(d.coverage.method).toBe('extractive');
    expect(c.text.length).toBeGreaterThan(2000);
  });
  it('explicit user reference wins over semantic ranking and advisory disagreement', () => {
    const explicit = candidate('selected', {}, { label: 'Unusual item' }), semantic = candidate('semantic', {}, { label: 'Project details review' });
    const w = work([semantic, explicit], { references: [resourceKey(explicit.chunk.ref)], budget: { ...defaultContextBudgets.assistant, maxChunks: 1 } });
    const r = selectContext(w, [semantic, explicit], { assess: () => [{ id: explicit.chunk.id, signal: 'irrelevant' }, { id: semantic.chunk.id, signal: 'relevant' }] });
    expect(r.deliveries[0].chunk.id).toBe(explicit.chunk.id);
    expect(r.diagnostics.candidates[0]).toMatchObject({ reason: 'EXPLICIT_REFERENCE', advisory: 'irrelevant' });
  });
  it('deduplicates identical references and rejects conflicting duplicate revisions', () => {
    const c = candidate('duplicate');
    expect(select([c, c]).diagnostics.counts).toMatchObject({ FULL: 1, EXCLUDE: 1 });
    const representation = { ...c, chunk: { ...c.chunk, id: hash('another-representation'), category: 'email-snippet' as const } };
    expect(select([c, representation]).deliveries).toHaveLength(1);
    const other = { ...c, chunk: { ...c.chunk, ref: { ...c.chunk.ref, revision: hash('new') } } };
    const r = select([c, other]); expect(r.deliveries).toEqual([]);
    expect(r.diagnostics.candidates.every(d => d.reason === 'CONFLICTING_DUPLICATE')).toBe(true);
  });
  it('handles no-source requests honestly and holds missing required references', () => {
    const r = select([]); expect(r.deliveries).toEqual([]); expect(r.diagnostics.selectedSize.bytes).toBe(0); expect(r.diagnostics.blocked).toBe(false);
    expect(select([], { requiredReferences: [hash('missing')] }).diagnostics.blocked).toBe(true);
  });
  it('holds budget-exhausted required context instead of substituting a summary', () => {
    const c = candidate('required', { text: 'x'.repeat(9000), relation: 'current-thread', required: true, fineDetail: true });
    const r = select([c], { budget: { ...defaultContextBudgets.assistant, maxBytes: 1200 } });
    expect(r.diagnostics.blocked).toBe(true); expect(r.deliveries).toEqual([]);
    expect(r.diagnostics.candidates[0]).toMatchObject({ mode: 'EXCLUDE', reason: 'BUDGET_EXHAUSTED' });
  });
});

it('enforces workflow, module, capability and tool policy before advisory selection', () => {
  const c = candidate('policy', { requiredCapabilities: ['google.mail.read'], requiredTools: ['read_context'] });
  for (const patch of [{ enabled: false }, { disabledModules: ['inbox'] }, { capabilities: [] }, { allowedTools: [] }] as Partial<ContextWorkItem>[]) {
    const advisor = { assess: vi.fn(() => []) };
    expect(selectContext(work([c], patch), [c], advisor).deliveries).toEqual([]);
    expect(advisor.assess.mock.calls[0][1]).toEqual([]);
  }
});
it('prepares lightweight permitted tool descriptors without loading schemas or adding grants', () => {
  const descriptors = [{ id: 'read_context', description: 'Read permitted context', capability: 'context.read', schemaKey: 'read_context.v1' }, { id: 'send_mail', description: 'Send mail', capability: 'google.mail.send', schemaKey: 'send.v1' }];
  expect(selectContext(work([]), [], undefined, descriptors).tools).toEqual([descriptors[0]]);
  expect(selectContext(work([], { allowedTools: [] }), [], undefined, descriptors).tools).toEqual([]);
});
it('uses reference-only without source detail and honors explicitly requested summaries', () => {
  const c = candidate('ref', { preferredMode: 'REFERENCE_ONLY' });
  const r = select([c]); expect(r.deliveries[0].text).toBe(''); expect(r.deliveries[0].coverage.omittedCharacters).toBe(c.text.length);
  expect(select([{ ...c, preferredMode: 'SUMMARY' }]).deliveries[0].mode).toBe('SUMMARY');
});
it('measures UTF-8 and encoded delivery overhead within both budgets and redacts diagnostics', () => {
  const c = candidate('utf8', { text: '秘密🙂'.repeat(1000) }, { label: 'PRIVATE SUBJECT CANARY', id: 'PRIVATE_SOURCE_ID' });
  const r = select([c], { references: [resourceKey(c.chunk.ref)], budget: { ...defaultContextBudgets.assistant, maxBytes: 1500, maxEstimatedTokens: 600 } });
  const expected = r.deliveries.reduce((n, d) => n + measure(JSON.stringify(c.encode(d))).bytes, 0);
  expect(r.diagnostics.selectedSize.bytes).toBe(expected); expect(expected).toBeLessThanOrEqual(1500);
  expect(JSON.stringify(r.diagnostics)).not.toMatch(/秘密|PRIVATE SUBJECT CANARY|PRIVATE_SOURCE_ID|accountA/);
  expect(contextChunkSchema.parse(c.chunk).ref.provenance).toEqual(c.chunk.ref.provenance);
});
it('supports configured per-workflow budgets without changing monetary or request controls', () => {
  const budgets = structuredClone(defaultContextBudgets); budgets.briefing.maxBytes = 3000;
  expect(settingsUpdateSchema.parse({ expectedRevision: 0, patch: { contextBudgets: budgets } }).patch.contextBudgets).toEqual(budgets);
  expect(settingsUpdateSchema.safeParse({ expectedRevision: 0, patch: { contextBudgets: { ...budgets, assistant: { ...budgets.assistant, maxBytes: 100000 } } } }).success).toBe(false);
  expect(defaults.spending.mode).toBe('monitor'); expect(defaults.contextBudgets).toBeUndefined();
});
it('includes only the grounded thread and retains source revision fences at the production adapter', () => {
  const state = initialAgentState(); state.config = { ...state.config, enabled: true, shareGoogle: true, shareTasks: true };
  const revision = hash('thread'), event: AgentIntake = { id: randomUUID(), family: 'email', accountId, resourceId: 'm1', prompt: 'Draft reply', replyTo: { runId: randomUUID(), sourceRevision: hash('source'), threadId: 'thread', threadRevision: revision }, depth: 0, causationId: null, origin: 'user', trigger: 'manual' };
  const item = (id: string, threadId: string): AgentContext['items'][number] => ({ id, resourceId: id.toLowerCase(), kind: 'email', accountId, revision, title: 'Project', text: 'Complete thread text', fetchedAt: at, trust: 'untrusted-source', senderScope: null, threadId });
  const context: AgentContext = { id: randomUUID(), hash: hash('context'), createdAt: at, timezone: 'Europe/Amsterdam', items: [item('M1', 'thread'), item('M2', 'thread'), item('M3', 'unrelated')], limitations: [], available: { thread: true, tasks: false, calendar: false }, sharing: { google: true, tasks: false } };
  const result = selectWorkflowContext(context, event, state, defaults, now);
  expect(result.context.items.map(s => s.id)).toEqual(['M1', 'M2']); expect(result.context.items.every(s => s.revision === revision)).toBe(true);
  const stale = selectWorkflowContext(context, { ...event, replyTo: { ...event.replyTo!, threadRevision: hash('changed') } }, state, defaults, now);
  expect(stale.selection.blocked).toBe(true); expect(stale.context.items).toEqual([]);
});
it('Assistant selects relevant bounded sources, never reuses old source-bearing history, and supports no-source chat', () => {
  const input: RunRequest = { id: randomUUID(), conversationId: randomUUID(), mode: 'chat', prompt: 'Review Project Apollo', accountId, includeGoogle: true };
  const sources: AssistantSource[] = ['Project Apollo', 'Train bookings'].map((label, i) => ({ id: 'M' + (i + 1), kind: 'mail', accountId, resourceId: 'mail' + i, label, detail: 'Snippet only', fetchedAt: at, cached: i === 0 }));
  const previous = runSchema.parse({ id: randomUUID(), conversationId: input.conversationId, fingerprint: '', mode: 'chat', provider: 'deepseek', requestedModel: 'deepseek-flash', reportedModel: null, prompt: 'Review Project Apollo', accountId, includeGoogle: true, createdAt: at, finishedAt: at, status: 'succeeded', stage: 'Complete', error: null, result: { answer: 'OLD_PRIVATE_CONTENT', citations: ['M1'], suggestions: [] }, sources: [sources[0]], warnings: [], usage: null, inputBytes: 0, maxOutputTokens: 100, classification: null });
  const result = selectAssistantContext(input, sources, [previous], defaults, now);
  expect(result.sources.map(s => s.id)).toEqual(['M1']); expect(result.history).toEqual([]); expect(result.selection.reused).toBe(1);
  const empty = selectAssistantContext({ ...input, includeGoogle: false, accountId: null }, [], [previous], defaults, now);
  expect(empty.sources).toEqual([]); expect(empty.history).toEqual([]);
});
it('an unavailable relevance advisor does not override explicit native context selection', () => {
  const c = candidate('chosen', { relation: 'selected' });
  expect(selectContext(work([c]), [c], { assess: () => { throw Error('Unavailable'); } }).deliveries[0].mode).toBe('FULL');
});
