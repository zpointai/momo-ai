// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import {afterEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Worker} from 'node:worker_threads';
import {buildSync} from 'esbuild';
import Database from 'better-sqlite3';
import {SettingsDatabase} from '../electron/storage/database';
import {OrchestrationService} from '../electron/agent/service';
import {MailService} from '../electron/mail/service';
import {hash} from '../electron/agent/catalogue';
import {threadRevision} from '../electron/mail/thread';
import {applyBudgetBoundary,costEligibility,costSummary,previewBudgetBoundary,reserveCost,settleCost} from '../electron/agent/usage';
import {assessmentState,currentAssessments} from '../src/shared/assessment';
import {archivableWorkflow} from '../src/shared/activity';
import {agentRunSchema,initialAgentState,type AgentRun,type JevAnswer,type ProcessingResult} from '../src/shared/orchestration';
import {type LocalMailDraft,type MailThread} from '../src/shared/mail';
import type {CostEntry} from '../src/shared/usage';
import type {ProcessingOptions} from '../electron/agent/providers';
import {defaultContextBudgets} from '../src/shared/context';

const dbs:SettingsDatabase[]=[],folders:string[]=[];
afterEach(()=>{for(const db of dbs.splice(0))try{db.close();}catch{/* closed for restart */}for(const folder of folders.splice(0)){if(!path.resolve(folder).startsWith(path.join(os.tmpdir(),'momo-phase1-')))throw new Error('Unsafe cleanup');rmSync(folder,{recursive:true,force:true});}});
function file(){const dir=mkdtempSync(path.join(os.tmpdir(),'momo-phase1-'));folders.push(dir);return path.join(dir,'momo.sqlite');}
function database(filename=':memory:'){const db=new SettingsDatabase(filename);dbs.push(db);return{db,raw:(db as unknown as {db:Database.Database}).db};}
function fixture(filename=':memory:'){
 const {db,raw}=database(filename),at=new Date().toISOString();db.update({expectedRevision:0,patch:{deepseekEnabled:true,jevEnabled:true,dailyCallLimit:100}});
 const state=initialAgentState();state.revision=1;state.config={...state.config,enabled:true,shareGoogle:true,shareTasks:true,dailyCalls:100};
 const policy={id:randomUUID(),accountId:'accountA',family:'email' as const,level:'L1' as const,enabled:true,version:1,maxLocalPerDay:1,schedule:{enabled:false,hour:9,minute:0,timezone:'Europe/Amsterdam'},updatedAt:at};state.policies.push(policy);db.agent('saveState',state);
 const message={id:'mail1',threadId:'thread1',subject:'A real fixture request',from:'Sender <sender@example.test>',to:'owner@example.test',snippet:'Can you confirm the requested details?',receivedAt:at,unread:true};
 const text=`From: ${message.from.slice(0,120)}; Date: ${message.receivedAt}; ${message.snippet.slice(0,600)}`;
 const source={id:'M1',kind:'email',accountId:'accountA',resourceId:'mail1',revision:hash({title:message.subject,text}),title:message.subject,text,fetchedAt:at,trust:'untrusted-source',senderScope:hash('sender'),threadId:'thread1'};
 const original=agentRunSchema.parse({id:randomUUID(),definition:'workflow-v1',event:{id:randomUUID(),family:'email',accountId:'accountA',resourceId:'mail1',prompt:'Assess priority'},dedup:hash(randomUUID()),context:{id:randomUUID(),hash:hash(source),createdAt:at,timezone:'Europe/Amsterdam',items:[source],limitations:['Snippet only'],available:{thread:false,tasks:false,calendar:false},sharing:{google:true,tasks:false}},policy,config:state.config,profileRevision:1,createdAt:at,finishedAt:at,status:'review',checkpoint:'Review',attempt:1,decision:{answers:{},questionSet:'email-v1',questionHash:hash('q'),routingVersion:'routing-v1',thresholds:{sufficiency:.65,routeConfidence:.55},requestedModel:'jev-latest',reportedModel:null,route:'NEEDS_REVIEW',reasons:['THREAD_NOT_AVAILABLE'],priority:'high',preferenceVersion:null,degraded:false},result:null,findings:[],proposals:[],calls:[],error:'Thread required',shadow:null});db.agent('enqueue',original);
 const thread:MailThread={id:'thread1',accountId:'accountA',fetchedAt:at,truncated:false,messages:[{message,text:'The full current body, absent from the snippet. Please confirm the project code.',textAvailable:true,truncated:false,attachments:[],headers:{replyTo:'sender@example.test',cc:'',messageId:'<mail1@example.test>',references:''},labels:['INBOX']}]};
 let activeAccount='accountA',holdQuality=false;let output:ProcessingResult={text:'Grounded reply',draft:'Thank you for the details.',clarification:null,evidence:['M1'],reminders:[]};let afterProcess=()=>{};
 const google={state:vi.fn(async()=>({configuration:'configured' as const,connecting:false,activeAccountId:activeAccount,accounts:[{id:'accountA',email:'owner@example.test',status:'connected' as const,calendarWrite:false,mailCompose:false,mailSend:false,mailModify:false}]})),readMailThread:vi.fn(async()=>structuredClone(thread)),readMailMessage:vi.fn(async()=>structuredClone(thread.messages[0])),summary:vi.fn(),inbox:vi.fn(),calendar:vi.fn(),calendarEpoch:()=>0,writeMail:vi.fn(),findSentMessage:vi.fn()};
 const storage={agent:async(op:string,input?:unknown)=>db.agent(op,input),get:async()=>db.get(),workspace:vi.fn(async()=>db.workspace()),taskCommand:vi.fn(),mail:async(op:string,input?:unknown)=>db.mail(op,input)};
 const mail=new MailService(storage,google);const changed=vi.fn();
 const decide=vi.fn(async(_key:string,_model:string,_context:unknown,questions:Record<string,unknown>)=>({reportedModel:'jev-latest',usage:{input:40,output:1},answers:Object.fromEntries(Object.keys(questions).map(key=>{const choice=key==='priority'?'high':key==='new_commitment'&&holdQuality?'yes':'no';const keys=Object.keys((questions[key] as {criteria:Record<string,string>}).criteria);return[key,{type:'choice',choice,confidence:1,probabilities:Object.fromEntries(keys.map(k=>[k,k===choice?1:0]))}];})) as Record<string,JevAnswer>}));
 const process=vi.fn(async(o:ProcessingOptions)=>{await o.checkAuthority();await o.beforeRound();await o.usage('deepseek-flash',{input:100,output:30});afterProcess();return structuredClone(output);});
 const service=new OrchestrationService(storage,{status:async()=>'configured',read:async()=>'TEST_ONLY'},google,changed,{decide},{process},Date.now,mail);
 const event=()=>({id:randomUUID(),family:'email' as const,accountId:'accountA',resourceId:'mail1',prompt:'Draft a reply using my facts.',replyTo:{runId:original.id,sourceRevision:source.revision,threadId:thread.id,threadRevision:threadRevision(thread)},trigger:'manual' as const,origin:'user' as const,causationId:null,depth:0});
 const run=async()=>{const start=await service.start(event());await service.idle();return (await service.snapshot()).runs.find(r=>r.id===start.id)!;};
 return{db,raw,state,source,original,thread,service,mail,google,storage,changed,decide,process,event,run,setAccount:(id:string)=>{activeAccount=id;},setOutput:(value:ProcessingResult)=>{output=value;},holdQuality:()=>{holdQuality=true;},afterProcess:(fn:()=>void)=>{afterProcess=fn;}};
}

