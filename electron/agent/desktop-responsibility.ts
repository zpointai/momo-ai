import { randomUUID } from 'node:crypto';
import { agentRunSchema, type AgentCommand, type AgentState, type AgentRun } from '../../src/shared/orchestration';
import type { LocalTask } from '../../src/shared/assistant';
import type { Settings } from '../../src/shared/contracts';
import { AppError } from '../errors';
import { hash } from './catalogue';
import { createTeam } from './team';
import { defaultContextBudgets } from '../../src/shared/context';
import { selectWorkflowContext } from '../context/adapters';

export function desktopResponsibility(command:Extract<AgentCommand,{action:'createDesktopResponsibility'}>,task:LocalTask,state:AgentState,settings:Settings,now:number):AgentRun{
  const at=new Date(now).toISOString(),expires=Date.parse(command.expiresAt),review=Date.parse(command.reviewAt);
  if(review<=now||review>expires||expires>now+30*86400000)throw new AppError('invalid_input','Choose a future review and expiry within 30 days.');
  const policy=state.policies.find(p=>p.family==='task'&&p.accountId===(task.accountId??null)&&p.enabled&&['L1','L2'].includes(p.level));
  if(!policy||!state.config.enabled||state.config.paused||!state.config.shareTasks||settings.disabledModules.includes('planner'))throw new AppError('permission_denied','Enable a preparation-level task workflow and local task sharing in Automations first.');
  const resource={module:'planner',connector:'local',type:'task',id:task.id,accountId:task.accountId??null,profile:'local',revision:hash(task),label:task.title,provenance:{kind:'user',runId:command.id,fetchedAt:at},access:'read',retention:{kind:'retained',expiresAt:command.expiresAt}};
  const run=agentRunSchema.parse({id:command.id,definition:'workflow-v1',event:{id:command.id,family:'task',accountId:task.accountId??null,resourceId:task.id,prompt:command.objective},dedup:hash({kind:'desktop-responsibility-v1',command}),context:{id:randomUUID(),hash:hash(task),createdAt:at,timezone:settings.timezone,items:[],limitations:['Owner-resume only. No schedules, continuous observation, SMS or external changes.'],available:{calendar:false,tasks:true,thread:false},sharing:{google:false,tasks:true}},desktopResponsibility:{owner:'mo',specialistScope:['planner','context','review'],nextSafeStage:'owner-review',version:1,conversationId:command.conversationId,objective:command.objective,resource,trigger:'owner-resume',reviewAt:command.reviewAt,expiresAt:command.expiresAt,revision:0,status:'waiting',lastResumedAt:null},policy,config:state.config,profileRevision:state.revision,createdAt:at,finishedAt:at,status:'complete',checkpoint:'Responsibility saved · waiting for owner',attempt:0,decision:null,result:null,findings:[],proposals:[],calls:[],error:null,shadow:null});
  const text=JSON.stringify({title:task.title,status:task.status,due:task.due});
  run.context.items=[{id:'T1',kind:'task',accountId:task.accountId??'local',resourceId:task.id,revision:hash(task),title:task.title,text,fetchedAt:at,trust:'untrusted-source',senderScope:null,threadId:null,delivery:{contextId:hash(task),mode:'FULL',coverage:{status:'complete',suppliedCharacters:text.length,omittedCharacters:0,sourcePartial:false,method:'source'},ref:run.desktopResponsibility!.resource}}];
  const selected=selectWorkflowContext(run.context,run.event,state,settings,now,true,true);run.context=selected.context;run.contextSelection=selected.selection;
  if(selected.selection.blocked||run.context.items.length!==1)throw new AppError('permission_denied','The linked task does not fit the current context scope.');
  run.team=createTeam(run,settings.contextBudgets?.assistant??defaultContextBudgets.assistant);
  for(const item of run.team.items){item.status='held';item.reason='Waiting for an explicit desktop resume.';}
  return run;
}
