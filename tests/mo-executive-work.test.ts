// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import {afterEach,expect,it,vi} from 'vitest';
import {stableTaskId} from '../src/desktop/WorkspaceControls';
import {randomUUID} from 'node:crypto';
import {executiveFixture} from '../evaluation/mo-executive-fixture';
import {agentRunSchema,agentStateSchema} from '../src/shared/orchestration';
import {ownerWork} from '../src/shared/executive-work';
import {workItems,workGroup,workProvenance} from '../src/shared/work';
import {hash} from '../electron/agent/catalogue';
const clean:(()=>Promise<void>)[]=[];afterEach(async()=>{for(const c of clean.splice(0))await c();});
const answer=(extra:object={})=>({model:'deepseek-flash',usage:{prompt_tokens:100,completion_tokens:20},choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({answer:'Review this meeting request [M1].',citations:['M1'],suggestions:[],...extra})}}]});
const tool=()=>({model:'deepseek-flash',usage:{prompt_tokens:100,completion_tokens:20},choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,tool_calls:[{id:randomUUID(),type:'function',function:{name:'delegate_work',arguments:JSON.stringify({specialist:'inbox',objective:'Inspect the selected email',sources:['inbox'],date:null,sourceId:'mail1'})}}]}}]});
function setup(responses:unknown[]=[tool(),answer()]){
 const fetcher=vi.fn(async()=>Response.json(responses.shift())),f=executiveFixture(fetcher as typeof fetch);clean.push(()=>f.close());
 // Use a real native source and repository, with synthetic fixture content only.
 Object.defineProperty(f.orchestration,'snapshot',{value:async()=>({state:agentStateSchema.parse(f.db.agent('state')),runs:f.roots()})});
 return {...f,fetcher};
}
async function attention(f:ReturnType<typeof setup>){
 const source=(await f.native.read({...f.input,messageId:'mail1'},{sources:['inbox'],date:null,sourceId:'mail1'},[],new AbortController().signal)).sources[0];
 const at=new Date().toISOString(),id=randomUUID();
 const root=agentRunSchema.parse({id,definition:'workflow-v1',event:{id,family:'email',accountId:'accountA',resourceId:'mail1',prompt:'Assess the selected email',origin:'user',trigger:'manual'},dedup:hash(id),context:{id:randomUUID(),hash:hash(source),createdAt:at,timezone:'Europe/Amsterdam',items:[{id:'M1',kind:'email',accountId:'accountA',resourceId:'mail1',revision:source.ref!.revision,title:source.label,text:source.detail,fetchedAt:source.fetchedAt,trust:'untrusted-source',senderScope:null,threadId:'thread1'}],limitations:['Selected message only'],available:{calendar:false,tasks:false,thread:false},sharing:{google:true,tasks:false}},policy:{...f.state.policies[0],family:'email'},config:f.state.config,profileRevision:f.state.revision,createdAt:at,finishedAt:at,status:'complete',checkpoint:'Assessment generated',attempt:0,decision:{answers:{},questionSet:'test',questionHash:hash('test'),routingVersion:'routing-v1',thresholds:{sufficiency:.5,routeConfidence:.5},requestedModel:'deepseek-flash',reportedModel:'deepseek-flash',route:'EXTRACT_ACTIONS',reasons:[],priority:'high',preferenceVersion:null,degraded:false},result:{text:'The message needs your review [M1].',draft:null,evidence:['M1'],reminders:[]},findings:[],proposals:[],calls:[],error:null,shadow:null});
 f.db.agent('enqueue',root);return root;
}
const items=(f:ReturnType<typeof setup>)=>workItems({state:agentStateSchema.parse(f.db.agent('state')),runs:f.roots()},f.db.workspace(),'accountA');
it('claims the existing attention identity atomically; concurrent and later clicks never replay work',async()=>{
 const f=setup(),original=await attention(f);expect(items(f)[0]).toMatchObject({attention:true,view:{state:'needs-owner',rootRunId:original.id}});
 await Promise.all(Array.from({length:5},()=>f.orchestration.command({action:'handleWork',id:original.id})));await f.service.idle();
 const request=JSON.parse(f.fetcher.mock.calls[0][1]!.body as string);expect(JSON.parse(request.messages.at(-1).content).selectedWork).toMatchObject({id:original.id,state:'working'});
 const root=f.roots()[0];expect(f.roots()).toHaveLength(1);expect(root.id).toBe(original.id);expect(root.executiveOrigin?.context).toEqual(original.context);expect(root.executiveOrigin?.result).toEqual(original.result);expect(root.team?.items.map(w=>w.role)).toEqual(['executive','inbox']);expect(root.executive?.state).toBe('completed');expect(f.fetcher).toHaveBeenCalledTimes(2);
 await f.orchestration.command({action:'handleWork',id:original.id});expect(f.fetcher).toHaveBeenCalledTimes(2);expect(items(f)[0]).toMatchObject({attention:false,group:'Recently completed'});expect(f.db.workspace().runs).toHaveLength(1);
});
it('cancels prepared work without deleting the original assessment or replaying its proposal',async()=>{
 const f=setup([tool(),answer({reply:{sourceId:'M1',body:'I will check before confirming.'}})]),r=await attention(f);await f.orchestration.command({action:'handleWork',id:r.id});await f.service.idle();const before=f.roots()[0];expect(before.executive?.state).toBe('prepared');await f.orchestration.command({action:'cancel',id:r.id});const cancelled=f.roots()[0];expect(ownerWork(cancelled).state).toBe('cancelled');expect(cancelled.executiveOrigin).toEqual(before.executiveOrigin);expect(cancelled.executive?.proposals).toEqual(before.executive?.proposals);await f.orchestration.command({action:'handleWork',id:r.id});expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it('prepared replies retain one root and one proposal through repeated Handle clicks',async()=>{
 const f=setup([tool(),answer({reply:{sourceId:'M1',body:'Let me check the calendar first.'}})]),r=await attention(f);await f.orchestration.command({action:'handleWork',id:r.id});await f.service.idle();
 expect(f.roots()[0].executive?.state).toBe('prepared');const proposals=f.roots()[0].executive?.proposals;await f.orchestration.command({action:'handleWork',id:r.id});expect(f.roots()).toHaveLength(1);expect(f.roots()[0].executive?.proposals).toEqual(proposals);expect(proposals).toHaveLength(1);expect(f.roots()[0].localDraftId).toBeUndefined();expect(items(f)[0].group).toBe('Needs you');
});
it.each(['snooze','not-relevant','resolved-elsewhere'] as const)('records %s as an audited owner choice without deleting the assessment',async choice=>{
 const f=setup([]),r=await attention(f);await f.orchestration.command({action:'workDisposition',id:r.id,expectedRevision:0,choice});const root=f.roots()[0];expect(root.result).toEqual(r.result);expect(root.context).toEqual(r.context);expect(root.workControl?.history[0].action).toBe(choice);expect(items(f)[0].attention).toBe(false);expect(f.fetcher).not.toHaveBeenCalled();
 if(choice==='snooze'){expect(items(f)[0].group).toBe('Waiting');expect(workItems({state:f.state,runs:f.roots()},f.db.workspace(),'accountA',Date.now()+86400001)[0].attention).toBe(true);}
 if(choice==='resolved-elsewhere')expect(items(f)[0].view.nextStep).toContain('Mo did not complete');
 await f.orchestration.command({action:'workDisposition',id:r.id,expectedRevision:1,choice:'unsnooze'});expect(items(f)[0].attention).toBe(true);
});
it('rejects stale disposition revisions and preserves provenance language',async()=>{const f=setup([]),r=await attention(f);await f.orchestration.command({action:'workDisposition',id:r.id,expectedRevision:0,choice:'snooze'});await expect(f.orchestration.command({action:'workDisposition',id:r.id,expectedRevision:0,choice:'not-relevant'})).rejects.toThrow('Work changed');expect(workProvenance(r)).toMatchObject({createdBy:'Inbox Mo',origin:'Owner-requested workflow',ownerSaved:false});});
it('denies revoked source sharing before creating assistant work or duplicating the root',async()=>{const f=setup([]),r=await attention(f);const s=agentStateSchema.parse(f.db.agent('state'));s.revision++;s.config.shareGoogle=false;f.db.agent('saveState',s);await expect(f.orchestration.command({action:'handleWork',id:r.id})).rejects.toThrow('sharing');expect(f.fetcher).not.toHaveBeenCalled();expect(f.roots()).toHaveLength(1);expect(f.db.workspace().runs).toHaveLength(0);});
it('cancels claimed work and rejects a late provider result',async()=>{
 const f=setup([]),r=await attention(f);let release!:(v:Response)=>void;f.fetcher.mockImplementation(()=>new Promise<Response>(resolve=>{release=resolve;}));await f.orchestration.command({action:'handleWork',id:r.id});await vi.waitFor(()=>expect(f.fetcher).toHaveBeenCalledOnce());await f.orchestration.command({action:'cancel',id:r.id});release(Response.json(answer()));await f.service.idle();expect(ownerWork(f.roots()[0]).state).toBe('cancelled');expect(f.db.getRun(r.id)?.result).toBeNull();await f.orchestration.command({action:'handleWork',id:r.id});expect(f.fetcher).toHaveBeenCalledOnce();
});
it('holds stale selected evidence and groups only ownerWork states',async()=>{const f=setup(),r=await attention(f);f.setStale(true);await f.orchestration.command({action:'handleWork',id:r.id});await f.service.idle();expect(['failed','stale']).toContain(ownerWork(f.roots()[0]).state);expect(f.fetcher).not.toHaveBeenCalled();expect(workGroup('needs-owner')).toBe('Needs you');expect(workGroup('assigned')).toBe('Mo is working');expect(workGroup('stale')).toBe('Waiting');expect(workGroup('completed')).toBe('Recently completed');});
it('selects exactly the requested work context and refuses another account',async()=>{const f=setup([]),r=await attention(f);const bound=await f.native.selectedWork({...f.input,workId:r.id});expect(bound?.id).toBe(r.id);expect(JSON.stringify(bound)).toContain('mail1');await expect(f.native.selectedWork({...f.input,workId:r.id,accountId:null,includeGoogle:false})).rejects.toThrow('another account');});
it.each(['request','saved'] as const)('withholds source-derived work metadata when the %s Google grant is off',async grant=>{
 const f=setup([]),r=await attention(f);r.error='Private email quotation in a blocker';f.db.agent('update',r);
 if(grant==='saved'){const state=agentStateSchema.parse(f.db.agent('state'));state.revision++;state.config.shareGoogle=false;f.db.agent('saveState',state);}
 const selected=await f.native.selectedWork({...f.input,workId:r.id,includeGoogle:grant!=='request'});expect(selected?.notice).toContain('not shared');expect(JSON.stringify(selected)).not.toMatch(/Private email|mail1|Review meeting/);expect(f.fetcher).not.toHaveBeenCalled();
});

it('continues a clarification under the original root and preserves the earlier specialist turn',async()=>{
 const f=setup([tool(),answer({clarification:'Which date should I use?'}),tool(),answer()]),r=await attention(f);await f.orchestration.command({action:'handleWork',id:r.id});await f.service.idle();expect(f.roots()[0].executive?.state).toBe('needs-owner');
 await f.send({workId:r.id,conversationId:r.id,messageId:'mail1',prompt:'Use tomorrow please.'});expect(f.roots()).toHaveLength(1);expect(f.roots()[0].executiveHistory).toHaveLength(1);expect(f.roots()[0].executiveOrigin?.context).toEqual(r.context);expect(f.roots()[0].executive?.state).toBe('completed');
});
it('clears attention only after the reviewed task has a native receipt',async()=>{
 const f=setup([answer({suggestions:[{title:'Review the request',sourceIds:['M1']}]})]),r=await attention(f);await f.orchestration.command({action:'handleWork',id:r.id});await f.service.idle();expect(items(f)[0].attention).toBe(true);
 f.db.agent('projectExecutiveOutcomes');expect(items(f)[0].view.state).toBe('prepared');const id=await stableTaskId(r.id+':0');f.db.taskCommand({action:'create',id,accountId:'accountA',draft:{title:'Review the request',due:{kind:'none'}}});f.db.agent('projectExecutiveOutcomes');expect(items(f)[0].view.state).toBe('completed');expect(items(f)[0].attention).toBe(false);await f.orchestration.command({action:'handleWork',id:r.id});expect(f.db.workspace().tasks).toHaveLength(1);
});
it('inspects selected completed work without another Executive root or assignment',async()=>{
 const f=setup([tool(),answer(),tool(),answer()]),r=await attention(f);await f.orchestration.command({action:'handleWork',id:r.id});await f.service.idle();const before=f.roots()[0];await f.send({workId:r.id,conversationId:r.id,messageId:'mail1',prompt:'Show me what Inbox Mo found.'});expect(f.roots()).toHaveLength(1);expect(f.roots()[0]).toEqual(before);
});
