import { z } from 'zod';
import { accountIdSchema, timezoneSchema } from './google';

export const moduleIdSchema = z.enum(['dashboard','inbox','planner','situation','relay','home-automation']);
export type ModuleId = z.infer<typeof moduleIdSchema>;
const stableId = z.string().regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/).max(80);
export const capabilitySchema = z.enum(['google.mail.read','google.calendar.read','google.calendar.create','local.tasks','assistant.direct','workflows']);
export type Capability = z.infer<typeof capabilitySchema>;
const contribution = z.object({id:stableId, owner:moduleIdSchema, implementation:z.string().min(1).max(160)}).strict();
export const moduleSchema = z.object({
  id:moduleIdSchema, version:z.literal(1), name:z.string().min(1).max(40), icon:z.enum(['home','inbox','calendar','globe','radio','house']),
  dependencies:z.array(moduleIdSchema).max(3), capabilities:z.array(capabilitySchema).max(6),
  routes:z.array(z.string().regex(/^\/[a-z/-]*$/)).min(1).max(5),
  widgets:z.array(contribution).max(8), commands:z.array(contribution).max(8), settings:z.array(contribution).max(4),
  tools:z.array(contribution).max(8), workflows:z.array(z.enum(['email','briefing','chat','task'])).max(4), events:z.array(contribution).max(8),
}).strict();
export type ModuleDefinition = z.infer<typeof moduleSchema>;
export function createRegistry(raw:unknown[]) {
  const modules=raw.map(item=>moduleSchema.parse(item)); const ids=new Set<string>(); const routes=new Set<string>(); const contributions=new Set<string>();
  for(const module of modules) {
    if(ids.has(module.id)) throw new Error('Duplicate module: '+module.id); ids.add(module.id);
    for(const route of module.routes){if(routes.has(route))throw new Error('Duplicate route: '+route);routes.add(route);}
    for(const c of [...module.widgets,...module.commands,...module.settings,...module.tools,...module.events]) {
      if(c.owner!==module.id||contributions.has(c.id))throw new Error('Invalid contribution ownership or duplicate ID: '+c.id); contributions.add(c.id);
    }
  }
  for(const m of modules) for(const id of m.dependencies) if(!ids.has(id)||id===m.id)throw new Error('Unavailable module dependency: '+id);
  const visit=(id:ModuleId,trail:ModuleId[])=>{if(trail.includes(id))throw new Error('Cyclic module dependency');for(const next of modules.find(m=>m.id===id)!.dependencies)visit(next,[...trail,id]);};
  modules.forEach(m=>visit(m.id,[]));
  return Object.freeze(modules.map(m=>Object.freeze(m)));
}
const c=(owner:ModuleId,id:string,implementation:string)=>({owner,id,implementation});
export const modules=createRegistry([
  {id:'dashboard',version:1,name:'Dashboard',icon:'home',dependencies:[],capabilities:['local.tasks'],routes:['/dashboard','/today'],widgets:[c('dashboard','dashboard.briefing','DashboardView')],commands:[c('dashboard','dashboard.open','DesktopApp.navigate')],settings:[],tools:[],workflows:['briefing','chat'],events:[c('dashboard','dashboard.briefing-ready','OrchestrationService.publish')]},
  {id:'inbox',version:1,name:'Inbox',icon:'inbox',dependencies:[],capabilities:['google.mail.read'],routes:['/inbox'],widgets:[c('inbox','inbox.attention','DashboardView')],commands:[c('inbox','inbox.open','DesktopApp.navigate')],settings:[c('inbox','inbox.connection','GoogleSettings')],tools:[c('inbox','inbox.summary','GoogleService.summary')],workflows:['email'],events:[c('inbox','inbox.assessment-ready','OrchestrationService.publish')]},
  {id:'planner',version:1,name:'Planner',icon:'calendar',dependencies:[],capabilities:['google.calendar.read','local.tasks'],routes:['/planner'],widgets:[c('planner','planner.agenda','DashboardView'),c('planner','planner.tasks','TaskList')],commands:[c('planner','planner.open','DesktopApp.navigate')],settings:[c('planner','planner.connection','GoogleSettings')],tools:[c('planner','planner.read','GoogleService.calendar'),c('planner','planner.create','CalendarActionService')],workflows:['task'],events:[c('planner','planner.task-changed','StorageClient.taskCommand')]},
  {id:'relay',version:1,name:'Relay',icon:'radio',dependencies:['planner'],capabilities:['local.tasks'],routes:['/relay'],widgets:[],commands:[c('relay','relay.open','DesktopApp.navigate')],settings:[c('relay','relay.settings','RelaySettings')],tools:[],workflows:[],events:[c('relay','relay.received','OrchestrationService.receiveRelay')]},
  {id:'situation',version:1,name:'Situation View',icon:'globe',dependencies:[],capabilities:[],routes:['/situation','/situation-view'],widgets:[],commands:[c('situation','situation.open','DesktopApp.navigate')],settings:[c('situation','situation.settings','SituationSettings')],tools:[],workflows:[],events:[c('situation','situation.changed','SituationService')]},
  {id:'home-automation',version:1,name:'Home Automation',icon:'house',dependencies:[],capabilities:[],routes:['/home-automation'],widgets:[],commands:[c('home-automation','home-automation.open','DesktopApp.navigate')],settings:[c('home-automation','home-automation.settings','HomeAutomationSettings')],tools:[],workflows:[],events:[]},
]);
export function moduleAvailability(id:ModuleId,disabled:readonly ModuleId[],capabilities:readonly Capability[]) {
  const module=modules.find(m=>m.id===id)!;
  if(disabled.includes(id))return {enabled:false,reason:module.name+' is disabled in Settings.'};
  const missing=module.dependencies.find(d=>disabled.includes(d));if(missing)return {enabled:false,reason:'Required workspace is disabled: '+missing};
  const unavailable=module.capabilities.filter(c=>!capabilities.includes(c));
  return {enabled:true,reason:unavailable.length?'Connection or capability needed: '+unavailable.join(', '):null};
}
export const settingsSections=['overview','appearance','accounts','ai','usage','limits','providers','automation','learning','notifications','situation','relay','home-automation','privacy','advanced'] as const;
export type SettingsSection=typeof settingsSections[number];
export type WorkspaceRoute={page:ModuleId|'settings';section?:SettingsSection};
export function resolveRoute(raw:string):WorkspaceRoute {
  const value=raw.replace(/^#/, '').toLowerCase().replace(/^\//,'');
  if(['automations','automation','settings/automation'].includes(value))return{page:'settings',section:'automation'};
  if(['memory','learning','settings/learning'].includes(value))return{page:'settings',section:'learning'};
  if(value.startsWith('settings')){const parts=value.split('/');const section=parts[1]==='ai'&&['usage','limits','providers'].includes(parts[2])?parts[2]:parts[1];return{page:'settings',section:settingsSections.includes(section as SettingsSection)?section as SettingsSection:'overview'};}
  const found=modules.find(m=>m.routes.includes('/'+value));return{page:found?.id??'dashboard'};
}
export const resourceRefSchema=z.object({
  module:moduleIdSchema,connector:z.enum(['google','local','situation']),type:z.enum(['email','mailDraft','calendar','calendarRange','task','briefing','mailAction','weather','traffic','aircraft','place','situation-status','relayEvent']),id:z.string().min(1).max(1024),
  accountId:accountIdSchema.nullable(),profile:z.literal('local'),revision:z.string().min(1).max(128),label:z.string().max(240),
  provenance:z.object({kind:z.enum(['connector','workflow','assistant','user']),runId:z.string().max(128).nullable(),fetchedAt:z.string().datetime()}).strict(),
  access:z.enum(['read','review']),retention:z.object({kind:z.enum(['transient','retained']),expiresAt:z.string().datetime().nullable()}).strict(),
  timezone:timezoneSchema.optional(),
  date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
}).strict().refine(r=>!['weather','traffic','aircraft','place','situation-status'].includes(r.type)||(r.module==='situation'&&r.connector==='situation')).refine(r=>r.connector!=='situation'||r.module==='situation').refine(r=>r.connector!=='google'||!!r.accountId,'Google resources require an account').refine(r=>!['email','mailDraft','mailAction'].includes(r.type)||r.module==='inbox').refine(r=>!['calendar','calendarRange','task'].includes(r.type)||r.module==='planner');
export type ResourceRef=z.infer<typeof resourceRefSchema>;
export function resourceDestination(raw:unknown,activeAccountId:string|null,disabled:readonly ModuleId[],now=Date.now()) {
  const ref=resourceRefSchema.parse(raw);
  if(disabled.includes(ref.module))throw new Error('This workspace is disabled. Enable it in Settings to open this source.');
  if(ref.accountId&&ref.accountId!==activeAccountId)throw new Error('Select the source’s original account before opening it.');
  if(ref.retention.expiresAt&&+new Date(ref.retention.expiresAt)<=now)throw new Error('This retained source has expired. Refresh its workspace.');
  return {route:{page:ref.module} as WorkspaceRoute,ref};
}
export const workspaceEventSchema=z.object({id:z.string().uuid(),type:z.enum(['resource.open','resource.changed','workflow.updated']),owner:moduleIdSchema,resource:resourceRefSchema,origin:z.enum(['user','connector','momo']),at:z.string().datetime()}).strict().refine(e=>e.owner===e.resource.module);
export type WorkspaceEvent=z.infer<typeof workspaceEventSchema>;
/** Local typed dispatcher. Events carry references, never bodies, secrets, or an execution grant. */
export class WorkspaceEvents {
  private listeners=new Set<(event:WorkspaceEvent)=>void>();
  subscribe(listener:(event:WorkspaceEvent)=>void){this.listeners.add(listener);return()=>{this.listeners.delete(listener);};}
  publish(raw:WorkspaceEvent){const event=workspaceEventSchema.parse(raw);for(const listener of this.listeners)listener(event);}
}
export const workspaceEvents=new WorkspaceEvents();
export const workflowModule=(family:'email'|'briefing'|'chat'|'task'):ModuleId=>family==='email'?'inbox':family==='task'?'planner':'dashboard';
/** Only system-authored operational text uses this. Source/user/model prose is never rewritten. */
export function operationalText(text:string){return text.replace(/Jev\s*\+\s*DeepSeek|deepseek-[\w.-]+|jev-[\w.-]+|DeepSeek|Jev|Gemini/gi,'MoMo');}
