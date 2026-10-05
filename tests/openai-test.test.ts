// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { afterEach,expect,it,vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { SettingsDatabase } from '../electron/storage/database';
import { AssistantService } from '../electron/ai/service';
import { ProviderHttp } from '../electron/ai/providers';
import { OpenAIConnectionTest,OPENAI_TEST_PROMPT,openAITestBody } from '../electron/ai/openai-test';
import { costSummary } from '../electron/agent/usage';
import { runRequestSchema,type AssistantRun,type RunRequest } from '../src/shared/assistant';
import { invokeOperation } from '../electron/ipc/operations';
import { channels } from '../src/shared/contracts';
const key='SYNTHETIC_OPENAI_TEST_SECRET';
const final={type:'message',role:'assistant',status:'completed',phase:'final_answer',content:[{type:'output_text',text:'{"status":"ready"}'}]};
const response=()=>({id:'resp_controlled',object:'response',model:'gpt-6-luna',status:'completed',error:null,incomplete_details:null,usage:{input_tokens:40,output_tokens:10,total_tokens:50,input_tokens_details:{cached_tokens:5},output_tokens_details:{reasoning_tokens:2}},output:[{...final,phase:'commentary',content:[{type:'output_text',text:'Checking the test.'}]},final]});
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const close of cleanup.splice(0))await close();vi.restoreAllMocks();});
function fixture(transport:typeof fetch=vi.fn(async()=>Response.json(response()))){
 const db=new SettingsDatabase(':memory:'),settings=db.get();let revision='a'.repeat(64);
 const credentials={read:vi.fn(async()=>key),status:vi.fn(async()=>'configured' as const),revision:vi.fn(async()=>revision)};
 const google={state:vi.fn(),inbox:vi.fn(),calendar:vi.fn(),summary:vi.fn()};
 const store={get:async()=>db.get(),getRun:async(id:string)=>db.getRun(id),startRun:async(run:AssistantRun,limit:number)=>db.startRun(run,limit),saveRun:async(run:AssistantRun)=>db.saveRun(run),workspace:async()=>db.workspace(),clearConversation:async(id:string)=>db.clearConversation(id)};
 const service=new AssistantService(store,credentials,google,vi.fn(),undefined,undefined,new OpenAIConnectionTest(new ProviderHttp(transport)));
 cleanup.push(async()=>{await service.close();db.close();});
 const input:RunRequest={id:randomUUID(),conversationId:randomUUID(),mode:'openai-test',prompt:OPENAI_TEST_PROMPT,includeGoogle:false,accountId:null};
 const run=async()=>{await service.start(input);await vi.waitFor(()=>expect(db.getRun(input.id)?.status).not.toBe('running'));return db.getRun(input.id)!;};
 return{db,settings,service,credentials,google,input,transport,run,rotate:()=>{revision='b'.repeat(64);},costs:()=>costSummary((db as unknown as {db:Database.Database}).db)};
}
it('dispatches exactly one fixed protected request, accounts usage and verifies only the terminal final answer',async()=>{
 const fetcher=vi.fn(async()=>Response.json(response())),f=fixture(fetcher),run=await f.run();
 expect(fetcher).toHaveBeenCalledTimes(1);const [url,init]=fetcher.mock.calls[0] as unknown as [string,RequestInit];expect(url).toBe('https://api.openai.com/v1/responses');expect(init.redirect).toBe('error');expect(new Headers(init.headers).get('Authorization')).toBe('Bearer '+key);expect(JSON.parse(String(init.body))).toEqual(openAITestBody);
 expect(run).toMatchObject({provider:'openai',status:'succeeded',maxOutputTokens:512,maxRunSeconds:30,sources:[],usage:{input:40,output:10,cacheHit:5,reasoning:2}});expect(await f.service.openAIVerification()).toMatchObject({status:'succeeded'});
 expect(f.google.state).not.toHaveBeenCalled();expect(f.google.inbox).not.toHaveBeenCalled();expect(f.db.get()).toEqual(f.settings);expect(f.costs().recent[0]).toMatchObject({provider:'openai',input:40,output:10,high:8550,availability:'reported'});expect(JSON.stringify(f.db.workspace())).not.toContain(key);
 await f.service.start(f.input);expect(fetcher).toHaveBeenCalledTimes(1);f.rotate();expect(await f.service.openAIVerification()).toBeNull();
});
it.each(['incomplete','commentary-only','ambiguous-final','wrong-model','missing-usage','bad-total','refusal','tool-output','duplicate-json','credential-echo','oversized','http','network'])('fails truthfully without a retry or successful verification: %s',async kind=>{
 const body=response();let raw:string|undefined;
 if(kind==='incomplete')body.status='incomplete';if(kind==='commentary-only')body.output=[body.output[0]];if(kind==='ambiguous-final')body.output.push(final);if(kind==='wrong-model')body.model='substitute';if(kind==='missing-usage')delete (body as Partial<typeof body>).usage;if(kind==='bad-total')body.usage.total_tokens=1;if(kind==='refusal')body.output=[{...final,content:[{type:'refusal',text:'No'}]}];if(kind==='tool-output')body.output=[{...final,type:'function_call'}];if(kind==='duplicate-json')raw=JSON.stringify(body).replace('"input_tokens":40','"input_tokens":40,"input_tokens":0');if(kind==='credential-echo')raw=JSON.stringify(body).replace('Checking the test.',key);if(kind==='oversized')raw=' '.repeat(65537);
 const fetcher=vi.fn(async()=>{if(kind==='network')throw Error(key);return kind==='http'?new Response(key,{status:401}):new Response(raw??JSON.stringify(body));}),f=fixture(fetcher),run=await f.run();
 expect(fetcher).toHaveBeenCalledTimes(1);expect(run.status).toBe('failed');expect(run.error).not.toContain(key);expect(run.result).toBeNull();expect(await f.service.openAIVerification()).toMatchObject({status:'failed'});expect(f.costs().recent).toHaveLength(1);expect(f.costs().recent[0].dispatched).toBe(true);
 if(kind==='incomplete')expect(run.usage?.input).toBe(40);
});
it('blocks review sessions before reading credentials, reservation or transport',async()=>{
 const f=fixture();process.argv.push('--no-paid-inference');try{await expect(f.service.start(f.input)).rejects.toThrow('review session');expect(f.credentials.read).not.toHaveBeenCalled();expect(f.transport).not.toHaveBeenCalled();expect(f.db.workspace().runs).toHaveLength(0);expect(f.costs().recent).toHaveLength(0);}finally{process.argv.splice(process.argv.lastIndexOf('--no-paid-inference'),1);}
});
it('keeps existing hard-stop and pause authority, rejecting admission without paid dispatch',async()=>{
 const f=fixture();f.db.update({expectedRevision:0,patch:{spending:{mode:'hard-stop',currency:'USD',warning:null,stop:'0.000001'}}});await expect(f.service.start(f.input)).rejects.toThrow();expect(f.transport).not.toHaveBeenCalled();expect(f.costs().recent).toHaveLength(0);
});
it('honors a zero process request allowance before creating an attempt',async()=>{const f=fixture();process.argv.push('--provider-request-limit=0');try{await expect(f.service.start(f.input)).rejects.toThrow('request limit');expect(f.transport).not.toHaveBeenCalled();expect(f.costs().recent).toHaveLength(0);}finally{process.argv.splice(process.argv.lastIndexOf('--provider-request-limit=0'),1);}});
it('cancellation never becomes a verified test and retains the dispatched unknown attempt',async()=>{const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(Error('aborted'))))),f=fixture(fetcher);await f.service.start(f.input);await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));f.service.cancel(f.input.id);await vi.waitFor(()=>expect(f.db.getRun(f.input.id)?.status).toBe('cancelled'));expect(await f.service.openAIVerification()).toMatchObject({status:'cancelled'});expect(f.costs().recent[0]).toMatchObject({availability:'unknown',input:null,high:null,dispatched:true});});
it('a key rotation during transport prevents verification of the new key and preserves terminal usage',async()=>{
 let rotate=()=>{};const f=fixture(vi.fn(async()=>{rotate();return Response.json(response());}));rotate=f.rotate;expect((await f.run()).status).toBe('failed');expect(await f.service.openAIVerification()).toBeNull();expect(f.costs().recent[0].input).toBe(40);
});
it('IPC rejects arbitrary OpenAI prompts, source sharing and extra fields',async()=>{
 const f=fixture(),execute=vi.fn();for(const patch of [{prompt:'Read my private mail'},{accountId:'accountA'},{includeGoogle:true},{provider:'openai'},{messageId:'mail'}]){const raw={...f.input,...patch};expect(runRequestSchema.safeParse(raw).success).toBe(false);expect((await invokeOperation(channels.startRun,raw,true,execute)).ok).toBe(false);}expect(execute).not.toHaveBeenCalled();
});
