export type MoActionClass = 'READ' | 'PREPARE' | 'LOCAL_ACTION' | 'EXTERNAL_ACTION';
export interface MoCapability {
 id:string; name:string; native:string; sources:readonly string[]; actionClass:MoActionClass;
 desktop:boolean; voice:boolean; grant:string; freshness:string; confirmation:string; output:string; retention:string;
}
const read=(id:string,name:string,native:string,sources:string[],grant:string,freshness='Current native evidence, at most five minutes old'):MoCapability=>({id,name,native,sources,actionClass:'READ',desktop:true,voice:true,grant,freshness,confirmation:'Authenticated caller and PIN for Voice',output:'Bounded spoken summary; disclose partial coverage',retention:'Context Manager budget; in-memory call context with history off'});
/** Channel availability is a projection, never a replacement for native authorization. */
export const moCapabilities:readonly MoCapability[]=[
 read('inbox.search','Find email','GoogleService.inbox',['inbox'],'Selected account + Google sharing'),
 read('inbox.thread','Read selected thread','GoogleService.readMailThread',['inbox'],'Exact message/thread binding + Google sharing'),
 read('planner.agenda','Agenda','GoogleService.calendar',['agenda'],'Selected account + Google sharing'),
 read('tasks.read','Local tasks','StorageClient.workspace',['tasks'],'Local task sharing'),
 read('work.read','Work and responsibilities','ownerWork',['workflows'],'Local sharing; source-derived content also requires source grants'),
 read('briefing.read','Daily plan','Mo Executive / Briefing specialist',['agenda','tasks','workflows','weather'],'Each requested native source grant'),
 read('weather.read','Weather','MoContext / SituationService.snapshot and command',['weather'],'Explicit default saved place + Weather sharing + native network permission for refresh','Current observation; explicit owner refresh reuses native cooldown, no autonomous refresh'),
 ...[['reply.prepare','Reply proposal'],['task.prepare','Task proposal'],['responsibility.prepare','Tracking proposal']].map(([id,name]):MoCapability=>({...read(id,name,'Mo Executive / existing Work',[], 'Current source grants + review policy'),actionClass:'PREPARE',confirmation:'Desktop review required; no execution',retention:'Requested Work artifact and necessary source references'})),
 {...read('task.create','Create local task','OrchestrationService / applyLocal / taskCommand',['tasks'],'Local sharing + enabled chat policy + exact Voice confirmation'),actionClass:'LOCAL_ACTION',confirmation:'One-use, session/generation/authority-bound confirmation within 45 seconds',freshness:'Revalidate authority at native commit',output:'Native receipt only',retention:'Existing Work proposal, task and action provenance'},
 {...read('traffic.read','Traffic','SituationService / TomTom Calculate Route',['traffic'],'Existing saved route and provider entitlement'),voice:false,freshness:'Fresh permitted lookup required',confirmation:'Spoken/cloud processing entitlement not established',output:'Display-only in Situation View; Voice limitation only',retention:'Transient display-only; no model, history, Context Manager or Briefing data'},
 {...read('calendar.create','Create private calendar event','CalendarActionService / GoogleService.insertApprovedEvent',['agenda'],'Voice calendar opt-in + Google sharing + existing calendar write permission'),actionClass:'EXTERNAL_ACTION',confirmation:'Exact account/title/timezone/start/end readback; one-use session-bound confirmation within 45 seconds',freshness:'Revalidate session, account epoch, native authority and write scope before dispatch',output:'Verified native receipt; unknown outcomes are never retried',retention:'Existing calendar action and Voice provenance; no invitations or transcripts'},
 ...[['mail.send','Send email'],['calendar.write','Update or delete calendar events'],['sms.send','Send SMS'],['desktop.control','Desktop Control']].map(([id,name]):MoCapability=>({...read(id,name,'Existing native approval boundary',[], 'Existing native authority'),desktop:id!=='desktop.control',voice:false,actionClass:'EXTERNAL_ACTION',confirmation:'Prohibited from Voice execution',output:'No completion claim without native receipt',retention:'Existing action audit'})),
];
export const voiceCapabilities=()=>moCapabilities.filter(c=>c.voice);
export const moReadSources=['inbox','agenda','tasks','workflows','weather'] as const;
export function capabilityForRead(source:string){return ({inbox:'inbox.search',agenda:'planner.agenda',tasks:'tasks.read',workflows:'work.read',weather:'weather.read'} as Record<string,string>)[source];}
