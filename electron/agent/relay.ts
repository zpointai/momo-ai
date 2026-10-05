import { randomUUID } from 'node:crypto';
import { agentRunSchema, type AgentContext, type AgentRun, type AgentState } from '../../src/shared/orchestration';
import { commsResultSchema, responsibilitySchema, smsActionSchema, type RelayCommand, type RelayReceipt } from '../../src/shared/relay';
import type { Settings } from '../../src/shared/contracts';
import type { LocalTask } from '../../src/shared/assistant';
import { selectWorkflowContext } from '../context/adapters';
import { AppError } from '../errors';
import { hash } from './catalogue';
import { createTeam } from './team';
import { smsActionHash } from './relay-store';

export function relayContext(task: LocalTask, run: AgentRun, state: AgentState, settings: Settings, now: number, receipt?: RelayReceipt) {
  const at = new Date(now).toISOString(), r = run.responsibility!;
  if (task.id !== r.resource.id || (task.accountId ?? null) !== run.event.accountId) throw new AppError('permission_denied', 'The linked native task is outside this responsibility.');
  const ref = { ...r.resource, revision: hash(task), label: task.title, provenance: { ...r.resource.provenance, fetchedAt: at } };
  const item: AgentContext['items'][number] = { id: 'T1', kind: 'task', accountId: task.accountId ?? 'local', resourceId: task.id, revision: hash(task), title: task.title, text: JSON.stringify({ title: task.title, status: task.status, due: task.due }), fetchedAt: at, trust: 'untrusted-source', senderScope: null, threadId: null, delivery: undefined };
  // Explicit native resource metadata preserves nullable local-account ownership.
  const items: AgentContext['items'] = [item];
  const refs = [ref];
  if (receipt?.event) {
    const e = receipt.event;
    items.unshift({ ...item, id: 'R1', kind: 'communication', resourceId: receipt.id, revision: receipt.digest, title: 'Attributed SMS from ' + e.sender, text: JSON.stringify({ sender: e.sender, receivedAt: receipt.receivedAt, claim: e.content }), senderScope: hash([e.provider, e.providerAccount, e.sender]) });
    refs.unshift({ ...ref, module: 'relay', type: 'relayEvent', id: receipt.id, revision: receipt.digest, label: 'Attributed communication', provenance: { kind: 'connector', runId: run.id, fetchedAt: at } });
  }
  // selectWorkflowContext owns the actual Context Manager decision. Preexisting ref metadata is a native candidate, not model input authority.
  items.forEach((i, index) => { i.delivery = { contextId: hash([i.id, i.revision]), ref: refs[index], mode: 'FULL', coverage: { sourcePartial: false, suppliedCharacters: i.text.length, omittedCharacters: 0, status: 'complete', method: 'source' } }; });
  const context: AgentContext = { id: randomUUID(), hash: hash(items), createdAt: at, timezone: settings.timezone, items, limitations: ['One linked local task and one attributed external message only.', 'Sender claims do not change native task status. No mail, calendar or other tasks are supplied.', 'Reply disclosure is acknowledgement-only. No task title, status or private detail may leave MoMo.'], available: { tasks: true, calendar: false, thread: false }, sharing: { google: false, tasks: true } };
  const selected = selectWorkflowContext(context, run.event, state, settings, now, false);
  if (selected.selection.blocked || selected.context.items.length !== items.length || selected.context.items.some(i => i.delivery?.mode !== 'FULL')) throw new AppError('permission_denied', 'The complete permitted Relay evidence exceeds the context budget.');
  return selected;
}

