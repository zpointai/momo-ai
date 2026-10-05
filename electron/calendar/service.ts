import { createHash, randomUUID } from 'node:crypto';
import { calendarActionCommandSchema, calendarActionSchema, eventDraftSchema, type CalendarAction, type CalendarActionCommand, type CalendarActionResult, type CalendarReview } from '../../src/shared/calendar-actions';
import type { GoogleService } from '../google/service';
import { GoogleHttpError } from '../google/http';
import { normalizeEvent } from '../google/normalize';
import { hash } from '../agent/catalogue';
import { AppError } from '../errors';
export interface ActionStorage {
  calendarActions(): Promise<CalendarAction[]> | CalendarAction[];
  putCalendarAction(action:CalendarAction, expectedStatus:CalendarAction['status']|null):Promise<CalendarAction> | CalendarAction;
}
export function proposalHash(action:Pick<CalendarAction,'id'|'version'|'tool'|'draft'|'accountEmail'|'calendar'|'eventId'|'expiresAt'|'target'|'workflow'|'voice'>) {
  return createHash('sha256').update(JSON.stringify({id:action.id,version:action.version,tool:action.tool,draft:eventDraftSchema.parse(action.draft),accountEmail:action.accountEmail,calendar:action.calendar,eventId:action.eventId,expiresAt:action.expiresAt,...(action.target?{target:action.target,workflow:action.workflow}:{}),...(action.voice?{voice:action.voice}:{})})).digest('hex');
}
export function eventBody(action:CalendarAction) {
  const t=action.draft.time;
  if(action.tool==='calendar.update'){if(t.kind!=='timed')throw new AppError('invalid_input','Only timed event updates are supported.');return {start:{dateTime:t.start,timeZone:action.draft.timezone},end:{dateTime:t.end,timeZone:action.draft.timezone}};}
  return {id:action.eventId,summary:action.draft.title,
    start:t.kind==='allDay'?{date:t.startDate}:{dateTime:t.start,timeZone:action.draft.timezone},
    end:t.kind==='allDay'?{date:t.endDate}:{dateTime:t.end,timeZone:action.draft.timezone},
    visibility:'private',transparency:'opaque',reminders:{useDefault:false},
    extendedProperties:{private:{momoProposal:action.id,momoHash:action.hash}}};
}
function matches(raw:unknown, action:CalendarAction):boolean {
  const value=raw as {id?:string;status?:string;summary?:string;start?:{date?:string;dateTime?:string};end?:{date?:string;dateTime?:string};extendedProperties?:{private?:Record<string,string>}}|null;
  const t=action.draft.time;
  return !!value && value.id===action.eventId && value.status!=='cancelled' && value.summary===action.draft.title
    && (action.tool==='calendar.update' || value.extendedProperties?.private?.momoProposal===action.id && value.extendedProperties.private.momoHash===action.hash)
    && (t.kind==='allDay' ? value.start?.date===t.startDate && value.end?.date===t.endDate
      : +new Date(value.start?.dateTime??'')===+new Date(t.start) && +new Date(value.end?.dateTime??'')===+new Date(t.end));
}
export class CalendarActionService {
  private busy=false;
  private workflowValidator?: (action:CalendarAction)=>Promise<()=>boolean>;
  setWorkflowValidator(validate:(action:CalendarAction)=>Promise<()=>boolean>){this.workflowValidator=validate;}
  private async validateWorkflow(action:CalendarAction){if(action.tool==='calendar.create')return()=>true;if(!this.workflowValidator)throw new AppError('permission_denied','The linked workflow validator is unavailable.');return this.workflowValidator(action);}
  private async exactTarget(action:CalendarAction){
    if(action.tool!=='calendar.update')return;
    const raw=await this.google.findApprovedEvent(action.draft.accountId,action.eventId),event=normalizeEvent(raw);
    if(!event||hash(event)!==action.target!.revision||event.etag!==action.target!.etag)throw new AppError('permission_denied','The exact event changed. Replan before preparing another update.');
  }
  private reviews=new Map<string,{id:string;hash:string;epoch:number;until:number}>();
  constructor(private storage:ActionStorage,private google:Pick<GoogleService,'state'|'calendarEpoch'|'insertApprovedEvent'|'findApprovedEvent'>&Partial<Pick<GoogleService,'updateApprovedEvent'>>,private now=Date.now,private dispatchAllowed=()=>true) {}
  private async existing(id:string) { const action=(await this.storage.calendarActions()).find(a=>a.id===id); if(!action) throw new AppError('invalid_input','This calendar proposal is unavailable.'); if(proposalHash(action)!==action.hash) throw new AppError('permission_denied','This proposal changed. It cannot be approved.'); return action; }
  private async account(action:CalendarAction, write=false) {
    const state=await this.google.state(); const account=state.accounts.find(a=>a.id===action.draft.accountId && a.status==='connected');
    if(!account || state.activeAccountId!==account.id || account.email!==action.accountEmail) throw new AppError('permission_denied','Choose the original connected Google account before continuing.');
    if(write && !account.calendarWrite) throw new AppError('permission_denied','Enable Calendar event creation for this account in Settings, then review again.');
  }
  private async review(action:CalendarAction):Promise<CalendarReview> {
    await this.account(action);
    if(action.status!=='pending' || +new Date(action.expiresAt)<=this.now()) throw new AppError('conflict','This proposal is no longer awaiting approval. Create a new draft if needed.');
    await this.validateWorkflow(action);await this.exactTarget(action);
    this.reviews.clear(); const nonce=randomUUID(); this.reviews.set(nonce,{id:action.id,hash:action.hash,epoch:this.google.calendarEpoch(),until:Math.min(+new Date(action.expiresAt),this.now()+120000)});
    return {action,nonce};
  }
  async command(raw:CalendarActionCommand, voice?:{provenance:NonNullable<CalendarAction['voice']>;guard:()=>Promise<void>}):Promise<CalendarActionResult> {
    const command=calendarActionCommandSchema.parse(raw);
    if(command.action==='list') return {actions:await this.storage.calendarActions(),review:null};
    if(this.busy) throw new AppError('conflict','A calendar action is already in progress.');
    this.busy=true;
    try {
      let review:CalendarReview|null=null;
      if(command.action==='prepareUpdate'){
        if(!this.google.updateApprovedEvent)throw new AppError('unavailable','Calendar updates are unavailable.');
        const state=await this.google.state(),account=state.accounts.find(a=>a.id===command.draft.accountId&&a.status==='connected');
        if(!account||state.activeAccountId!==account.id)throw new AppError('permission_denied','Choose the original connected account.');
        const raw=await this.google.findApprovedEvent(account.id,command.eventId),event=normalizeEvent(raw);
        if(!event||event.id!==command.eventId||hash(event)!==command.expectedRevision||!event.etag||event.time.kind!=='timed'||event.title!==command.draft.title)throw new AppError('conflict','The exact native event changed or cannot be verified.');
        const base={id:randomUUID(),version:1 as const,tool:'calendar.update' as const,draft:command.draft,accountEmail:account.email,calendar:'primary' as const,eventId:event.id,target:{revision:command.expectedRevision,etag:event.etag,start:event.time.start,end:event.time.end},workflow:command.workflow,createdAt:new Date(this.now()).toISOString(),expiresAt:new Date(this.now()+900000).toISOString(),status:'pending' as const,approvedAt:null,finishedAt:null,detail:'Time change prepared locally. Calendar approval and email approval are separate.'};
        const action=calendarActionSchema.parse({...base,hash:proposalHash(base)});
        await this.validateWorkflow(action);await this.storage.putCalendarAction(action,null);review=await this.review(action);
      } else if(command.action==='prepare') {
        if(voice){await voice.guard();const actions=await this.storage.calendarActions();if(actions.some(a=>a.voice&&(a.voice.sessionId===voice.provenance.sessionId||a.draft.accountId===command.draft.accountId&&['unknown','dispatching'].includes(a.status))))throw new AppError('permission_denied','Only one calendar submission is allowed per call. Check any previous uncertain outcome before calling again.');}
        const state=await this.google.state(); const account=state.accounts.find(a=>a.id===command.draft.accountId && a.status==='connected');
        if(!account || state.activeAccountId!==account.id) throw new AppError('permission_denied','Choose a connected Google account first.');
        const base={id:randomUUID(),version:1 as const,tool:'calendar.create' as const,draft:command.draft,accountEmail:account.email,calendar:'primary' as const,eventId:'momo'+randomUUID().replaceAll('-',''),createdAt:new Date(this.now()).toISOString(),expiresAt:new Date(this.now()+900000).toISOString(),status:'pending' as const,approvedAt:null,finishedAt:null,detail:'Awaiting your approval. No event has been sent.'};
        const bound={...base,...(voice?{voice:voice.provenance}:{})};
        const action=calendarActionSchema.parse({...bound,hash:proposalHash(bound)});
        await this.storage.putCalendarAction(action,null); review=await this.review(action);
      } else {
        const action=await this.existing(command.id);
        if(command.action==='review') review=await this.review(action);
        else if(command.action==='deny') {
          await this.account(action); await this.storage.putCalendarAction({...action,status:'denied',finishedAt:new Date(this.now()).toISOString(),detail:'Declined. No event was sent.'},'pending'); this.reviews.clear();
        } else if(command.action==='approve') {
          if(action.voice&&(!voice||JSON.stringify(voice.provenance)!==JSON.stringify(action.voice)))throw new AppError('permission_denied','This event requires its exact live Voice confirmation.');
          await voice?.guard();
          if(!this.dispatchAllowed())throw new AppError('permission_denied','Global pause is on.');
          const ticket=this.reviews.get(command.nonce); this.reviews.delete(command.nonce);
          if(!ticket || ticket.id!==action.id || ticket.hash!==command.hash || command.hash!==action.hash || ticket.until<=this.now() || ticket.epoch!==this.google.calendarEpoch()) throw new AppError('permission_denied','This review expired or the account changed. Review the proposal again.');
          if(+new Date(action.expiresAt)<=this.now()) throw new AppError('permission_denied','The proposal expired. Create a new draft.');
          await this.account(action,true);
          const workflowValid=await this.validateWorkflow(action);await this.exactTarget(action);
          if(!workflowValid())throw new AppError('permission_denied','The scheduling workflow changed before dispatch.');
          // Atomic pending -> dispatching is the one-use approval and write reservation.
          // Once persisted, even a crash before the HTTP request becomes unknown, never retried.
          const reserved=await this.storage.putCalendarAction({...action,status:'dispatching',approvedAt:new Date(this.now()).toISOString(),detail:action.tool==='calendar.update'?'Approval consumed. Updating the exact event…':'Approval consumed. Creating the event…'},'pending');
          try {
            const valid=()=>this.dispatchAllowed() && workflowValid() && this.now()<ticket.until && this.now()<+new Date(action.expiresAt);
            const raw=action.tool==='calendar.update'?await this.google.updateApprovedEvent!(action.draft.accountId,action.eventId,action.target!.etag,eventBody(action),ticket.epoch,valid):await this.google.insertApprovedEvent(action.draft.accountId,eventBody(action),ticket.epoch,valid,voice?.guard);
            await this.finish(reserved,matches(raw,action)?'succeeded':'unknown',matches(raw,action)?(action.tool==='calendar.update'?'Updated the exact event in your primary calendar. Email remains separately approved.':'Created in your primary calendar.'):'Google replied, but the event could not be verified. Check its outcome before creating another.');
          } catch(error) {
            const rejected=error instanceof GoogleHttpError && [400,401,403,404,409,412,422,429].includes(error.status) || error instanceof AppError && error.code==='permission_denied';
            await this.finish(reserved,rejected?'failed':'unknown',rejected?'Google calendar change was blocked or rejected. No automatic retry was made.':'The outcome is uncertain. Check outcome to look up the same event; MoMo will not submit it again.');
          }
        } else if(command.action==='reconcile') {
          if(action.status!=='unknown') throw new AppError('conflict','Only an uncertain outcome needs checking.');
          await this.account(action);
          try {
            const raw=await this.google.findApprovedEvent(action.draft.accountId,action.eventId);
            await this.finish(action,matches(raw,action)?'succeeded':'unknown',matches(raw,action)?'Verified in Google Calendar. No new event was submitted.':'The stored event does not match this proposal. Check Google Calendar before creating another.');
          } catch { await this.finish(action,'unknown','The event could not be confirmed. It may be absent, delayed, removed, or inaccessible. No new event was submitted.'); }
        }
      }
      return {actions:await this.storage.calendarActions(),review};
    } finally {this.busy=false;}
  }
  private finish(action:CalendarAction,status:CalendarAction['status'],detail:string) { return this.storage.putCalendarAction({...action,status,detail,finishedAt:new Date(this.now()).toISOString()},action.status); }
}
