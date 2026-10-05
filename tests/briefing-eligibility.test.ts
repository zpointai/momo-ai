// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { afterEach,expect,it,vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { SettingsDatabase } from '../electron/storage/database';
import { OrchestrationService } from '../electron/agent/service';
import { costEligibility,reserveCost,settleCost } from '../electron/agent/usage';
import { AppError } from '../electron/errors';
import { initialAgentState,type AgentIntake,type AgentRun } from '../src/shared/orchestration';
import { workflowPresentation } from '../src/shared/briefing';
import { personalLimits } from '../src/shared/usage';
import type { StorageClient } from '../electron/storage/client';
import type { GoogleService } from '../electron/google/service';
const at='2026-09-25T12:00:00.000Z',dbs:SettingsDatabase[]=[];
afterEach(()=>{for(const db of dbs.splice(0))db.close();});
function fixture(){
 const db=new SettingsDatabase(':memory:');dbs.push(db);const raw=(db as unknown as {db:Database.Database}).db;
 db.update({expectedRevision:0,patch:{jevEnabled:true,deepseekEnabled:true,aiLimits:personalLimits,spending:{mode:'hard-stop',currency:'USD',warning:'30',stop:'50'}}});
 const state=initialAgentState();state.revision=1;state.config={...state.config,enabled:true,shareGoogle:true,allowDeepSeekFallback:true};state.policies.push({id:randomUUID(),accountId:'accountA',family:'briefing',level:'L1',enabled:true,version:1,maxLocalPerDay:1,schedule:{enabled:false,hour:9,minute:0,timezone:'Europe/Amsterdam'},updatedAt:at});db.agent('saveState',state);
 const credentials={status:vi.fn(async()=> 'configured' as const),read:vi.fn(async()=>{throw Error('No credential access permitted by test');}),peekStatus:vi.fn(()=> 'configured' as const)};
 const google={state:vi.fn(async()=>({activeAccountId:'accountA',accounts:[{id:'accountA',status:'connected'}]})),inbox:vi.fn(async()=>({accountId:'accountA',fetchedAt:at,messages:[],failed:0})),calendar:vi.fn(async()=>({accountId:'accountA',fetchedAt:at,events:[],truncated:false,skipped:0})),summary:vi.fn()};
 const storage={agent:vi.fn(async(op:string,input?:unknown)=>db.agent(op,input)),get:async()=>db.get(),workspace:async()=>db.workspace(),taskCommand:vi.fn()} as unknown as Pick<StorageClient,'agent'|'get'|'workspace'|'taskCommand'>;
 const jev={decide:vi.fn(async()=>{throw Error('No provider permitted');})},deepseek={process:vi.fn(async()=>{throw Error('No provider permitted');})};
 const service=new OrchestrationService(storage,credentials,google as unknown as GoogleService,()=>{},jev,deepseek,()=>Date.parse(at));
 const event:AgentIntake={id:randomUUID(),accountId:'accountA',family:'briefing',prompt:'Isolated eligibility test',trigger:'manual',causationId:null,depth:0,origin:'user'};
 return{db,raw,credentials,google,storage,jev,deepseek,service,event};
}
function unknown(f:ReturnType<typeof fixture>,tokens:boolean){const id=randomUUID();reserveCost(f.raw,{id,runId:id,provider:'deepseek',requestedModel:'historical',at:'2026-09-20T10:00:00.000Z',maxTokens:1,profile:'historical',purpose:'ordinary',dispatched:true});if(tokens)settleCost(f.raw,id,{usage:{input:10,output:5},model:'historical',outcome:'interrupted',dispatched:true,terminal:true});}
it('checks exact unpriced exposure without source, credential, reservation, history or provider operations',async()=>{
 const f=fixture();f.db.update({expectedRevision:1,patch:{spending:{mode:'monitor',currency:'USD',warning:null,stop:null}}});unknown(f,true);unknown(f,false);f.db.update({expectedRevision:2,patch:{spending:{mode:'hard-stop',currency:'USD',warning:'30',stop:'50'}}});
 const before=JSON.stringify({settings:f.db.get(),costs:f.db.agent('costs'),usage:f.db.agent('usage'),runs:f.db.agent('runs')});
 for(let i=0;i<2;i++){const result=await f.service.command({action:'checkBriefing'});expect(result.briefingEligibility).toMatchObject({eligible:false,issues:[{code:'unpriced_exposure'}],exposure:{unknown:2,tokensKnown:1,tokensMissing:1,missingHistoricRate:2}});}
 await expect(f.service.start(f.event)).rejects.toThrow('unpriced exposure');
 expect(JSON.stringify({settings:f.db.get(),costs:f.db.agent('costs'),usage:f.db.agent('usage'),runs:f.db.agent('runs')})).toBe(before);
 expect(f.google.inbox).not.toHaveBeenCalled();expect(f.google.calendar).toHaveBeenCalledTimes(1);expect(f.credentials.status).not.toHaveBeenCalled();expect(f.credentials.read).not.toHaveBeenCalled();expect(f.jev.decide).not.toHaveBeenCalled();expect(f.deepseek.process).not.toHaveBeenCalled();await f.service.close();
});
it('distinguishes missing next tariff, provisional reservation, monetary stop and capacity',async()=>{
 const f=fixture();expect(costEligibility(f.raw,{provider:'deepseek',requestedModel:'unknown-model',maxTokens:8192,at}).issues[0].code).toBe('next_rate_missing');
 const id=randomUUID();reserveCost(f.raw,{id,runId:id,provider:'deepseek',requestedModel:'deepseek-flash',at,maxTokens:8192,profile:'normal',purpose:'ordinary',dispatched:true});
 expect((await f.service.command({action:'checkBriefing'})).briefingEligibility).toMatchObject({eligible:true,exposure:{unknown:0,provisional:1}});
 f.db.update({expectedRevision:1,patch:{spending:{mode:'hard-stop',currency:'USD',warning:null,stop:'0.001'}}});expect((await f.service.command({action:'checkBriefing'})).briefingEligibility?.issues[0].code).toBe('spending_stop');
 f.db.update({expectedRevision:2,patch:{aiLimits:{...personalLimits,daily:1},spending:{mode:'monitor',currency:'USD',warning:null,stop:null}}});f.raw.prepare('INSERT INTO agent_usage VALUES (?,?,?,?)').run(randomUUID(),randomUUID(),'jev',at);expect((await f.service.command({action:'checkBriefing'})).briefingEligibility?.eligible).toBe(true);await f.service.close();
});
it('rechecks dispatch after eligible preflight and never falls back around a spending rejection',async()=>{
 const f=fixture();expect((await f.service.command({action:'checkBriefing'})).briefingEligibility?.eligible).toBe(true);
 const original=f.storage.agent;f.storage.agent=async(op,input)=>{if(op==='reserve')throw new AppError('permission_denied','Unpriced exposure blocks this reservation.');return original(op,input);};
 const queued=await f.service.start(f.event);await f.service.idle();const run=(f.db.agent('runs') as AgentRun[]).find(r=>r.id===queued.id)!;
 expect(run).toMatchObject({status:'failed',calls:[],result:null});expect(workflowPresentation(run).label).toBe('Not started');expect(f.jev.decide).not.toHaveBeenCalled();expect(f.deepseek.process).not.toHaveBeenCalled();expect(f.credentials.read).not.toHaveBeenCalled();await f.service.close();
});
it('does not relabel a dispatched held result as an unstarted briefing or mutate its raw status',()=>{
 const base={status:'partial',calls:[],result:null,error:'Estimated monthly spending stop reached, or existing exposure is unpriced.',findings:[],decision:null} as unknown as AgentRun;
 expect(workflowPresentation(base).label).toBe('Not started');expect(base.status).toBe('partial');
 expect(workflowPresentation({...base,status:'review',calls:[{}] as AgentRun['calls'],decision:{reasons:['INSUFFICIENT_CONTEXT']} as AgentRun['decision']}).label).toBe('Needs review');
 expect(workflowPresentation({...base,status:'interrupted',calls:[{}] as AgentRun['calls']}).label).toBe('Interrupted');
});
it('rejects a second briefing while the first is waiting at dispatch without another queued identity',async()=>{
 const f=fixture();let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),atReservation=new Promise<void>(r=>entered=r),original=f.storage.agent;
 f.storage.agent=async(op,input)=>{if(op==='reserve'){entered();await gate;throw new AppError('permission_denied','Spending control changed before dispatch.');}return original(op,input);};
 await f.service.command({action:'start',event:f.event});await atReservation;
 await expect(f.service.command({action:'start',event:{...f.event,id:randomUUID()}})).rejects.toThrow('already queued or running');
 expect(f.db.agent('runs')).toHaveLength(1);release();await f.service.idle();expect(f.jev.decide).not.toHaveBeenCalled();expect(f.deepseek.process).not.toHaveBeenCalled();await f.service.close();
});
