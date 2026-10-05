import { z } from 'zod';
import { MO_IDENTITY } from './mo';
import { resourceRefSchema } from './modules';
import { relayTransportConfigSchema, relayTransportStateSchema, smsDispatchSchema } from './relay-transport';
const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const identity = z.string().trim().min(1).max(160).regex(/^[^\s\x00-\x1f\x7f]+$/);
const at = z.string().datetime();
export const relayBindingSchema = z.object({ provider: z.enum(['twilio', 'synthetic']), providerAccount: identity, channel: z.literal('sms'), receiver: identity, sender: identity, kind: z.literal('message') }).strict();
/** An authenticated native intake envelope, never an instruction or permission grant. */
export const relayEventSchema = z.object({
  version: z.literal(1), eventId: identity, provider: relayBindingSchema.shape.provider, providerAccount: identity,
  channel: z.literal('sms'), receiver: identity, sender: identity, providerTimestamp: at, providerMessageId: identity,
  kind: z.enum(['message', 'delivery']), content: z.string().max(1600),
  authentication: z.object({ intakeId: uuid, mode: z.enum(['gateway', 'synthetic']), verifiedAt: at }).strict(),
  delivery: z.object({ status: z.enum(['accepted', 'queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed', 'unknown']), relatedMessageId: identity }).strict().optional(),
}).strict().refine(e => e.kind === 'message' ? !!e.content.trim() && !e.delivery : !!e.delivery && !e.content, 'Invalid event payload');
export type RelayEvent = z.infer<typeof relayEventSchema>;
export const responsibilitySchema = z.object({
  version: z.literal(1), objective: z.string().trim().min(1).max(500), resource: resourceRefSchema,
  binding: relayBindingSchema, scope: z.literal('task-follow-up'), disclosure: z.literal('acknowledgement-only'),
  expiresAt: at, reviewAt: at, authorityRevision: z.number().int().positive(), cancellationGeneration: z.number().int().nonnegative(),
  continuationRevision: z.number().int().min(0).max(12),
  status: z.enum(['waiting', 'queued', 'processing', 'needs-decision', 'cancelled', 'expired', 'completed', 'archived']),
  waitingReason: z.string().max(240), nextStage: z.enum(['receive-event', 'read-linked-task', 'owner-review', 'none']),
  activeEventId: uuid.nullable(), lastEventId: uuid.nullable(),
}).strict().refine(r => r.resource.type === 'task' && r.resource.connector === 'local');
export type Responsibility = z.infer<typeof responsibilitySchema>;
export const commsResultSchema = z.object({ schema: z.literal('comms-v1'), intent: z.enum(['update', 'question', 'unclear']), claimQuote: z.string().max(400), evidence: z.tuple([z.literal('R1'), z.literal('T1')]), reply: z.enum(['acknowledge', 'clarify']) }).strict();
export type CommsResult = z.infer<typeof commsResultSchema>;
export const smsActionSchema = z.object({
  version: z.literal(1), id: uuid, provider: relayBindingSchema.shape.provider, providerAccount: identity, from: identity, to: identity,
  body: z.string().trim().min(1).max(1600), revision: z.number().int().nonnegative(), bodyHash: digest,
  eventId: uuid, rootRunId: uuid, authorityRevision: z.number().int().positive(), cancellationGeneration: z.number().int().nonnegative(),
  disclosure: z.literal('acknowledgement-only'), expiresAt: at, hash: digest, ownerEdited: z.boolean(),
  status: z.enum(['local-draft', 'reviewed', 'stale']),
}).strict();
export type SmsAction = z.infer<typeof smsActionSchema>;
export const smsApprovalSchema = z.object({ actionId: uuid, hash: digest, nonce: uuid, expiresAt: at }).strict();
export type SmsApproval = z.infer<typeof smsApprovalSchema>;
export const relayReasonSchema = z.enum(['authorized', 'unknown-sender', 'ambiguous', 'expired-authority', 'revoked-authority', 'busy', 'review-due', 'limit', 'unsupported-event', 'stale-event', 'authority-changed', 'interrupted', 'cancelled', 'prepared', 'failed', 'dismissed']);
export const relayReceiptSchema = z.object({
  id: uuid, event: relayEventSchema.nullable(), digest, dedup: digest, receivedAt: at, rootRunId: uuid.nullable(), continuationRevision: z.number().int().min(0).max(12),
  disposition: z.enum(['held', 'queued', 'processing', 'prepared', 'failed', 'cancelled', 'archived']), reason: relayReasonSchema,
  synthetic: z.boolean(), duplicateCount: z.number().int().nonnegative(), updatedAt: at,
  result: commsResultSchema.nullable(), draft: smsActionSchema.nullable(), approval: smsApprovalSchema.nullable(),
  dispatch: smsDispatchSchema.optional(),
  timeline: z.array(z.object({ at, detail: z.string().max(240) }).strict()).max(12),
}).strict();
export type RelayReceipt = z.infer<typeof relayReceiptSchema>;
export const relaySnapshotSchema = z.object({
  assistant: z.literal(MO_IDENTITY).optional(),
  connection: z.enum(['not-configured','configured']), provider: z.literal('twilio'), lastSync: at.nullable(),
  transport: relayTransportStateSchema.optional(),
  receipts: z.array(relayReceiptSchema).max(200), responsibilities: z.array(z.object({ id: uuid, responsibility: responsibilitySchema }).strict()).max(100),
  totalReceipts: z.number().int().nonnegative(),
}).strict();
export type RelaySnapshot = z.infer<typeof relaySnapshotSchema>;
export const relayCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('snapshot') }).strict(),
  z.object({ action: z.literal('get'), id: uuid }).strict(),
  z.object({ action: z.literal('create'), id: uuid, taskId: uuid, objective: z.string().trim().min(1).max(500), binding: relayBindingSchema, expiresAt: at, reviewAt: at, disclosure: z.literal('acknowledgement-only') }).strict(),
  z.object({ action: z.enum(['cancel', 'complete', 'archive', 'wait']), id: uuid, expectedRevision: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal('editDraft'), id: uuid, expectedRevision: z.number().int().nonnegative(), body: smsActionSchema.shape.body }).strict(),
  z.object({ action: z.enum(['reviewDraft', 'dismiss']), id: uuid }).strict(),
  z.object({ action:z.literal('configureTransport'),config:relayTransportConfigSchema }).strict(),
  z.object({ action:z.literal('secureSetup'),purpose:z.enum(['rest','pair']) }).strict(),
  z.object({ action:z.enum(['syncTransport','checkReadiness','authorizeOutbound']) }).strict(),
  z.object({ action:z.literal('sendSms'),id:uuid,approval:smsApprovalSchema }).strict(),
  z.object({ action:z.literal('reconcileSms'),id:uuid }).strict(),
]);
export type RelayCommand = z.infer<typeof relayCommandSchema>;
export const relayNeedsDecision = (r: RelayReceipt) => r.disposition === 'held' || r.disposition === 'failed' || r.disposition === 'prepared';
export const relayReasonText: Record<z.infer<typeof relayReasonSchema>, string> = {
  authorized: 'Authorized update queued', 'unknown-sender': 'No exact owner-approved sender binding', ambiguous: 'More than one responsibility matches',
  'expired-authority': 'Responsibility permission expired', 'revoked-authority': 'Responsibility is closed or cancelled', busy: 'Review the current continuation first',
  'review-due': 'Owner review date reached', limit: 'Continuation limit reached', 'unsupported-event': 'Delivery callbacks are not enabled',
  'stale-event': 'The event is too old or has a future timestamp', 'authority-changed': 'Current authority or evidence changed',
  interrupted: 'Processing was interrupted; no automatic replay', cancelled: 'Cancelled by owner', prepared: 'Local reply ready for review', failed: 'Preparation needs attention', dismissed: 'Dismissed by owner',
};
