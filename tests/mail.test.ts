// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { afterEach,describe,expect,it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SettingsDatabase } from '../electron/storage/database';
import { MailService } from '../electron/mail/service';
import { addresses,mimeMessage,normalizeThreadMessage,replyFields } from '../electron/mail/mime';
import { GoogleService } from '../electron/google/service';
import { GoogleHttp,allowedGoogleRequest } from '../electron/google/http';
import { googleScopes } from '../electron/google/oauth';
import { calendarWriteScope } from '../src/shared/calendar-actions';
import { gmailComposeScope,gmailModifyScope,mailCommandSchema,type LocalMailDraft,type MailAction } from '../src/shared/mail';
import type { VaultData } from '../electron/google/vault';
const now=Date.now();const databases:SettingsDatabase[]=[];const folders:string[]=[];
afterEach(()=>{for(const d of databases.splice(0))try{d.close();}catch{/* already closed for restart */}for(const f of folders.splice(0))rmSync(f,{recursive:true,force:true});});
function source(id='m1',labels=['INBOX','UNREAD']){return{id,threadId:'t1',internalDate:String(now),snippet:'Fictional planning email',labelIds:labels,payload:{mimeType:'text/plain',headers:[{name:'From',value:'Author <author@example.test>'},{name:'To',value:'me@example.test, guest@example.test'},{name:'Cc',value:'guest@example.test, other@example.test'},{name:'Subject',value:'Fictional plan'},{name:'Message-ID',value:'<original@example.test>'}],body:{data:Buffer.from('Fictional source only.').toString('base64url')}}};}
function harness(scopes:string[]=[],filename=':memory:'){
 const db=new SettingsDatabase(filename);databases.push(db);let clock=now;let paused=false;let mode='ok';let labels=['INBOX','UNREAD'];const writes:{url:string;method:string;body:Record<string,unknown>}[]=[];
 let vault:VaultData={version:1,client:{client_id:'test.apps.googleusercontent.com'},activeAccountId:'a',accounts:['a','b'].map(id=>({id,email:id==='a'?'me@example.test':'second@example.test',status:'connected',token:{access:'synthetic',refresh:'synthetic',expiresAt:now+3600000,scopes:[...googleScopes,...scopes]}}))};
 const http=new GoogleHttp(async(url,init)=>{const u=String(url);const method=init?.method??'GET';if(method!=='GET'){writes.push({url:u,method,body:init?.body?JSON.parse(String(init.body)):{}});if(mode==='lost')throw new Error('Synthetic transport loss');if(mode==='reject')return new Response('{}',{status:403});if(u.includes('/drafts'))return new Response(JSON.stringify({id:u.endsWith('/send')?'sent1':'draft1'}));if(u.endsWith('/send'))return new Response('{"id":"sent1"}');if(u.endsWith('/trash'))labels=[...labels.filter(l=>l!=='INBOX'),'TRASH'];else if(u.endsWith('/untrash'))labels=labels.filter(l=>l!=='TRASH');else {const b=JSON.parse(String(init?.body));labels=labels.filter(l=>!b.removeLabelIds.includes(l));labels.push(...b.addLabelIds.filter((l:string)=>!labels.includes(l)));}return new Response(JSON.stringify({id:'m1',labelIds:labels}));}if(u.includes('/threads/'))return new Response(JSON.stringify({id:'t1',messages:[source()]}));return new Response(JSON.stringify(source('m1',labels)));});
 const google=new GoogleService({read:async()=>vault,write:async v=>{vault=v;}},http,async()=>{},()=>{},undefined,()=>clock);
 const service=new MailService({mail:async(op,input)=>db.mail(op,input)},google,()=>!paused,()=>clock);
 const command=(c:Record<string,unknown>)=>service.command(mailCommandSchema.parse({accountId:'a',...c}));
 async function draft(){const id=randomUUID();await command({action:'compose',id,mode:'compose'});const r=await command({action:'saveLocal',id,expectedRevision:0,fields:{to:'recipient@example.test',cc:'',bcc:'',subject:'Fictional test',body:'Synthetic plain text only.'}});return r.drafts.find(d=>d.id===id)!;}
 async function review(d:LocalMailDraft){return(await command({action:'prepareSend',id:d.id,expectedRevision:d.revision})).review!;}
 return{db,google,command,draft,review,writes,mode:(v:string)=>{mode=v;},pause:()=>{paused=true;},time:(v:number)=>{clock=v;},labels:(v:string[])=>{labels=v;}};
}
describe('native mail through the production Google transport boundary',()=>{
 it('keeps full-thread reads and local autosave usable with read-only scopes; rejects remote writes',async()=>{const h=harness();expect((await h.command({action:'thread',id:'t1'})).thread?.messages[0].text).toBe('Fictional source only.');const d=await h.draft();await expect(h.command({action:'saveRemote',id:d.id,expectedRevision:d.revision})).rejects.toThrow('draft access');await expect(h.review(d)).rejects.toThrow('sending access');await expect(h.command({action:'modify',id:'m1',scope:'message',kind:'archive'})).rejects.toThrow('management');expect(h.writes).toHaveLength(0);});
 it('uses real draft POST then PUT and sends the approved existing remote draft exactly once',async()=>{const h=harness([gmailComposeScope]);let d=await h.draft();d=(await h.command({action:'saveRemote',id:d.id,expectedRevision:d.revision})).drafts[0];expect(d.remoteDraftId).toBe('draft1');d=(await h.command({action:'saveLocal',id:d.id,expectedRevision:d.revision,fields:{...d.fields,body:'Revised fictional body.'}})).drafts[0];await expect(h.review(d)).rejects.toThrow('latest revision');d=(await h.command({action:'saveRemote',id:d.id,expectedRevision:d.revision})).drafts[0];const review=await h.review(d);const cmd={action:'approveSend',id:review.action.id,hash:review.action.hash,nonce:review.nonce};expect((await h.command(cmd)).drafts[0].status).toBe('sent');await expect(h.command(cmd)).rejects.toThrow();expect(h.writes.map(w=>w.method)).toEqual(['POST','PUT','POST']);expect(h.writes[2].url.endsWith('/drafts/send')).toBe(true);expect(h.writes[2].body).toEqual({id:'draft1',message:{raw:mimeMessage(d)}}); // Atomic send uses reviewed MIME even if another client edits the remote draft.
});
 it.each(['edit','switch','pause','expiry'])('invalidates an exact send approval after %s without a POST',async reason=>{const h=harness([gmailComposeScope]);const d=await h.draft();const r=await h.review(d);if(reason==='edit')await h.command({action:'saveLocal',id:d.id,expectedRevision:d.revision,fields:{...d.fields,to:'changed@example.test'}});if(reason==='switch'){await h.google.select('b');await h.google.select('a');}if(reason==='pause')h.pause();if(reason==='expiry')h.time(now+120001);try{await h.command({action:'approveSend',id:r.action.id,hash:r.action.hash,nonce:r.nonce});}catch{/* rejection is required; failed record is also a valid known non-dispatch */}expect(h.writes).toHaveLength(0);expect((h.db.mail('draft',d.id) as LocalMailDraft).status).not.toBe('sent');});
 it('records uncertain sends without a retry or editable duplicate draft',async()=>{const h=harness([gmailComposeScope]);const d=await h.draft();const r=await h.review(d);h.mode('lost');const result=await h.command({action:'approveSend',id:r.action.id,hash:r.action.hash,nonce:r.nonce});expect(result.actions[0].status).toBe('unknown');expect(result.drafts[0].status).toBe('unknown');await expect(h.review(result.drafts[0])).rejects.toThrow();await expect(h.command({action:'saveLocal',id:d.id,expectedRevision:result.drafts[0].revision,fields:d.fields})).rejects.toThrow();expect(h.writes).toHaveLength(1);});
 it('treats explicit Gmail rejection as a failure, without automatic retries',async()=>{const h=harness([gmailComposeScope]);const d=await h.draft();const r=await h.review(d);h.mode('reject');const result=await h.command({action:'approveSend',id:r.action.id,hash:r.action.hash,nonce:r.nonce});expect(result.actions[0].status).toBe('failed');expect(result.drafts[0].status).toBe('local');expect(h.writes).toHaveLength(1);});
 it('archives and undoes only the selected message; rejects undo after label drift',async()=>{const h=harness([gmailModifyScope]);const r=await h.command({action:'modify',scope:'message',id:'m1',kind:'archive'});const a=r.actions[0];expect(a.expectedLabels).toEqual(['UNREAD']);await h.command({action:'undo',id:a.id});expect(h.writes[1].body).toEqual({addLabelIds:['INBOX'],removeLabelIds:[]});await expect(h.command({action:'undo',id:a.id})).rejects.toThrow('changed');expect(h.writes).toHaveLength(2);});
 it('uses Trash and untrash, never permanent deletion or a thread-wide mutation',async()=>{const h=harness([gmailModifyScope]);const r=await h.command({action:'modify',scope:'message',id:'m1',kind:'trash'});await h.command({action:'undo',id:r.actions[0].id});expect(h.writes.map(w=>w.url.split('/').at(-1))).toEqual(['trash','untrash']);expect(mailCommandSchema.safeParse({action:'modify',accountId:'a',scope:'thread',id:'t1',kind:'trash'}).success).toBe(false);expect(allowedGoogleRequest('https://gmail.googleapis.com/gmail/v1/users/me/messages/m1','DELETE')).toBe(false);});
 it.each(['unknown','succeeded'])('recovers a interrupted remote-draft metadata update as %s without another create',async status=>{const folder=mkdtempSync(path.join(os.tmpdir(),'momo-mail-recovery-'));folders.push(folder);const filename=path.join(folder,'momo.sqlite');const h=harness([gmailComposeScope],filename);const d=await h.draft();const action:MailAction={id:randomUUID(),accountId:'a',kind:'saveDraft',scope:'message',messageId:null,draftId:d.id,draftRevision:d.revision,draft:d,hash:'a'.repeat(64),createdAt:new Date(now).toISOString(),expiresAt:new Date(now+120000).toISOString(),status:'pending',detail:'Synthetic',previousLabels:[],expectedLabels:[],resultId:null,undoOf:null};h.db.mail('saveAction',{action,status:null});h.db.mail('saveAction',{action:{...action,status:'dispatching'},status:'pending'});if(status==='succeeded')h.db.mail('saveAction',{action:{...action,status:'succeeded',resultId:'draft1'},status:'dispatching'});h.db.close();const restored=new SettingsDatabase(filename);databases.push(restored);const recovered=restored.mail('draft',d.id) as LocalMailDraft;expect(recovered.status).toBe(status==='unknown'?'unknown':'remote');if(status==='succeeded')expect(recovered.remoteDraftId).toBe('draft1');expect(h.writes).toHaveLength(0);});
 it('retains original-account local autosave on selection change, but prohibits remote cross-account work',async()=>{const h=harness([gmailComposeScope]);const d=await h.draft();await h.google.select('b');await h.command({action:'saveLocal',id:d.id,expectedRevision:d.revision,fields:d.fields});await expect(h.command({action:'saveRemote',id:d.id,expectedRevision:d.revision+1})).rejects.toThrow('original');expect(h.writes).toHaveLength(0);});
});
describe('isolated local-discard lifecycle (no live profile or network)',()=>{
 it('discards exactly one local identity, retains other drafts, and is idempotent',async()=>{
  const h=harness(),first=await h.draft(),other=await h.draft();const before=h.db.get();
  const c={action:'discardLocal',id:first.id,expectedRevision:first.revision};
  expect((await h.command(c)).drafts).toEqual([other]);expect((await h.command(c)).drafts).toEqual([other]);
  expect(h.db.get()).toEqual(before);expect(h.db.workspace().tasks).toEqual([]);expect(h.writes).toHaveLength(0);
  await expect(h.command({action:'compose',id:first.id,mode:'compose'})).rejects.toThrow('discarded');
  await expect(h.command({action:'saveLocal',id:first.id,expectedRevision:first.revision,fields:first.fields})).rejects.toThrow('unavailable');
  expect(h.db.mail('draft',first.id)).toBeNull();
 });
 it('rejects a stale revision and cross-account confirmation without changing either draft',async()=>{
  const h=harness(),d=await h.draft();await h.command({action:'saveLocal',id:d.id,expectedRevision:d.revision,fields:{...d.fields,subject:'Changed only in isolated test'}});
  const current=h.db.mail('draft',d.id);await expect(h.command({action:'discardLocal',id:d.id,expectedRevision:d.revision})).rejects.toThrow('changed');
  await h.google.select('b');await expect(h.command({action:'discardLocal',id:d.id,expectedRevision:d.revision+1})).rejects.toThrow('original');
  await expect(h.command({action:'discardLocal',accountId:'b',id:d.id,expectedRevision:d.revision+1})).rejects.toThrow('unavailable');expect(h.db.mail('draft',d.id)).toEqual(current);expect(h.writes).toHaveLength(0);
 });
 it('orders save/discard races by revision and never recreates a discarded identity',async()=>{
  const h=harness(),d=await h.draft();
  const save=h.command({action:'saveLocal',id:d.id,expectedRevision:d.revision,fields:{...d.fields,body:'Later isolated edit'}});
  const stale=h.command({action:'discardLocal',id:d.id,expectedRevision:d.revision});await save;await expect(stale).rejects.toThrow('changed');
  const discard=h.command({action:'discardLocal',id:d.id,expectedRevision:d.revision+1});
  const lateSave=h.command({action:'saveLocal',id:d.id,expectedRevision:d.revision+1,fields:d.fields});await discard;await expect(lateSave).rejects.toThrow('unavailable');
  await expect(h.command({action:'compose',id:d.id,mode:'compose'})).rejects.toThrow('discarded');expect(h.db.mail('draft',d.id)).toBeNull();expect(h.writes).toHaveLength(0);
 });
 it('atomically invalidates only this draft’s unused approvals, retaining audit/action records',async()=>{
  const h=harness([gmailComposeScope]),d=await h.draft(),other=await h.draft();const review=await h.review(d),otherReview=await h.review(other);
  const result=await h.command({action:'discardLocal',id:d.id,expectedRevision:d.revision});
  expect(result.actions).toHaveLength(2);expect(result.actions.find(a=>a.id===review.action.id)?.status).toBe('denied');expect(result.actions.find(a=>a.id===otherReview.action.id)).toEqual(otherReview.action);
  await expect(h.command({action:'approveSend',id:review.action.id,hash:review.action.hash,nonce:review.nonce})).rejects.toThrow();expect(h.writes).toHaveLength(0);
 });
 it.each(['pending','dispatching','unknown','succeeded'])('blocks a saveDraft needing recovery (%s), preserving history and content',async status=>{
  const h=harness(),d=await h.draft();const at=new Date(now).toISOString();const a:MailAction={id:randomUUID(),accountId:'a',kind:'saveDraft',scope:'message',messageId:null,draftId:d.id,draftRevision:d.revision,draft:d,hash:'b'.repeat(64),createdAt:at,expiresAt:new Date(now+120000).toISOString(),status:'pending',detail:'Isolated lifecycle state',previousLabels:[],expectedLabels:[],resultId:null,undoOf:null};
  h.db.mail('saveAction',{action:a,status:null});if(status!=='pending')h.db.mail('saveAction',{action:{...a,status:'dispatching'},status:'pending'});if(['unknown','succeeded'].includes(status))h.db.mail('saveAction',{action:{...a,status,resultId:status==='succeeded'?'remote-test-id':null},status:'dispatching'});
  const actions=h.db.mail('actions','a');await expect(h.command({action:'discardLocal',id:d.id,expectedRevision:d.revision})).rejects.toThrow(/activity/i);expect(h.db.mail('draft',d.id)).toEqual(d);expect(h.db.mail('actions','a')).toEqual(actions);expect(h.writes).toHaveLength(0);
 });
 it('removes a known local Gmail copy without a remote call',async()=>{
  const h=harness(),d=await h.draft();const remote={...d,status:'remote',remoteDraftId:'existing-remote-test-id',remoteRevision:d.contentRevision,revision:d.revision+1};h.db.mail('saveDraft',{draft:remote,revision:d.revision});
  await h.command({action:'discardLocal',id:d.id,expectedRevision:remote.revision});expect(h.writes).toHaveLength(0);expect(h.db.mail('draft',d.id)).toBeNull();
 });
 it.each(['sending','sent','unknown'])('blocks %s draft status without calling Gmail',async status=>{
  const h=harness(),d=await h.draft();h.db.mail('saveDraft',{draft:{...d,status,revision:d.revision+1},revision:d.revision});
  await expect(h.command({action:'discardLocal',id:d.id,expectedRevision:d.revision+1})).rejects.toThrow();expect(h.db.mail('draft',d.id)).not.toBeNull();expect(h.writes).toHaveLength(0);
 });
 it('retains the discarded-identity fence through a real isolated SQLite restart',async()=>{
  const folder=mkdtempSync(path.join(os.tmpdir(),'momo-discard-test-'));folders.push(folder);const filename=path.join(folder,'isolated.sqlite');const h=harness([],filename),d=await h.draft();await h.command({action:'discardLocal',id:d.id,expectedRevision:d.revision});h.db.close();const reopened=new SettingsDatabase(filename);databases.push(reopened);
  expect(reopened.mail('draft',d.id)).toBeNull();expect(()=>reopened.mail('saveDraft',{draft:{...d,revision:0},revision:null})).toThrow('discarded');expect(()=>reopened.mail('saveDraft',{draft:{...d,revision:d.revision+1},revision:d.revision})).toThrow('discarded');
 });
 it('validates IPC discard inputs strictly',()=>{
  const valid={action:'discardLocal',id:randomUUID(),accountId:'a',expectedRevision:1};expect(mailCommandSchema.safeParse(valid).success).toBe(true);
  for(const input of [{...valid,expectedRevision:-1},{...valid,accountId:''},{...valid,remoteDelete:true},{...valid,id:'not-an-id'}])expect(mailCommandSchema.safeParse(input).success).toBe(false);
 });
});
describe('MIME and recipient contracts',()=>{
 it('deduplicates reply-all, excludes own accounts, retains thread identifiers and encodes UTF-8',async()=>{const h=harness();const result=await h.command({action:'compose',id:randomUUID(),mode:'replyAll',sourceMessageId:'m1',body:'Здравейте, équipe.'});const d=result.drafts[0];expect(d.fields.to).toBe('author@example.test');expect(d.fields.cc).toBe('guest@example.test, other@example.test');const mime=Buffer.from(mimeMessage(d),'base64url').toString();expect(mime).toContain('In-Reply-To: <original@example.test>');expect(mime).toContain('References: <original@example.test>');expect(mime).toContain('Subject: =?UTF-8?B?');expect(Buffer.from(mime.split('\r\n\r\n')[1].replace(/\r\n/g,''),'base64').toString()).toBe('Здравейте, équipe.');expect(d.threadId).toBe('t1');});
 it('rejects CRLF injection and invalid addresses, respects quoted display-name commas',()=>{expect(addresses('"Last, First" <First@example.test>, first@example.test')).toEqual(['first@example.test']);expect(()=>addresses('a@example.test\r\nBcc: hidden@example.test')).toThrow();expect(()=>addresses('not-an-address')).toThrow();const forward=replyFields(normalizeThreadMessage(source()),'forward',['me@example.test']);expect(forward.to).toBe('');expect(forward.subject).toBe('Fwd: Fictional plan');expect(forward.body).toContain('Fictional source only.');});
});
it('requests an optional Gmail scope for the same account and preserves previous grants on partial consent',async()=>{
 let vault:VaultData={version:1,client:{client_id:'test.apps.googleusercontent.com'},activeAccountId:'a',accounts:[{id:'a',email:'me@example.test',status:'connected',token:{access:'synthetic',refresh:'synthetic',expiresAt:now+3600000,scopes:[...googleScopes,calendarWriteScope]}}]};
 let includeExisting=false;let requested:readonly string[]=[];
 const google=new GoogleService({read:async()=>vault,write:async value=>{vault=value;}},new GoogleHttp(async url=>String(url).endsWith('/token')?Response.json({access_token:'synthetic2',refresh_token:'synthetic2',expires_in:3600,token_type:'Bearer',scope:[...googleScopes,gmailComposeScope,...(includeExisting?[calendarWriteScope]:[])].join(' ')}):Response.json({sub:'a',email:'me@example.test',email_verified:true})),async()=>{},()=>{},async(_id,_browser,_signal,scopes)=>{requested=scopes??[];return{code:'synthetic',verifier:'synthetic',redirectUri:'http://127.0.0.1:9999/callback'};},()=>now);
 await expect(google.connect('a','compose')).rejects.toThrow('Existing permissions');expect((await google.state()).accounts[0]).toMatchObject({calendarWrite:true,mailCompose:false});expect(requested).toContain(gmailComposeScope);expect(requested).toContain(calendarWriteScope);expect(requested).not.toContain('https://mail.google.com/');includeExisting=true;await google.connect('a','compose');expect((await google.state()).accounts[0]).toMatchObject({calendarWrite:true,mailCompose:true,mailSend:true,mailModify:false});
});
