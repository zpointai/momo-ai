import {z} from 'zod';
import {resourceRefSchema} from './modules';
export const proactiveTriggers=['source-change','task-due','task-completed'] as const;
export const proactiveTriggerSchema=z.enum(proactiveTriggers);
export const proactiveScopeSchema=z.object({
 resources:z.array(resourceRefSchema).min(1).max(8),
 triggers:z.array(proactiveTriggerSchema).min(1).max(3),
 attachedToExistingWork:z.boolean(),paused:z.boolean(),authorityRevision:z.string().length(64),approvedAt:z.string().datetime(),
 mailThreads:z.array(z.object({sourceId:z.string(),threadId:z.string()}).strict()).max(8),
 calendarWindows:z.array(z.object({sourceId:z.string(),startDate:z.string(),endDate:z.string(),timezone:z.string()}).strict()).max(8),
 observations:z.array(z.object({key:z.string().max(1200),revision:z.string().length(64),at:z.string().datetime()}).strict()).max(24),
 events:z.array(z.object({id:z.string().length(64),at:z.string().datetime(),trigger:proactiveTriggerSchema,sourceKey:z.string().max(1200),revision:z.string().length(64),detail:z.string().max(240),outcome:z.enum(['baseline','superseded','held','wake','completed']),assistantRunId:z.string().uuid().optional()}).strict()).max(64),
 pending:z.object({id:z.string().length(64),assistantRunId:z.string().uuid(),at:z.string().datetime(),trigger:proactiveTriggerSchema,detail:z.string().max(240)}).strict().nullable(),
 lastWakeAt:z.string().datetime().nullable(),waitingReason:z.string().max(240),
}).strict();
export type ProactiveScope=z.infer<typeof proactiveScopeSchema>;
export type ProactiveTrigger=z.infer<typeof proactiveTriggerSchema>;
export const proactiveTriggerLabels:Record<ProactiveTrigger,string>={'source-change':'Meaningful source changes','task-due':'Linked task becomes due','task-completed':'Linked task is completed'};
