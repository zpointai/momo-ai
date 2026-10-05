import { z } from 'zod';
import { contextDeliverySchema, contextDiagnosticsSchema } from './context';
import { accountIdSchema, dateSchema, timezoneSchema } from './google';
import { resourceRefSchema } from './modules';
import { moChannelSchema } from './mo';
import { voiceRunDiagnosticsSchema } from './voice';
export const uuidSchema = z.string().uuid();
export const dueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }).strict(),
  z.object({ kind: z.literal('date'), date: dateSchema, timezone: timezoneSchema }).strict(),
  z.object({ kind: z.literal('instant'), at: z.string().datetime(), timezone: timezoneSchema }).strict(),
]);
export const taskDraftSchema = z.object({ title: z.string().trim().min(1).max(240), due: dueSchema }).strict();
export type TaskDraft = z.infer<typeof taskDraftSchema>;
export const taskSchema = taskDraftSchema.extend({ accountId:accountIdSchema.nullable().optional(), id: uuidSchema, status: z.enum(['open', 'done']), revision: z.number().int().nonnegative(), createdAt: z.string().datetime(), remindedAt: z.string().datetime().nullable() }).strict();
export type LocalTask = z.infer<typeof taskSchema>;
export const taskReceiptSchema=z.object({id:uuidSchema,existed:z.boolean(),task:taskSchema.nullable()}).strict();
export type TaskReceipt=z.infer<typeof taskReceiptSchema>;
export const taskCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), id: uuidSchema, draft: taskDraftSchema, accountId:accountIdSchema.nullable().optional() }).strict(),
  z.object({ action: z.literal('update'), id: uuidSchema, expectedRevision: z.number().int().nonnegative(), draft: taskDraftSchema, status: z.enum(['open', 'done']) }).strict(),
  z.object({ action: z.literal('delete'), id: uuidSchema, expectedRevision: z.number().int().nonnegative() }).strict(),
  z.object({ action: z.literal('dismiss'), id: uuidSchema, expectedRevision: z.number().int().nonnegative() }).strict(),
]);
export type TaskCommand = z.infer<typeof taskCommandSchema>;
export const sourceSchema = z.object({ ref: resourceRefSchema.optional(), delivery: contextDeliverySchema.optional(), id: z.string().regex(/^[METWS]\d{1,2}$/), kind: z.enum(['mail', 'calendar', 'task', 'workflow', 'weather']), accountId: accountIdSchema, resourceId: z.string().max(1024), label: z.string().max(240), detail: z.string().max(6000), fetchedAt: z.string().datetime(), cached: z.boolean() }).strict();
export type AssistantSource = z.infer<typeof sourceSchema>;
export const answerSchema = z.object({
  clarification: z.string().trim().min(1).max(500).optional(),
  answer: z.string().trim().min(1).max(12000),
  citations: z.array(z.string().regex(/^[METWS]\d{1,2}$/)).max(20),
  suggestions: z.array(z.object({ title: z.string().trim().min(1).max(240), sourceIds: z.array(z.string().regex(/^[METWS]\d{1,2}$/)).max(5) }).strict()).max(5),
  reply: z.object({ sourceId: z.string().regex(/^M\d{1,2}$/), body: z.string().trim().min(1).max(5000) }).strict().optional(),
  responsibility: z.object({ sourceId: z.string().regex(/^T\d{1,2}$/), objective: z.string().trim().min(1).max(500) }).strict().optional(),
  openSituation: z.enum(['weather', 'traffic']).optional(),
}).strict();
export type AssistantAnswer = z.infer<typeof answerSchema>;
export const runRequestSchema = z.object({
  workId:uuidSchema.optional(), id: uuidSchema, conversationId: uuidSchema, mode: z.enum(['chat', 'briefing', 'lede', 'classify', 'openai-test']),
  prompt: z.string().trim().min(1).max(2000), accountId: accountIdSchema.nullable(), includeGoogle: z.boolean(), messageId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(),
  includeLocal: z.boolean().optional(), includeWeather: z.boolean().optional(),
}).strict().refine(v => (v.mode!=='openai-test'||(!v.includeGoogle&&v.accountId===null&&!v.messageId&&v.prompt==='Test OpenAI access with one fixed, non-private request.')) && (!v.includeGoogle || v.accountId !== null) && (!['briefing','lede'].includes(v.mode) || v.includeGoogle) && (!['lede','classify'].includes(v.mode) || !v.includeGoogle || !!v.messageId));
export type RunRequest = z.infer<typeof runRequestSchema>;
export const usageSchema = z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative(), cacheHit:z.number().int().nonnegative().optional(),cacheMiss:z.number().int().nonnegative().optional(),cacheWrite:z.number().int().nonnegative().optional(),reasoning:z.number().int().nonnegative().optional() }).strict();
export type Usage = z.infer<typeof usageSchema>;
export const runSchema = z.object({
  voiceDiagnostics: voiceRunDiagnosticsSchema.optional(),
  executiveRunId: uuidSchema.optional(),
  channel: moChannelSchema.optional(), includeLocal: z.boolean().optional(), includeWeather: z.boolean().optional(),
  calls: z.array(z.object({ id: uuidSchema, at: z.string().datetime(), dispatched: z.boolean(), usage: usageSchema.nullable(), reportedModel: z.string().max(100).nullable(), status: z.enum(['reserved','complete','unknown']),resultReceivedAt:z.string().datetime().optional(),receivedAfterCancellation:z.boolean().optional() }).strict()).max(6).optional(),
  contextSelection: contextDiagnosticsSchema.optional(),
  dispatchedAt:z.string().datetime().optional(),maxRunSeconds:z.number().int().positive().optional(),profile:z.string().optional(),accountingPurpose:z.enum(['ordinary','development']).optional(),
  id: uuidSchema, conversationId: uuidSchema, fingerprint: z.string().max(64), mode: z.enum(['chat','briefing','lede','classify','openai-test']),
  credentialRevision:z.string().regex(/^[a-f0-9]{64}$/).optional(),
  provider: z.enum(['deepseek', 'jev', 'openai']), requestedModel: z.string().max(100), reportedModel: z.string().max(100).nullable(),
  prompt: z.string().max(2000), accountId: accountIdSchema.nullable(), includeGoogle: z.boolean(),
  createdAt: z.string().datetime(), finishedAt: z.string().datetime().nullable(),
  status: z.enum(['running', 'succeeded', 'failed', 'cancelled', 'interrupted']), stage: z.string().max(100), error: z.string().max(240).nullable(),
  result: answerSchema.nullable(), sources: z.array(sourceSchema).max(20), warnings: z.array(z.string().max(240)).max(8),
  usage: usageSchema.nullable(), inputBytes: z.number().int().nonnegative(), maxOutputTokens: z.number().int().nonnegative(),
  classification: z.object({ urgentProbability: z.number().min(0).max(1) }).strict().nullable(),
}).strict();
export type AssistantRun = z.infer<typeof runSchema>;
export const workspaceSchema = z.object({ runs: z.array(runSchema).max(100), tasks: z.array(taskSchema).max(500), callsToday: z.object({ deepseek: z.number().int().nonnegative(), jev: z.number().int().nonnegative(), openai:z.number().int().nonnegative().optional() }).strict() }).strict();
export type AssistantWorkspace = z.infer<typeof workspaceSchema>;
export const emptyWorkspace: AssistantWorkspace = { runs: [], tasks: [], callsToday: { deepseek: 0, jev: 0 } };
export function taskDue(task: LocalTask, now: Date) {
  if (task.status !== 'open' || task.remindedAt || task.due.kind === 'none') return false;
  if (task.due.kind === 'instant') return Date.parse(task.due.at) <= +now;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: task.due.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return ['year','month','day'].map(k => parts.find(p => p.type === k)!.value).join('-') >= task.due.date;
}
