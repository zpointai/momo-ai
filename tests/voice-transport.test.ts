// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createHash, generateKeyPairSync, randomUUID, verify } from 'node:crypto';
import type WebSocket from 'ws';
import { DesktopVoice, type VoiceConnection } from '../electron/relay/voice';
import type { AssistantRun } from '../src/shared/assistant';
import type { AssistantService } from '../electron/ai/service';
import type { VoiceSession } from '../src/shared/voice';

class Socket extends EventEmitter {
 readyState=1;bufferedAmount=0;sent:Record<string,unknown>[]=[];
 send(value:string){this.sent.push(JSON.parse(value));}
 terminate(){this.readyState=3;this.emit('close');}
 input(value:unknown){this.emit('message',Buffer.from(JSON.stringify(value)),false);}
}
const closes:(()=>void)[]=[];afterEach(()=>closes.splice(0).forEach(c=>c()));
async function fixture(){
 const pair=generateKeyPairSync('ed25519'),id=randomUUID(),ws=new Socket();let time=Date.now();
 const config={version:1 as const,revision:1,enabled:true,accountSid:'AC'+'a'.repeat(32),number:'+12025550101',numberSid:'PN'+'a'.repeat(32),messagingServiceSid:'MG'+'a'.repeat(32),campaignSid:'QE'+'a'.repeat(32),gatewayOrigin:'https://relay.example.test',region:'us1' as const,edge:'dublin' as const,voice:{enabled:true,accountId:'accountA',includeGoogle:false,includeLocal:true,includeWeather:false,retainHistory:false}};
 let connection:VoiceConnection|null={config,device:{id,privateKey:pair.privateKey.export({type:'pkcs8',format:'pem'}).toString()}};
 const start=vi.fn(async(..._args:Parameters<AssistantService['start']>)=>({status:'succeeded',result:{answer:'Native response [T1]',citations:['T1'],suggestions:[]}} as AssistantRun)),cancel=vi.fn(),idle=vi.fn(async()=>{}),ended=vi.fn(async()=>{});
 const connect=vi.fn(()=>ws as unknown as WebSocket);
 const voice=new DesktopVoice(async()=>connection,{start,cancel,idle},()=>{},ended,()=>time,connect);voice.start();closes.push(()=>voice.stop());
 await vi.waitFor(()=>expect(connect).toHaveBeenCalledOnce());
 const hello={type:'hello',version:1,deviceId:id,accountSid:config.accountSid,number:config.number,voice:{configured:true,ownerConfigured:true,pinConfigured:true,desktopOnline:false,activeCalls:0,scope:'read-prepare',recording:false}};
 const session:VoiceSession={id:randomUUID(),conversationId:randomUUID(),callSid:'CA'+'b'.repeat(32),ownerId:id,startedAt:new Date(time).toISOString(),expiresAt:new Date(time+600000).toISOString(),scope:'read-prepare',authentication:'caller-and-pin'};
 const turn={type:'turn',sessionId:session.id,turnId:randomUUID(),generation:1,text:'What needs attention?'};
 const accept=()=>{ws.input(hello);ws.input({type:'session',session});};
 return {voice,ws,hello,session,turn,accept,start,cancel,idle,ended,connect,pair,config,disconnect:()=>{connection=null;},advance:(ms:number)=>{time+=ms;}};
}
it('desktop handshake uses the existing device key, exact WSS origin and fresh signed route',async()=>{
 const f=await fixture();const [url,headers]=f.connect.mock.calls[0] as unknown as [string,Record<string,string>];
 expect(url).toBe('wss://relay.example.test/desktop/voice');expect(verify(null,Buffer.from(['GET','/desktop/voice',headers['x-relay-time'],headers['x-relay-nonce'],createHash('sha256').update('').digest('hex')].join('\n')),f.pair.publicKey,Buffer.from(headers['x-relay-signature'],'base64'))).toBe(true);
 f.accept();expect(f.voice.snapshot()).toMatchObject({channel:'online',call:'connected',sessionId:f.session.id});expect(f.start).not.toHaveBeenCalled();
});
it('rejects gateway account and authenticated owner identity mismatches',async()=>{
 const f=await fixture();f.ws.input({...f.hello,number:'+12025550999'});expect(f.voice.snapshot().channel).toBe('offline');expect(f.start).not.toHaveBeenCalled();
 const g=await fixture();g.ws.input(g.hello);g.ws.input({type:'session',session:{...g.session,ownerId:randomUUID()}});expect(g.voice.snapshot().channel).toBe('offline');
});
it('authenticated turns preserve native source grants, explicit conversation and provenance',async()=>{
 const f=await fixture();f.accept();f.ws.input(f.turn);await f.voice.idle();expect(f.start).toHaveBeenCalledOnce();expect(f.start.mock.calls[0][0]).toMatchObject({id:f.turn.turnId,conversationId:f.session.conversationId,includeGoogle:false,includeLocal:true,accountId:'accountA',mode:'chat'});expect(f.start.mock.calls[0][3]).toMatchObject({session:f.session,retainHistory:false});expect(f.ws.sent.at(-1)).toMatchObject({type:'result',text:'Native response'});
});
it('duplicate event is delivered once and closed session IDs cannot reconnect',async()=>{
 const f=await fixture();f.accept();f.ws.input(f.turn);f.ws.input(f.turn);await f.voice.idle();expect(f.start).toHaveBeenCalledOnce();f.ws.input({type:'ended',sessionId:f.session.id,endedAt:new Date().toISOString()});f.ws.input({type:'session',session:f.session});expect(f.voice.snapshot().channel).toBe('offline');
});
it('cancelled call rejects late model text and records an end timestamp',async()=>{
 const f=await fixture();let release!:()=>void;f.idle.mockImplementationOnce(()=>new Promise<void>(r=>{release=r;}));f.accept();f.ws.input(f.turn);await vi.waitFor(()=>expect(f.start).toHaveBeenCalledOnce());f.ws.input({type:'ended',sessionId:f.session.id,endedAt:new Date().toISOString()});release();await f.voice.idle();await vi.waitFor(()=>expect(f.ended).toHaveBeenCalledOnce());expect(f.cancel).toHaveBeenCalledWith(f.turn.turnId);expect(f.ws.sent.filter(m=>m.type==='result')).toEqual([]);expect(f.voice.snapshot().call).toBe('none');
});
it('interruption cancels only its voice turn and does not replay it',async()=>{
 const f=await fixture();let release!:()=>void;f.idle.mockImplementationOnce(()=>new Promise<void>(r=>{release=r;}));f.accept();f.ws.input(f.turn);await vi.waitFor(()=>expect(f.start).toHaveBeenCalledOnce());f.ws.input({type:'cancel',sessionId:f.session.id,turnId:f.turn.turnId});release();await f.voice.idle();expect(f.cancel).toHaveBeenCalledWith(f.turn.turnId);expect(f.ws.sent.some(m=>m.type==='result')).toBe(false);
});
it('local disable and session expiry deny work before model dispatch',async()=>{
 const f=await fixture();f.accept();f.disconnect();f.ws.input(f.turn);await f.voice.idle();expect(f.start).not.toHaveBeenCalled();await f.voice.tick();expect(f.voice.snapshot().channel).toBe('disabled');
 const g=await fixture();g.accept();g.advance(600001);g.ws.input(g.turn);await g.voice.idle();expect(g.start).not.toHaveBeenCalled();
});
it('an unauthenticated turn and raw audio cannot reach Mo',async()=>{
 const f=await fixture();f.ws.input(f.turn);expect(f.start).not.toHaveBeenCalled();expect(f.voice.snapshot().channel).toBe('offline');
 const g=await fixture();g.accept();g.ws.emit('message',Buffer.from('RAW_AUDIO'),true);expect(g.start).not.toHaveBeenCalled();expect(g.voice.snapshot().call).toBe('none');
});
it('projects fresh gateway status and stage metadata without transcript capture',async()=>{
 const f=await fixture();f.accept();const at=Date.now();f.ws.input({type:'status',voice:{...f.hello.voice,desktopOnline:true,activeCalls:1,observedAt:at,desktopLastSeenAt:at}});
 expect(f.voice.snapshot().gateway).toMatchObject({desktopOnline:true,activeCalls:1,observedAt:at});f.ws.input(f.turn);await f.voice.idle();
 const stages=f.ws.sent.filter(m=>m.type==='stage');expect(stages.map(m=>m.stage)).toEqual(['desktopReceivedAt','executiveStartedAt','executiveCompletedAt','responseReturnedAt']);expect(JSON.stringify(stages)).not.toContain(f.turn.text);
 f.ws.terminate();expect(f.voice.snapshot()).toMatchObject({gateway:null,channel:'offline',call:'none'});
});
it('serializes a replacement behind cancelled native work and invalidates its late output',async()=>{
 const f=await fixture();let release!:()=>void;f.idle.mockImplementationOnce(()=>new Promise<void>(r=>{release=r;}));f.accept();f.ws.input(f.turn);await vi.waitFor(()=>expect(f.start).toHaveBeenCalledOnce());
 const cancellation=f.start.mock.calls[0][3]!.cancellation!;f.ws.input({type:'cancel',sessionId:f.session.id,turnId:f.turn.turnId,reason:'interrupted'});
 const next={...f.turn,turnId:randomUUID(),generation:3,text:'Next question'};f.ws.input(next);expect(f.start).toHaveBeenCalledOnce();expect(cancellation.reason).toBe('interrupted');release();await f.voice.idle();
 expect(f.start).toHaveBeenCalledTimes(2);expect(f.ws.sent.filter(m=>m.type==='result').map(m=>m.turnId)).toEqual([next.turnId]);expect(f.start.mock.calls[1][0].conversationId).toBe(f.session.conversationId);
});
it('leaves Processing as soon as native work ends, before returning the transport result',async()=>{
 const f=await fixture(),send=f.ws.send.bind(f.ws);let observed=false;
 f.ws.send=value=>{const frame=JSON.parse(value);if(frame.type==='stage'&&frame.stage==='executiveCompletedAt'){observed=true;expect(f.voice.snapshot().call).toBe('waiting');}send(value);};
 f.accept();f.ws.input(f.turn);await f.voice.idle();expect(observed).toBe(true);
});
it('clears pending action authority and in-memory references on disconnect',async()=>{
 const f=await fixture();f.accept();f.ws.input(f.turn);await f.voice.idle();const execution=f.start.mock.calls[0][3]!;
 execution.confirmation!.prepare({title:'Synthetic task',due:{kind:'none'}},{sessionId:f.session.id,callSid:f.session.callSid,accountId:'accountA',profile:'local',generation:1,authorityHash:'same',authorityRevision:1,settingsRevision:1,expiresAt:Date.now()+60000});
 f.ws.input({type:'ended',sessionId:f.session.id,endedAt:new Date().toISOString()});await f.voice.idle();
 expect(()=>execution.confirmation!.consume('Yes',{sessionId:f.session.id,callSid:f.session.callSid,accountId:'accountA',profile:'local',generation:2,authorityHash:'same',authorityRevision:1,settingsRevision:1,expiresAt:Date.now()+60000})).toThrow('no pending');
 expect(f.voice.snapshot()).toMatchObject({call:'none',sessionId:null});
});