it('projects dismissal/resolution/corrections atomically, retains evidence and survives restart and reopening',async()=>{
 const filename=file(),f=fixture(filename);await f.service.command({action:'feedback',runId:f.original.id,sourceId:'M1',kind:'priority',value:'normal'});
 let snapshot=await f.service.snapshot();expect(assessmentState(snapshot.runs[0],snapshot.state.feedback)).toEqual({status:'active',priority:'normal'});
 await f.service.command({action:'feedback',runId:f.original.id,sourceId:'M1',kind:'dismissed',value:'Dismiss'});
 snapshot=await f.service.snapshot();expect(assessmentState(snapshot.runs[0],snapshot.state.feedback).status).toBe('dismissed');expect(snapshot.runs[0].context).toEqual(f.original.context);expect(snapshot.runs[0].decision).toEqual(f.original.decision);
 f.db.agent('update',f.original);expect((f.db.agent('runs') as AgentRun[])[0].assessment?.status).toBe('dismissed');
 expect(f.changed.mock.calls.at(-1)?.[0].runs[0].assessment.status).toBe('dismissed');expect(currentAssessments(snapshot.runs,'accountB')).toEqual([]);
 f.setAccount('accountB');await expect(f.service.command({action:'feedback',runId:f.original.id,sourceId:'M1',kind:'resolved',value:'Resolved'})).rejects.toThrow('original');f.setAccount('accountA');
 await f.service.command({action:'feedback',runId:f.original.id,sourceId:'M1',kind:'resolved',value:'Resolved'});await f.service.close();f.db.close();
 const reopened=database(filename).db;const run=(reopened.agent('runs') as AgentRun[])[0];expect(assessmentState(run).status).toBe('resolved');expect(run.context).toEqual(f.original.context);expect(f.process).not.toHaveBeenCalled();
});
it('ignores foreign/stale correction provenance and selects newest retained source assessment',()=>{
 const f=fixture(),old={...f.original,createdAt:'2026-01-01T00:00:00.000Z'},feedback={id:randomUUID(),runId:f.original.id,sourceId:'M1',accountId:'wrong',scope:f.source.senderScope,resourceId:'mail1',threadId:'thread1',createdAt:f.original.createdAt,kind:'dismissed' as const,strength:'implicit' as const,value:'dismiss',baseline:'high' as const,sourceRevision:f.source.revision,valid:true};
 expect(assessmentState(f.original,[feedback]).status).toBe('active');expect(assessmentState(f.original,[{...feedback,accountId:'accountA',sourceRevision:hash('changed')}]).status).toBe('active');expect(currentAssessments([old,f.original],'accountA')).toEqual([f.original]);
});
it('archives only terminal presentation rows, preserves authoritative tables, restores and persists',async()=>{
 const filename=file(),f=fixture(filename);await f.service.command({action:'feedback',runId:f.original.id,sourceId:'M1',kind:'dismissed',value:'Dismiss'});
 const tables=['agent_runs','agent_state','agent_receipts','usage_costs','agent_usage','mail_actions','mail_action_audit','calendar_action_audit'];const before=tables.map(t=>f.raw.prepare('SELECT * FROM '+t).all());
 await f.service.command({action:'archiveActivity',accountId:'accountA',ids:['workflow:'+f.original.id]});expect(tables.map(t=>f.raw.prepare('SELECT * FROM '+t).all())).toEqual(before);
 expect((await f.service.snapshot()).activityArchives).toEqual([{id:'workflow:'+f.original.id,accountId:'accountA'}]);await f.service.close();f.db.close();const reopened=database(filename).db;expect(reopened.agent('activityArchives')).toHaveLength(1);reopened.agent('restoreActivity','accountA');expect(reopened.agent('activityArchives')).toEqual([]);
});
it('refuses pending, running, uncertain and review rows including expired-but-pending approvals, atomically',async()=>{
 const f=fixture();for(const status of ['pending','dispatching','unknown']){const id=randomUUID();f.raw.prepare('INSERT INTO mail_actions VALUES (?,?,?)').run(id,'accountA',JSON.stringify({id,accountId:'accountA',status,expiresAt:'2000-01-01T00:00:00Z'}));expect(()=>f.db.agent('archiveActivity',{accountId:'accountA',ids:['mail:'+id]})).toThrow('must remain visible');}
 await expect(f.service.command({action:'archiveActivity',accountId:'accountA',ids:['workflow:'+f.original.id]})).rejects.toThrow('must remain visible');
 const completed={...f.original,assessment:{status:'resolved' as const,priority:'high' as const}};expect(archivableWorkflow(completed)).toBe(true);expect(archivableWorkflow({...completed,status:'running'})).toBe(false);expect(archivableWorkflow({...completed,calls:[{id:randomUUID(),provider:'jev',purpose:'decision',requestedModel:'jev-latest',reportedModel:null,status:'unknown',usage:null,elapsedMs:0}]})).toBe(false);
 const id=randomUUID();f.raw.prepare('INSERT INTO mail_actions VALUES (?,?,?)').run(id,'accountA',JSON.stringify({id,accountId:'accountA',status:'succeeded'}));expect(()=>f.db.agent('archiveActivity',{accountId:'accountB',ids:['mail:'+id]})).toThrow();expect(()=>f.db.agent('archiveActivity',{accountId:'accountA',ids:['mail:'+id,'workflow:'+f.original.id]})).toThrow();expect(f.db.agent('activityArchives')).toEqual([]);
});
it('retrieves current full thread only for explicit reply and creates an editable, source-bound local draft through the native lifecycle',async()=>{
 const f=fixture();await f.service.snapshot();expect(f.google.readMailThread).not.toHaveBeenCalled();const run=await f.run();expect(run.status).toBe('complete');expect(run.localDraftId).toBe(run.id);expect(run.calls).toHaveLength(3);
 expect(f.process.mock.calls[0][0].context.items[0].text).toContain('full current body');expect(f.process.mock.calls[0][0].context.available.thread).toBe(true);expect(f.process.mock.calls[0][0].context.items.every(s=>s.kind==='email')).toBe(true);expect(f.google.calendar).not.toHaveBeenCalled();expect(f.google.summary).not.toHaveBeenCalled();expect(f.storage.workspace).not.toHaveBeenCalled();expect(f.google.writeMail).not.toHaveBeenCalled();
 const draft=(f.db.mail('drafts','accountA') as LocalMailDraft[])[0];expect(draft).toMatchObject({id:run.id,threadId:'thread1',sourceMessageId:'mail1',accountId:'accountA',status:'local',remoteDraftId:null,provenance:{runId:run.id,threadRevision:threadRevision(f.thread)}});
 const edited=await f.mail.command({action:'saveLocal',accountId:'accountA',id:draft.id,expectedRevision:draft.revision,fields:{...draft.fields,body:'Owner edited reply'}});expect(edited.drafts[0].fields.body).toBe('Owner edited reply');expect(edited.drafts[0].provenance).toEqual(draft.provenance);
});
it('Phase 4 retains the prior thread message and records bounded full context without unrelated sources',async()=>{
 const f=fixture(),prior=structuredClone(f.thread.messages[0]);prior.message.id='prior1';prior.text='The prior source specifies project code BLUE.';f.thread.messages.push(prior);
 const run=await f.run();expect(run.status).toBe('complete');expect(run.context.items).toHaveLength(2);expect(run.context.items[1].text).toContain('project code BLUE');expect(run.contextSelection?.counts).toEqual({FULL:2,EXCLUDE:0,REFERENCE_ONLY:0,SUMMARY:0});expect(run.contextSelection?.selectedSize.bytes).toBeLessThanOrEqual(defaultContextBudgets['grounded-reply'].maxBytes);expect(f.google.calendar).not.toHaveBeenCalled();expect(f.google.writeMail).not.toHaveBeenCalled();
});
it('Phase 4 holds complete-thread budget exhaustion before either provider and preserves diagnostics',async()=>{
 const f=fixture();f.db.update({expectedRevision:1,patch:{contextBudgets:{...defaultContextBudgets,'grounded-reply':{...defaultContextBudgets['grounded-reply'],maxBytes:256,maxEstimatedTokens:64}}}});
 const run=await f.run();expect(run.status).toBe('review');expect(run.contextSelection?.blocked).toBe(true);expect(run.contextSelection?.candidates[0].reason).toBe('BUDGET_EXHAUSTED');expect(run.calls).toEqual([]);expect(f.decide).not.toHaveBeenCalled();expect(f.process).not.toHaveBeenCalled();expect(f.db.mail('drafts','accountA')).toEqual([]);
});
it('returns clarification without a draft and preserves advisory concerns for owner review',async()=>{
 const f=fixture();f.setOutput({text:'Your project code is not supplied.',draft:null,clarification:'Which project code should I include?',evidence:['M1'],reminders:[]});const run=await f.run();expect(run.status).toBe('review');expect(run.result?.clarification).toContain('Which project code');expect(f.db.mail('drafts','accountA')).toEqual([]);
 const held=fixture();held.holdQuality();const result=await held.run();expect(result.status).toBe('complete');expect(result.team?.ledger?.semantic).toBe('flags');expect(held.db.mail('drafts','accountA')).toHaveLength(1);
});
it('binds a repeated explicit reply request to its own run and fences cancellation during the final thread read',async()=>{
 const f=fixture(),first=await f.run(),second=await f.run();expect(second.id).not.toBe(first.id);expect(second.localDraftId).toBe(second.id);expect(f.db.mail('drafts','accountA')).toHaveLength(2);
 const cancelled=fixture();cancelled.google.readMailThread.mockImplementationOnce(async()=>structuredClone(cancelled.thread)).mockImplementationOnce(async()=>{cancelled.service.cancel();return structuredClone(cancelled.thread);});const run=await cancelled.run();expect(run.status).toBe('cancelled');expect(cancelled.db.mail('drafts','accountA')).toEqual([]);
});
it('rejects stale source/thread/revision/account and incomplete bounded thread before provider calls',async()=>{
 for(const change of ['revision','account','partial','source'] as const){const f=fixture(),event=f.event();if(change==='revision')event.replyTo.threadRevision=hash('stale');if(change==='account')f.setAccount('accountB');if(change==='partial')f.thread.truncated=true;if(change==='source'){f.thread.messages[0].message.snippet='Changed';event.replyTo.threadRevision=threadRevision(f.thread);}
  await expect(f.service.start(event)).rejects.toThrow();expect(f.process).not.toHaveBeenCalled();expect(f.decide).not.toHaveBeenCalled();expect(f.db.mail('drafts','accountA')).toEqual([]);
 }
 const f=fixture();f.thread.messages[0].textAvailable=false;await expect(f.service.start(f.event())).rejects.toThrow('More information needed');expect(f.process).not.toHaveBeenCalled();
});
it('revalidates thread, account and authority after generation without creating a draft on stale completion',async()=>{
 for(const change of ['thread','account','policy'] as const){const f=fixture();f.afterProcess(()=>{if(change==='thread')f.thread.messages[0].text='A newer reply arrived';if(change==='account')f.setAccount('accountB');if(change==='policy')f.db.agent('saveState',{...f.state,revision:2,config:{...f.state.config,shareGoogle:false}});});const run=await f.run();expect(run.localDraftId).toBeUndefined();expect(f.db.mail('drafts','accountA')).toEqual([]);expect(f.google.writeMail).not.toHaveBeenCalled();}
});

