import type { SituationCommand, SituationSnapshot } from './situation';
import type { DesktopObservationCommand, DesktopObservationState } from './desktop-observation';
import { backgroundSettingsSchema } from './background';
import { aiLimitsSchema,spendingSchema,rateSchema } from './usage';
import { contextBudgetsSchema } from './context';
import type { MailCommand,MailResult } from './mail';
import type { AgentCommand, AgentSnapshot } from './orchestration';
import type { CalendarActionCommand, CalendarActionResult } from './calendar-actions';
import { z } from 'zod';
import { moduleIdSchema } from './modules';
import type { TaskReceipt } from './assistant';
import type { AssistantWorkspace, RunRequest, AssistantRun, TaskCommand } from './assistant';
import { googleStateSchema, type GoogleCommand, type InboxQuery, type InboxData, type MessageQuery, type MessageData, type CalendarQuery, type CalendarData } from './google';
export const providerSchema = z.enum(['deepseek', 'minimax', 'jev', 'openai']);
export type Provider = z.infer<typeof providerSchema>;
export const saveCredentialSchema = z.object({ provider: z.enum(['deepseek','jev','openai']), secret: z.string().regex(/^[\x21-\x7e]{8,2048}$/) }).strict();
export const settingsSchema = z.object({
  executiveModel: z.enum(['deepseek-flash','gpt-6-luna']).default('deepseek-flash'),
  desktopObservation: z.object({ enabled: z.boolean() }).strict().optional(),
  timezone: z.string().max(80).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }),
  theme: z.enum(['dark', 'light']), reducedMotion: z.boolean(), assistantWidth: z.number().int().min(300).max(640), assistantCollapsed: z.boolean().default(false),
  disabledModules: z.array(moduleIdSchema).max(6).default([]),
  contextBudgets: contextBudgetsSchema.optional(),backgroundIntelligence:backgroundSettingsSchema.optional(),
  sidebarCollapsed: z.boolean().default(false), deepseekEnabled: z.boolean().default(false), jevEnabled: z.boolean().default(false), dailyCallLimit: z.number().int().min(1).max(100000).default(20),
  aiLimits:aiLimitsSchema.nullable().default(null),spending:spendingSchema.default({mode:'monitor',currency:'USD',warning:null,stop:null}),importedRates:z.array(rateSchema).max(30).default([]),
}).strict();
export type Settings = z.infer<typeof settingsSchema>;
export const defaults: Settings = settingsSchema.parse({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', theme: 'dark', reducedMotion: false, assistantWidth: 400, assistantCollapsed: false });
export const settingsRecordSchema = z.object({ values: settingsSchema, revision: z.number().int().nonnegative() }).strict();
export type SettingsRecord = z.infer<typeof settingsRecordSchema>;
export const settingsUpdateSchema = z.object({ patch: settingsSchema.partial().extend({ executiveModel:z.enum(['deepseek-flash','gpt-6-luna']).optional(), aiLimits:aiLimitsSchema.nullable().optional(),spending:spendingSchema.optional(),importedRates:z.array(rateSchema).max(30).optional(),disabledModules:z.array(moduleIdSchema).max(5).optional(), assistantCollapsed: z.boolean().optional(), sidebarCollapsed: z.boolean().optional(), deepseekEnabled: z.boolean().optional(), jevEnabled: z.boolean().optional(), dailyCallLimit: z.number().int().min(1).max(100000).optional() }).refine(value => Object.keys(value).length > 0), expectedRevision: z.number().int().nonnegative() }).strict();
export type SettingsUpdate = z.infer<typeof settingsUpdateSchema>;
export const credentialStatusSchema = z.enum(['missing', 'configured', 'error']);
export const snapshotSchema = z.object({
  version: z.string(), settings: settingsRecordSchema,
  credentials: z.object({ deepseek: credentialStatusSchema, minimax: credentialStatusSchema, jev: credentialStatusSchema, openai: credentialStatusSchema.default('missing') }).strict(),
  openaiVerification:z.object({status:z.enum(['running','succeeded','failed','cancelled','interrupted']),at:z.string().datetime()}).strict().nullable().optional(),
  protectionAvailable: z.boolean(), networkEnabled: z.boolean(), aiRequestsEnabled: z.boolean(), storage: z.literal('ready'), google: googleStateSchema,
}).strict();
export type Snapshot = z.infer<typeof snapshotSchema>;
export const errorCodeSchema = z.enum(['invalid_input', 'permission_denied', 'conflict', 'unavailable', 'cancelled', 'internal']);
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type Result<T> = { ok: true; value: T } | { ok: false; error: { code: ErrorCode; message: string } };
export const resultSchema = <T extends z.ZodType>(value: T) => z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), value }).strict(),
  z.object({ ok: z.literal(false), error: z.object({ code: errorCodeSchema, message: z.string().max(240) }).strict() }).strict(),
]);
export const channels = { agent:'momo:agent:command',agentChanged:'momo:agent:changed', calendarAction:'momo:calendar:action', snapshot: 'momo:app:snapshot', settings: 'momo:settings:update', importCredential: 'momo:credentials:import', removeCredential: 'momo:credentials:remove', changed: 'momo:app:changed', google: 'momo:google:command', inbox: 'momo:google:inbox', message: 'momo:google:message', calendar: 'momo:google:calendar', workspace: 'momo:assistant:workspace', startRun: 'momo:assistant:start', cancelRun: 'momo:assistant:cancel', task: 'momo:tasks:command', workspaceChanged: 'momo:assistant:changed' } as const;
export interface DesktopBridge {
  homeCommand(input:import('./home-automation').HomeCommand):Promise<Result<import('./home-automation').HomeSnapshot>>;
  relayCommand(input:import('./relay').RelayCommand):Promise<Result<import('./relay').RelaySnapshot>>;
  desktopObservation(input: DesktopObservationCommand): Promise<Result<DesktopObservationState>>;
  situationCommand?(input:SituationCommand):Promise<Result<SituationSnapshot>>;
  onClockChanged(listener:()=>void):()=>void;
  mailCommand(input:MailCommand):Promise<Result<MailResult>>;
  clearConversation(id:string):Promise<Result<AssistantWorkspace>>;
  taskReceipt(id:string):Promise<Result<TaskReceipt>>;
  agentCommand(input:AgentCommand):Promise<Result<AgentSnapshot>>;
  onAgentChanged(listener:(snapshot:AgentSnapshot)=>void):()=>void;
  calendarAction(input:CalendarActionCommand):Promise<Result<CalendarActionResult>>;
  saveCredential(input: z.infer<typeof saveCredentialSchema>): Promise<Result<Snapshot>>;
  getSnapshot(): Promise<Result<Snapshot>>;
  updateSettings(input: SettingsUpdate): Promise<Result<Snapshot>>;
  importCredential(provider: Provider): Promise<Result<Snapshot>>;
  removeCredential(provider: Provider): Promise<Result<Snapshot>>;
  googleCommand(command: GoogleCommand): Promise<Result<Snapshot>>;
  readInbox(query: InboxQuery): Promise<Result<InboxData>>;
  readMessage(query: MessageQuery): Promise<Result<MessageData>>;
  readCalendar(query: CalendarQuery): Promise<Result<CalendarData>>;
  getWorkspace(): Promise<Result<AssistantWorkspace>>;
  startRun(input: RunRequest): Promise<Result<AssistantRun>>;
  cancelRun(id: string): Promise<Result<AssistantWorkspace>>;
  taskCommand(input: TaskCommand): Promise<Result<AssistantWorkspace>>;
  onWorkspaceChanged(listener: (workspace: AssistantWorkspace) => void): () => void;
  onChanged(listener: (snapshot: Snapshot) => void): () => void;
}
