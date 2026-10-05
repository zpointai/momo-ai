// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { executiveFixture } from '../evaluation/mo-executive-fixture';
import { moChannelSchema, MO_IDENTITY } from '../src/shared/mo';
import type { VoiceSession } from '../src/shared/voice';
import { agentStateSchema } from '../src/shared/orchestration';
import type { AssistantRun } from '../src/shared/assistant';
import { spokenText } from '../electron/relay/voice';
import { DeepSeekProvider } from '../electron/ai/providers';
import { voiceUsageStates } from '../src/shared/voice-accounting';

const clean:(()=>Promise<void>)[]=[];afterEach(async()=>{for(const c of clean.splice(0))await c();vi.restoreAllMocks();});
const answer=(text='Hello.',extra:object={})=>({answer:text,citations:[],suggestions:[],...extra});
const delegation={specialist:'planner',objective:'Read the permitted agenda',sources:['agenda'],date:null,sourceId:null};
const deep=(result:object,tool=false)=>({model:'deepseek-flash',usage:{prompt_tokens:150,completion_tokens:40},choices:[{finish_reason:tool?'tool_calls':'stop',message:{role:'assistant',content:tool?null:JSON.stringify(result),...(tool?{tool_calls:[{id:randomUUID(),type:'function',function:{name:'delegate_work',arguments:JSON.stringify(result)}}]}:{})}}]});
const luna=(result:object)=>({id:'resp_test',object:'response',model:'gpt-6-luna',status:'completed',usage:{input_tokens:150,output_tokens:40,total_tokens:190},output:[{type:'message',role:'assistant',status:'completed',phase:'final_answer',content:[{type:'output_text',text:JSON.stringify(result)}]}]});
function fixture(responses:unknown[],model:'deepseek-flash'|'gpt-6-luna'='deepseek-flash'){
 const bodies:Record<string,unknown>[]=[];const fetcher=vi.fn(async(_u:unknown,init?:RequestInit)=>{bodies.push(JSON.parse(String(init?.body)));return Response.json(responses.shift());});
 const f=executiveFixture(fetcher as typeof fetch,model);clean.push(()=>f.close());
 const session:VoiceSession={id:randomUUID(),conversationId:randomUUID(),callSid:'CA'+'b'.repeat(32),ownerId:randomUUID(),startedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+600000).toISOString(),scope:'read-prepare',authentication:'caller-and-pin'};
 let history:AssistantRun[]=[];const guard=vi.fn(async()=>{});
 return {...f,fetcher,bodies,session,guard,async voice(prompt='PRIVATE_OWNER_UTTERANCE',retainHistory=false,includeGoogle=true){const run=await f.service.start({...f.input,id:randomUUID(),conversationId:session.conversationId,prompt,includeGoogle},undefined,undefined,{session,retainHistory,history,guard});await f.service.idle();history=[run,...history].slice(0,3);return run;}};
}
it('uses the same Executive and DeepSeek default, retains usage but no ephemeral transcript',async()=>{
 const f=fixture([deep(delegation,true),deep(answer('PRIVATE_SPOKEN_ANSWER [E1]',{citations:['E1']}))]);const run=await f.voice();
 expect(run.status).toBe('succeeded');expect(run.provider).toBe('deepseek');expect(run.requestedModel).toBe('deepseek-flash');expect(f.reads).toEqual(['agenda']);expect(run.calls).toHaveLength(2);
 expect(f.db.workspace().callsToday.deepseek).toBe(2);expect(f.roots()).toEqual([]);
 const saved=f.db.getRun(run.id)!;expect(saved.prompt).not.toContain('PRIVATE_OWNER');expect(saved.result).toBeNull();expect(saved.sources).toEqual([]);
 expect(saved.channel).toMatchObject({assistant:MO_IDENTITY,channel:'voice',sessionId:f.session.id,linkedConversationId:f.session.conversationId,authorization:'authenticated-owner',voice:{callSid:f.session.callSid,retention:'ephemeral',scope:'read-prepare'}});
 expect(JSON.stringify(f.bodies)).toContain('authenticated owner voice session');
});
it('retains full conversation only with explicit history opt-in',async()=>{const f=fixture([deep(answer('RETAINED_ANSWER'))]);const run=await f.voice('RETAINED_REQUEST',true);expect(f.db.getRun(run.id)).toMatchObject({prompt:'RETAINED_REQUEST',result:{answer:'RETAINED_ANSWER'},channel:{voice:{retention:'history'}}});});
it('ephemeral follow-up history stays bounded to this explicit call conversation',async()=>{
 const f=fixture([deep(answer('ANSWER_IN_MEMORY')),deep(answer('Follow-up'))]);await f.voice('REMEMBER_WITHIN_CALL');await f.voice('Continue');expect(JSON.stringify(f.bodies[1])).toContain('ANSWER_IN_MEMORY');expect(JSON.stringify(f.db.workspace())).not.toContain('ANSWER_IN_MEMORY');
});
it('prepares a task through existing Work without creating a task or retaining the utterance',async()=>{
 const f=fixture([deep(answer('SPOKEN_PROPOSAL_TEXT',{suggestions:[{title:'Review the proposal tomorrow',sourceIds:[]}]}))]);const run=await f.voice();expect(run.status).toBe('succeeded');
 expect(f.db.workspace().tasks).toEqual([]);const root=f.roots()[0];expect(root.executive).toMatchObject({assistantRunId:run.id,state:'prepared',proposals:[{kind:'task-proposal'}]});
 expect(f.db.getRun(run.id)?.result?.suggestions[0].title).toBe('Review the proposal tomorrow');expect(JSON.stringify(f.roots())).not.toContain('PRIVATE_OWNER_UTTERANCE');expect(JSON.stringify(f.db.workspace())).not.toContain('SPOKEN_PROPOSAL_TEXT');
});
it('prepares a reply using existing Inbox specialist evidence and Work review only',async()=>{
 const f=fixture([deep({...delegation,specialist:'inbox',sources:['inbox']},true),deep({...delegation,specialist:'inbox',sources:['inbox'],sourceId:'mail1'},true),deep(answer('Ready for review [M1]',{citations:['M1'],reply:{sourceId:'M1',body:'I will review this.'}}))]);
 const run=await f.voice('Find the latest email from fixture@example.test and propose an answer for review');expect(run.error).toBeNull();expect(run.status).toBe('succeeded');expect(f.reads).toEqual(['inbox','inbox','thread']);expect(f.roots()[0].executive?.state).toBe('prepared');expect(f.roots()[0].team?.items.every(i=>!i.permission.externalWrites&&i.permission.actions.length===0)).toBe(true);
 expect(f.db.getRun(run.id)?.result?.reply?.body).toBe('I will review this.');expect(f.db.workspace().tasks).toEqual([]);
});
it('source denial happens before native reads under voice scope and is not labelled cancellation',async()=>{const f=fixture([deep(delegation,true)]);const run=await f.voice('Agenda',false,false);expect(run.status).toBe('failed');expect(run.voiceDiagnostics?.resultDisposition).toBe('failed');expect(run.voiceDiagnostics?.cancelReason).toBeUndefined();expect(f.reads).toEqual([]);expect(f.roots()).toEqual([]);});
it('revoked native sharing still denies a voice grant',async()=>{const f=fixture([deep(delegation,true)]);const state=agentStateSchema.parse(f.db.agent('state'));state.revision++;state.config.shareGoogle=false;f.db.agent('saveState',state);const run=await f.voice();expect(run.status).toBe('failed');expect(f.reads).toEqual([]);});
it('session expiry blocks a late tool and accounts the attempted model call',async()=>{
 const f=fixture([]);f.fetcher.mockImplementationOnce(async()=>{f.guard.mockRejectedValue(Error('expired'));return Response.json(deep(delegation,true));});const run=await f.voice();expect(run.status).toBe('failed');expect(f.reads).toEqual([]);expect(f.db.getRun(run.id)?.calls?.[0].usage).toBeTruthy();
});
it('cancellation drops late proposals and creates no Work artifacts',async()=>{
 const f=fixture([]);let release!:(response:Response)=>void;f.fetcher.mockImplementationOnce(()=>new Promise<Response>(r=>{release=r;}));const pending=f.voice();await vi.waitFor(()=>expect(f.fetcher).toHaveBeenCalledOnce());f.service.cancel();release(Response.json(deep(answer('Late',{suggestions:[{title:'Must not persist',sourceIds:[]}]}))));const run=await pending;expect(run.status).toBe('cancelled');expect(run.result).toBeNull();expect(f.roots()).toEqual([]);
});
it('Luna stays explicit and uses unchanged normal accounting',async()=>{const f=fixture([luna(answer())],'gpt-6-luna');const run=await f.voice();expect(run.requestedModel).toBe('gpt-6-luna');expect(run.provider).toBe('openai');expect(f.db.workspace().callsToday.openai).toBe(1);expect(f.db.workspace().callsToday.deepseek).toBe(0);expect(f.bodies[0]).toMatchObject({store:false,model:'gpt-6-luna'});});
it('voice provenance cannot be forged by a mere phone match or merged with desktop history',()=>{
 const base={assistant:MO_IDENTITY,channel:'voice',sessionId:randomUUID(),linkedConversationId:randomUUID(),authorization:'authenticated-owner'};expect(moChannelSchema.safeParse(base).success).toBe(false);expect(moChannelSchema.safeParse({...base,authorization:'local-owner'}).success).toBe(false);
});
it('spoken output strips citation IDs, SSML, long URLs and provider identifiers',()=>{const text=spokenText('See [M1] https://example.test/private CA'+'a'.repeat(32)+' <audio>answer</audio>');expect(text).not.toMatch(/\[M1\]|https:|CA[a-f0-9]{32}|[<>]/);});
it('cancellation before dispatch preserves a not-dispatched reservation and no provider charge claim',async()=>{
 const f=fixture([]),save=f.storage.saveRun;f.storage.saveRun=async run=>{if(run.stage==='Considering your request')f.service.cancel(run.id);return save(run);};
 const run=await f.voice();expect(run.status).toBe('cancelled');expect(f.fetcher).not.toHaveBeenCalled();expect(voiceUsageStates(run)[0].state).toBe('Not dispatched');expect(f.roots()).toEqual([]);
});
it('late provider receipt keeps known usage but discards its cancelled proposal',async()=>{
 const f=fixture([]);let release!:()=>void;
 vi.spyOn(DeepSeekProvider.prototype,'turn').mockImplementation(async(_key,_messages,_tools,_signal,_max,receipt)=>{await new Promise<void>(r=>{release=r;});receipt({input:21,output:9},'deepseek-flash');return {result:answer('I created it.',{suggestions:[{title:'Late proposal',sourceIds:[]}]}),call:null,message:{role:'assistant',content:''},usage:{input:21,output:9},reportedModel:'deepseek-flash'};});
 const work=f.voice();await vi.waitFor(()=>expect(release).toBeTypeOf('function'));f.service.cancel();release();const run=await work;
 expect(run.status).toBe('cancelled');expect(f.roots()).toEqual([]);expect(run.result).toBeNull();expect(run.calls?.[0]).toMatchObject({status:'complete',usage:{input:21,output:9},receivedAfterCancellation:true});expect(f.db.getRun(run.id)?.calls?.[0].usage).toEqual({input:21,output:9});
});
it('dispatched cancellation without a provider receipt keeps unknown usage and never retries',async()=>{
 const f=fixture([]);f.fetcher.mockImplementationOnce(async(_url,init)=>new Promise<Response>((_resolve,reject)=>{init?.signal?.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError')),{once:true});}));
 const work=f.voice();await vi.waitFor(()=>expect(f.fetcher).toHaveBeenCalledOnce());f.service.cancel();const run=await work;
 expect(run.status).toBe('cancelled');expect(voiceUsageStates(run)[0].state).toBe('Dispatched / usage unknown');expect(run.calls?.[0].usage).toBeNull();expect(f.fetcher).toHaveBeenCalledOnce();expect(f.roots()).toEqual([]);
});
