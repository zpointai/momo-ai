// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { SettingsDatabase } from '../../electron/storage/database';
import { OrchestrationService } from '../../electron/agent/service';
import { MailService } from '../../electron/mail/service';
import { CalendarActionService } from '../../electron/calendar/service';
import { BriefingStore } from '../../electron/agent/briefing-store';
import { threadRevision } from '../../electron/mail/thread';
import { normalizeEvent } from '../../electron/google/normalize';
import { initialAgentState, type AgentIntake, type AgentRun } from '../../src/shared/orchestration';
import { eventOnDate, addDays, type CalendarData, type CalendarQuery } from '../../src/shared/google';
import type { MailThread } from '../../src/shared/mail';
import type { ProcessingOptions } from '../../electron/agent/providers';
import type { SchedulingInterpretation, SchedulingReplyPlan } from '../../src/shared/scheduling';

export function schedulingFixture(body='Could we meet for 30 minutes sometime next week?'){
 const db=new SettingsDatabase(':memory:');let now=Date.parse('2026-09-29T08:00:00Z'),accountId='fixtureAccount';const at=()=>new Date(now).toISOString();
 db.update({expectedRevision:db.get().revision,patch:{timezone:'Europe/Amsterdam'}});
 const state=initialAgentState();state.revision=1;Object.assign(state.config,{enabled:true,shareGoogle:true});
 state.policies.push({id:randomUUID(),family:'email',accountId,level:'L1',enabled:true,version:1,maxLocalPerDay:1,schedule:{enabled:false,hour:9,minute:0,timezone:'Europe/Amsterdam'},updatedAt:at()});db.agent('saveState',state);
 const thread:MailThread={accountId,id:'thread1',fetchedAt:at(),truncated:false,messages:[{message:{id:'message1',threadId:'thread1',subject:'SYNTHETIC scheduling fixture',from:'sender@example.test',to:'owner@example.test',snippet:body,receivedAt:at(),unread:true},text:body,textAvailable:true,truncated:false,headers:{replyTo:'sender@example.test',cc:'',messageId:'<message1@example.test>',references:''},attachments:[],labels:['INBOX']}]};
 const rawEvents=[{id:'event1',etag:'"revision1"',summary:'Planning review',status:'confirmed',organizer:{self:true},attendees:[{email:'sender@example.test'}],location:'Retained location',start:{dateTime:'2026-09-30T08:00:00.000Z',timeZone:'Europe/Amsterdam'},end:{dateTime:'2026-09-30T08:30:00.000Z',timeZone:'Europe/Amsterdam'}}];
 let partial=false, provider=false, providerResult:SchedulingInterpretation|SchedulingReplyPlan|undefined;
 const google={
  state:vi.fn(async()=>({configuration:'configured' as const,connecting:false,activeAccountId:accountId,accounts:[{id:'fixtureAccount',email:'owner@example.test',status:'connected' as const,mailSend:true,mailCompose:true,calendarWrite:true}]})),
  readMailThread:vi.fn(async()=>({...structuredClone(thread),fetchedAt:at()})),readMailMessage:vi.fn(async()=>structuredClone(thread.messages[0])),
  calendar:vi.fn(async(q:CalendarQuery):Promise<CalendarData>=>({accountId:q.accountId,startDate:q.startDate,endDate:q.endDate,timezone:q.timezone,fetchedAt:at(),cached:false,truncated:partial,skipped:0,events:rawEvents.map(e=>normalizeEvent(e)!).filter(e=>{for(let day=q.startDate;day<q.endDate;day=addDays(day,1))if(eventOnDate(e,day,q.timezone))return true;return false;})})),
  calendarEpoch:()=>0,summary:vi.fn(),inbox:vi.fn(),findApprovedEvent:vi.fn(async(_account:string,id:string)=>structuredClone(rawEvents.find(e=>e.id===id))),
  updateApprovedEvent:vi.fn(async(_a:string,id:string,etag:string,patch:object,_epoch:number,valid:()=>boolean)=>{if(!valid())throw Error('Authority changed');const old=rawEvents.find(e=>e.id===id)!;if(old.etag!==etag)throw Error('ETag changed');Object.assign(old,patch,{etag:'"revision2"'});return structuredClone(old);}),
  insertApprovedEvent:vi.fn(),findSentMessage:vi.fn(),writeMail:vi.fn(async(_a:string,_kind:string,_input:unknown,_epoch:number,valid:()=>boolean)=>{if(!valid())throw Error('Authority changed');return{id:'sent1'};}),
 };
 const storage={agent:async(op:string,input?:unknown)=>db.agent(op,input),get:async()=>db.get(),workspace:async()=>db.workspace(),taskCommand:vi.fn(),mail:async(op:string,input?:unknown)=>db.mail(op,input)};
 const mail=new MailService(storage,google,()=>true,()=>now),calendar=new CalendarActionService(db,google,()=>now);
 const coordinate=vi.fn(async(o:ProcessingOptions,kind:'interpret'|'reply')=>{await o.checkAuthority();await o.beforeRound();await o.usage('deepseek-flash',{input:200,output:50});return kind==='interpret'?providerResult:providerResult&&'candidateIds' in providerResult?providerResult:{opening:'Thanks for reaching out.',question:'Which of these options would suit you best?',candidateIds:JSON.parse(o.context.items.find(s=>s.id==='E1')!.text).candidates.map((c:{id:string})=>c.id),style:'conversational'};});
 const credentials={status:vi.fn(async()=>provider?'configured' as const:'missing' as const),peekStatus:()=>provider?'configured' as const:'missing' as const,read:vi.fn(async()=> 'isolated-fixture-key')};
 const service=new OrchestrationService(storage,credentials,google,()=>{}, {decide:vi.fn()}, {process:vi.fn(),coordinate},()=>now,mail,new BriefingStore(),calendar);
 mail.setWorkflowValidator(draft=>service.validateSchedulingDraft(draft));calendar.setWorkflowValidator(action=>service.validateSchedulingCalendar(action));
 const event=():AgentIntake=>({id:randomUUID(),family:'email',accountId:'fixtureAccount',resourceId:thread.messages[0].message.id,prompt:'Check scheduling',scheduling:{threadId:thread.id,threadRevision:threadRevision(thread)},origin:'user',trigger:'manual',depth:0,causationId:null});
 const get=(id:string)=>db.agent('get',id) as AgentRun;
 const run=async()=>{const started=await service.start(event());await service.idle();return get(started.id);};
 return {db,service,mail,calendar,google,thread,rawEvents,coordinate,credentials,event,get,run,now:()=>now,advance:(ms:number)=>{now+=ms;},account:(id:string)=>{accountId=id;},partial:(value=true)=>{partial=value;},provider:(value:typeof providerResult)=>{provider=true;providerResult=value;db.update({expectedRevision:db.get().revision,patch:{deepseekEnabled:true}});},close:async()=>{await service.close();db.close();}};
}
