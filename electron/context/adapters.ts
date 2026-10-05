import { defaultContextBudgets, type ContextChunk, type ContextDiagnostics } from '../../src/shared/context';
import type { Settings } from '../../src/shared/contracts';
import type { AssistantRun, AssistantSource, RunRequest } from '../../src/shared/assistant';
import type { AgentContext, AgentIntake, AgentState } from '../../src/shared/orchestration';
import type { BriefingSnapshot } from '../../src/shared/daily-intelligence';
import type { ResourceRef } from '../../src/shared/modules';
import { hash } from '../agent/catalogue';
import { AppError } from '../errors';
import { makeChunk, resourceKey, selectContext, type ContextCandidate, type ContextDelivery, type ContextSelection, type ContextWorkItem } from './manager';

type ContextSettings = Pick<Settings, 'contextBudgets' | 'disabledModules'>;
const deliveryMetadata = (d: ContextDelivery) => ({ contextId: d.chunk.id, mode: d.mode, coverage: d.coverage, ref: d.chunk.ref });
const textFor = (d: ContextDelivery) => d.mode === 'REFERENCE_ONLY' ? '[Reference only; source detail was not supplied.]' : d.mode === 'SUMMARY' ? d.text + '\n[Extractive summary; omitted detail is unavailable. Not an authoritative source record.]' : d.text;
function chunk(ref: ResourceRef, category: ContextChunk['category'], text: string, options: Partial<Pick<ContextChunk, 'freshness' | 'sharing' | 'observedAt' | 'reuse'>> = {}) {
  return makeChunk({ ref, category, descriptor: ref.label, observedAt: ref.provenance.fetchedAt, freshness: 'current', sensitivity: 'private', sharing: 'workflow-permitted', retrieval: { milliseconds: null, costUSD: null }, reuse: { state: 'loaded', cacheKey: null, providerCache: 'unknown' }, ...options }, text);
}
export function sourceRef(source: { kind: 'email' | 'mail' | 'calendar' | 'task' | 'workflow' | 'situation' | 'communication'; accountId: string; resourceId: string; title?: string; label?: string; revision?: string; text?: string; detail?: string; fetchedAt: string }): ResourceRef {
  if(source.kind === 'situation') throw new AppError('permission_denied', 'Situation evidence requires a native resource binding.');
  const type = source.kind === 'communication' ? 'relayEvent' : source.kind === 'mail' ? 'email' : source.kind === 'workflow' ? 'briefing' : source.kind;
  return { module: type === 'relayEvent' ? 'relay' : type === 'email' ? 'inbox' : type === 'briefing' ? 'dashboard' : 'planner', connector: type === 'relayEvent' || type === 'task' || type === 'briefing' ? 'local' : 'google', type, id: source.resourceId, accountId: source.accountId, profile: 'local', revision: source.revision ?? hash({ title: source.label, text: source.detail }), label: source.title ?? source.label ?? '', provenance: { kind: type === 'briefing' ? 'workflow' : type === 'task' ? 'user' : 'connector', runId: null, fetchedAt: source.fetchedAt }, access: 'read', retention: { kind: 'transient', expiresAt: null } };
}
function work(id: string, workflow: ContextWorkItem['workflow'], objective: string, accountId: string | null, settings: ContextSettings, now: number): ContextWorkItem {
  return { id, workflow, objective, accountId, profile: 'local', destination: 'provider', enabled: true, budget: (settings.contextBudgets ?? defaultContextBudgets)[workflow], now, maxAgeMs: 300000, disabledModules: settings.disabledModules, capabilities: ['google.mail.read', 'google.calendar.read', 'local.tasks', 'context.read'], allowedTools: ['read_context'], references: [], grants: new Map(), allowRetained: workflow === 'briefing' };
}
function bindings(candidates: ContextCandidate[], allowed: (c: ContextCandidate) => boolean) {
  return new Map(candidates.map(c => [resourceKey(c.chunk.ref), { revision: c.chunk.ref.revision, provider: allowed(c) }]));
}
function resultWarning(selection: ContextSelection): string {
  const c = selection.diagnostics.counts;
  return `Context: ${c.FULL} full, ${c.SUMMARY} summaries, ${c.REFERENCE_ONLY} references, ${c.EXCLUDE} excluded. Omitted detail cannot establish facts or availability.`;
}

