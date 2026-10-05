import {proactiveTriggerSchema} from './proactive';
import {voiceActionProvenanceSchema} from './voice';
import { workControlSchema } from './work-control';
import { desktopResponsibilitySchema, executiveBindingSchema } from './mo';
import { responsibilitySchema } from './relay';
import { coordinatedSchedulingSchema,inboxSchedulingSchema, schedulingRequestSchema } from './scheduling';
import { backgroundRunSchema,backgroundViewSchema } from './background';
import { costsSchema,aiLimitsSchema,budgetBoundarySchema } from './usage';
import { agentTeamSchema } from './agent-team';
import { eventDraftSchema } from './calendar-actions';
import { contextDeliverySchema, contextDiagnosticsSchema } from './context';
import { briefingEligibilitySchema } from './briefing';
import { dailyIntelligenceSchema } from './daily-intelligence';
import { z } from 'zod';
import { accountIdSchema, timezoneSchema } from './google';
import { taskDraftSchema, usageSchema, uuidSchema } from './assistant';
export const hashSchema=z.string().regex(/^[a-f0-9]{64}$/);
export const familySchema=z.enum(['email','briefing','chat','task']);
export const routeSchema=z.enum(['NO_LLM','SUMMARIZE','EXTRACT_ACTIONS','DRAFT_REPLY','CALENDAR_REASONING','DOCUMENT_ANALYSIS','MULTI_STEP_REASONING','USER_DIALOGUE','NEEDS_REVIEW']);
export type Route=z.infer<typeof routeSchema>;
export type Family=z.infer<typeof familySchema>;
export const probability=z.number().finite().min(0).max(1);
export const jevAnswerSchema=z.discriminatedUnion('type',[
  z.object({type:z.literal('noul'),noul:probability}).strict(),
  z.object({type:z.literal('choice'),choice:z.string().max(80),confidence:probability,probabilities:z.record(z.string(),probability)}).strict(),
  z.object({type:z.literal('score'),score:z.number().finite().min(0).max(9),confidence:probability,probabilities:z.record(z.string(),probability),legend:z.record(z.string(),z.string().max(500))}).strict(),
]);
export type JevAnswer=z.infer<typeof jevAnswerSchema>;
export type JevQuestion={type:'noul';instructions:string;criteria:{true:string;false:string}}|{type:'choice';instructions:string;criteria:Record<string,string>}|{type:'score';instructions:string;criteria:string[]};
export const agentConfigSchema=z.object({enabled:z.boolean(),paused:z.boolean(),shareGoogle:z.boolean(),shareTasks:z.boolean(),shadow:z.boolean(),allowDeepSeekFallback:z.boolean(),
  deepseekModel:z.enum(['deepseek-flash','deepseek-v4-pro']),jevModel:z.string().regex(/^jev-[a-zA-Z0-9.-]{1,60}$/),dailyCalls:z.number().int().min(1).max(100000),maxCallsPerRun:z.number().int().min(1).max(24),maxOutputTokens:z.number().int().min(256).max(65536),maxRunSeconds:z.number().int().min(15).max(600),autoAdapt:z.literal(false),externalAutomation:z.literal(false)}).strict();
