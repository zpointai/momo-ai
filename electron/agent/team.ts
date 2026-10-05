import { randomUUID } from 'node:crypto';
import { agentWorkItemSchema, contextAgentResultSchema, type AgentCapability, type AgentRole, type AgentTeam, type AgentWorkItem } from '../../src/shared/agent-team';
import { defaultContextBudgets, type ContextBudget } from '../../src/shared/context';
import type { AgentRun, Route } from '../../src/shared/orchestration';
import { workflowModule } from '../../src/shared/modules';
import { sourceRef } from '../context/adapters';
import { makeChunk, resourceKey, selectContext, type ContextRelevanceAdvisor } from '../context/manager';
import { hash, profiles } from './catalogue';
import { AppError } from '../errors';

const schedulingCapabilities: AgentCapability[] = ['context.read', 'inbox.assess', 'reply.prepare', 'planner.analyze', 'response.generate', 'evidence.review'];
export const roleCapabilities: Record<AgentRole, readonly AgentCapability[]> = {
  comms: ['context.read', 'reply.prepare', 'response.generate', 'evidence.review'],
  executive: ['context.read', 'inbox.assess', 'reply.prepare', 'planner.analyze', 'briefing.synthesize', 'response.generate', 'task.propose', 'calendar.propose', 'evidence.review'],
  inbox: ['context.read', 'inbox.assess', 'reply.prepare', 'response.generate', 'task.propose', 'evidence.review'],
  planner: ['context.read', 'planner.analyze', 'response.generate', 'task.propose', 'calendar.propose', 'evidence.review'],
  briefing: ['context.read', 'briefing.synthesize', 'response.generate', 'evidence.review'],
  context: ['context.read'], review: ['context.read', 'evidence.review'],
};
export function specialistRole(run: Pick<AgentRun, 'event' | 'responsibility'>): AgentRole {
  if ('executive' in run && run.executive) return 'executive';
  if (run.responsibility) return 'comms';
  if (run.event.family === 'chat' && /^(list my tasks|check conflicts)$|\b(calendar|scheduling|availability)\b/i.test(run.event.prompt.trim())) return 'planner';
  return run.event.family === 'email' ? 'inbox' : run.event.family === 'task' ? 'planner' : run.event.family === 'briefing' ? 'briefing' : 'executive';
}
export function nativeRoute(run: AgentRun): Route {
  if (run.event.scheduling || run.background || run.policy.level === 'L0' || specialistRole(run) === 'planner' && /^(list my tasks|check conflicts)$/i.test(run.event.prompt.trim())) return 'NO_LLM';
  if (run.event.replyTo) return 'DRAFT_REPLY';
  if (run.event.family === 'email') return 'EXTRACT_ACTIONS';
  if (run.event.family === 'briefing') return 'EXTRACT_ACTIONS';
  if (specialistRole(run) === 'planner') return 'CALENDAR_REASONING';
  return 'USER_DIALOGUE';
}
const subset = <T>(next: readonly T[], prior: readonly T[]) => next.every(v => prior.includes(v));
const modeOrder = { REFERENCE_ONLY: 0, SUMMARY: 1, FULL: 2 };
function deny(message: string): never { throw new AppError('permission_denied', message); }