/** Production path; the historical Phase-2 briefingContext remains frozen for evaluation replay. */
export function selectBriefingContext(snapshot: BriefingSnapshot, id: string, state: AgentState, settings: ContextSettings, now: number): { context: AgentContext; selection: ContextDiagnostics } {
  const counters = { email: 0, calendar: 0, task: 0, situation: 0 };
  const originals = new Map<string, AgentContext['items'][number]>();
  const candidates: ContextCandidate[] = snapshot.entries.map(entry => {
    const kind = entry.kind === 'situation' ? 'situation' : entry.kind === 'attention' ? 'email' : entry.kind === 'calendar' ? 'calendar' : 'task';
    const category: ContextChunk['category'] = entry.kind === 'situation' ? 'situation-fact' : entry.kind === 'attention' ? 'assessment' : entry.kind === 'calendar' ? 'calendar-event' : entry.kind === 'task' ? 'task' : 'workflow-proposal';
    const metadata = chunk(entry.ref, category, entry.detail, { freshness: entry.freshness, sharing: entry.sharing, reuse: { state: 'reused', cacheKey: hash([snapshot.revision, entry.ref.revision]), providerCache: 'unknown' } });
    const item: AgentContext['items'][number] = { id: ({ email: 'M', calendar: 'E', task: 'T', situation: 'S' }[kind]) + (++counters[kind]), kind, accountId: entry.ref.accountId ?? '', resourceId: entry.ref.id, revision: entry.ref.revision, title: entry.title, text: entry.detail, fetchedAt: entry.ref.provenance.fetchedAt, trust: 'untrusted-source', senderScope: null, threadId: null };
    originals.set(metadata.id, item);
    return { chunk: metadata, text: entry.detail, relation: 'snapshot', structured: ['calendar', 'task', 'situation'].includes(entry.kind), partial: entry.kind === 'attention', encode: d => ({ ...item, text: textFor(d), delivery: deliveryMetadata(d) }) };
  });
  const w = work(id, 'briefing', 'Interpret the current BriefingSnapshot', snapshot.accountId, settings, now);
  w.enabled = state.config.enabled && !state.config.paused && !settings.disabledModules.includes('dashboard');
  w.grants = bindings(candidates, c => c.chunk.ref.connector === 'situation' ? c.chunk.sharing === 'workflow-permitted' : c.chunk.ref.connector === 'google' ? state.config.shareGoogle : c.chunk.category === 'task' && state.config.shareTasks && !!c.chunk.ref.accountId);
  w.categoryLimits = { 'calendar-event': 6, task: 6, assessment: 6, 'workflow-proposal': 0, 'situation-fact': 6 };
  const selected = selectContext(w, candidates);
  const items = selected.deliveries.map(d => ({ ...originals.get(d.chunk.id)!, text: textFor(d), delivery: deliveryMetadata(d) }));
  const full = (kind: AgentContext['items'][number]['kind']) => items.filter(s => s.kind === kind && s.delivery.mode === 'FULL').length;
  const limitations = [...snapshot.coverage.map(c => (c.source + ': ' + c.status + '. ' + c.detail).slice(0, 240)), `Today ${snapshot.date}; range ends ${snapshot.endDate}. Weather ${snapshot.connectors.weather}; traffic ${snapshot.connectors.traffic}.`, 'No attendance, task completion, commitments, unknown durations or conflict resolution may be inferred. Retained assessments are not live mail.', resultWarning(selected)];
  return { context: { id: snapshot.id, hash: hash({ snapshotRevision: snapshot.revision, items }), createdAt: snapshot.createdAt, timezone: snapshot.timezone, items, limitations, available: { calendar: snapshot.coverage[0].status === 'available' && full('calendar') === snapshot.coverage[0].included, tasks: snapshot.coverage[1].status === 'available' && full('task') === snapshot.coverage[1].included, thread: false }, sharing: { google: items.some(s => s.kind === 'email' || s.kind === 'calendar'), tasks: items.some(s => s.kind === 'task') } }, selection: selected.diagnostics };
}