const attempt=(at:string,id=randomUUID())=>({id,runId:id,provider:'deepseek' as const,requestedModel:'deepseek-flash',at,maxTokens:8192,profile:'normal',purpose:'ordinary' as const,dispatched:true});
function legacy(raw:Database.Database,at:string,patch:Partial<CostEntry>={}){const {maxTokens:_maxTokens,...base}=attempt(at);const entry:CostEntry={...base,reportedModel:null,purpose:'unclassified',outcome:'historical',availability:'unknown',input:null,output:null,cacheHit:null,cacheMiss:null,reasoning:null,rateId:null,low:null,high:null,reservation:null,...patch};raw.prepare('INSERT INTO usage_costs VALUES (?,?,?)').run(entry.id,entry.at,JSON.stringify(entry));return entry;}
it('previews without mutation, applies an auditable restart-safe boundary, preserves unknowns and does not reset counters/settings',()=>{
 const filename=file(),{db,raw}=database(filename),at=new Date().toISOString(),old=new Date(Date.now()-10000).toISOString();db.update({expectedRevision:0,patch:{spending:{mode:'hard-stop',currency:'USD',stop:'50',warning:'30'}}});const row=legacy(raw,old);raw.prepare('INSERT INTO agent_usage VALUES (?,?,?,?)').run(row.id,row.runId,row.provider,old);const saved=db.get(),usage=db.agent('usage'),ledger=raw.prepare('SELECT * FROM usage_costs').all();
 expect(costEligibility(raw,attempt(at)).issues[0].code).toBe('unpriced_exposure');const preview=previewBudgetBoundary(raw,at);expect(raw.prepare('SELECT * FROM budget_boundaries').all()).toEqual([]);expect(preview.legacyIds).toEqual([row.id]);applyBudgetBoundary(raw,preview);expect(db.get()).toEqual(saved);expect(db.agent('usage')).toEqual(usage);expect(raw.prepare('SELECT * FROM usage_costs').all()).toEqual(ledger);expect(costEligibility(raw,attempt(at)).issues).toEqual([]);expect(costSummary(raw,at)).toMatchObject({monthToDate:{unknown:1},enforcement:{historicalUnknown:1,month:{unknown:0}}});
 db.close();const reopened=database(filename);expect(costSummary(reopened.raw,at).enforcement?.boundary).toEqual(preview);expect(reopened.db.agent('usage')).toEqual(usage);expect(reopened.db.get()).toEqual(saved);applyBudgetBoundary(reopened.raw,preview);expect(reopened.raw.prepare('SELECT * FROM budget_boundaries').all()).toHaveLength(1);
 const newer=legacy(reopened.raw,new Date(Date.parse(at)+1).toISOString(),{purpose:'ordinary'});expect(costEligibility(reopened.raw,attempt(newer.at)).issues[0].code).toBe('unpriced_exposure');
});
it('keeps priced usage and unresolved reservations counted across the boundary and rejects stale/tampered previews',()=>{
 const {db,raw}=database(),at=new Date().toISOString(),old=new Date(Date.now()-10000).toISOString();legacy(raw,old);const reservation=attempt(old);reserveCost(raw,reservation);const known=attempt(old);reserveCost(raw,known);settleCost(raw,known.id,{usage:{input:1000,output:100},model:'deepseek-flash',outcome:'complete',dispatched:true,terminal:true});const unresolved=legacy(raw,old,{outcome:'unknown'});const preview=previewBudgetBoundary(raw,at);expect(preview.legacyIds).not.toContain(unresolved.id);expect(()=>applyBudgetBoundary(raw,{...preview,legacyIds:[...preview.legacyIds,unresolved.id]})).toThrow('preview');
 applyBudgetBoundary(raw,preview);const costs=costSummary(raw,at);expect(costs.enforcement?.month).toMatchObject({unknown:1,priced:1,provisional:1,exposure:costs.monthToDate.exposure});const fresh=previewBudgetBoundary(raw);db.update({expectedRevision:0,patch:{theme:'light'}});expect(()=>applyBudgetBoundary(raw,fresh)).toThrow('preview');expect(()=>applyBudgetBoundary(raw,{...preview,id:randomUUID()},Date.parse(at)+300001)).toThrow('preview');
});
it('races independent connections through the same immediate reservation transaction after the boundary without overbooking or counter reset',async()=>{
 const filename=file(),{db,raw}=database(filename),at=new Date().toISOString();legacy(raw,new Date(Date.now()-10000).toISOString());db.update({expectedRevision:0,patch:{spending:{mode:'hard-stop',currency:'USD',stop:'0.02',warning:null}}});applyBudgetBoundary(raw,previewBudgetBoundary(raw));
 const code=buildSync({stdin:{contents:`import {workerData,parentPort} from 'node:worker_threads';import Database from 'better-sqlite3';import {reserveAgentUsage} from './electron/agent/usage';const db=new Database(workerData.filename,{timeout:5000});const gate=new Int32Array(workerData.gate);parentPort.postMessage('ready');Atomics.wait(gate,0,0);try{reserveAgentUsage(db,workerData.request);parentPort.postMessage({ok:true});}catch(e){parentPort.postMessage({ok:false,message:e.message});}finally{db.close();}`,resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'cjs',external:['better-sqlite3'],write:false}).outputFiles[0].text;
 const gate=new SharedArrayBuffer(4);let ready=0;const workers:Worker[]=[];
 try{const results=await Promise.all([0,1].map(()=>new Promise<{ok:boolean;message?:string}>((resolve,reject)=>{const worker=new Worker(code,{eval:true,workerData:{filename,gate,request:{...attempt(at),model:'deepseek-flash',daily:100,providerDaily:100,perRun:4}}});workers.push(worker);worker.on('error',reject);worker.on('message',value=>{if(value==='ready'){if(++ready===2){Atomics.store(new Int32Array(gate),0,1);Atomics.notify(new Int32Array(gate),0);}}else resolve(value);});})));expect(results.filter(r=>r.ok)).toHaveLength(1);expect(results.find(r=>!r.ok)?.message).toContain('spending stop');expect(db.agent('usage')).toMatchObject({deepseek:1,total:1});expect(costSummary(raw,at).enforcement?.month.provisional).toBe(1);}finally{await Promise.all(workers.map(w=>w.terminate()));}
});
it('migrates schema 7 additively with a consistent backup and no automatically applied owner boundary',()=>{
 const filename=file();const first=database(filename);const saved=first.db.get();first.raw.exec('DROP TABLE relay_events; DELETE FROM schema_migrations WHERE version=9; DROP TABLE activity_archives; DROP TABLE budget_boundaries; DELETE FROM schema_migrations WHERE version=8; PRAGMA user_version=7');first.db.close();const next=database(filename);expect(next.raw.pragma('user_version',{simple:true})).toBe(9);expect(next.db.get()).toEqual(saved);expect(next.db.agent('activityArchives')).toEqual([]);expect(costSummary(next.raw).enforcement?.boundary).toBeNull();const backup=readdirSync(path.dirname(filename)).find(n=>n.includes('before-v8'))!;expect(backup).toBeTruthy();const old=new Database(path.join(path.dirname(filename),backup),{readonly:true});try{expect(old.pragma('user_version',{simple:true})).toBe(7);expect(old.prepare("SELECT name FROM sqlite_master WHERE name='budget_boundaries'").get()).toBeUndefined();}finally{old.close();}
});