export function assertWorkItem(item: AgentWorkItem, run: AgentRun, now: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (Date.parse(item.deadline) <= now) throw new AppError('unavailable', 'Agent work timed out. Start a new request.');
  if (item.rootRunId !== run.id || item.accountId !== run.event.accountId || item.profile !== 'local') deny('Work item account or run scope changed.');
  if (item.workflow !== run.event.family || item.module !== (run.responsibility ? 'relay' : workflowModule(run.event.family)) || item.provenance.contextHash !== run.context.hash) deny('Work item native context binding changed.');
  const nativeCapabilities = (run.executive ? roleCapabilities.executive : run.executive ? roleCapabilities.executive : run.event.scheduling ? schedulingCapabilities : run.background ? roleCapabilities.executive.filter(c=>['context.read','inbox.assess','planner.analyze','briefing.synthesize','evidence.review'].includes(c)) : roleCapabilities[specialistRole(run)]).filter(c => c !== 'reply.prepare' || !!(run.event.replyTo || run.event.scheduling || run.responsibility));
  if (!subset(item.allowedCapabilities, nativeCapabilities)) deny('Work item capabilities exceed the native workflow.');
  if (item.permission.policyId !== run.policy.id || item.permission.policyVersion !== run.policy.version || item.permission.profileRevision !== run.profileRevision) deny('Work item policy revision changed.');
  if (!subset(item.allowedCapabilities, roleCapabilities[item.role]) || !subset(item.allowedTools, ['read_context'])) deny('The specialist cannot use that capability or tool.');
  if (item.permission.shareGoogle && !run.config.shareGoogle || item.permission.shareTasks && !run.config.shareTasks) deny('Work item sharing exceeds native policy.');
  if (run.background && item.permission.actions.length) deny('Background work cannot authorize or prepare executable actions.');
  if (item.permission.externalWrites || !item.permission.ownerApprovalRequired) deny('Models cannot authorize actions.');
  if (item.permission.actions.includes('local-reply') && !(run.event.replyTo || run.event.scheduling || run.responsibility) || item.permission.actions.includes('calendar-proposal') && specialistRole(run) !== 'planner') deny('This workflow cannot prepare that action.');
  if (!subset(item.permission.actions, run.policy.level === 'L0' ? [] : ['local-reply', 'task-proposal', 'calendar-proposal'])) deny('Work item action scope exceeds native policy.');
  const bindings = new Map(item.revisionBindings.map(b => [b.key, b.revision]));
  for (const ref of item.sources) {
    const source = run.context.items.find(s => resourceKey(s.delivery?.ref ?? sourceRef(s)) === resourceKey(ref));
    if (!source || ref.accountId !== item.accountId || bindings.get(resourceKey(ref)) !== ref.revision || source.revision !== ref.revision) deny('Work item source revision or account changed.');
    if (Math.abs(now - Date.parse(source.fetchedAt)) > item.maxSourceAgeMs && source.delivery?.ref.provenance.kind !== 'workflow') deny('Work item source is stale.');
    if (ref.retention.expiresAt && Date.parse(ref.retention.expiresAt) <= now) deny('Work item source expired.');
  }
  for (const b of item.context.bindings) {
    const source = run.context.items.find(s => s.id === b.evidenceId);
    if (!source || !item.sources.some(r => resourceKey(r) === resourceKey(b.delivery.ref)) || source.revision !== b.delivery.ref.revision || b.delivery.contextId !== source.delivery?.contextId || modeOrder[b.delivery.mode] > modeOrder[source.delivery?.mode ?? 'FULL'] || source.delivery?.coverage.sourcePartial && !b.delivery.coverage.sourcePartial) deny('Work item cannot expand source delivery.');
  }
  if (item.requiredTools.some(t => !item.allowedTools.includes(t))) deny('Required tool is not permitted.');
  if (item.requiredEvidenceIds.some(id => !item.context.bindings.some(b => b.evidenceId === id && b.delivery.mode === 'FULL' && !b.delivery.coverage.sourcePartial))) deny('Required evidence must remain complete and FULL.');
  if (item.parentWorkItemId) {
    const parent = run.team?.items.find(w => w.id === item.parentWorkItemId);
    if (!parent || !run.team) deny('Missing native parent work item.');
    assertHandoff(parent, item, run.team);
  }
}

