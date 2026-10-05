import { z } from 'zod';
import { resourceRefSchema } from './modules';
import {proactiveScopeSchema} from './proactive';
import { voiceSessionSchema } from './voice';
import { moReadSources } from './mo-capabilities';

/** One identity across channels; a transport address is never local-context authority. */
export const MO_IDENTITY = 'momo-executive' as const;
export const moChannelSchema = z.object({
  assistant: z.literal(MO_IDENTITY), channel: z.enum(['desktop', 'sms', 'voice']),
  sessionId: z.string().uuid(), linkedConversationId: z.string().uuid().nullable(),
  authorization: z.enum(['local-owner', 'unlinked', 'authenticated-owner']),
  voice:voiceSessionSchema.extend({endedAt:z.string().datetime().nullable(),retention:z.enum(['ephemeral','history'])}).optional(),
}).strict().refine(v => v.channel === 'desktop' ? v.authorization === 'local-owner'&&!v.voice : v.channel==='voice'&&v.authorization==='authenticated-owner' ? !!v.voice&&v.voice.id===v.sessionId&&v.voice.conversationId===v.linkedConversationId : v.authorization === 'unlinked' && v.linkedConversationId === null&&!v.voice);

export const moReadSchema = z.object({
  sources: z.array(z.enum(moReadSources)).min(1).max(3),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  sourceId: z.string().max(1024).nullable(),
  endDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  refreshWeather:z.boolean().optional(),
  search:z.object({sender:z.string().trim().min(1).max(120).nullable(),topic:z.string().trim().min(1).max(180).nullable(),latest:z.boolean()}).strict().nullable().optional(),
}).strict();
export type MoRead = z.infer<typeof moReadSchema>;
/** A model proposes scope; the Executive supplies all authority and evidence bindings. */
export const moDelegationSchema = z.object({
  specialist: z.enum(['inbox','planner','briefing','context','review','comms']),
  objective: z.string().trim().min(1).max(500),
  sources: moReadSchema.shape.sources,
  date: moReadSchema.shape.date,
  sourceId: moReadSchema.shape.sourceId,
  endDate:moReadSchema.shape.endDate,search:moReadSchema.shape.search,refreshWeather:moReadSchema.shape.refreshWeather,
}).strict();
export type MoDelegation = z.infer<typeof moDelegationSchema>;
export const moDelegationTool = {
  type: 'function' as const,
  function: { name: 'delegate_work', description: 'Ask one relevant specialist for bounded native evidence. Inbox: inbox; Planner: agenda/tasks; Briefing: inbox/agenda/tasks/workflows/weather; Context/Research: permitted selected sources only (no web search); Review: verify already supplied evidence, selectively; Comms: local workflow/Relay responsibility status only, never send or read SMS. Use only needed sources. No tools, grants, accounts or write authority can be supplied. Use exact bound mail resourceId for its full thread. Date is YYYY-MM-DD or null.', parameters: {
    type: 'object', properties: { specialist: { type:'string',enum:['inbox','planner','briefing','context','review','comms'] }, objective:{type:'string',maxLength:500}, ...moReadToolParameters() }, required:['specialist','objective','sources','date','sourceId','endDate','search'], additionalProperties:false,
  } },
};
function moReadToolParameters(){return {refreshWeather:{type:'boolean',description:'True only for an explicit current owner request to refresh, update or check weather/forecast. Uses the existing native provider for the default saved place, subject to saved permissions, freshness, cooldown and session network guards. Omit otherwise. Never confirms task execution.'},sources:{type:'array',items:{type:'string',enum:[...moReadSources]},minItems:1,maxItems:3},date:{type:['string','null'],description:'Agenda start date YYYY-MM-DD in owner timezone; otherwise null.'},endDate:{type:['string','null'],description:'Exclusive agenda end date, at most 7 days after start; otherwise null.'},sourceId:{type:['string','null'],description:'Exact bound mail resourceId for full thread; otherwise null.'},search:{anyOf:[{type:'null'},{type:'object',properties:{sender:{type:['string','null'],description:'Literal sender name, domain or address as supplied; never translate or invent it. No Gmail operators.'},topic:{type:['string','null'],description:'Exact literal phrase, not semantic search. Use null when the original subject wording or language is unknown; do not add inferred translations. No Gmail operators.'},latest:{type:'boolean'}},required:['sender','topic','latest'],additionalProperties:false}],description:'Bounded all-mail sender/topic search, excluding spam/trash. If a combined search is empty, at most one sender-only page returns unconfirmed candidates. Null for recent Inbox or exact thread.'}};}

export const executiveBindingSchema = z.object({
  assistantRunId:z.string().uuid(),conversationId:z.string().uuid(),revision:z.number().int().nonnegative(),
  state:z.enum(['needs-owner','ready-for-mo','assigned','working','waiting','prepared','approval-required','blocked','stale','completed','cancelled','failed']),
  nextStep:z.string().max(240),
  proposals:z.array(z.object({id:z.string().max(100),kind:z.enum(['reply-proposal','task-proposal','responsibility-proposal'])}).strict()).max(7).optional(),
}).strict();
export const moReadTool = {
  type: 'function' as const,
  function: { name: 'read_workspace', description: 'Read only the necessary permitted native sources. Agenda date is YYYY-MM-DD in the owner timezone, null for the next seven days. For a discussed mail thread use its exact resourceId as sourceId, otherwise null. Task and workflow reads are local. Weather is eligible saved evidence only. No writes, traffic, external search or permissions.', parameters: {
    type: 'object', properties: moReadToolParameters(), required: ['sources', 'date', 'sourceId','endDate','search'], additionalProperties: false,
  } },
};
export const desktopResponsibilitySchema = z.object({
  proactive:proactiveScopeSchema.optional(),
  owner: z.literal('mo').optional(), specialistScope: z.array(z.enum(['inbox','planner','context','review','comms','briefing'])).max(6).optional(), nextSafeStage: z.literal('owner-review').optional(),
  version: z.literal(1), conversationId: z.string().uuid(), objective: z.string().trim().min(1).max(500),
  resource: resourceRefSchema, trigger: z.enum(['owner-resume','native-event']), reviewAt: z.string().datetime(), expiresAt: z.string().datetime(),
  revision: z.number().int().nonnegative(), status: z.enum(['waiting', 'review', 'completed', 'cancelled', 'expired']),
  lastResumedAt: z.string().datetime().nullable(),
}).strict();