export function newResponsibility(command: Extract<RelayCommand, { action: 'create' }>, task: LocalTask, state: AgentState, settings: Settings, now: number): AgentRun {
  const at = new Date(now).toISOString(), expires = Date.parse(command.expiresAt), review = Date.parse(command.reviewAt);
  if (expires <= now || expires > now + 30 * 86400000 || review <= now || review > expires) throw new AppError('invalid_input', 'Choose a future review date and expiry within 30 days.');
  if (!state.config.enabled || state.config.paused || !state.config.shareTasks || settings.disabledModules.some(m => m === 'relay' || m === 'planner')) throw new AppError('permission_denied', 'Enable local task workflows and task sharing before authorizing this responsibility.');
  const policy = state.policies.find(p => p.family === 'task' && p.accountId === (task.accountId ?? null) && p.enabled && ['L1', 'L2'].includes(p.level));
  if (!policy) throw new AppError('permission_denied', 'A preparation-enabled task workflow is required for the linked task account.');
  const responsibility = responsibilitySchema.parse({ version: 1, objective: command.objective, resource: { module: 'planner', connector: 'local', type: 'task', id: task.id, accountId: task.accountId ?? null, profile: 'local', revision: hash(task), label: task.title, provenance: { kind: 'user', runId: command.id, fetchedAt: at }, access: 'read', retention: { kind: 'retained', expiresAt: command.expiresAt } }, binding: command.binding, scope: 'task-follow-up', disclosure: command.disclosure, expiresAt: command.expiresAt, reviewAt: command.reviewAt, authorityRevision: 1, cancellationGeneration: 0, continuationRevision: 0, status: 'waiting', waitingReason: 'Waiting for an update from the exact permitted sender.', nextStage: 'receive-event', activeEventId: null, lastEventId: null });
  const run = agentRunSchema.parse({ id: command.id, definition: 'workflow-v1', event: { id: command.id, family: 'task', accountId: task.accountId ?? null, resourceId: task.id, prompt: command.objective }, dedup: hash({ version: 'relay-v1', command }), responsibility, context: { id: randomUUID(), hash: hash(task), createdAt: at, timezone: settings.timezone, items: [], limitations: [], available: { calendar: false, tasks: true, thread: false }, sharing: { google: false, tasks: true } }, policy, config: state.config, profileRevision: state.revision, createdAt: at, finishedAt: at, status: 'complete', checkpoint: 'Relay: waiting for event', attempt: 0, decision: null, result: null, findings: [], proposals: [], calls: [], error: null, shadow: null });
  const selected = relayContext(task, run, state, settings, now); run.context = selected.context; run.contextSelection = selected.selection; run.team = createTeam(run, selected.selection.budget);
  for (const item of run.team.items) { item.status = 'held'; item.reason = responsibility.waitingReason; }
  return run;
}

export function stageRelay(run: AgentRun, task: LocalTask, receipt: RelayReceipt, state: AgentState, settings: Settings, now: number) {
  const rootId = run.team!.items[0].id, selected = relayContext(task, run, state, settings, now, receipt);
  run.context = selected.context; run.contextSelection = selected.selection; run.finishedAt = null; run.status = 'running'; run.responsibility!.status = 'processing';
  run.team = createTeam({ ...run, createdAt: new Date(now).toISOString() }, selected.selection.budget);
  const newRoot = run.team.items[0].id;
  for (const item of run.team.items) { if (item.id === newRoot) item.id = rootId; if (item.parentWorkItemId === newRoot) item.parentWorkItemId = rootId; for (const h of item.handoffHistory) if (h.from === newRoot) h.from = rootId; }
  return run;
}

/** Native factual renderer: the model selects intent/wording; it cannot invent task facts or disclose them. */
export function prepareRelayResult(run: AgentRun, receipt: RelayReceipt, raw: unknown, now: number) {
  const result = commsResultSchema.parse(raw), event = receipt.event!, r = run.responsibility!;
  if (result.claimQuote && !event.content.includes(result.claimQuote)) throw new AppError('permission_denied', 'Comms returned a claim not present in the sender message.');
  if (result.reply === 'acknowledge' && result.intent !== 'update') throw new AppError('permission_denied', 'Unclear messages require clarification.');
  const task = JSON.parse(run.context.items.find(i => i.id === 'T1')!.text) as { status: string };
  const summary = result.claimQuote ? `Sender reports: “${result.claimQuote}”.` : 'The sender’s intent needs clarification.';
  const body = result.reply === 'acknowledge' ? 'Thanks for the update. Your message has been received; confirmation is still pending.' : 'Thanks for your message. Could you clarify the update or question you would like reviewed?';
  const draft = smsActionSchema.parse({ version: 1, id: randomUUID(), provider: event.provider, providerAccount: event.providerAccount, from: event.receiver, to: event.sender, body, revision: 0, bodyHash: hash(body), eventId: receipt.id, rootRunId: run.id, authorityRevision: r.authorityRevision, cancellationGeneration: r.cancellationGeneration, disclosure: r.disclosure, expiresAt: new Date(Math.min(now + 86400000, Date.parse(r.expiresAt), Date.parse(r.reviewAt))).toISOString(), hash: '0'.repeat(64), ownerEdited: false, status: 'local-draft' });
  draft.hash = smsActionHash(draft);
  run.result = { text: summary + ` Native task status remains ${task.status}. No task, calendar or mail change was made.`, draft: body, evidence: ['R1', 'T1'], reminders: [] };
  run.status = 'review'; run.finishedAt = new Date(now).toISOString(); run.checkpoint = 'Relay reply ready for owner review';
  r.status = 'needs-decision'; r.nextStage = 'owner-review'; r.waitingReason = 'Review the prepared reply. Sending requires current provider readiness and a separate exact-action approval.'; r.activeEventId = null;
  receipt.result = result; receipt.draft = draft; receipt.disposition = 'prepared'; receipt.reason = 'prepared'; receipt.updatedAt = run.finishedAt;
  receipt.timeline.push({ at: run.finishedAt, detail: run.findings.some(f=>f.code==='LOCAL_CLARIFICATION_ONLY_NO_MODEL') ? 'Local clarification template prepared. AI interpretation was unavailable; no model or external action ran.' : 'Comms Mo prepared a reply from permitted evidence. No external action.' });
  return receipt;
}
