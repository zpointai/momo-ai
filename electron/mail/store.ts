import type Database from 'better-sqlite3';
import { discardLocalDraftSchema,draftDiscardBlock,localMailDraftSchema,mailActionSchema,type MailAction } from '../../src/shared/mail';
import { AppError } from '../errors';
export class MailRepository{
 constructor(private db:Database.Database){}
 drafts(accountId:string){return(this.db.prepare('SELECT payload FROM mail_drafts WHERE account_id=? ORDER BY rowid DESC LIMIT 200').all(accountId) as {payload:string}[]).map(r=>localMailDraftSchema.parse(JSON.parse(r.payload)));}
 actions(accountId:string){return(this.db.prepare('SELECT payload FROM mail_actions WHERE account_id=? ORDER BY rowid DESC LIMIT 500').all(accountId) as {payload:string}[]).map(r=>mailActionSchema.parse(JSON.parse(r.payload)));}
 draft(id:string){const row=this.db.prepare('SELECT payload FROM mail_drafts WHERE id=?').get(id) as {payload:string}|undefined;return row?localMailDraftSchema.parse(JSON.parse(row.payload)):null;}
 action(id:string){const row=this.db.prepare('SELECT payload FROM mail_actions WHERE id=?').get(id) as {payload:string}|undefined;return row?mailActionSchema.parse(JSON.parse(row.payload)):null;}
 saveDraft(raw:unknown,revision:number|null){const next=localMailDraftSchema.parse(raw);return this.db.transaction(()=>{
  if(this.db.prepare('SELECT id FROM mail_discard_receipts WHERE id=?').get(next.id))throw new AppError('conflict','This local draft was discarded. Start a new draft instead.');
  const old=this.draft(next.id);if(!old){if(revision!==null||next.revision!==0)throw new AppError('conflict','Draft no longer exists.');if(this.drafts(next.accountId).length>=200)throw new AppError('unavailable','Local draft limit reached.');this.db.prepare('INSERT INTO mail_drafts VALUES (?, ?, ?)').run(next.id,next.accountId,JSON.stringify(next));}
  else{if(old.revision!==revision||next.revision!==old.revision+1||old.accountId!==next.accountId||old.from!==next.from||old.sourceMessageId!==next.sourceMessageId||old.threadId!==next.threadId||old.inReplyTo!==next.inReplyTo||old.references!==next.references||JSON.stringify(old.provenance)!==JSON.stringify(next.provenance))throw new AppError('conflict','Draft changed. Reload before saving.');if(['sent','unknown'].includes(old.status)&&JSON.stringify(old.fields)!==JSON.stringify(next.fields))throw new AppError('conflict','Resolve this draft’s send outcome before editing it.');this.db.prepare('UPDATE mail_drafts SET payload=? WHERE id=?').run(JSON.stringify(next),next.id);}
  return next;
 })();}
 saveAction(raw:unknown,status:MailAction['status']|null){const next=mailActionSchema.parse(raw);return this.db.transaction(()=>{
  const old=this.action(next.id);if(!old){if(status!==null||next.status!=='pending')throw new AppError('conflict','Invalid mail action.');if(this.actions(next.accountId).length>=500)throw new AppError('unavailable','Mail action history is full.');this.db.prepare('INSERT INTO mail_actions VALUES (?, ?, ?)').run(next.id,next.accountId,JSON.stringify(next));}
  else{const identity=(a:MailAction)=>JSON.stringify({...a,status:null,detail:null,resultId:null});const transitions:Record<string,string[]>={pending:['dispatching','denied','expired'],dispatching:['succeeded','failed','unknown'],unknown:['succeeded','unknown']};if(old.status!==status||identity(old)!==identity(next)||!transitions[old.status]?.includes(next.status))throw new AppError('conflict','Mail action changed or was already handled.');this.db.prepare('UPDATE mail_actions SET payload=? WHERE id=?').run(JSON.stringify(next),next.id);}
  this.db.prepare('INSERT INTO mail_action_audit (action_id,at,status,payload_hash) VALUES (?,?,?,?)').run(next.id,new Date().toISOString(),next.status,next.hash);return next;
 })();}
 discardDraft(raw:unknown):string[]{const c=discardLocalDraftSchema.parse(raw);return this.db.transaction(()=>{
  const receipt=this.db.prepare('SELECT account_id,revision FROM mail_discard_receipts WHERE id=?').get(c.id) as {account_id:string;revision:number}|undefined;
  if(receipt){if(receipt.account_id===c.accountId&&receipt.revision===c.expectedRevision)return [];throw new AppError('conflict','This discard confirmation no longer matches a local draft.');}
  const draft=this.draft(c.id);
  if(!draft||draft.accountId!==c.accountId)throw new AppError('permission_denied','Draft is unavailable for this account.');
  if(draft.revision!==c.expectedRevision)throw new AppError('conflict','The draft changed after this confirmation opened. Keep it, reopen the latest draft, and review discard again.');
  const actions=(this.db.prepare("SELECT payload FROM mail_actions WHERE account_id=? AND json_extract(payload,'$.draftId')=? ORDER BY rowid DESC").all(c.accountId,c.id) as {payload:string}[]).map(r=>mailActionSchema.parse(JSON.parse(r.payload)));
  const blocked=draftDiscardBlock(draft,actions);if(blocked)throw new AppError('conflict',blocked);
  const unused=actions.filter(a=>a.kind==='send'&&a.status==='pending');
  for(const a of unused)this.saveAction({...a,status:'denied',detail:'Local draft discarded. This unused send approval cannot dispatch.'},'pending');
  this.db.prepare('INSERT INTO mail_discard_receipts VALUES (?,?,?,?)').run(c.id,c.accountId,c.expectedRevision,new Date().toISOString());
  const deleted=this.db.prepare("DELETE FROM mail_drafts WHERE id=? AND account_id=? AND json_extract(payload,'$.revision')=?").run(c.id,c.accountId,c.expectedRevision);
  if(deleted.changes!==1)throw new AppError('conflict','Draft changed. Nothing was discarded.');
  return unused.map(a=>a.id);
 })();}
 recover(){this.db.transaction(()=>{
  for(const r of this.db.prepare("SELECT payload FROM mail_actions WHERE json_extract(payload,'$.status')='dispatching'").all() as {payload:string}[]){const a=mailActionSchema.parse(JSON.parse(r.payload));this.saveAction({...a,status:'unknown',detail:'MoMo stopped during dispatch. No automatic retry. Inspect the outcome before repeating.'},'dispatching');}
  // Repair a crash between recording the outcome and updating its draft. Never recreate a
  // remote draft or resend because the local metadata update was interrupted.
  for(const r of this.db.prepare('SELECT payload FROM mail_actions ORDER BY rowid').all() as {payload:string}[]){
   const a=mailActionSchema.parse(JSON.parse(r.payload));if(!a.draftId||!a.draft||!['send','saveDraft'].includes(a.kind))continue;
   const d=this.draft(a.draftId);if(!d||d.contentRevision!==a.draft.contentRevision||d.status==='sent')continue;
   if(a.status==='unknown'&&d.status!=='unknown')this.saveDraft({...d,revision:d.revision+1,status:'unknown'},d.revision);
   if(a.status==='succeeded'&&a.resultId){
    if(a.kind==='send')this.saveDraft({...d,revision:d.revision+1,status:'sent',sentMessageId:a.resultId},d.revision);
    else if(d.remoteDraftId!==a.resultId||d.remoteRevision!==d.contentRevision)this.saveDraft({...d,revision:d.revision+1,status:'remote',remoteDraftId:a.resultId,remoteRevision:d.contentRevision},d.revision);
   }
  }
  for(const r of this.db.prepare("SELECT payload FROM mail_drafts WHERE json_extract(payload,'$.status')='sending'").all() as {payload:string}[]){const d=localMailDraftSchema.parse(JSON.parse(r.payload));this.saveDraft({...d,revision:d.revision+1,status:'unknown'},d.revision);}
 })();}
 execute(operation:string,input:unknown):unknown{if(operation==='discardDraft')return this.discardDraft(input);if(operation==='drafts')return this.drafts(String(input));if(operation==='actions')return this.actions(String(input));if(operation==='draft')return this.draft(String(input));if(operation==='action')return this.action(String(input));if(operation==='saveDraft'){const v=input as {draft:unknown;revision:number|null};return this.saveDraft(v.draft,v.revision);}if(operation==='saveAction'){const v=input as {action:unknown;status:MailAction['status']|null};return this.saveAction(v.action,v.status);}throw new AppError('invalid_input','Unknown mail storage operation.');}
}