export function assertHandoff(parent: AgentWorkItem, child: AgentWorkItem, team: AgentTeam) {
  if (child.rootRunId !== parent.rootRunId || child.parentWorkItemId !== parent.id || child.accountId !== parent.accountId || child.profile !== parent.profile || child.workflow !== parent.workflow || child.module !== parent.module) deny('Handoff cannot change account, workflow or root scope.');
  if (child.depth !== parent.depth + 1 || child.depth > team.limits.maxDepth) deny('Maximum handoff depth reached.');
  if (Date.parse(child.deadline) > Date.parse(parent.deadline) || child.maxSourceAgeMs > parent.maxSourceAgeMs) deny('Handoff cannot extend freshness or timeout.');
  if (!subset(child.allowedCapabilities, parent.allowedCapabilities) || !subset(child.allowedCapabilities, roleCapabilities[child.role]) || !subset(child.allowedTools, parent.allowedTools)) deny('Handoff cannot expand capabilities or tools.');
  const a = child.permission, b = parent.permission;
  if (a.policyId !== b.policyId || a.policyVersion !== b.policyVersion || a.profileRevision !== b.profileRevision || a.externalWrites || !a.ownerApprovalRequired || a.shareGoogle && !b.shareGoogle || a.shareTasks && !b.shareTasks || !subset(a.actions, b.actions)) deny('Handoff cannot expand permissions.');
  if (Object.keys(child.contextBudget).some(k => child.contextBudget[k as keyof ContextBudget] > parent.contextBudget[k as keyof ContextBudget])) deny('Handoff cannot expand the context budget.');
  if (child.sources.some(r => !parent.sources.some(p => resourceKey(r) === resourceKey(p) && r.revision === p.revision))) deny('Handoff cannot expand sources or revisions.');
  for (const c of child.context.bindings) {
    const p = parent.context.bindings.find(v => v.evidenceId === c.evidenceId && v.delivery.contextId === c.delivery.contextId);
    if (!p || c.delivery.ref.revision !== p.delivery.ref.revision || modeOrder[c.delivery.mode] > modeOrder[p.delivery.mode]) deny('Handoff cannot upgrade selected context.');
  }
}

export function handoff(team: AgentTeam, parent: AgentWorkItem, role: AgentRole, objective: string, now: number, patch: Partial<AgentWorkItem> = {}): AgentWorkItem {
  const child = agentWorkItemSchema.parse({ ...structuredClone(parent), id: randomUUID(), parentWorkItemId: parent.id, role, objective, depth: parent.depth + 1,
    allowedCapabilities: parent.allowedCapabilities.filter(c => roleCapabilities[role].includes(c)),
    permission: { ...parent.permission, actions: role === 'context' || role === 'review' ? [] : parent.permission.actions },
    expectedResult: role === 'comms' ? 'comms-v1' : role === 'context' ? 'context-v1' : role === 'review' ? 'review-v1' : 'processing-v1',
    deliverables: role === 'context' ? ['references'] : role === 'review' ? ['ledger'] : parent.deliverables,
    status: 'queued', resultSummary: null, reason: null, handoffHistory: [], ...patch });
  assertHandoff(parent, child, team);
  const fingerprint = (w: AgentWorkItem) => hash({ parent: w.parentWorkItemId, role: w.role, objective: w.objective, sources: w.sources, context: w.context, permission: w.permission, capabilities: w.allowedCapabilities, tools: w.allowedTools, budget: w.contextBudget, expected: w.expectedResult, deliverables: w.deliverables, unresolved: w.unresolvedQuestions });
  const duplicate = team.items.find(w => fingerprint(w) === fingerprint(child));
  if (duplicate) return duplicate;
  if (team.items.length >= team.limits.maxSteps) deny('Maximum agent steps reached.');
  parent.handoffHistory.push({ from: parent.id, to: child.id, role, at: new Date(now).toISOString(), objective });
  team.items.push(child); return child;
}

