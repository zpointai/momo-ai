import { z } from 'zod';
import { resourceRefSchema, moduleIdSchema } from './modules';
import { contextBudgetSchema, contextDeliverySchema } from './context';

export const agentRoleSchema = z.enum(['executive', 'inbox', 'planner', 'briefing', 'context', 'review', 'comms']);
export type AgentRole = z.infer<typeof agentRoleSchema>;
export const roleNames: Record<AgentRole, string> = { executive: 'Coordinator', comms: 'Comms Mo', inbox: 'Inbox', planner: 'Planner', briefing: 'Briefing', context: 'Context', review: 'Evidence review' };
export const agentCapabilitySchema = z.enum(['context.read', 'inbox.assess', 'reply.prepare', 'planner.analyze', 'briefing.synthesize', 'response.generate', 'task.propose', 'calendar.propose', 'evidence.review']);
export type AgentCapability = z.infer<typeof agentCapabilitySchema>;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
export const agentPermissionSchema = z.object({
  policyId: uuid, policyVersion: z.number().int().positive(), profileRevision: z.number().int().nonnegative(),
  shareGoogle: z.boolean(), shareTasks: z.boolean(),
  actions: z.array(z.enum(['local-reply', 'task-proposal', 'calendar-proposal'])).max(3),
  externalWrites: z.literal(false), ownerApprovalRequired: z.literal(true),
}).strict();
export const agentBindingSchema = z.object({ evidenceId: z.string().max(20), delivery: contextDeliverySchema }).strict();
const handoffSchema = z.object({ from: uuid, to: uuid, role: agentRoleSchema, at: z.string().datetime(), objective: z.string().max(2000) }).strict();
/** A native instruction envelope. Its fields are constraints, never permission grants. */
export const agentWorkItemSchema = z.object({
  requestFingerprint: digest.optional(),
  version: z.literal(1), id: uuid, rootRunId: uuid, parentWorkItemId: uuid.nullable(), role: agentRoleSchema,
  objective: z.string().min(1).max(2000), workflow: z.enum(['email', 'briefing', 'chat', 'task']), module: moduleIdSchema,
  accountId: z.string().nullable(), profile: z.literal('local'), sources: z.array(resourceRefSchema).max(20),
  context: z.object({ selectionId: uuid, bindings: z.array(agentBindingSchema).max(20) }).strict(),
  allowedCapabilities: z.array(agentCapabilitySchema).max(10), allowedTools: z.array(z.literal('read_context')).max(1),
  permission: agentPermissionSchema, contextBudget: contextBudgetSchema,
  expectedResult: z.enum(['processing-v1', 'context-v1', 'review-v1', 'inbox-scheduling-v1', 'planner-availability-v1', 'comms-v1']),
  requiredEvidenceIds: z.array(z.string().max(20)).max(20), requiredTools: z.array(z.literal('read_context')).max(1),
  deliverables: z.array(z.enum(['answer', 'reply-or-clarification', 'conflicts', 'snapshot', 'references', 'ledger'])).max(6),
  priority: z.enum(['high', 'normal', 'unknown']), deadline: z.string().datetime(), maxSourceAgeMs: z.number().int().min(1).max(300000),
  provenance: z.object({ origin: z.enum(['user', 'connector', 'momo']), createdAt: z.string().datetime(), contextHash: digest }).strict(),
  revisionBindings: z.array(z.object({ key: digest, revision: z.string().min(1).max(128) }).strict()).max(20),
  depth: z.number().int().min(0).max(6), status: z.enum(['queued', 'running', 'complete', 'clarification', 'held', 'failed', 'cancelled', 'timed-out', 'interrupted']),
  unresolvedQuestions: z.array(z.string().max(2000)).max(6), handoffHistory: z.array(handoffSchema).max(12),
  resultSummary: z.string().max(500).nullable(), reason: z.string().max(240).nullable(),
}).strict();
export type AgentWorkItem = z.infer<typeof agentWorkItemSchema>;
export const contextAgentResultSchema = z.object({
  schema: z.literal('context-v1'), workItemId: uuid,
  refs: z.array(resourceRefSchema).max(20),
  findings: z.array(z.object({ evidenceId: z.string().max(20), descriptor: z.string().max(240), delivery: contextDeliverySchema }).strict()).max(20),
  unresolvedQuestions: z.array(z.string().max(2000)).max(6),
}).strict();
export type ContextAgentResult = z.infer<typeof contextAgentResultSchema>;
export const evidenceLedgerSchema = z.object({
  workItemId: uuid, at: z.string().datetime(), passed: z.boolean(),
  checks: z.array(z.object({ code: z.string().max(80), status: z.enum(['pass', 'reject', 'unknown']), detail: z.string().max(240) }).strict()).max(24),
  semantic: z.enum(['not-requested', 'unavailable', 'no-flags', 'flags']),
}).strict();
export type EvidenceLedger = z.infer<typeof evidenceLedgerSchema>;
export const agentTeamSchema = z.object({
  version: z.literal(1), specialistId: uuid, items: z.array(agentWorkItemSchema).max(12),
  limits: z.object({ maxDepth: z.number().int().min(1).max(6), maxSteps: z.number().int().min(1).max(12) }).strict(),
  toolCompletions: z.array(z.object({ workItemId: uuid, tool: z.literal('read_context'), evidenceIds: z.array(z.string().max(20)).max(5), at: z.string().datetime() }).strict()).max(8),
  ledger: evidenceLedgerSchema.nullable(),
}).strict();
export type AgentTeam = z.infer<typeof agentTeamSchema>;
