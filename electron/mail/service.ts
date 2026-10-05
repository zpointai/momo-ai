import {threadRevision} from './thread';
import { createHash,randomUUID } from 'node:crypto';
import { z } from 'zod';
import { localMailDraftSchema,mailActionSchema,mailCommandSchema,mailResultSchema,type LocalMailDraft,type MailAction,type MailCommand,type MailResult } from '../../src/shared/mail';
import type { GoogleService } from '../google/service';
import { GoogleHttpError } from '../google/http';
import type { StorageClient } from '../storage/client';
import { AppError } from '../errors';
import { addresses,messageIdFor,mimeMessage,recipients,replyFields } from './mime';
type Store=Pick<StorageClient,'mail'>;
type Google=Pick<GoogleService,'state'|'calendarEpoch'|'readMailMessage'|'readMailThread'|'writeMail'|'findSentMessage'>;
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export class MailService {
 private workflowValidator:((draft:LocalMailDraft)=>Promise<()=>boolean>)|undefined;
 setWorkflowValidator(validate:(draft:LocalMailDraft)=>Promise<()=>boolean>){this.workflowValidator=validate;}
 private async validateWorkflow(draft:LocalMailDraft){
  if(draft.provenance?.workflow!=='inbox-planner-v1')return()=>true;
  if(!this.workflowValidator)throw new AppError('permission_denied','Scheduling evidence validation is unavailable. No remote action is authorized.');
  return this.workflowValidator(draft);
 }
 private remoteInFlight:{accountId:string;id:string}|null=null;
 private queue:Promise<unknown>=Promise.resolve();private pending=0;private approvals=new Map<string,{nonce:string;hash:string;epoch:number;expires:number}>();
 constructor(private storage:Store,private google:Google,private writesAllowed:()=>boolean=()=>true,private now=Date.now){}
 command(raw:MailCommand,checkAuthority?:()=>Promise<void>):Promise<MailResult>{const c=mailCommandSchema.parse(raw);if(c.action==='discardLocal'&&this.remoteInFlight?.accountId===c.accountId&&this.remoteInFlight.id===c.id)throw new AppError('conflict','A Gmail save or send is still in progress. Wait and inspect Recent mail activity before discarding.');if(this.pending>=30)throw new AppError('unavailable','Mail work is busy. Wait for the current save.');this.pending++;const job=this.queue.then(async()=>{try{return await this.execute(c,checkAuthority);}finally{this.remoteInFlight=null;}});this.queue=job.catch(()=>undefined);return job.finally(()=>{this.pending--;});}
 private async account(id:string,selected=true){const state=await this.google.state();const account=state.accounts.find(a=>a.id===id);if(!account||selected&&state.activeAccountId!==id)throw new AppError('permission_denied','Select the original mail account.');return{account,state};}
 private async draft(id:string,accountId:string){const d=localMailDraftSchema.nullable().parse(await this.storage.mail('draft',id));if(!d||d.accountId!==accountId)throw new AppError('permission_denied','Draft is unavailable for this account.');return d;}
 private async action(id:string,accountId:string){const a=mailActionSchema.nullable().parse(await this.storage.mail('action',id));if(!a||a.accountId!==accountId)throw new AppError('permission_denied','Mail action is unavailable for this account.');return a;}
 private async result(accountId:string,extra:Partial<MailResult>={}){return mailResultSchema.parse({drafts:await this.storage.mail('drafts',accountId),actions:await this.storage.mail('actions',accountId),thread:null,review:null,...extra});}
 private async saveDraft(d:LocalMailDraft,patch:Partial<LocalMailDraft>){return localMailDraftSchema.parse(await this.storage.mail('saveDraft',{draft:{...d,...patch,revision:d.revision+1,updatedAt:new Date(this.now()).toISOString()},revision:d.revision}));}
 private async saveAction(a:MailAction,patch:Partial<MailAction>){return mailActionSchema.parse(await this.storage.mail('saveAction',{action:{...a,...patch},status:a.status}));}
 private async intent(accountId:string,kind:MailAction['kind'],details:Partial<MailAction>):Promise<MailAction>{
  const record={id:randomUUID(),accountId,kind,scope:'message',messageId:null,draftId:null,draftRevision:null,draft:null,createdAt:new Date(this.now()).toISOString(),expiresAt:new Date(this.now()+120000).toISOString(),status:'pending',detail:'Ready for this exact action.',previousLabels:[],expectedLabels:[],resultId:null,undoOf:null,...details};
  return mailActionSchema.parse(await this.storage.mail('saveAction',{action:{...record,hash:digest(record)},status:null}));
 }
 private async dispatch(a:MailAction,kind:Parameters<Google['writeMail']>[1],input:Parameters<Google['writeMail']>[2],epoch:number,valid:()=>boolean){
  a=await this.saveAction(a,{status:'dispatching',detail:'Dispatching the requested action.'});let dispatched=false;
  try{
   const response=await this.google.writeMail(a.accountId,kind,input,epoch,()=>{if(!this.writesAllowed()||!valid()||this.now()>=+new Date(a.expiresAt))return false;dispatched=true;return true;});
   const value=z.object({id:z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),message:z.object({id:z.string().optional()}).optional()}).parse(response);
   if(!['send','saveDraft'].includes(kind)&&value.id!==a.messageId)throw new Error('Mismatched action response');
   return this.saveAction(a,{status:'succeeded',resultId:value.id,detail:kind==='send'?'Sent by Gmail.':kind==='saveDraft'?'Draft saved to Gmail.':kind==='trash'?'This message was moved to Trash.':kind==='restore'?'This message was restored from Trash.':'The requested message change was confirmed by Gmail.'});
  }catch(error){
   // A rejected request is known not to have succeeded. Transport loss, cancellation after dispatch,
   // server errors and malformed success responses are uncertain and must never replay automatically.
   const known=!dispatched||error instanceof GoogleHttpError&&[400,401,403,404,429].includes(error.status);
   return this.saveAction(a,{status:known?'failed':'unknown',detail:known?(error instanceof AppError?error.message:'Gmail rejected the action.'):'Outcome unknown. No automatic retry. Check Gmail or use the read-only outcome check.'});
  }
 }
 private async execute(c:MailCommand,checkAuthority?:()=>Promise<void>):Promise<MailResult>{
  const {account,state}=await this.account(c.accountId,c.action!=='saveLocal');
  if(c.action==='list')return this.result(c.accountId);
  if(c.action==='thread'){const thread=await this.google.readMailThread(c.accountId,c.id);return this.result(c.accountId,{thread:{...thread,revision:threadRevision(thread)}});}
  if(c.action==='discardLocal'){
   // Runs in the existing mail queue; storage atomically checks the exact revision,
   // fences the identity, and denies unused send intents without touching Gmail.
   await this.account(c.accountId);
   const invalidated=z.array(z.string()).parse(await this.storage.mail('discardDraft',c));
   for(const id of invalidated)this.approvals.delete(id);
   return this.result(c.accountId);
  }
  if(c.action==='compose'){
   const existing=localMailDraftSchema.nullable().parse(await this.storage.mail('draft',c.id));if(existing){if(existing.accountId!==c.accountId)throw new AppError('conflict','Draft ID belongs to another account.');return this.result(c.accountId);}
   let fields={to:'',cc:'',bcc:'',subject:'',body:c.body??''};let threadId:string|null=null;let inReplyTo:string|null=null;let references='';
   if(c.mode!=='compose'){
    if(!c.sourceMessageId)throw new AppError('invalid_input','Select a source message.');const thread=c.grounding?await this.google.readMailThread(c.accountId,c.grounding.threadId):null;
    if(c.grounding&&(!thread||thread.accountId!==c.accountId||thread.id!==c.grounding.threadId||threadRevision(thread)!==c.grounding.threadRevision))throw new AppError('conflict','The reply thread changed. Review it and draft again.');
    const message=thread?thread.messages.find(m=>m.message.id===c.sourceMessageId):await this.google.readMailMessage(c.accountId,c.sourceMessageId);await this.account(c.accountId);
    if(!message)throw new AppError('conflict','The source message is no longer in this thread.');
    fields=replyFields(message,c.mode,state.accounts.map(a=>a.email));if(c.body!==undefined)fields.body=c.body;
    if(c.mode!=='forward'){threadId=message.message.threadId;inReplyTo=message.headers.messageId;references=message.headers.references;if(!/^<[^<>\s@]+@[^<>\s]+>$/.test(inReplyTo))throw new AppError('invalid_input','This message has no safe reply identifier. Start a new message instead.');}
   }
   await this.account(c.accountId);await checkAuthority?.();
   const at=new Date(this.now()).toISOString();const draft=localMailDraftSchema.parse({id:c.id,accountId:c.accountId,...(c.grounding?{provenance:{runId:c.grounding.runId,threadRevision:c.grounding.threadRevision,...(c.grounding.workflow?{workflow:c.grounding.workflow}:{})}}:{}),from:account.email,mode:c.mode,sourceMessageId:c.sourceMessageId??null,threadId,inReplyTo,references,fields,revision:0,contentRevision:0,createdAt:at,updatedAt:at,status:'local',remoteDraftId:null,remoteRevision:null,sentMessageId:null});await this.storage.mail('saveDraft',{draft,revision:null});return this.result(c.accountId);
  }
  if(c.action==='saveLocal'){
   const draft=await this.draft(c.id,c.accountId);if(draft.revision!==c.expectedRevision||['sending','sent','unknown'].includes(draft.status))throw new AppError('conflict','Draft changed or its send outcome needs checking.');
   this.approvals.forEach((_,id)=>{this.approvals.delete(id);});
   await this.saveDraft(draft,{fields:c.fields,contentRevision:draft.contentRevision+1,status:'local'});return this.result(c.accountId);
  }
  if(c.action==='saveRemote'||c.action==='prepareSend'){
   const draft=await this.draft(c.id,c.accountId);if(draft.revision!==c.expectedRevision||['sending','sent','unknown'].includes(draft.status))throw new AppError('conflict','Draft changed or its outcome needs checking.');
   const workflowValid=await this.validateWorkflow(draft);if(!workflowValid())throw new AppError('permission_denied','Scheduling work was cancelled or changed.');
   const prior=await this.storage.mail('actions',c.accountId) as MailAction[];
   if(prior.some(a=>a.draftId===draft.id&&a.draft?.contentRevision===draft.contentRevision&&(['dispatching','unknown'].includes(a.status)||a.status==='succeeded'&&(a.kind==='send'||a.kind==='saveDraft'&&a.resultId!==draft.remoteDraftId))))throw new AppError('conflict','A previous remote operation needs recovery. Restart MoMo and inspect its outcome before repeating.');
   if(!this.writesAllowed())throw new AppError('permission_denied','Mail writes are paused or this workspace is disabled.');
   if(c.action==='saveRemote'){
    if(!account.mailCompose)throw new AppError('permission_denied','Enable Gmail draft access in Settings. Local drafts still work.');
    this.remoteInFlight={accountId:c.accountId,id:draft.id};const raw=mimeMessage(draft,false);const a=await this.intent(c.accountId,'saveDraft',{draftId:draft.id,draftRevision:draft.revision,draft});const epoch=this.google.calendarEpoch();
    const outcome=await this.dispatch(a,'saveDraft',{...(draft.remoteDraftId?{id:draft.remoteDraftId}:{}),raw,...(draft.threadId?{threadId:draft.threadId}:{})},epoch,workflowValid);
    if(outcome.status==='succeeded')await this.saveDraft(draft,{remoteDraftId:outcome.resultId,remoteRevision:draft.contentRevision,status:'remote'});else if(outcome.status==='unknown')await this.saveDraft(draft,{status:'unknown'});return this.result(c.accountId);
   }
   if(!account.mailSend)throw new AppError('permission_denied','Enable Gmail sending access in Settings.');recipients(draft.fields);mimeMessage(draft);
   if(draft.remoteDraftId&&draft.remoteRevision!==draft.contentRevision)throw new AppError('conflict','Save the latest revision to Gmail before sending this remote draft.');
   const existing=(await this.storage.mail('actions',c.accountId) as MailAction[]).find(a=>a.kind==='send'&&a.draftId===draft.id&&a.draftRevision===draft.revision&&a.status==='pending'&&+new Date(a.expiresAt)>this.now());
   const action=existing??await this.intent(c.accountId,'send',{draftId:draft.id,draftRevision:draft.revision,draft});const nonce=randomUUID();this.approvals.set(action.id,{nonce,hash:action.hash,epoch:this.google.calendarEpoch(),expires:this.now()+120000});return this.result(c.accountId,{review:{action,nonce}});
  }
  if(c.action==='approveSend'){
   const a=await this.action(c.id,c.accountId);const approval=this.approvals.get(a.id);this.approvals.delete(a.id);const draft=a.draftId?await this.draft(a.draftId,c.accountId):null;
   if(!approval||approval.nonce!==c.nonce||approval.hash!==c.hash||a.hash!==c.hash||approval.expires<=this.now()||a.status!=='pending'||a.kind!=='send'||!draft||draft.revision!==a.draftRevision||JSON.stringify(draft)!==JSON.stringify(a.draft)||!account.mailSend)throw new AppError('permission_denied','The exact send review expired, changed, or was already used. Review again.');
   const workflowValid=await this.validateWorkflow(draft);if(!workflowValid())throw new AppError('permission_denied','Scheduling work was cancelled or changed.');
   this.remoteInFlight={accountId:c.accountId,id:draft.id};const sending=await this.saveDraft(draft,{status:'sending'});const outcome=await this.dispatch(a,'send',{...(draft.remoteDraftId?{id:draft.remoteDraftId}:{}),raw:mimeMessage(draft),...(draft.threadId?{threadId:draft.threadId}:{})},approval.epoch,()=>this.now()<approval.expires&&workflowValid());
   await this.saveDraft(sending,{status:outcome.status==='succeeded'?'sent':outcome.status==='unknown'?'unknown':draft.remoteDraftId?'remote':'local',sentMessageId:outcome.status==='succeeded'?outcome.resultId:null});return this.result(c.accountId);
  }
  if(c.action==='deny'){const a=await this.action(c.id,c.accountId);this.approvals.delete(c.id);await this.saveAction(a,{status:'denied',detail:'Declined by you. No dispatch.'});return this.result(c.accountId);}
  if(c.action==='modify'||c.action==='undo'){
   if(!account.mailModify)throw new AppError('permission_denied','Enable Gmail message management in Settings.');if(!this.writesAllowed())throw new AppError('permission_denied','Mail writes are paused.');
   const old=c.action==='undo'?await this.action(c.id,c.accountId):null;if(old&&(old.status!=='succeeded'||!['archive','read','unread','trash'].includes(old.kind)||!old.messageId))throw new AppError('permission_denied','Only a confirmed supported message change can be undone.');
   const messageId=old?.messageId??c.id;const source=await this.google.readMailMessage(c.accountId,messageId);await this.account(c.accountId);const previous=[...source.labels];const relevant=(a:string[])=>a.filter(l=>['INBOX','UNREAD','TRASH'].includes(l)).sort().join(',');
   if(old&&relevant(previous)!==relevant(old.expectedLabels))throw new AppError('conflict','Message labels changed since that action. Review the current message.');
   const kind=c.action==='modify'?c.kind:old!.kind==='trash'?'restore':'undo';let expected=[...previous];
   if(kind==='archive')expected=expected.filter(l=>l!=='INBOX');if(kind==='read')expected=expected.filter(l=>l!=='UNREAD');if(kind==='unread'&&!expected.includes('UNREAD'))expected.push('UNREAD');if(kind==='trash'){expected=expected.filter(l=>l!=='INBOX');if(!expected.includes('TRASH'))expected.push('TRASH');}if(kind==='restore')expected=expected.filter(l=>l!=='TRASH');
   if(kind==='undo'){const changed=old!.kind==='archive'?'INBOX':'UNREAD';expected=expected.filter(l=>l!==changed);if(old!.previousLabels.includes(changed))expected.push(changed);}
   const a=await this.intent(c.accountId,c.action==='undo'?'undo':kind as MailAction['kind'],{messageId,previousLabels:previous,expectedLabels:expected,undoOf:old?.id??null});
   const epoch=this.google.calendarEpoch();await this.dispatch(a,kind,{id:messageId,add:expected.filter(l=>!previous.includes(l)),remove:previous.filter(l=>!expected.includes(l))},epoch,()=>true);return this.result(c.accountId);
  }
  if(c.action==='reconcile'){
   let a=await this.action(c.id,c.accountId);if(a.status!=='unknown')return this.result(c.accountId);
   if(a.kind==='send'&&a.draft){const found=await this.google.findSentMessage(c.accountId,messageIdFor(a.draft));if(found.messages.length===1){const m=await this.google.readMailMessage(c.accountId,found.messages[0].id);const expected=recipients(a.draft.fields);const same=(a:string[],b:string[])=>a.sort().join(',')===b.sort().join(',');const body=(s:string)=>s.replace(/\r\n/g,'\n').replace(/\n$/,'');if(m.labels.includes('SENT')&&m.headers.messageId===messageIdFor(a.draft)&&m.message.subject===a.draft.fields.subject&&same(addresses(m.message.to),expected.to)&&same(addresses(m.headers.cc),expected.cc)&&same(addresses(m.message.from),[a.draft.from.toLowerCase()])&&m.textAvailable&&!m.truncated&&body(m.text)===body(a.draft.fields.body)){a=await this.saveAction(a,{status:'succeeded',resultId:m.message.id,detail:'Sent message matched by unique Message-ID, sender, To/Cc, subject and plain-text body. Gmail does not return Bcc in this view.'});const d=await this.draft(a.draftId!,c.accountId);await this.saveDraft(d,{status:'sent',sentMessageId:m.message.id});}}}
   else if(a.messageId&&a.kind!=='saveDraft'){const m=await this.google.readMailMessage(c.accountId,a.messageId);const relevant=(values:string[])=>values.filter(l=>['INBOX','UNREAD','TRASH'].includes(l)).sort().join(',');if(relevant(m.labels)===relevant(a.expectedLabels))await this.saveAction(a,{status:'succeeded',resultId:m.message.id,detail:'The message now has the requested label state; this does not prove which client changed it.'});}
   return this.result(c.accountId);
  }
  throw new AppError('invalid_input','Unknown mail operation.');
 }
}