export function createTeam(run: AgentRun, budget: ContextBudget = defaultContextBudgets[(run.event.replyTo || run.event.scheduling || run.responsibility) ? 'grounded-reply' : run.event.family === 'briefing' ? 'briefing' : 'assistant']): AgentTeam {
  const route = nativeRoute(run), role = specialistRole(run), now = Date.parse(run.createdAt);
  const bindings = run.context.items.map(s => ({ evidenceId: s.id, delivery: s.delivery! }));
  if (bindings.some(b => !b.delivery)) deny('Agent context must pass through Context Manager.');
  const capabilities = [...(run.event.scheduling ? schedulingCapabilities : run.background ? roleCapabilities.executive.filter(c=>['context.read','inbox.assess','planner.analyze','briefing.synthesize','evidence.review'].includes(c)) : roleCapabilities[role])].filter(c => c !== 'reply.prepare' || !!(run.event.replyTo || run.event.scheduling || run.responsibility));
  const root = agentWorkItemSchema.parse({ version: 1, id: randomUUID(), rootRunId: run.id, parentWorkItemId: null, role: 'executive', objective: run.event.prompt || 'Assess the selected source', workflow: run.event.family, module: run.responsibility ? 'relay' : workflowModule(run.event.family), accountId: run.event.accountId, profile: 'local', sources: bindings.map(b => b.delivery.ref), context: { selectionId: run.contextSelection!.workItemId, bindings }, allowedCapabilities: capabilities, allowedTools: ['read_context'], permission: { policyId: run.policy.id, policyVersion: run.policy.version, profileRevision: run.profileRevision, shareGoogle: run.config.shareGoogle, shareTasks: run.config.shareTasks, actions: run.background || run.policy.level === 'L0' ? [] : run.event.scheduling || run.responsibility ? ['local-reply'] : [...(run.event.replyTo ? ['local-reply'] : []), ...(['inbox', 'planner', 'executive'].includes(role) ? ['task-proposal'] : []), ...(role === 'planner' ? ['calendar-proposal'] : [])], externalWrites: false, ownerApprovalRequired: true }, contextBudget: budget, expectedResult: 'processing-v1', requiredEvidenceIds: run.event.scheduling ? run.context.items.filter(s => s.kind === 'email').map(s => s.id) : run.event.replyTo ? run.context.items.map(s => s.id) : [], requiredTools: [], deliverables: run.event.replyTo ? ['reply-or-clarification'] : ['answer'], priority: 'unknown', deadline: new Date(now + 300000).toISOString(), maxSourceAgeMs: 300000, provenance: { origin: run.event.origin, createdAt: run.createdAt, contextHash: run.context.hash }, revisionBindings: bindings.map(b => ({ key: resourceKey(b.delivery.ref), revision: b.delivery.ref.revision })), depth: 0, status: 'queued', unresolvedQuestions: [], handoffHistory: [], resultSummary: null, reason: null });
  const team: AgentTeam = { version: 1, specialistId: root.id, items: [root], limits: { maxDepth: 3, maxSteps: 12 }, toolCompletions: [], ledger: null };
  if (run.executive) { root.permission.actions=[]; return team; }
  const selectedBindings = run.event.scheduling ? bindings.filter(b => b.delivery.ref.module === 'inbox') : bindings;
  const specialist = handoff(team, root, role, root.objective, now, run.event.scheduling ? { expectedResult: 'inbox-scheduling-v1', sources: selectedBindings.map(b => b.delivery.ref), context: {...root.context, bindings: selectedBindings}, revisionBindings: root.revisionBindings.filter(b => selectedBindings.some(s => resourceKey(s.delivery.ref) === b.key)) } : {});
  team.specialistId = specialist.id;
  if (profiles[route].tools.some(t => !specialist.allowedTools.includes(t as 'read_context'))) deny('No eligible specialist for the required tools.');
  return team;
}
export const specialist = (run: AgentRun) => run.team!.items.find(w => w.id === run.team!.specialistId)!;