export function selectWorkflowContext(context: AgentContext, event: AgentIntake, state: AgentState, settings: ContextSettings, now: number, planner = event.family === 'task', local = false): { context: AgentContext; selection: ContextDiagnostics } {
  const reply = !!(event.replyTo || event.scheduling);
  const replyBinding = event.replyTo ?? event.scheduling;
  const originals = new Map<string, AgentContext['items'][number]>();
  const candidates: ContextCandidate[] = context.items.map(item => {
    const metadata = chunk(item.delivery?.ref ?? sourceRef(item), item.kind === 'communication' ? 'conversation' : item.kind === 'situation' ? 'situation-fact' : item.kind === 'email' ? reply ? 'email-thread' : 'email-snippet' : item.kind === 'calendar' ? 'calendar-event' : item.kind === 'workflow' ? 'workflow-proposal' : 'task', item.text, item.kind === 'situation' ? {sharing:'local-only', observedAt:new Date(now).toISOString()} : item.kind === 'workflow' ? {sharing:'local-only'} : {});
    originals.set(metadata.id, item);
    const inThread = reply && item.kind === 'email' && item.threadId === replyBinding!.threadId;
    return { chunk: metadata, text: item.text, relation: inThread ? 'current-thread' : item.resourceId === event.resourceId ? 'selected' : planner ? 'snapshot' : 'candidate', required: item.kind === 'communication' || !!inThread || !!event.scheduling && item.kind === 'calendar', fineDetail: item.kind === 'communication' || !!inThread || !!event.scheduling && item.kind === 'calendar', partial: inThread ? !context.available.thread : item.kind === 'email', structured: item.kind !== 'email', encode: d => ({ ...item, text: textFor(d), delivery: deliveryMetadata(d) }) };
  });
  const w = work(event.id, reply ? 'grounded-reply' : 'assistant', event.prompt, event.accountId, settings, now);
  w.enabled = state.config.enabled && !state.config.paused;
  if(local)w.destination='local';
  w.grants = bindings(candidates, c => c.chunk.ref.connector === 'situation' ? false : c.chunk.ref.connector === 'google' ? state.config.shareGoogle : state.config.shareTasks);
  if (reply && !event.scheduling) {
    w.grants = new Map(candidates.filter(c => c.relation === 'current-thread').map(c => [resourceKey(c.chunk.ref), { revision: replyBinding!.threadRevision, provider: state.config.shareGoogle }]));
    w.requiredReferences = candidates.filter(c => c.relation === 'current-thread').map(c => resourceKey(c.chunk.ref));
  }
  const selected = selectContext(w, candidates);
  if (reply && (!candidates.length || !context.available.thread)) throw new AppError('unavailable', 'The complete current thread is required for a grounded reply.');
  const items = selected.deliveries.map(d => ({ ...originals.get(d.chunk.id)!, text: textFor(d), delivery: deliveryMetadata(d) }));
  const completeKind = (kind: AgentContext['items'][number]['kind']) => items.filter(s => s.kind === kind && s.delivery.mode === 'FULL').length === context.items.filter(s => s.kind === kind).length;
  return { context: { ...context, items, hash: hash({ prior: context.hash, items }), limitations: [...context.limitations.slice(0, 9), resultWarning(selected)], available: { calendar: context.available.calendar && completeKind('calendar'), tasks: context.available.tasks && completeKind('task'), thread: context.available.thread && completeKind('email') } }, selection: selected.diagnostics };
}