export const agentDefaults:z.infer<typeof agentConfigSchema>={enabled:false,paused:false,shareGoogle:false,shareTasks:false,shadow:false,allowDeepSeekFallback:false,deepseekModel:'deepseek-flash',jevModel:'jev-latest',dailyCalls:10,maxCallsPerRun:4,maxOutputTokens:2048,maxRunSeconds:90,autoAdapt:false,externalAutomation:false};
export const workflowPolicySchema=z.object({id:uuidSchema,accountId:accountIdSchema.nullable(),family:familySchema,level:z.enum(['L0','L1','L2','L3','L4']),enabled:z.boolean(),version:z.number().int().positive(),maxLocalPerDay:z.number().int().min(1).max(3),schedule:z.object({enabled:z.boolean(),hour:z.number().int().min(0).max(23),minute:z.number().int().min(0).max(59),timezone:timezoneSchema}).strict(),updatedAt:z.string().datetime()}).strict();
export type WorkflowPolicy=z.infer<typeof workflowPolicySchema>;
export const contextItemSchema=z.object({delivery:contextDeliverySchema.optional(),id:z.string().regex(/^[METWSR]\d{1,2}$/),kind:z.enum(['email','calendar','task','workflow','situation','communication']),accountId:accountIdSchema,resourceId:z.string().max(1024),revision:hashSchema,title:z.string().max(240),text:z.string().max(12000),fetchedAt:z.string().datetime(),trust:z.literal('untrusted-source'),senderScope:hashSchema.nullable(),threadId:z.string().max(128).nullable()}).strict();
export const contextSchema=z.object({schedulingInterpretation:inboxSchedulingSchema.optional(),id:uuidSchema,hash:hashSchema,createdAt:z.string().datetime(),timezone:timezoneSchema,items:z.array(contextItemSchema).max(20),limitations:z.array(z.string().max(240)).max(10),available:z.object({calendar:z.boolean(),tasks:z.boolean(),thread:z.boolean()}).strict(),sharing:z.object({google:z.boolean(),tasks:z.boolean()}).strict()}).strict();
export type AgentContext=z.infer<typeof contextSchema>;
export const intakeSchema=z.object({scheduling:schedulingRequestSchema.optional(),id:uuidSchema,family:familySchema,accountId:accountIdSchema.nullable(),resourceId:z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).optional(),replyTo:z.object({runId:uuidSchema,sourceRevision:hashSchema,threadId:z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),threadRevision:hashSchema}).strict().optional(),prompt:z.string().trim().max(2000),trigger:z.enum(['manual','schedule','source']).default('manual'),causationId:uuidSchema.nullable().default(null),depth:z.number().int().min(0).max(2).default(0),origin:z.enum(['user','connector','momo']).default('user')}).strict();
export type AgentIntake=z.infer<typeof intakeSchema>;
export const processingResultSchema=z.object({text:z.string().min(1).max(10000),draft:z.string().max(6000).nullable(),evidence:z.array(z.string().regex(/^[METWR]\d{1,2}$/)).max(20),clarification:z.string().min(1).max(2000).nullable().optional(),reminders:z.array(z.object({title:z.string().min(1).max(240),sourceId:z.string().regex(/^[METWR]\d{1,2}$/)}).strict()).max(3),
 calendarProposal:z.object({draft:eventDraftSchema,evidence:z.array(z.string().regex(/^[METWR]\d{1,2}$/)).min(1).max(20)}).strict().nullable().optional(),
 commitments:z.array(z.object({text:z.string().min(1).max(240),sourceId:z.string().regex(/^[METWR]\d{1,2}$/),quote:z.string().min(1).max(1000)}).strict()).max(8).optional(),
}).strict();
export type ProcessingResult=z.infer<typeof processingResultSchema>;
export const findingSchema=z.object({code:z.string().max(80),severity:z.enum(['info','review','error'])}).strict();
export const decisionSchema=z.object({answers:z.record(z.string(),jevAnswerSchema),questionSet:z.string().max(50),questionHash:hashSchema,routingVersion:z.literal('routing-v1'),thresholds:z.object({sufficiency:probability,routeConfidence:probability}).strict(),requestedModel:z.string().max(80),reportedModel:z.string().max(100).nullable(),route:routeSchema,reasons:z.array(z.string().max(80)).max(12),priority:z.enum(['high','normal','unknown']),preferenceVersion:uuidSchema.nullable(),degraded:z.boolean()}).strict();
export type AgentDecision=z.infer<typeof decisionSchema>;
export const localProposalSchema=z.object({id:uuidSchema,taskId:uuidSchema,hash:hashSchema,accountId:accountIdSchema,draft:taskDraftSchema,sourceId:z.string().max(20),sourceRevision:hashSchema,expiresAt:z.string().datetime(),policyVersion:z.number().int(),status:z.enum(['pending','applied','denied','expired']),authorization:z.enum(['none','explicit','L2'])}).strict();
export type LocalProposal=z.infer<typeof localProposalSchema>;
const executiveOriginSchema=z.object({context:contextSchema,team:agentTeamSchema.optional(),policy:workflowPolicySchema,config:agentConfigSchema,profileRevision:z.number().int(),status:z.string(),checkpoint:z.string(),finishedAt:z.string().datetime().nullable(),result:processingResultSchema.nullable(),decision:decisionSchema.nullable()}).strict();
export const agentRunSchema=z.object({voiceAction:voiceActionProvenanceSchema.optional(),workControl:workControlSchema.optional(),executiveOrigin:executiveOriginSchema.optional(),executiveHistory:z.array(z.object({assistantRunId:uuidSchema,context:contextSchema,team:agentTeamSchema.optional(),finishedAt:z.string().datetime().nullable()}).strict()).max(12).optional(),executive:executiveBindingSchema.optional(),desktopResponsibility:desktopResponsibilitySchema.optional(),responsibility:responsibilitySchema.optional(),scheduling:coordinatedSchedulingSchema.optional(),background:backgroundRunSchema.optional(),team:agentTeamSchema.optional(),calendarProposalId:uuidSchema.optional(),contextSelection:contextDiagnosticsSchema.optional(),briefingBinding:z.object({snapshotId:z.string().uuid(),revision:hashSchema}).strict().optional(),id:uuidSchema,assessment:z.object({status:z.enum(['active','dismissed','resolved']),priority:z.enum(['high','normal','unknown'])}).strict().optional(),localDraftId:uuidSchema.optional(),limits:aiLimitsSchema.optional(),accountingPurpose:z.enum(['ordinary','development']).optional(),definition:z.literal('workflow-v1'),event:intakeSchema,dedup:hashSchema,context:contextSchema,policy:workflowPolicySchema,config:agentConfigSchema,profileRevision:z.number().int(),createdAt:z.string().datetime(),finishedAt:z.string().datetime().nullable(),status:z.enum(['queued','running','complete','review','partial','failed','cancelled','interrupted','budget_exhausted']),checkpoint:z.string().max(100),steps:z.array(z.object({at:z.string().datetime(),checkpoint:z.string().max(100),status:z.string().max(30)}).strict()).max(32).default([]),quality:z.object({answers:z.record(z.string(),jevAnswerSchema),questionSet:z.enum(['quality-v1','quality-v2','atomic-review-v1']),questionHash:hashSchema,requestedModel:z.string().max(80),reportedModel:z.string().max(100).nullable()}).strict().nullable().default(null),processingProfile:z.object({template:z.string().max(80),thinking:z.enum(['none','low','high'])}).strict().optional(),attempt:z.number().int().min(0).max(1),decision:decisionSchema.nullable(),result:processingResultSchema.nullable(),findings:z.array(findingSchema).max(20),proposals:z.array(localProposalSchema).max(3),calls:z.array(z.object({id:uuidSchema,provider:z.enum(['jev','deepseek']),purpose:z.string().max(30),requestedModel:z.string().max(80),reportedModel:z.string().max(100).nullable(),status:z.enum(['reserved','complete','unknown']),usage:usageSchema.nullable(),elapsedMs:z.number().nonnegative()}).strict()).max(24),error:z.string().max(240).nullable(),shadow:z.object({candidateId:uuidSchema,baseline:z.string().max(20),candidate:z.string().max(20)}).strict().nullable()}).strict();
export type AgentRun=z.infer<typeof agentRunSchema>;
export const feedbackSchema=z.object({id:uuidSchema,runId:uuidSchema,sourceId:z.string().max(20),accountId:accountIdSchema,scope:hashSchema,resourceId:z.string().max(1024),threadId:z.string().max(128),createdAt:z.string().datetime(),kind:z.enum(['priority','route','edited_draft','dismissed','resolved','preference','failed','undo']),strength:z.enum(['explicit','implicit','machine']),value:z.string().max(2000),baseline:z.enum(['high','normal','unknown']),sourceRevision:hashSchema,valid:z.boolean()}).strict();
export type AgentFeedback=z.infer<typeof feedbackSchema>;
export const evaluationSchema=z.object({datasetVersion:z.literal('replay-v1'),at:z.string().datetime(),kind:z.literal('offline-corrections-and-synthetic'),tuningIds:z.array(uuidSchema),heldOutIds:z.array(uuidSchema),syntheticCount:z.number().int(),baselineCorrect:z.number().int(),candidateCorrect:z.number().int(),urgentMisses:z.number().int(),falseAlerts:z.number().int(),policyViolations:z.number().int(),latencyMs:z.number().nonnegative(),measuredProviderCalls:z.literal(0),passed:z.boolean(),reason:z.string().max(200)}).strict();
export const candidateSchema=z.object({id:uuidSchema,accountId:accountIdSchema,scope:hashSchema,target:z.enum(['high','normal']),createdAt:z.string().datetime(),status:z.enum(['candidate','insufficient','evaluated','rejected','active','rolled_back','invalidated']),evidenceIds:z.array(uuidSchema).max(100),evaluation:evaluationSchema.nullable(),previousVersion:uuidSchema.nullable(),activatedAt:z.string().datetime().nullable(),activation:z.enum(['none','explicit']),diff:z.string().max(240)}).strict();
export type AgentCandidate=z.infer<typeof candidateSchema>;
export const grantSchema=z.object({id:uuidSchema,version:z.number().int().positive(),accountId:accountIdSchema,tool:z.literal('calendar.create'),toolVersion:z.literal(1),workflow:z.literal('briefing'),effect:z.literal('external-write'),titlePrefix:z.string().min(4).max(80),notBefore:z.string().datetime(),expiresAt:z.string().datetime(),maxDurationMinutes:z.number().int().min(1).max(60),maxUses:z.literal(1),uses:z.number().int().min(0).max(1),status:z.enum(['proposed','active','revoked']),createdAt:z.string().datetime()}).strict();
export type AgentGrant=z.infer<typeof grantSchema>;
export const agentStateSchema=z.object({version:z.literal(1),revision:z.number().int().nonnegative(),config:agentConfigSchema,policies:z.array(workflowPolicySchema).max(40),feedback:z.array(feedbackSchema).max(500),candidates:z.array(candidateSchema).max(100),grants:z.array(grantSchema).max(40)}).strict();
export type AgentState=z.infer<typeof agentStateSchema>;
export const initialAgentState=():AgentState=>({version:1,revision:0,config:{...agentDefaults},policies:[],feedback:[],candidates:[],grants:[]});
export const agentSnapshotSchema=z.object({background:backgroundViewSchema.optional(),dailyIntelligence:dailyIntelligenceSchema.optional(),activityArchives:z.array(z.object({id:z.string(),accountId:accountIdSchema.nullable()}).strict()).optional(),budgetPreview:budgetBoundarySchema.optional(),briefingEligibility:briefingEligibilitySchema.optional(),scheduleStatus:z.array(z.object({policyId:uuidSchema,checkedAt:z.string().datetime(),eligibleNow:z.boolean(),reason:z.string().max(300)}).strict()).optional(),costs:costsSchema.optional(),state:agentStateSchema,runs:z.array(agentRunSchema).max(100),usage:z.object({day:z.string(),deepseek:z.number().int().nonnegative(),jev:z.number().int().nonnegative(),openai:z.number().int().nonnegative().optional(),total:z.number().int().nonnegative()}).strict().optional()}).strict();
export type AgentSnapshot=z.infer<typeof agentSnapshotSchema>;
export const agentCommandSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('handleWork'),id:uuidSchema}).strict(),
  z.object({action:z.literal('workDisposition'),id:uuidSchema,expectedRevision:z.number().int().nonnegative(),choice:z.enum(['snooze','unsnooze','not-relevant','resolved-elsewhere'])}).strict(),
  z.object({action:z.literal('createDesktopResponsibility'),id:uuidSchema,conversationId:uuidSchema,taskId:uuidSchema,objective:z.string().trim().min(1).max(500),reviewAt:z.string().datetime(),expiresAt:z.string().datetime()}).strict(),
  z.object({action:z.literal('watchWork'),id:uuidSchema,expectedRevision:z.number().int().nonnegative(),triggers:z.array(proactiveTriggerSchema).min(1).max(3),reviewAt:z.string().datetime(),expiresAt:z.string().datetime()}).strict(),
  z.object({action:z.literal('changeDesktopResponsibility'),id:uuidSchema,expectedRevision:z.number().int().nonnegative(),change:z.enum(['resume','pause','cancel','complete'])}).strict(),
  z.object({action:z.literal('snapshot')}).strict(),
  z.object({action:z.enum(['checkScheduling','useReplannedReply','completeScheduling']),id:uuidSchema}).strict(),
  z.object({action:z.literal('replanScheduling'),id:uuidSchema,confirmed:schedulingRequestSchema.shape.confirmed}).strict(),
  z.object({action:z.literal('prepareSchedulingCalendar'),id:uuidSchema,candidateId:hashSchema}).strict(),
  z.object({action:z.literal('retryScheduling'),id:uuidSchema}).strict(),
  z.object({action:z.literal('continueScheduling'),id:uuidSchema,confirmed:schedulingRequestSchema.shape.confirmed.unwrap()}).strict(),
  z.object({action:z.literal('refreshIntelligence'),providerCalls:z.number().int().min(0).max(2).default(2)}).strict(),
  z.object({action:z.literal('insightDisposition'),id:uuidSchema,status:z.enum(['dismissed','resolved'])}).strict(),
  z.object({action:z.literal('archiveActivity'),accountId:accountIdSchema.nullable(),ids:z.array(z.string().regex(/^(workflow|mail|calendar|conversation):[a-zA-Z0-9-]{1,100}$/)).min(1).max(1200)}).strict(),
  z.object({action:z.literal('restoreActivity'),accountId:accountIdSchema.nullable()}).strict(),
  z.object({action:z.literal('previewBudgetBoundary')}).strict(),
  z.object({action:z.literal('applyBudgetBoundary'),preview:budgetBoundarySchema}).strict(),
  z.object({action:z.literal('checkBriefing')}).strict(),
  z.object({action:z.literal('dailyBriefing'),refresh:z.boolean(),synthesize:z.boolean().default(false)}).strict(),
  z.object({action:z.literal('config'),expectedRevision:z.number().int(),config:agentConfigSchema}).strict(),
  z.object({action:z.literal('policy'),expectedRevision:z.number().int(),policy:workflowPolicySchema}).strict(),
  z.object({action:z.literal('start'),event:intakeSchema}).strict(),
  z.object({action:z.literal('approveLocal'),id:uuidSchema,hash:hashSchema}).strict(),
  z.object({action:z.literal('reviseLocal'),id:uuidSchema,hash:hashSchema,draft:taskDraftSchema}).strict(),
  z.object({action:z.enum(['cancel','denyLocal','reject','evaluate','activate','rollback','forgetRun','revokeGrant']),id:uuidSchema}).strict(),
  z.object({action:z.literal('feedback'),runId:uuidSchema,sourceId:z.string().max(20),kind:z.enum(['priority','route','edited_draft','dismissed','resolved','preference','failed','undo']),value:z.string().min(1).max(2000)}).strict(),
  z.object({action:z.literal('candidate'),feedbackId:uuidSchema}).strict(),
  z.object({action:z.literal('grant'),grant:grantSchema}).strict(),
  z.object({action:z.enum(['exportLearning','forgetLearning'])}).strict(),
]);
export type AgentCommand=z.infer<typeof agentCommandSchema>;