/** Re-selection uses only native supplied candidates; read_context cannot fetch new accounts or bodies. */
export function contextRequest(run: AgentRun, parent: AgentWorkItem, ids: string[], now: number, signal?: AbortSignal, advisor?: ContextRelevanceAdvisor) {
  assertWorkItem(parent, run, now, signal);
  if (!parent.allowedTools.includes('read_context') || !parent.allowedCapabilities.includes('context.read')) deny('Context tool is not permitted.');
  if (ids.some(id => !parent.context.bindings.some(b => b.evidenceId === id))) deny('Context request contains an unauthorized source.');
  const bindings = parent.context.bindings.filter(b => ids.includes(b.evidenceId));
  const child = handoff(run.team!, parent, 'context', 'Select permitted evidence for: ' + parent.objective.slice(0, 1800), now, { sources: bindings.map(b => b.delivery.ref), context: { ...parent.context, bindings }, revisionBindings: parent.revisionBindings.filter(b => bindings.some(v => resourceKey(v.delivery.ref) === b.key)), requiredEvidenceIds: parent.requiredEvidenceIds.filter(id => ids.includes(id)) });
  assertWorkItem(child, run, now, signal); child.status = 'running';
  const originals = run.context.items.filter(s => ids.includes(s.id));
  const selection = selectContext({ id: child.id, workflow: run.event.replyTo ? 'grounded-reply' : run.event.family === 'briefing' ? 'briefing' : 'assistant', objective: parent.objective, accountId: child.accountId, profile: child.profile, destination: run.background ? 'local' : 'provider', enabled: true, budget: child.contextBudget, now, maxAgeMs: child.maxSourceAgeMs, disabledModules: [], capabilities: child.allowedCapabilities, allowedTools: child.allowedTools, references: bindings.map(b => resourceKey(b.delivery.ref)), grants: new Map(child.sources.map(r => [resourceKey(r), { revision: r.revision, provider: r.connector === 'google' ? child.permission.shareGoogle : child.permission.shareTasks }])), allowRetained: run.event.family === 'briefing' }, originals.map(s => {
    const d = bindings.find(b => b.evidenceId === s.id)!.delivery;
    return { chunk: makeChunk({ ref: d.ref, category: s.kind === 'email' ? run.event.replyTo ? 'email-thread' : 'email-snippet' : s.kind === 'calendar' ? 'calendar-event' : s.kind === 'workflow' ? 'workflow-proposal' : 'task', observedAt: s.fetchedAt, freshness: d.ref.provenance.kind === 'workflow' ? 'retained' : 'current', sensitivity: 'private', sharing: s.kind === 'workflow' ? 'local-only' : 'workflow-permitted', descriptor: s.title, retrieval: { costUSD: null, milliseconds: null }, reuse: { state: 'reused', cacheKey: null, providerCache: 'unknown' } }, s.text), text: s.text, relation: 'selected' as const, preferredMode: d.mode, fineDetail: child.requiredEvidenceIds.includes(s.id), partial: d.coverage.sourcePartial, structured: s.kind !== 'email', encode: () => s };
  }), advisor);
  if (selection.diagnostics.blocked) deny('Required context cannot be delivered to this specialist.');
  const selected = selection.deliveries.map(d => {
    const s = originals.find(s => resourceKey(d.chunk.ref) === resourceKey(s.delivery!.ref))!;
    if (modeOrder[d.mode] > modeOrder[s.delivery!.mode]) deny('Context selection cannot upgrade a delivery mode.');
    return d.mode === s.delivery!.mode ? s : { ...s, text: d.mode === 'REFERENCE_ONLY' ? '[Reference only; source detail was not supplied.]' : d.text + '\n[Extractive summary; omitted detail is unavailable.]', delivery: { contextId: d.chunk.id, ref: d.chunk.ref, mode: d.mode, coverage: d.coverage } };
  });
  child.status = 'complete'; child.resultSummary = `${selected.length} permitted sources selected.`;
  const result = contextAgentResultSchema.parse({ schema: 'context-v1', workItemId: child.id, refs: selected.map(s => s.delivery!.ref), findings: selected.map(s => ({ evidenceId: s.id, descriptor: s.title, delivery: s.delivery })), unresolvedQuestions: child.unresolvedQuestions });
  return { workItem: child, sources: selected, refs: result.refs, result, selection: selection.diagnostics };
}

export function finishTeam(run: AgentRun) {
  if (!run.team) return;
  const status = run.status === 'complete' ? 'complete' : run.status === 'cancelled' ? 'cancelled' : run.error?.includes('timed out') ? 'timed-out' : run.status === 'interrupted' ? 'interrupted' : run.result?.clarification ? 'clarification' : run.status === 'review' ? 'held' : 'failed';
  for (const item of run.team.items) if (item.role === 'executive' || item.id === run.team.specialistId || ['queued', 'running'].includes(item.status)) { item.status = status; item.reason = run.error; item.resultSummary = run.result?.text.slice(0, 500) ?? null; if (run.result?.clarification) item.unresolvedQuestions = [run.result.clarification]; }
}