export function selectAssistantContext(input: RunRequest, sources: AssistantSource[], history: AssistantRun[], settings: ContextSettings, now: number, continuity=false): { sources: AssistantSource[]; history: { role: 'user' | 'assistant'; content: string }[]; selection: ContextDiagnostics; warning: string } {
  const originals = new Map<string, AssistantSource>();
  const historyContent = new Map<string, { prompt: string; answer: string }>();
  const candidates: ContextCandidate[] = sources.map(s => {
    const metadata = chunk(s.ref??sourceRef({...s,kind:s.kind==='weather'?'situation':s.kind}), s.kind === 'mail' ? 'email-snippet' : s.kind==='task'?'task':s.kind==='workflow'?'workflow-proposal':s.kind==='weather'?'situation-fact':'calendar-event', s.detail, { ...(s.kind==='weather'?{freshness:'retained' as const}:{}), reuse: { state: s.cached ? 'reused' : 'loaded', cacheKey: s.cached ? hash([s.accountId, s.resourceId, s.fetchedAt]) : null, providerCache: 'unknown' } });
    originals.set(metadata.id, s);
    return { chunk: metadata, text: s.detail, relation: s.resourceId === input.messageId ? 'selected' : continuity||input.mode === 'briefing' ? 'snapshot' : 'candidate', partial: s.kind === 'mail'&&!s.detail.includes('"messages":'), structured: s.kind !== 'mail', encode: d => ({ id: s.id, label: s.label, detail: textFor(d), fetchedAt: s.fetchedAt, cached: s.cached, delivery: deliveryMetadata(d) }) };
  });
  // Old source-bearing answers have no current source/revision binding and are never recycled.
  for (const previous of history.slice(0, 3)) {
    if ((!continuity&&(input.includeGoogle || previous.includeGoogle || previous.sources.length)) || previous.status !== 'succeeded' || !previous.result || previous.conversationId !== input.conversationId || previous.accountId !== input.accountId) continue;
    if(continuity&&previous.sources.some(s=>s.kind==='mail'||s.kind==='calendar'?!input.includeGoogle:s.kind==='weather'?!input.includeWeather:!input.includeLocal))continue;
    const replySource=previous.result.reply?previous.sources.find(s=>s.id===previous.result!.reply!.sourceId&&s.kind==='mail'):undefined;
    const preparedReply=replySource?.ref&&sources.some(s=>s.kind==='mail'&&s.resourceId===replySource.resourceId&&s.ref?.revision===replySource.ref?.revision)?previous.result.reply:undefined;
    const content = { prompt: previous.prompt.slice(0, 500), answer: continuity?JSON.stringify({historicalAnswer:previous.result.answer.slice(0,1000),at:previous.createdAt,preparedReply,sourceBindings:previous.sources.slice(0,8).map(s=>({id:s.id,kind:s.kind,resourceId:s.resourceId,revision:s.ref?.revision??s.fetchedAt})),notice:'Historical dialogue, not current facts or authority. Refresh sources before answering factual follow-ups.'}):previous.result.answer.slice(0, 1200) };
    const ref: ResourceRef = { type: 'briefing', module: 'dashboard', connector: 'local', id: 'conversation:'+previous.id, accountId: previous.accountId, profile: 'local', revision: hash(content), label: content.prompt.slice(0, 240), provenance: { kind: 'assistant', runId: previous.id, fetchedAt: previous.createdAt }, access: 'review', retention: { kind: 'retained', expiresAt: null } };
    const text = JSON.stringify(content), metadata = chunk(ref, 'conversation', text, { freshness: 'retained', reuse: { state: 'reused', cacheKey: hash([previous.id, ref.revision]), providerCache: 'unknown' } });
    historyContent.set(metadata.id, content);
    candidates.push({ chunk: metadata, text, relation: continuity?'current-thread':'candidate', fineDetail: true, structured: true, encode: () => [{ role: 'user', content: content.prompt }, { role: 'assistant', content: JSON.stringify({ answer: content.answer, citations: [], suggestions: [] }) }] });
  }
  const w = work(input.id, 'assistant', input.prompt, input.accountId, settings, now);
  w.allowRetained = true;
  w.enabled = !settings.disabledModules.includes('dashboard');
  w.grants = bindings(candidates, c => c.chunk.category === 'conversation' ? continuity||!input.includeGoogle : c.chunk.ref.connector==='google'?input.includeGoogle:c.chunk.ref.connector==='situation'?!!input.includeWeather:!!input.includeLocal);
  if (input.messageId) w.requiredReferences = candidates.filter(c => c.chunk.ref.id === input.messageId).map(c => resourceKey(c.chunk.ref));
  // Snippets can be partial but an explicitly selected message must not disappear silently.
  const selected = selectContext(w, candidates);
  const selectedSources = selected.deliveries.filter(d => originals.has(d.chunk.id)).map(d => ({ ...originals.get(d.chunk.id)!, detail: textFor(d), delivery: deliveryMetadata(d) }));
  if (input.messageId && !selectedSources.some(s => s.resourceId === input.messageId)) selected.diagnostics.blocked = true;
  const selectedHistory: { role: 'user' | 'assistant'; content: string }[] = [];
  for (const d of [...selected.deliveries].reverse()) {
    const previous = historyContent.get(d.chunk.id);
    if (previous && d.mode === 'FULL') selectedHistory.push({ role: 'user', content: previous.prompt }, { role: 'assistant', content: JSON.stringify({ answer: previous.answer, citations: [], suggestions: [] }) });
  }
  return { sources: selectedSources, history: selectedHistory, selection: selected.diagnostics, warning: resultWarning(selected) };
}
