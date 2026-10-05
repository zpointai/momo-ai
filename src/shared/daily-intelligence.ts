import { sourceStateSchema } from './situation';
import { z } from 'zod';
import { accountIdSchema, dateSchema, timezoneSchema } from './google';
import { resourceRefSchema } from './modules';

const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const coverageSchema=z.object({source:z.enum(['calendar','tasks','attention','approvals']),status:z.enum(['available','partial','unavailable','disabled']),detail:z.string().max(500),fetchedAt:z.string().datetime().nullable(),included:z.number().int().nonnegative(),total:z.number().int().nonnegative().nullable()}).strict();
export const briefingEntrySchema=z.object({
 id:z.string().max(100),kind:z.enum(['calendar','task','attention','approval','workflow','situation']),section:z.enum(['today','tasks','attention','prepare','ahead']),
 ref:resourceRefSchema,title:z.string().max(240),detail:z.string().max(2400),
 freshness:z.enum(['current','retained']),sensitivity:z.literal('private'),sharing:z.enum(['local-only','workflow-permitted']),estimatedTokens:z.number().int().nonnegative(),
}).strict();
export const briefingSnapshotSchema=z.object({version:z.literal(1),id:z.string().uuid(),revision:digest,authorityRevision:digest,accountId:accountIdSchema.nullable(),profile:z.literal('local'),createdAt:z.string().datetime(),date:dateSchema,endDate:dateSchema,timezone:timezoneSchema,trigger:z.enum(['view','manual','schedule']),
 entries:z.array(briefingEntrySchema).max(46),coverage:z.array(coverageSchema).length(4),
 connectors:z.object({weather:sourceStateSchema,traffic:sourceStateSchema}).strict(),
}).strict();
export type BriefingSnapshot=z.infer<typeof briefingSnapshotSchema>;
export type BriefingEntry=z.infer<typeof briefingEntrySchema>;
export const briefingSynthesisSchema=z.object({snapshotId:z.string().uuid(),snapshotRevision:digest,runId:z.string().uuid().nullable(),updatedAt:z.string().datetime(),status:z.enum(['not-requested','blocked','running','complete','held','failed','stale']),reason:z.string().max(240),text:z.string().max(10000).nullable()}).strict();
export type BriefingSynthesis=z.infer<typeof briefingSynthesisSchema>;
export const dailyIntelligenceSchema=z.object({snapshot:briefingSnapshotSchema,synthesis:briefingSynthesisSchema,scheduleReceipt:z.object({policyId:z.string().uuid(),date:dateSchema}).strict().optional()}).strict().refine(value=>value.synthesis.snapshotId===value.snapshot.id&&value.synthesis.snapshotRevision===value.snapshot.revision,'Synthesis must bind to the exact snapshot.');
export type DailyIntelligence=z.infer<typeof dailyIntelligenceSchema>;
/** Retained older snapshots may contain operational activity; it belongs in Work. */
export function briefingContentEntries(entries:BriefingEntry[]){return entries.filter(e=>!['workflow','approval'].includes(e.kind)&&e.ref.type!=='briefing');}
