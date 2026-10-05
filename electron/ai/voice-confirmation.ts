import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { taskDraftSchema, type TaskDraft } from '../../src/shared/assistant';
import { wallTimeToInstant } from '../../src/shared/calendar-actions';
import { dateSchema } from '../../src/shared/google';
import { VoiceFailure } from './voice-failure';
import type { VoiceCallContext } from './voice-context';
import type { VoiceCalendarConfirmation } from './voice-calendar';
export interface VoiceActionBinding {sessionId:string;callSid:string;accountId:string;profile:'local';generation:number;authorityHash:string;authorityRevision:number;settingsRevision:number;expiresAt:number}
export interface PendingVoiceTask {nonce:string;taskId:string;draft:TaskDraft;binding:VoiceActionBinding;expiresAt:number}
export interface VoiceMoTurn {context:VoiceCallContext;confirmation:VoiceTaskConfirmation;binding:VoiceActionBinding;allowCreate:boolean;calendar?:{confirmation:VoiceCalendarConfirmation;epoch:number;email:string}}
export const voiceTaskRequestSchema=z.object({title:z.string().trim().min(1).max(240),date:dateSchema.nullable(),time:z.string().regex(/^\d{2}:\d{2}$/).nullable()}).strict();
export const voiceTaskTool={type:'function' as const,function:{name:'request_local_task',description:'Prepare one local task for exact spoken confirmation. Only after an explicit owner create-task/remind-me request. No execution. Resolve date/time in supplied owner timezone; ask clarification rather than invent a time. No email/calendar/SMS writes.',parameters:{type:'object',properties:{title:{type:'string'},date:{type:['string','null'],description:'YYYY-MM-DD or null for no due date.'},time:{type:['string','null'],description:'HH:mm in owner timezone or null for date-only.'}},required:['title','date','time'],additionalProperties:false}}};
export const exactVoiceYes=(text:string)=>/^(?:yes|confirm|do it)[.!]?$/i.test(text.trim());
export const localTaskIntent=(text:string)=>/\b(?:create|add|make|set(?: up)?)\b.*\b(?:task|reminder|to-do|todo)\b|\bremind me\b/i.test(text);
export function normalizeVoiceTask(raw:unknown,timezone:string):TaskDraft {
 const value=voiceTaskRequestSchema.parse(raw);
 if(value.time&&!value.date)throw new VoiceFailure('output-schema','What date should the reminder be due?');
 return taskDraftSchema.parse({title:value.title,due:value.date?value.time?{kind:'instant',at:wallTimeToInstant(value.date+'T'+value.time,timezone),timezone}:{kind:'date',date:value.date,timezone}:{kind:'none'}});
}
export function voiceTaskReadback(draft:TaskDraft){
 const due=draft.due.kind==='none'?'No due date.':draft.due.kind==='date'?'Due '+draft.due.date+' in '+draft.due.timezone+'.':'Due '+new Intl.DateTimeFormat('en-GB',{timeZone:draft.due.timezone,dateStyle:'full',timeStyle:'short'}).format(new Date(draft.due.at))+' in '+draft.due.timezone+'.';
 return `Create a local task: ${draft.title}. ${due} Local reminders depend on MoMo being running. Should I create this task?`;
}
/** Ephemeral exact confirmation, not an approval queue or a persistent authority. */
export class VoiceTaskConfirmation {
 private pending:PendingVoiceTask|null=null;
 hasPending(){return this.pending!==null;}
 clear(){this.pending=null;}
 prepare(draft:TaskDraft,binding:VoiceActionBinding,now=Date.now()){
  this.pending={nonce:randomUUID(),taskId:randomUUID(),draft:structuredClone(draft),binding:structuredClone(binding),expiresAt:Math.min(now+45000,binding.expiresAt)};
  return structuredClone(this.pending);
 }
 consume(text:string,binding:VoiceActionBinding,now=Date.now()):PendingVoiceTask|null {
  const p=this.pending;this.pending=null;
  if(!exactVoiceYes(text))return null;
  if(!p)throw new VoiceFailure('confirmation-expired','There is no pending task to confirm. Please ask me to prepare it again.');
  const old=p.binding;
  if(now>=p.expiresAt||binding.generation!==old.generation+1||binding.sessionId!==old.sessionId||binding.callSid!==old.callSid||binding.accountId!==old.accountId||binding.profile!==old.profile||binding.authorityHash!==old.authorityHash||binding.authorityRevision!==old.authorityRevision||binding.settingsRevision!==old.settingsRevision)throw new VoiceFailure('confirmation-expired','That confirmation is no longer valid. Please ask me to prepare the task again.');
  return p;
 }
}
