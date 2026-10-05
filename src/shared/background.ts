import { z } from 'zod';
import { resourceRefSchema } from './modules';
import { contextDeliverySchema } from './context';
const digest=z.string().regex(/^[a-f0-9]{64}$/),at=z.string().datetime();
export const backgroundSettingsSchema=z.object({enabled:z.boolean(),cadenceMinutes:z.union([z.literal(30),z.literal(60),z.literal(180),z.literal(360)]),startupResume:z.boolean()}).strict();
export const backgroundDefaults={enabled:false,cadenceMinutes:60 as const,startupResume:false};
export const backgroundTriggerSchema=z.enum(['manual','schedule','startup','resume','source-refresh','revision']);
export type BackgroundTrigger=z.infer<typeof backgroundTriggerSchema>;
export const insightSchema=z.object({
 version:z.literal(1),id:z.string().uuid(),runId:z.string().uuid(),workItemId:z.string().uuid(),accountId:z.string(),profile:z.literal('local'),
 category:z.enum(['source-change','inbox','attention','conflict','missing-information','classification','context','weather-change','commute-delay','traffic-incident','flight-change','situation-source-unavailable']),
 title:z.string().max(240),summary:z.string().max(1000),sources:z.array(resourceRefSchema).min(1).max(20),
 sourceRevisions:z.array(z.object({key:digest,revision:z.string().max(128)}).strict()).max(20),
 provenance:z.object({trigger:backgroundTriggerSchema,authorityRevision:digest,method:z.enum(['deterministic','advisory']),reason:z.string().max(240)}).strict(),
 observedAt:at,lastCheckedAt:at.optional(),expiresAt:at.nullable(),priority:z.enum(['high','normal','unknown']),significance:z.enum(['attention','informational']),
 advisory:z.array(z.object({id:z.string().max(80),selected:z.string().max(80),confidence:z.number().min(0).max(1).nullable(),probabilities:z.record(z.string(),z.number().min(0).max(1))}).strict()).max(3),
 unresolvedQuestions:z.array(z.string().max(240)).max(6),suggestedNextStep:z.string().max(240).nullable(),ownerAttention:z.boolean(),
 actionProposal:z.object({id:z.string().uuid(),hash:digest,scope:z.literal('owner-approval'),expiresAt:at,runId:z.string().uuid(),workItemId:z.string().uuid()}).strict().nullable(),
 status:z.enum(['active','dismissed','superseded','stale','resolved']),identity:digest,revisionIdentity:digest,supersedes:z.string().uuid().nullable(),
 transitions:z.array(z.object({at,status:z.enum(['active','dismissed','superseded','stale','resolved']),reason:z.string().max(240)}).strict()).max(100),
}).strict();
export type BackgroundInsight=z.infer<typeof insightSchema>;
export const backgroundRunSchema=z.object({version:z.literal(1),trigger:backgroundTriggerSchema,authorityRevision:digest,sourceRevision:digest,reason:z.string().max(240),
 snapshotId:z.string().uuid(),snapshotRevision:digest,sourceGrants:z.array(resourceRefSchema).max(46),
 settings:backgroundSettingsSchema,providerLimit:z.number().int().min(0).max(2),itemsInspected:z.number().int().min(0).max(46),
 deterministicOperations:z.number().int().nonnegative(),categories:z.array(z.string().max(60)).max(7),insightIds:z.array(z.string().uuid()).max(60),
 preparedContext:z.array(contextDeliverySchema).max(20),coverage:z.array(z.string().max(240)).max(10),
}).strict();
export type BackgroundRun=z.infer<typeof backgroundRunSchema>;
export const backgroundViewSchema=z.object({insights:z.array(insightSchema).max(200),activeCount:z.number().int().nonnegative(),lastRunId:z.string().uuid().nullable()}).strict();
export function activeInsights(insights:BackgroundInsight[],accountId:string|null,now=Date.now()){
 return insights.filter(i=>i.accountId===accountId&&i.status==='active'&&(i.expiresAt===null||Date.parse(i.expiresAt)>now)&&i.ownerAttention);
}
