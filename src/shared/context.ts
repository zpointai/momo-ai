import { z } from 'zod';
import { resourceRefSchema } from './modules';

export const contextModeSchema = z.enum(['EXCLUDE', 'REFERENCE_ONLY', 'SUMMARY', 'FULL']);
export type ContextMode = z.infer<typeof contextModeSchema>;
export const contextWorkflowSchema = z.enum(['briefing', 'grounded-reply', 'assistant']);
export type ContextWorkflow = z.infer<typeof contextWorkflowSchema>;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative();
export const contextSizeSchema = z.object({ characters: count, bytes: count, estimatedTokens: count }).strict();
export type ContextSize = z.infer<typeof contextSizeSchema>;
export const contextBudgetSchema = z.object({
  maxBytes: z.number().int().min(256).max(10000),
  maxEstimatedTokens: z.number().int().min(64).max(4000),
  maxChunks: z.number().int().min(1).max(20),
  summaryCharacters: z.number().int().min(80).max(1200),
}).strict();
export type ContextBudget = z.infer<typeof contextBudgetSchema>;
export const contextBudgetsSchema = z.object({
  briefing: contextBudgetSchema, 'grounded-reply': contextBudgetSchema, assistant: contextBudgetSchema,
}).strict();
export type ContextBudgets = z.infer<typeof contextBudgetsSchema>;
export const defaultContextBudgets: ContextBudgets = {
  briefing: { maxBytes: 10000, maxEstimatedTokens: 2500, maxChunks: 20, summaryCharacters: 600 },
  'grounded-reply': { maxBytes: 10000, maxEstimatedTokens: 2500, maxChunks: 12, summaryCharacters: 600 },
  assistant: { maxBytes: 9000, maxEstimatedTokens: 2250, maxChunks: 20, summaryCharacters: 480 },
};
export const contextCoverageSchema = z.object({
  status: z.enum(['complete', 'partial', 'unavailable']),
  suppliedCharacters: count, omittedCharacters: count,
  sourcePartial: z.boolean(), method: z.enum(['source', 'extractive', 'reference']),
}).strict();
export type ContextCoverage = z.infer<typeof contextCoverageSchema>;
/** ResourceRef is the sole source identity, scope, revision and provenance record. */
export const contextChunkSchema = z.object({
  id: digest, ref: resourceRefSchema,
  category: z.enum(['email-thread', 'email-snippet', 'calendar-event', 'task', 'assessment', 'workflow-proposal', 'briefing-snapshot', 'conversation', 'situation-fact']),
  observedAt: z.string().datetime(), freshness: z.enum(['current', 'retained', 'stale', 'unavailable']),
  sensitivity: z.enum(['public', 'private', 'restricted']), sharing: z.enum(['local-only', 'workflow-permitted']),
  size: contextSizeSchema, descriptor: z.string().max(240),
  retrieval: z.object({ milliseconds: z.number().nonnegative().nullable(), costUSD: z.string().regex(/^\d+(\.\d+)?$/).nullable() }).strict(),
  reuse: z.object({ state: z.enum(['loaded', 'reused']), cacheKey: digest.nullable(), providerCache: z.literal('unknown') }).strict(),
}).strict();
export type ContextChunk = z.infer<typeof contextChunkSchema>;
export const contextDeliverySchema = z.object({
  contextId: digest, mode: z.enum(['REFERENCE_ONLY', 'SUMMARY', 'FULL']),
  coverage: contextCoverageSchema, ref: resourceRefSchema,
}).strict();
/** No labels, bodies, account IDs, prompts, or free-form advisory prose in diagnostics. */
export const contextDiagnosticsSchema = z.object({
  version: z.literal(1), workItemId: z.string().uuid(), workflow: contextWorkflowSchema,
  at: z.string().datetime(), budget: contextBudgetSchema,
  candidateSize: contextSizeSchema, selectedSize: contextSizeSchema,
  counts: z.object({ EXCLUDE: count, REFERENCE_ONLY: count, SUMMARY: count, FULL: count }).strict(),
  reused: count, loaded: count, blocked: z.boolean(),
  candidates: z.array(z.object({
    id: digest, category: contextChunkSchema.shape.category, revision: z.string().max(128),
    observedAt: z.string().datetime(), freshness: contextChunkSchema.shape.freshness,
    mode: contextModeSchema, reason: z.string().regex(/^[A-Z_]+$/).max(80),
    advisory: z.enum(['relevant', 'irrelevant', 'uncertain']).nullable(),
    size: contextSizeSchema, deliveredSize: contextSizeSchema,
    reuse: z.enum(['loaded', 'reused']),
  }).strict()).max(100),
}).strict();
export type ContextDiagnostics = z.infer<typeof contextDiagnosticsSchema>;

/** Descriptors are discovery hints, never tool registrations or execution grants. */
export interface ContextToolDescriptor {
  id: string;
  description: string;
  capability: string;
  schemaKey: string;
}
export interface ContextToolSchemaLoader {
  load(schemaKey: string, allowedTools: readonly string[]): Promise<unknown>;
}
