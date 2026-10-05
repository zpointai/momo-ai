import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { eventDraftSchema, wallTimeToInstant, type EventDraft } from '../../src/shared/calendar-actions';
import { dateSchema } from '../../src/shared/google';
import { exactVoiceYes, type VoiceActionBinding } from './voice-confirmation';
import { VoiceFailure } from './voice-failure';

export const voiceCalendarIntent=(text:string)=>/\b(?:create|add|make|schedule|book|put)\b[^.!?]{0,160}\b(?:calendar|event|appointment|meeting)\b/i.test(text)&&!/\b(?:don't|do not|never)\s+(?:create|add|make|schedule|book|put)\b/i.test(text);
export const unsupportedVoiceCalendar=(text:string)=>/\b(?:recurring|repeat|every|invite|attendees?|guests?|reminders?|delete|remove|reschedule)\b/i.test(text);
const clock=z.string().regex(/^\d{2}:\d{2}$/).nullable();
export const voiceCalendarRequestSchema=z.object({title:z.string().trim().min(1).max(240).nullable(),startDate:dateSchema.nullable(),startTime:clock,endDate:dateSchema.nullable(),endTime:clock}).strict();
const calendarFields=['title','startDate','startTime','endDate','endTime'] as const;
type CalendarFields=z.infer<typeof voiceCalendarRequestSchema>;
export const voiceCalendarUpdateSchema=voiceCalendarRequestSchema.extend({intent:z.enum(['details','cancel','other','unsupported']).default('details'),clearFields:z.array(z.enum(calendarFields)).max(5).default([]),uncertainFields:z.array(z.enum(calendarFields)).max(5).default([])});
export const voiceCalendarTool={type:'function' as const,function:{name:'request_calendar_event',description:'Collect or correct one private timed primary-calendar event for native readback, never execute. During collection interpret titles (including My Wife or Call My Wife) as event text, not commands to call someone. Return only fields supplied or corrected by the owner now; null means unchanged/missing. To remove a previously known field because the owner withdraws it, list it in clearFields. List ambiguous or garbled fields in uncertainFields even if a plausible value could be guessed; native code will ask only for the missing details. Do not guess a month from a sound-alike word, join split digits into a time, or invent a duration. Resolve explicit relative dates using supplied current time/timezone. intent details continues preparation, cancel abandons it, other means an unrelated request, unsupported means invitations/attendees/recurrence/reminders/editing an existing event.',parameters:{type:'object',properties:{intent:{type:'string',enum:['details','cancel','other','unsupported']},clearFields:{type:'array',items:{type:'string',enum:calendarFields}},uncertainFields:{type:'array',items:{type:'string',enum:calendarFields}},title:{type:['string','null']},startDate:{type:['string','null'],description:'YYYY-MM-DD'},startTime:{type:['string','null'],description:'HH:mm, owner timezone'},endDate:{type:['string','null'],description:'YYYY-MM-DD'},endTime:{type:['string','null'],description:'HH:mm, owner timezone'}},required:['intent','clearFields','uncertainFields','title','startDate','startTime','endDate','endTime'],additionalProperties:false}}};
export function missingVoiceCalendar(fields:CalendarFields){
  const names={title:'title',startDate:'date',startTime:'start time',endDate:'end date',endTime:'end time'};
  const missing=calendarFields.filter(k=>!fields[k]&&(k!=='endDate'||fields.startDate));
  return missing.length?'What '+missing.map(k=>names[k]).join(' and ')+' should I use for the event?':null;
}
export function normalizeVoiceCalendar(raw:unknown,accountId:string,timezone:string,now=Date.now()):EventDraft {
  const v=voiceCalendarRequestSchema.parse(raw);
  if(!v.title||!v.startDate||!v.startTime||!v.endDate||!v.endTime)throw new VoiceFailure('output-schema','Please give the event title, date, start time and end time.');
  const start=wallTimeToInstant(v.startDate+'T'+v.startTime,timezone),end=wallTimeToInstant(v.endDate+'T'+v.endTime,timezone);
  if(Date.parse(start)<=now||Date.parse(start)>now+366*86400000||Date.parse(end)-Date.parse(start)>86400000)throw new VoiceFailure('output-schema','Choose a future event within one year, lasting no more than one day.');
  return eventDraftSchema.parse({accountId,title:v.title,timezone,time:{kind:'timed',start,end}});
}
export function voiceCalendarReadback(draft:EventDraft,email:string){
  if(draft.time.kind!=='timed')throw new Error('Timed event required.');
  const format=new Intl.DateTimeFormat('en-GB',{timeZone:draft.timezone,dateStyle:'full',timeStyle:'short'});
  return `Create an event titled "${draft.title}" in the primary calendar for ${email}, from ${format.format(new Date(draft.time.start))} to ${format.format(new Date(draft.time.end))}, ${draft.timezone}. Private event, no invitations or reminders. Should I create this event?`;
}
export interface PendingVoiceCalendar {nonce:string;draft:EventDraft;binding:VoiceActionBinding;epoch:number;expiresAt:number}
export class VoiceCalendarConfirmation {
  private pending:PendingVoiceCalendar|null=null;
  private collection:{fields:CalendarFields;binding:VoiceActionBinding;epoch:number;expiresAt:number}|null=null;
  private attempted=new Set<string>();
  hasPending(){return this.pending!==null;}
  invalidateConfirmation(){this.pending=null;}
  clear(){this.invalidateConfirmation();this.collection=null;}
  reset(){this.clear();this.attempted.clear();}
  context(binding:VoiceActionBinding,epoch:number,now=Date.now()){
    const c=this.collection;
    if(!c)return null;
    const old=c.binding;
    if(now>=c.expiresAt||epoch!==c.epoch||binding.generation<old.generation||binding.sessionId!==old.sessionId||binding.callSid!==old.callSid||binding.accountId!==old.accountId||binding.profile!==old.profile||binding.authorityHash!==old.authorityHash||binding.authorityRevision!==old.authorityRevision||binding.settingsRevision!==old.settingsRevision){this.clear();return null;}
    return structuredClone(c.fields);
  }
  collect(raw:unknown,binding:VoiceActionBinding,epoch:number,now=Date.now()){
    const update=voiceCalendarUpdateSchema.parse(raw);
    if(update.intent!=='details'){this.clear();return {intent:update.intent,fields:null};}
    const fields=this.context(binding,epoch,now)??{title:null,startDate:null,startTime:null,endDate:null,endTime:null};
    // A partial correction changes only supplied fields, never unrelated known details.
    for(const field of calendarFields){if(update.clearFields.includes(field)||update.uncertainFields.includes(field))fields[field]=null;else if(update[field]!==null)fields[field]=update[field];}
    this.invalidateConfirmation();
    this.collection={fields,binding:structuredClone(binding),epoch,expiresAt:this.collection?.expiresAt??Math.min(now+180000,binding.expiresAt)};
    return {intent:update.intent,fields:structuredClone(fields)};
  }
  prepare(draft:EventDraft,binding:VoiceActionBinding,epoch:number,now=Date.now()){
    if(this.attempted.has(JSON.stringify(draft)))throw new VoiceFailure('action-execution-failed','This event was already submitted during this call. Check Calendar before trying again.');
    this.pending={nonce:randomUUID(),draft:structuredClone(draft),binding:structuredClone(binding),epoch,expiresAt:Math.min(now+45000,binding.expiresAt)};
    return structuredClone(this.pending);
  }
  consume(text:string,binding:VoiceActionBinding,epoch:number,now=Date.now()):PendingVoiceCalendar|null {
    const p=this.pending;this.pending=null;
    if(!exactVoiceYes(text))return null;
    if(!p)throw new VoiceFailure('confirmation-expired','There is no pending event to confirm.');
    const old=p.binding;
    if(now>=p.expiresAt||epoch!==p.epoch||binding.generation!==old.generation+1||binding.sessionId!==old.sessionId||binding.callSid!==old.callSid||binding.accountId!==old.accountId||binding.profile!==old.profile||binding.authorityHash!==old.authorityHash||binding.authorityRevision!==old.authorityRevision||binding.settingsRevision!==old.settingsRevision)throw new VoiceFailure('confirmation-expired','That event confirmation expired or its authority changed. Please prepare it again.');
    this.collection=null;this.attempted.add(JSON.stringify(p.draft));return p;
  }
}
