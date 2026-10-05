import { taskSchema } from '../../src/shared/assistant';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { agentRunSchema, type AgentRun } from '../../src/shared/orchestration';
import { relayEventSchema, relayReceiptSchema, smsActionSchema, type RelayReceipt, type RelaySnapshot, type SmsAction, type SmsApproval } from '../../src/shared/relay';
import { hash } from './catalogue';
import { AppError } from '../errors';
import { deliveryProgress, type SmsDispatch } from '../../src/shared/relay-transport';

export function smsActionHash(a: Omit<SmsAction, 'hash'> | SmsAction) {
  return hash({ version: a.version, id: a.id, provider: a.provider, providerAccount: a.providerAccount, from: a.from, to: a.to, body: a.body, revision: a.revision, bodyHash: a.bodyHash, eventId: a.eventId, rootRunId: a.rootRunId, authorityRevision: a.authorityRevision, cancellationGeneration: a.cancellationGeneration, disclosure: a.disclosure, expiresAt: a.expiresAt });
}
export function assertSmsApproval(a: SmsAction, approval: SmsApproval, current: SmsApproval | null, now: number) {
  if (!current || a.status !== 'local-draft' || a.hash !== smsActionHash(a) || a.bodyHash !== hash(a.body) || approval.actionId !== a.id || approval.hash !== a.hash || JSON.stringify(approval) !== JSON.stringify(current) || Date.parse(approval.expiresAt) <= now || Date.parse(a.expiresAt) <= now) throw new AppError('permission_denied', 'The exact SMS review changed, expired, or was already used.');
}
/** Local contract only. A future transport must consume and persist this transition before dispatch. */
export function consumeSmsApproval(receipt: RelayReceipt, approval: SmsApproval, now: number) {
  if (!receipt.draft) throw new AppError('unavailable', 'No SMS draft is retained.');
  assertSmsApproval(receipt.draft, approval, receipt.approval, now);
  receipt.approval = null; receipt.draft.status = 'reviewed';
}
export const sameContinuation = (a: AgentRun, b: AgentRun) => !!a.responsibility && !!b.responsibility && a.responsibility.authorityRevision === b.responsibility.authorityRevision && a.responsibility.cancellationGeneration === b.responsibility.cancellationGeneration && a.responsibility.continuationRevision === b.responsibility.continuationRevision;
/** Transport receipts only. Responsibilities stay in AgentRepository's root runs. */
export class RelayReceipts {
  constructor(private db: Database.Database) {}
  run(id: string): AgentRun | null { const row = this.db.prepare('SELECT payload FROM agent_runs WHERE id=?').get(id) as { payload: string } | undefined; return row ? agentRunSchema.parse(JSON.parse(row.payload)) : null; }
  roots() { return (this.db.prepare("SELECT payload FROM agent_runs WHERE json_type(payload,'$.responsibility')='object' ORDER BY created_at DESC").all() as { payload: string }[]).map(r => agentRunSchema.parse(JSON.parse(r.payload))); }
  get(id: string): RelayReceipt | null { const row = this.db.prepare('SELECT payload FROM relay_events WHERE id=?').get(id) as { payload: string } | undefined; return row ? relayReceiptSchema.parse(JSON.parse(row.payload)) : null; }
  put(receipt: RelayReceipt) { this.db.prepare('UPDATE relay_events SET payload=? WHERE id=?').run(JSON.stringify(relayReceiptSchema.parse(receipt)), receipt.id); return receipt; }
  putRun(run: AgentRun) { this.db.prepare('UPDATE agent_runs SET payload=? WHERE id=?').run(JSON.stringify(agentRunSchema.parse(run)), run.id); }
  snapshot(): RelaySnapshot {
    const receipts = (this.db.prepare("SELECT payload FROM relay_events WHERE json_extract(payload,'$.disposition')!='archived' ORDER BY created_at DESC,rowid DESC LIMIT 200").all() as { payload: string }[]).map(r => relayReceiptSchema.parse(JSON.parse(r.payload)));
    return { connection: 'not-configured', provider: 'twilio', lastSync: null, receipts, totalReceipts: (this.db.prepare('SELECT COUNT(*) n FROM relay_events').get() as { n: number }).n, responsibilities: this.roots().slice(0, 100).map(r => ({ id: r.id, responsibility: r.responsibility! })) };
  }
  intake(raw: unknown, now: number) {
    const event = relayEventSchema.parse(raw), receivedAt = new Date(now).toISOString();
    const key = (id: string) => hash([event.provider, event.providerAccount, event.channel, id]);
    const dedup = key(event.providerMessageId + ':' + event.kind + (event.delivery ? ':' + event.delivery.status : '')), eventKey = key(event.eventId);
    // Transport authentication/timestamps can change on redelivery; the original content cannot.
    const digest = hash({ provider: event.provider, providerAccount: event.providerAccount, channel: event.channel, receiver: event.receiver, sender: event.sender, providerTimestamp: event.providerTimestamp, providerMessageId: event.providerMessageId, kind: event.kind, content: event.content, delivery: event.delivery });
    return this.db.transaction(() => {
      const prior = this.db.prepare('SELECT id FROM relay_events WHERE dedup=? OR event_key=?').get(dedup, eventKey) as { id: string } | undefined;
      if (prior) { const receipt = this.get(prior.id)!; if (receipt.digest !== digest) throw new AppError('conflict', 'Relay event identity was replayed with different content.'); receipt.duplicateCount++; return this.put(receipt); }
      if ((this.db.prepare("SELECT count(*) n FROM relay_events WHERE json_extract(payload,'$.disposition')!='archived'").get() as { n: number }).n >= 200) throw new AppError('unavailable', 'Relay retention is full. Review or archive retained events first.');
      const matches = this.roots().filter(r => { const b = r.responsibility!.binding; return b.provider === event.provider && b.providerAccount === event.providerAccount && b.channel === event.channel && b.receiver === event.receiver && b.sender === event.sender && b.kind === event.kind; });
      const eligible = matches.filter(r => !['cancelled', 'completed', 'archived', 'expired'].includes(r.responsibility!.status) && Date.parse(r.responsibility!.expiresAt) > now);
      let reason: RelayReceipt['reason'] = event.kind !== 'message' ? 'unsupported-event' : Math.abs(now - Date.parse(event.providerTimestamp)) > 86400000 || Date.parse(event.providerTimestamp) > now + 300000 ? 'stale-event' : eligible.length > 1 ? 'ambiguous' : !eligible.length ? matches.some(r => Date.parse(r.responsibility!.expiresAt) <= now) ? 'expired-authority' : matches.length ? 'revoked-authority' : 'unknown-sender' : 'authorized';
      const run = reason === 'authorized' ? eligible[0] : null, r = run?.responsibility;
      if (r) reason = Date.parse(r.reviewAt) <= now ? 'review-due' : r.continuationRevision >= 12 ? 'limit' : r.status !== 'waiting' ? 'busy' : 'authorized';
      if(r && reason==='authorized' && r.lastEventId){const last=this.get(r.lastEventId);if(last?.event && Date.parse(event.providerTimestamp)<=Date.parse(last.event.providerTimestamp))reason='stale-event';}
      const receipt: RelayReceipt = { id: randomUUID(), event, digest, dedup, receivedAt, rootRunId: run?.id ?? null, continuationRevision: 0, disposition: reason === 'authorized' ? 'queued' : 'held', reason, synthetic: event.authentication.mode === 'synthetic', duplicateCount: 0, updatedAt: receivedAt, result: null, draft: null, approval: null, timeline: [{ at: receivedAt, detail: reason === 'authorized' ? 'Exact owner binding matched; queued on the existing root.' : 'Held for owner review: ' + reason }] };
      if (run && r && reason === 'authorized') {
        r.continuationRevision++; r.activeEventId = receipt.id; r.lastEventId = receipt.id; r.status = 'queued'; r.nextStage = 'read-linked-task'; r.waitingReason = 'Authorized event is queued for the desktop.';
        receipt.continuationRevision = r.continuationRevision; run.status = 'queued'; run.finishedAt = null; run.checkpoint = 'Relay update queued'; run.result = null; run.error = null; run.findings = []; run.attempt = 0;
        this.putRun(run);
      }
      if(event.kind==='delivery')receipt.disposition='archived';
      this.db.prepare('INSERT INTO relay_events VALUES (?,?,?,?,?)').run(receipt.id, dedup, eventKey, receivedAt, JSON.stringify(receipt));
      if(event.delivery)this.applyCallback(receipt);
      return receipt;
    }).immediate();
  }
  change(id: string, revision: number, action: 'cancel' | 'complete' | 'archive' | 'wait', now: number) {
    return this.db.transaction(() => {
      const run = this.run(id), r = run?.responsibility;
      if (!run || !r || r.continuationRevision !== revision) throw new AppError('conflict', 'Responsibility changed. Refresh before continuing.');
      if (action === 'wait' && (r.status !== 'needs-decision' || Date.parse(r.reviewAt) <= now || Date.parse(r.expiresAt) <= now || r.continuationRevision >= 12)) throw new AppError('permission_denied', 'This responsibility needs renewed authority; it cannot wait again.');
      r.authorityRevision++; r.cancellationGeneration++; r.status = action === 'wait' ? 'waiting' : action === 'cancel' ? 'cancelled' : action === 'complete' ? 'completed' : 'archived';
      r.nextStage = action === 'wait' ? 'receive-event' : 'none'; r.waitingReason = action === 'wait' ? 'Waiting for the next permitted update.' : 'Closed by the owner. Task and communication outcomes are unchanged.';
      const active = r.activeEventId ? this.get(r.activeEventId) : null;
      if (active && ['queued', 'processing'].includes(active.disposition)) { active.disposition = 'cancelled'; active.reason = 'cancelled'; active.updatedAt = new Date(now).toISOString(); this.put(active); }
      // All retained drafts are preserved as text but old review nonces lose authority.
      for (const row of this.db.prepare("SELECT id FROM relay_events WHERE json_extract(payload,'$.rootRunId')=?").all(id) as { id: string }[]) {
        const item = this.get(row.id)!; item.approval = null; if (item.draft) item.draft.status = 'stale'; if (action === 'archive') item.disposition = 'archived'; this.put(item);
      }
      r.activeEventId = null; run.status = action === 'cancel' ? 'cancelled' : 'complete'; run.finishedAt = new Date(now).toISOString(); run.checkpoint = 'Relay: ' + r.status; this.putRun(run); return run;
    }).immediate();
  }
  stage(next: AgentRun, expected: AgentRun) {
    return this.db.transaction(() => {
    const current = this.run(next.id);
    if (!current || !sameContinuation(current, expected) || current.status !== 'queued' || current.responsibility?.status !== 'queued' || JSON.stringify(current.event) !== JSON.stringify(next.event) || current.dedup !== next.dedup) throw new AppError('conflict', 'Relay continuation lost its authority before context commit.');
    this.putRun(next); const receipt = this.get(next.responsibility!.activeEventId!)!; receipt.disposition = 'processing'; receipt.updatedAt = next.context.createdAt; receipt.timeline.push({ at: next.context.createdAt, detail: 'Current linked task selected through Context Manager.' }); this.put(receipt); return next;
    }).immediate();
  }
  commit(next: AgentRun, receipt: RelayReceipt, now: number) {
    return this.db.transaction(() => {
      const current = this.run(next.id), stored = this.get(receipt.id);
      if (!current || !sameContinuation(current, next) || current.responsibility!.status !== 'processing' || !stored || stored.disposition !== 'processing' || stored.draft || Date.parse(current.responsibility!.expiresAt) <= now || Date.parse(current.responsibility!.reviewAt) <= now) throw new AppError('conflict', 'Relay continuation changed before commit.');
      const task = this.db.prepare('SELECT payload FROM local_tasks WHERE id=?').get(next.responsibility!.resource.id) as { payload: string } | undefined;
      const state = JSON.parse((this.db.prepare('SELECT payload FROM agent_state WHERE id=1').get() as { payload: string }).payload);
      const settings = JSON.parse((this.db.prepare('SELECT value FROM settings WHERE id=1').get() as { value: string }).value);
      if (!task || hash(taskSchema.parse(JSON.parse(task.payload))) !== next.context.items.find(i => i.id === 'T1')?.revision || JSON.stringify(state.config) !== JSON.stringify(next.config) || !state.policies.some((p: AgentRun['policy']) => p.id === next.policy.id && p.version === next.policy.version && p.enabled) || settings.disabledModules.some((m: string) => ['planner', 'relay'].includes(m))) throw new AppError('conflict', 'Task evidence or disclosure authority changed before commit.');
      if (JSON.stringify(current.event) !== JSON.stringify(next.event) || current.context.hash !== next.context.hash) throw new AppError('conflict', 'Relay immutable context changed.');
      receipt.duplicateCount = stored.duplicateCount;
      this.putRun(next); return this.put(receipt);
    }).immediate();
  }
  draftCommand(id: string, action: 'editDraft' | 'reviewDraft' | 'dismiss', now: number, body?: string, revision?: number) {
    return this.db.transaction(() => {
      const receipt = this.get(id); if (!receipt) throw new AppError('unavailable', 'Relay event is no longer retained.');
      if (action === 'dismiss') { if (['queued', 'processing'].includes(receipt.disposition)) throw new AppError('conflict', 'Cancel the responsibility first.'); receipt.disposition = 'archived'; receipt.reason = 'dismissed'; receipt.approval = null; return this.put(receipt); }
      const draft = receipt.draft, run = receipt.rootRunId ? this.run(receipt.rootRunId) : null, r = run?.responsibility;
      if(receipt.dispatch)throw new AppError('permission_denied','This exact reply already has a dispatch reservation. Inspect its outcome; it cannot be edited or sent again.');
      if (!draft || !r || r.status !== 'needs-decision' || r.authorityRevision !== draft.authorityRevision || r.cancellationGeneration !== draft.cancellationGeneration || Date.parse(r.expiresAt) <= now || Date.parse(r.reviewAt) <= now || Date.parse(draft.expiresAt) <= now) throw new AppError('permission_denied', 'Draft authority expired or changed. Text is preserved.');
      if (action === 'reviewDraft') {
        const state = JSON.parse((this.db.prepare('SELECT payload FROM agent_state WHERE id=1').get() as { payload: string }).payload);
        const task = this.db.prepare('SELECT payload FROM local_tasks WHERE id=?').get(r.resource.id) as { payload: string } | undefined;
        if (JSON.stringify(state.config) !== JSON.stringify(run!.config) || !state.policies.some((p: AgentRun['policy']) => p.id === run!.policy.id && p.version === run!.policy.version && p.enabled) || !task || hash(taskSchema.parse(JSON.parse(task.payload))) !== run!.context.items.find(i => i.id === 'T1')?.revision) throw new AppError('permission_denied', 'Disclosure authority or the linked task changed. The local text is preserved; this review cannot proceed.');
      }
      if (action === 'editDraft') { if (revision !== draft.revision) throw new AppError('conflict', 'This draft changed. Reopen the current revision.'); draft.body = smsActionSchema.shape.body.parse(body); draft.revision++; draft.bodyHash = hash(draft.body); draft.ownerEdited = true; draft.hash = smsActionHash(draft); receipt.approval = null; }
      else receipt.approval = { actionId: draft.id, hash: draft.hash, nonce: randomUUID(), expiresAt: new Date(Math.min(now + 300000, Date.parse(draft.expiresAt))).toISOString() };
      receipt.updatedAt = new Date(now).toISOString(); return this.put(receipt);
    }).immediate();
  }
  reserveDispatch(id:string,approval:SmsApproval,now:number){return this.db.transaction(()=>{
    const receipt=this.get(id),a=receipt?.draft,run=receipt?.rootRunId?this.run(receipt.rootRunId):null,r=run?.responsibility;
    if(!receipt||!a||!run||!r||receipt.dispatch||receipt.disposition!=='prepared'||r.status!=='needs-decision'||r.lastEventId!==id||r.authorityRevision!==a.authorityRevision||r.cancellationGeneration!==a.cancellationGeneration||Date.parse(r.expiresAt)<=now||Date.parse(r.reviewAt)<=now)throw new AppError('permission_denied','SMS authority is no longer current.');
    if(a.provider!=='twilio'||a.providerAccount!==r.binding.providerAccount||a.from!==r.binding.receiver||a.to!==r.binding.sender||a.eventId!==id||a.rootRunId!==run.id||a.disclosure!==r.disclosure)throw new AppError('permission_denied','SMS binding changed.');
    const state=JSON.parse((this.db.prepare('SELECT payload FROM agent_state WHERE id=1').get() as {payload:string}).payload),settings=JSON.parse((this.db.prepare('SELECT value FROM settings WHERE id=1').get() as {value:string}).value);
    const task=this.db.prepare('SELECT payload FROM local_tasks WHERE id=?').get(r.resource.id) as {payload:string}|undefined;
    if(!state.config.enabled||state.config.paused||!state.config.shareTasks||JSON.stringify(state.config)!==JSON.stringify(run.config)||!state.policies.some((p:AgentRun['policy'])=>p.id===run.policy.id&&p.version===run.policy.version&&p.enabled&&['L1','L2'].includes(p.level))||settings.disabledModules.some((m:string)=>['relay','planner'].includes(m))||!task||hash(taskSchema.parse(JSON.parse(task.payload)))!==run.context.items.find(i=>i.id==='T1')?.revision)throw new AppError('permission_denied','Current native policy or task evidence changed.');
    consumeSmsApproval(receipt,approval,now);
    receipt.dispatch={id:randomUUID(),actionHash:a.hash,approvalExpiresAt:approval.expiresAt,reservedAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),status:'dispatching',messageSid:null,detail:'Reserved durably before provider contact. No automatic resubmission.'};
    return this.put(receipt);
  }).immediate();}
  updateDispatch(id:string,dispatch:SmsDispatch){const receipt=this.get(id);if(!receipt?.dispatch||receipt.dispatch.id!==dispatch.id||receipt.dispatch.actionHash!==dispatch.actionHash)throw new AppError('conflict','Dispatch reservation changed.');receipt.dispatch={...dispatch,status:deliveryProgress(receipt.dispatch.status,dispatch.status)};this.put(receipt);
    for(const row of this.db.prepare("SELECT id FROM relay_events WHERE json_extract(payload,'$.event.delivery.relatedMessageId')=? ORDER BY created_at,rowid").all(dispatch.messageSid) as {id:string}[])this.applyCallback(this.get(row.id)!);
    return this.get(id)!;
  }
  validateDispatch(id:string,reservation:string,now:number){const receipt=this.get(id),a=receipt?.draft,run=receipt?.rootRunId?this.run(receipt.rootRunId):null,r=run?.responsibility;
    if(!receipt?.dispatch||receipt.dispatch.id!==reservation||receipt.dispatch.status!=='dispatching'||Date.parse(receipt.dispatch.approvalExpiresAt)<=now||!a||!run||!r||r.status!=='needs-decision'||r.authorityRevision!==a.authorityRevision||r.cancellationGeneration!==a.cancellationGeneration||r.lastEventId!==id||Date.parse(a.expiresAt)<=now||Date.parse(r.reviewAt)<=now||Date.parse(r.expiresAt)<=now)throw new AppError('permission_denied','SMS dispatch authority changed before provider contact.');
    const state=JSON.parse((this.db.prepare('SELECT payload FROM agent_state WHERE id=1').get() as {payload:string}).payload),settings=JSON.parse((this.db.prepare('SELECT value FROM settings WHERE id=1').get() as {value:string}).value),task=this.db.prepare('SELECT payload FROM local_tasks WHERE id=?').get(r.resource.id) as {payload:string}|undefined;
    if(!state.config.enabled||state.config.paused||JSON.stringify(state.config)!==JSON.stringify(run.config)||!state.policies.some((p:AgentRun['policy'])=>p.id===run.policy.id&&p.version===run.policy.version&&p.enabled&&['L1','L2'].includes(p.level))||settings.disabledModules.some((m:string)=>['relay','planner'].includes(m))||!task||hash(taskSchema.parse(JSON.parse(task.payload)))!==run.context.items.find(i=>i.id==='T1')?.revision)throw new AppError('permission_denied','Native policy or task changed before SMS dispatch.');return true;
  }
  private applyCallback(callback:RelayReceipt){const event=callback.event;if(!event?.delivery)return;for(const row of this.db.prepare("SELECT id FROM relay_events WHERE json_extract(payload,'$.dispatch.messageSid')=?").all(event.delivery.relatedMessageId) as {id:string}[]){const receipt=this.get(row.id)!;if(!receipt.draft||receipt.draft.providerAccount!==event.providerAccount||receipt.draft.from!==event.receiver||receipt.draft.to!==event.sender)continue;receipt.dispatch!.status=deliveryProgress(receipt.dispatch!.status,event.delivery.status==='accepted'?'provider-accepted':event.delivery.status);receipt.dispatch!.updatedAt=callback.receivedAt;receipt.dispatch!.detail='Authenticated provider delivery update. Responsibility completion is separate.';this.put(receipt);}}
  recoverDispatches(){for(const row of this.db.prepare("SELECT id FROM relay_events WHERE json_extract(payload,'$.dispatch.status')='dispatching'").all() as {id:string}[]){const r=this.get(row.id)!;r.dispatch!.status='unknown';r.dispatch!.detail='Application stopped during dispatch. Outcome unknown; no automatic resubmission.';this.put(r);}}
  prune(now: number) {
    for (const run of this.roots()) {
      const r = run.responsibility!;
      if (!['cancelled', 'completed', 'archived', 'expired'].includes(r.status) && (Date.parse(r.expiresAt) <= now || r.status !== 'needs-decision' && Date.parse(r.reviewAt) <= now)) {
        r.authorityRevision++; r.cancellationGeneration++; r.status = Date.parse(r.expiresAt) <= now ? 'expired' : 'needs-decision'; r.waitingReason = 'Permission expired or its owner review date was reached.'; r.nextStage = 'owner-review'; run.status = 'review'; run.finishedAt = new Date(now).toISOString(); this.putRun(run);
        if (r.activeEventId) { const receipt = this.get(r.activeEventId); if (receipt) { receipt.disposition = 'held'; receipt.reason = 'expired-authority'; receipt.approval = null; if (receipt.draft) receipt.draft.status = 'stale'; this.put(receipt); } }
      }
    }
    const cutoff = new Date(now - 90 * 86400000).toISOString();
    for (const row of this.db.prepare('SELECT id FROM relay_events WHERE created_at<?').all(cutoff) as { id: string }[]) {
      const receipt = this.get(row.id)!; receipt.event = null; receipt.draft = null; receipt.result = null; receipt.approval = null; receipt.timeline = []; receipt.disposition = 'archived'; this.put(receipt); // Content-free replay fence remains.
    }
  }
}
