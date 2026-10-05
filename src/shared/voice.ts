import { z } from 'zod';
import { accountIdSchema } from './google';

export const voiceConfigSchema=z.object({enabled:z.boolean(),accountId:accountIdSchema.nullable(),includeGoogle:z.boolean(),includeLocal:z.boolean(),includeWeather:z.boolean(),retainHistory:z.boolean(),allowLocalTaskCreate:z.boolean().optional(),allowCalendarCreate:z.boolean().optional()}).strict().refine(v=>(!v.includeGoogle||v.accountId!==null)&&(!v.allowLocalTaskCreate||v.includeLocal&&v.accountId!==null)&&(!v.allowCalendarCreate||v.includeGoogle&&v.accountId!==null));
export type VoiceConfig=z.infer<typeof voiceConfigSchema>;
export const defaultVoiceConfig:VoiceConfig={enabled:false,accountId:null,includeGoogle:false,includeLocal:false,includeWeather:false,retainHistory:false};
export const voiceSessionSchema=z.object({id:z.string().uuid(),conversationId:z.string().uuid(),callSid:z.string().regex(/^CA[a-fA-F0-9]{32}$/),ownerId:z.string().uuid(),startedAt:z.string().datetime(),expiresAt:z.string().datetime(),scope:z.literal('read-prepare'),authentication:z.literal('caller-and-pin')}).strict();
export type VoiceSession=z.infer<typeof voiceSessionSchema>;
export const voiceCancelReasonSchema=z.enum(['interrupted','superseded','disconnected','expired','disabled','authority-changed']);
export type VoiceCancelReason=z.infer<typeof voiceCancelReasonSchema>;
const timestamp=z.number().int().nonnegative();
export const voiceTurnTimingSchema=z.object({id:z.string().uuid(),generation:z.number().int(),finalAt:timestamp,forwardedAt:timestamp.optional(),desktopReceivedAt:timestamp.optional(),executiveStartedAt:timestamp.optional(),executiveCompletedAt:timestamp.optional(),responseReturnedAt:timestamp.optional(),responseReceivedAt:timestamp.optional(),submittedAt:timestamp.optional(),progressSubmittedAt:timestamp.optional(),cancelledAt:timestamp.optional(),cancelReason:voiceCancelReasonSchema.optional(),lateResultsRejected:z.number().int().nonnegative().optional()}).strict();
export const voiceDiagnosticsSchema=z.object({inboundAt:timestamp,pinAuthenticatedAt:timestamp.optional(),socketConnectedAt:timestamp.optional(),endedAt:timestamp.optional(),turns:z.array(voiceTurnTimingSchema).max(20),interruptions:z.array(z.object({at:timestamp,durationMs:z.number().nonnegative().optional()}).strict()).max(40),audibleStart:z.literal('not-observable')}).strict();
export const voiceFailureCategorySchema=z.enum(['provider-model','output-schema','native-tool','permission-source-denied','source-unavailable','source-stale','cancelled','superseded','session-gateway','session-limit','confirmation-expired','action-execution-failed','unknown']);
export type VoiceFailureCategory=z.infer<typeof voiceFailureCategorySchema>;
export const mailSearchOutcomeSchema=z.enum(['matched','no-matches','sender-candidates','partial']);
export type MailSearchOutcome=z.infer<typeof mailSearchOutcomeSchema>;
export const voiceActionProvenanceSchema=z.object({channel:z.literal('voice'),sessionId:z.string().uuid(),callSid:z.string().regex(/^CA[a-fA-F0-9]{32}$/),ownerId:z.string().uuid(),accountId:accountIdSchema,profile:z.literal('local'),capability:z.literal('task.create'),nonce:z.string().uuid(),generation:z.number().int().positive(),authorityRevision:z.number().int().nonnegative(),settingsRevision:z.number().int().nonnegative(),confirmedAt:z.string().datetime(),expiresAt:z.string().datetime(),status:z.enum(['confirmed','created']),taskId:z.string().uuid()}).strict();
export const voiceCalendarProvenanceSchema=z.object({channel:z.literal('voice'),sessionId:z.string().uuid(),callSid:z.string().regex(/^CA[a-fA-F0-9]{32}$/),ownerId:z.string().uuid(),capability:z.literal('calendar.create'),nonce:z.string().uuid(),generation:z.number().int().positive(),authorityRevision:z.number().int().nonnegative(),settingsRevision:z.number().int().nonnegative(),confirmedAt:z.string().datetime(),expiresAt:z.string().datetime()}).strict();
export const voiceRunDiagnosticsSchema=z.object({startedAt:timestamp,completedAt:timestamp.optional(),cancelledAt:timestamp.optional(),cancelReason:voiceCancelReasonSchema.optional(),resultDisposition:z.enum(['current','superseded','disconnected','cancelled','failed']).optional(),failureCategory:voiceFailureCategorySchema.optional(),mailSearch:mailSearchOutcomeSchema.optional(),capabilities:z.array(z.string().max(60)).max(16).optional(),selectedSourceIds:z.array(z.string().max(1024)).max(8).optional(),calendarRouting:z.object({available:z.boolean(),explicitIntent:z.boolean(),continuation:z.boolean(),toolOffered:z.boolean(),toolCalled:z.boolean()}).strict().optional(),calendarAction:z.object({id:z.string().uuid(),status:z.enum(['awaiting-confirmation','succeeded','failed','unknown'])}).strict().optional(),localAction:z.object({id:z.string().uuid(),status:z.enum(['awaiting-confirmation','created','cancelled']),taskId:z.string().uuid().optional()}).strict().optional()}).strict();
export const gatewayVoiceStatusSchema=z.object({configured:z.boolean(),ownerConfigured:z.boolean(),pinConfigured:z.boolean(),desktopOnline:z.boolean(),activeCalls:z.number().int().min(0).max(1),scope:z.literal('read-prepare'),recording:z.literal(false),observedAt:timestamp.optional(),desktopLastSeenAt:timestamp.nullable().optional()}).strict();
export function latestGatewayVoice(a:z.infer<typeof gatewayVoiceStatusSchema>|null|undefined,b:z.infer<typeof gatewayVoiceStatusSchema>|null|undefined){return !a?b??null:!b?a:(b.observedAt??0)>(a.observedAt??0)?b:a;}
export const voiceStatusSchema=z.object({gateway:gatewayVoiceStatusSchema.nullable(),channel:z.enum(['disabled','offline','connecting','online']),call:z.enum(['none','connected','processing','waiting']),sessionId:z.string().uuid().nullable(),lastSeenAt:timestamp.optional(),diagnostics:voiceDiagnosticsSchema.optional()}).strict();
export type VoiceStatus=z.infer<typeof voiceStatusSchema>;
export const voiceFrameSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('hello'),version:z.literal(1),deviceId:z.string().uuid(),accountSid:z.string(),number:z.string(),voice:gatewayVoiceStatusSchema}).strict(),
 z.object({type:z.literal('heartbeat')}).strict(),
 z.object({type:z.literal('status'),voice:gatewayVoiceStatusSchema}).strict(),
 z.object({type:z.literal('diagnostics'),sessionId:z.string().uuid(),diagnostics:voiceDiagnosticsSchema}).strict(),
 z.object({type:z.literal('session'),session:voiceSessionSchema}).strict(),
 z.object({type:z.literal('turn'),sessionId:z.string().uuid(),turnId:z.string().uuid(),generation:z.number().int().min(1).max(100),text:z.string().trim().min(1).max(2000)}).strict(),
 z.object({type:z.literal('cancel'),sessionId:z.string().uuid(),turnId:z.string().uuid(),reason:voiceCancelReasonSchema.optional()}).strict(),
 z.object({type:z.literal('ended'),sessionId:z.string().uuid(),endedAt:z.string().datetime()}).strict(),
 z.object({type:z.literal('state'),sessionId:z.string().uuid(),state:z.literal('waiting')}).strict(),
]);