it('keeps calendar fields through an interrupted turn but clears them on disconnect',async()=>{
 const f=await fixture();let release!:()=>void;f.idle.mockImplementationOnce(()=>new Promise<void>(r=>{release=r;}));
 f.accept();f.ws.input(f.turn);await vi.waitFor(()=>expect(f.start).toHaveBeenCalledOnce());
 const execution=f.start.mock.calls[0][3]!,binding={sessionId:f.session.id,callSid:f.session.callSid,accountId:'accountA',profile:'local' as const,generation:1,authorityHash:'same',authorityRevision:1,settingsRevision:1,expiresAt:Date.now()+60000};
 execution.calendarConfirmation!.collect({title:'Synthetic title',startDate:'2026-10-05',startTime:'12:30',endDate:'2026-10-05',endTime:'12:45'},binding,1);
 const invalidate=vi.spyOn(execution.calendarConfirmation!,'invalidateConfirmation');
 f.ws.input({type:'cancel',sessionId:f.session.id,turnId:f.turn.turnId,reason:'interrupted'});release();await f.voice.idle();
 expect(invalidate).toHaveBeenCalled();expect(execution.calendarConfirmation!.hasPending()).toBe(false);
 expect(execution.calendarConfirmation!.context({...binding,generation:3},1)).toMatchObject({title:'Synthetic title',startTime:'12:30',endTime:'12:45'});
 f.ws.input({type:'ended',sessionId:f.session.id,endedAt:new Date().toISOString()});await f.voice.idle();
 expect(execution.calendarConfirmation!.context({...binding,generation:3},1)).toBeNull();expect(f.ws.sent.some(m=>m.type==='result')).toBe(false);
});
