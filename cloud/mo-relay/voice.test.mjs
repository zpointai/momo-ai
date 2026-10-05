// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createServer } from 'node:http';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import WebSocket from 'ws';
import twilio from 'twilio';
import { Gateway, digest } from './gateway.mjs';
import { VoiceGateway, VOICE, VOICE_SETTLE_MS, pinVerifier, verifyPin } from './voice.mjs';

const PIN='82461937',verifier=pinVerifier(PIN),account='AC'+'a'.repeat(32),number='+12025550101',owner='+12025550102',origin='https://voice.example.test';
class Socket extends EventEmitter {
 readyState=1;bufferedAmount=0;sent=[];
 send(value){this.sent.push(JSON.parse(value));}
 close(){if(this.readyState!==1)return;this.readyState=3;this.emit('close');}
 terminate(){this.close();}
 input(message){this.emit('message',Buffer.from(JSON.stringify(message)),false);}
}
function fixture(t){
 let time=Date.now();const config={publicOrigin:origin,accountSid:account,number,messagingServiceSid:'MG'+'b'.repeat(32),authToken:'SYNTHETIC_TOKEN',bootstrapToken:'x'.repeat(40),bootstrapExpiresAt:time+60000,allowedSenders:[owner]};
 const gateway=new Gateway(config,':memory:',()=>time),pair=generateKeyPairSync('ed25519'),deviceId=randomUUID();
 gateway.pair(config.bootstrapToken,{deviceId,publicKey:pair.publicKey.export({type:'spki',format:'pem'}).toString()});
 const voice=new VoiceGateway(gateway,{enabled:true,ownerPhone:owner,pinVerifier:verifier});t.after(()=>{voice.close();gateway.close();});
 const params={AccountSid:account,CallSid:'CA'+'c'.repeat(32),To:number,From:owner,Direction:'inbound'};
 const post=(route,extra={},signature)=>{const p={...params,...extra},raw=new URLSearchParams(p).toString(),sig=signature??twilio.getExpectedTwilioSignature(config.authToken,origin+route,p);return route.startsWith(VOICE.auth+'?')?voice.authWebhook(route,raw,sig):voice.webhook(route,raw,sig);};
 const inbound=()=>post(VOICE.inbound),auth=(digits=PIN)=>post(VOICE.auth+'?challenge='+voice.calls.get(params.CallSid).challenge,{Digits:digits});
 const desktop=()=>{const ws=new Socket();voice.connectDesktop(ws);ws.input({type:'ready'});return ws;};
 const call=({settle=true}={})=>{const desk=desktop();inbound();const xml=auth();const c=voice.calls.get(params.CallSid),ws=new Socket();voice.connectTwilio(ws);const setup={type:'setup',callSid:c.sid,sessionId:'VX'+'d'.repeat(32),accountSid:account,from:owner,to:number,direction:'inbound',customParameters:{voiceTicket:c.ticket}};ws.input(setup);desk.input({type:'accepted',sessionId:c.id});
  // Existing lifecycle cases send complete utterances; fragment cases explicitly control time.
  if(settle){const input=ws.input.bind(ws);ws.input=m=>{input(m);if(m.type==='prompt'&&m.last){time+=VOICE_SETTLE_MS;voice.tick();}};}
  return {desk,ws,c,xml,setup};};
 return {voice,gateway,post,inbound,auth,desktop,call,params,config,pair,deviceId,advance:ms=>{time+=ms;voice.tick();},time:()=>time};
}
test('HTTP signatures bind exact public URL, account, called number and explicit caller',t=>{
 const f=fixture(t);assert.throws(()=>f.post(VOICE.inbound,{},'bad'),/INVALID_SIGNATURE/);
 assert.throws(()=>f.post(VOICE.inbound,{To:'+12025550999'}),/BINDING/);
 assert.throws(()=>f.post(VOICE.inbound,{AccountSid:'AC'+'e'.repeat(32)}),/BINDING/);
 assert.match(f.post(VOICE.inbound,{From:'+12025550999'}),/<Hangup/);assert.equal(f.voice.calls.size,0);
 assert.match(f.inbound(),/input="dtmf"/);assert.doesNotMatch(f.inbound(),/ConversationRelay/);
});
test('PIN salted verifier, success and no Digits or secret persistence',t=>{
 const f=fixture(t);f.desktop();const challenge=f.inbound();assert.doesNotMatch(challenge,/input="speech"|record/i);
 assert(verifyPin(PIN,verifier));assert.notEqual(pinVerifier(PIN),verifier);assert(!verifyPin('00000000',verifier));
 const xml=f.auth();assert.match(xml,/<ConversationRelay/);assert.match(xml,/wss:\/\/voice.example.test\/twilio\/voice\/session\//);assert.doesNotMatch(xml,/Record|intelligenceService|conversationConfiguration|82461937|scrypt/);
 const persisted=JSON.stringify(f.gateway.db.prepare('SELECT * FROM voice_calls').all());assert(!persisted.includes(PIN));assert(!persisted.includes('Digits'));assert(!JSON.stringify(f.voice.status()).includes(verifier));
});
test('three failed attempts end the call, consumed challenge cannot replay',t=>{
 const f=fixture(t);f.inbound();const old=f.voice.calls.get(f.params.CallSid).challenge;
 assert.match(f.auth('11111111'),/<Gather/);
 assert.match(f.post(VOICE.auth+'?challenge='+old,{Digits:PIN}),/<Hangup/);
 assert.match(f.auth('11111111'),/<Gather/);assert.match(f.auth('11111111'),/<Hangup/);assert.equal(f.voice.calls.size,0);assert.doesNotMatch(f.inbound(),/<Gather/);
});
test('PIN attempts are bounded across new calls',t=>{
 const f=fixture(t);
 for(let n=0;n<2;n++){f.params.CallSid='CA'+String(n).repeat(32);f.inbound();for(let i=0;i<3;i++)f.auth('11111111');}
 f.params.CallSid='CA'+'2'.repeat(32);f.inbound();assert.throws(()=>f.auth(),/RATE_LIMIT/);
});
test('signed challenge URL cannot be replaced, expired authentication cannot reconnect',t=>{
 const f=fixture(t);f.inbound();const old=f.voice.calls.get(f.params.CallSid).challenge;
 assert.throws(()=>f.post(VOICE.auth+'?challenge='+old,{Digits:PIN},twilio.getExpectedTwilioSignature(f.config.authToken,origin+VOICE.auth,{...f.params,Digits:PIN})),/INVALID_SIGNATURE/);
 f.advance(120001);assert.equal(f.voice.calls.size,0);assert.match(f.post(VOICE.auth+'?challenge='+old,{Digits:PIN}),/<Hangup/);
});
test('paired but offline desktop yields honest ending after authentication',t=>{const f=fixture(t);f.inbound();const xml=f.auth();assert.match(xml,/Mo is currently offline/);assert.doesNotMatch(xml,/ConversationRelay/);assert.equal(f.voice.calls.size,0);});
test('ConversationRelay upgrade verifies WSS signature at pinned URL, ignores proxy headers',t=>{
 const f=fixture(t),url=origin.replace('https:','wss:')+VOICE.session;
 const req={method:'GET',url:VOICE.session,headers:{'x-twilio-signature':twilio.getExpectedTwilioSignature(f.config.authToken,url,{}),host:'attacker.example','x-forwarded-host':'attacker.example'}};
 assert.equal(f.voice.validateSocket(req),'twilio');assert.throws(()=>f.voice.validateSocket({...req,url:VOICE.session+'?x=1'}));assert.throws(()=>f.voice.validateSocket({...req,headers:{'x-twilio-signature':'bad'}}),/INVALID_SIGNATURE/);
});
test('actual WebSocket upgrade reuses paired Ed25519 identity and rejects nonce replay',async t=>{
 const f=fixture(t),server=createServer();f.voice.attach(server);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const at=String(f.time()),nonce=randomUUID(),headers={'x-relay-device':f.deviceId,'x-relay-time':at,'x-relay-nonce':nonce,'x-relay-signature':sign(null,Buffer.from(['GET',VOICE.desktop,at,nonce,digest('')].join('\n')),f.pair.privateKey).toString('base64')};
 const ws=new WebSocket(`ws://127.0.0.1:${server.address().port}${VOICE.desktop}`,{headers});const [bytes]=await once(ws,'message');assert.equal(JSON.parse(bytes.toString()).deviceId,f.deviceId);ws.send(JSON.stringify({type:'ready'}));await new Promise(r=>setTimeout(r,20));assert(f.voice.online());
 assert.throws(()=>f.voice.validateSocket({method:'GET',url:VOICE.desktop,headers}),/REPLAYED/);ws.close();await once(ws,'close');
});
test('bound authenticated session forwards final text only and accepts only matching result',t=>{
 const f=fixture(t),{c,ws,desk}=f.call();assert.equal(desk.sent.find(m=>m.type==='session').session.scope,'read-prepare');
 ws.input({type:'prompt',voicePrompt:'partial',last:false});ws.input({type:'prompt',voicePrompt:' ',last:true});assert(!desk.sent.some(m=>m.type==='turn'));
 ws.input({type:'prompt',voicePrompt:'Agenda today?',last:true});const turn=desk.sent.find(m=>m.type==='turn');assert.equal(turn.text,'Agenda today?');
 desk.input({type:'result',sessionId:c.id,turnId:randomUUID(),generation:turn.generation,text:'WRONG'});assert(!ws.sent.some(m=>m.token==='WRONG'));
 desk.input({type:'result',sessionId:c.id,turnId:turn.turnId,generation:turn.generation,text:'A bounded response.'});assert.equal(ws.sent.at(-1).token,'A bounded response.');
});
test('ticket and setup bindings deny unauthenticated or cross-call sessions',t=>{
 const f=fixture(t);f.desktop();f.inbound();f.auth();const ws=new Socket();f.voice.connectTwilio(ws);ws.input({type:'setup',...f.params,callSid:f.params.CallSid,customParameters:{voiceTicket:'wrong'}});assert.equal(ws.readyState,3);
});
test('duplicate setup, prompts, results and interruption never replay substantive turns',t=>{
 const f=fixture(t),{c,ws,desk,setup}=f.call();ws.input(setup);const p={type:'prompt',voicePrompt:'What needs attention?',last:true};ws.input(p);ws.input(p);assert.equal(desk.sent.filter(m=>m.type==='turn').length,1);
 const turn=desk.sent.find(m=>m.type==='turn');ws.input({type:'interrupt',utteranceUntilInterrupt:'private speech'});assert(desk.sent.some(m=>m.type==='cancel'));
 desk.input({type:'result',sessionId:c.id,turnId:turn.turnId,generation:turn.generation,text:'LATE'});assert(!ws.sent.some(m=>m.token==='LATE'));
 ws.input({type:'prompt',voicePrompt:'A different question',last:true});const next=desk.sent.filter(m=>m.type==='turn').at(-1);assert(next.generation>turn.generation);
});
test('disconnect cancels work, stores only usage metadata and cannot resume authorization',t=>{
 const f=fixture(t),{c,ws,desk}=f.call();ws.input({type:'prompt',voicePrompt:'PRIVATE_TRANSCRIPT',last:true});const turn=desk.sent.find(m=>m.type==='turn');ws.close();
 assert(desk.sent.some(m=>m.type==='cancel'));assert(desk.sent.some(m=>m.type==='ended'));assert.equal(f.voice.calls.size,0);
 desk.input({type:'result',sessionId:c.id,turnId:turn.turnId,generation:turn.generation,text:'LATE'});assert(!ws.sent.some(m=>m.token==='LATE'));
 const record=f.gateway.db.prepare('SELECT * FROM voice_calls').get();assert.equal(record.turns,1);assert(record.ended);assert(!JSON.stringify(record).includes('PRIVATE_TRANSCRIPT'));assert.match(f.inbound(),/<Hangup/);
});
test('silence, desktop loss and absolute call expiry end sessions',t=>{
 const f=fixture(t);f.call();f.advance(21000);assert.equal(f.voice.calls.size,0);assert(!f.voice.online());
});
test('no audio or persistence command is accepted over speech transport',t=>{const f=fixture(t),{ws,desk}=f.call();ws.input({type:'media',payload:'RAW_AUDIO'});ws.input({type:'dtmf',digit:'1'});assert(!desk.sent.some(m=>m.type==='turn'));ws.emit('message',Buffer.from('RAW_AUDIO'),true);assert.equal(ws.readyState,3);});

test('status follows ready, heartbeat, authenticated call, disconnect and desktop loss',t=>{
 const f=fixture(t),{ws,desk}=f.call();assert.deepEqual(f.voice.status().activeCalls,1);assert(f.voice.status().desktopOnline);
 assert(desk.sent.some(m=>m.type==='status'&&m.voice.desktopOnline&&m.voice.activeCalls===1));
 f.advance(5000);desk.input({type:'heartbeat'});assert.equal(desk.sent.at(-1).voice.desktopLastSeenAt,f.time());
 ws.close();assert.equal(desk.sent.at(-1).voice.activeCalls,0);assert(f.voice.status().desktopOnline);
 desk.close();assert.equal(f.voice.status().desktopOnline,false);assert.equal(f.voice.status().activeCalls,0);
});
test('timing persists only allowlisted metadata, separates desktop and gateway stages, no audible fiction',t=>{
 const f=fixture(t),{c,ws,desk}=f.call();ws.input({type:'prompt',voicePrompt:'PRIVATE_SPEECH',last:true});const turn=desk.sent.find(m=>m.type==='turn');
 for(const stage of ['desktopReceivedAt','executiveStartedAt','executiveCompletedAt','responseReturnedAt'])desk.input({type:'stage',sessionId:c.id,turnId:turn.turnId,generation:turn.generation,stage,at:f.time()});
 desk.input({type:'stage',sessionId:c.id,turnId:turn.turnId,generation:turn.generation,stage:'transcript',at:f.time()});
 desk.input({type:'result',sessionId:c.id,turnId:turn.turnId,generation:turn.generation,text:'PRIVATE_ANSWER'});
 ws.input({type:'interrupt',utteranceUntilInterrupt:'PRIVATE_ANSWER',durationUntilInterruptMs:460});ws.close();
 const raw=f.gateway.db.prepare('SELECT diagnostics FROM voice_calls').get().diagnostics,d=JSON.parse(raw),r=d.turns[0];
 assert.equal(d.audibleStart,'not-observable');assert.equal(d.interruptions[0].durationMs,460);
 assert.equal(r.finalAt+VOICE_SETTLE_MS,r.forwardedAt);
 for(const k of ['forwardedAt','desktopReceivedAt','executiveStartedAt','executiveCompletedAt','responseReturnedAt','responseReceivedAt','submittedAt'])assert.equal(r[k],f.time());
 assert.doesNotMatch(raw,/PRIVATE_|Digits|scrypt|transcript/);assert(d.endedAt);
});
test('barge-in while playback is submitted supersedes one generation without duplicate work',t=>{
 const f=fixture(t),{c,ws,desk}=f.call();ws.input({type:'prompt',voicePrompt:'First question',last:true});const a=desk.sent.find(m=>m.type==='turn');
 desk.input({type:'result',sessionId:c.id,turnId:a.turnId,generation:a.generation,text:'First answer'});
 assert(ws.sent.at(-1).interruptible&&ws.sent.at(-1).preemptible);
 ws.input({type:'interrupt',durationUntilInterruptMs:100});ws.input({type:'prompt',voicePrompt:'Second question',last:true});
 const b=desk.sent.filter(m=>m.type==='turn').at(-1);assert(b.generation>a.generation);
 desk.input({type:'result',sessionId:c.id,turnId:a.turnId,generation:a.generation,text:'STALE'});
 assert(!ws.sent.some(m=>m.token==='STALE'));assert.equal(c.diagnostics.turns[0].lateResultsRejected,1);assert.equal(c.pending.id,b.turnId);
});
test('disconnect marks pending timing cancelled, denies late results and clears active-call truth',t=>{
 const f=fixture(t),{c,ws,desk}=f.call();ws.input({type:'prompt',voicePrompt:'Work pending',last:true});const turn=desk.sent.find(m=>m.type==='turn');ws.close();
 const d=JSON.parse(f.gateway.db.prepare('SELECT diagnostics FROM voice_calls').get().diagnostics);assert.equal(d.turns[0].cancelReason,'disconnected');assert(!d.turns[0].submittedAt);
 assert(desk.sent.some(m=>m.type==='cancel'&&m.reason==='disconnected'));assert.equal(f.voice.status().activeCalls,0);
 desk.input({type:'result',sessionId:c.id,turnId:turn.turnId,generation:turn.generation,text:'LATE'});assert(!ws.sent.some(m=>m.token==='LATE'));
});

test('slow active work gets one preemptible acknowledgement, not a new turn or completion',t=>{
 const f=fixture(t),{c,ws,desk}=f.call();ws.input({type:'prompt',voicePrompt:'Create a calendar event',last:true});const turn=desk.sent.find(m=>m.type==='turn');
 desk.input({type:'stage',sessionId:c.id,turnId:turn.turnId,generation:turn.generation,stage:'executiveStartedAt',at:f.time()});
 f.advance(999);assert.equal(ws.sent.filter(m=>m.token?.includes('still working')).length,0);
 f.advance(1);const progress=ws.sent.at(-1);assert.equal(progress.token,"I'm still working on your request.");assert(progress.interruptible&&progress.preemptible&&progress.last);
 f.advance(5000);assert.equal(ws.sent.filter(m=>m.token===progress.token).length,1);assert.equal(desk.sent.filter(m=>m.type==='turn').length,1);assert.equal(c.pending.id,turn.turnId);
 desk.input({type:'result',sessionId:c.id,turnId:turn.turnId,generation:turn.generation,text:'Please confirm the event details.'});f.advance(5000);
 assert.equal(ws.sent.at(-1).token,'Please confirm the event details.');assert.equal(c.pending,null);assert(c.diagnostics.turns[0].progressSubmittedAt);
});

test('no delayed speech after fast completion, interruption, replacement, disconnect or before execution',t=>{
 const f=fixture(t),{c,ws,desk}=f.call();
 for(const scenario of ['not-started','fast','interrupted','superseded','disconnected']){
  desk.input({type:'heartbeat'});ws.input({type:'prompt',voicePrompt:'Request '+scenario,last:true});const turn=desk.sent.filter(m=>m.type==='turn').at(-1);
  if(scenario!=='not-started')desk.input({type:'stage',sessionId:c.id,turnId:turn.turnId,generation:turn.generation,stage:'executiveStartedAt',at:f.time()});
  if(scenario==='fast')desk.input({type:'result',sessionId:c.id,turnId:turn.turnId,generation:turn.generation,text:'Done.'});
  if(scenario==='interrupted')ws.input({type:'interrupt'});
  if(scenario==='superseded')ws.input({type:'prompt',voicePrompt:'Replacement',last:true});
  if(scenario==='disconnected')ws.close();
  f.advance(4100);assert(!ws.sent.some(m=>m.token?.includes('still working')));
 }
});

test('partial owner speech suppresses the delayed acknowledgement',t=>{
 const f=fixture(t),{c,ws,desk}=f.call();ws.input({type:'prompt',voicePrompt:'First request',last:true});const turn=desk.sent.find(m=>m.type==='turn');
 desk.input({type:'stage',sessionId:c.id,turnId:turn.turnId,generation:turn.generation,stage:'executiveStartedAt',at:f.time()});
 ws.input({type:'prompt',voicePrompt:'Actually',last:false});f.advance(5000);assert(!ws.sent.some(m=>m.token?.includes('still working')));
});

test('acknowledges during the two-to-three-second latency observed on the calendar retest',t=>{
 const f=fixture(t),{c,ws,desk}=f.call();ws.input({type:'prompt',voicePrompt:'Prepare my event',last:true});const turn=desk.sent.find(m=>m.type==='turn');
 desk.input({type:'stage',sessionId:c.id,turnId:turn.turnId,generation:turn.generation,stage:'executiveStartedAt',at:f.time()});
 f.advance(1500);assert.equal(ws.sent.at(-1).token,"I'm still working on your request.");
 f.advance(1000);desk.input({type:'result',sessionId:c.id,turnId:turn.turnId,generation:turn.generation,text:'Please confirm the event.'});
 assert.equal(ws.sent.at(-1).token,'Please confirm the event.');assert.equal(ws.sent.filter(m=>m.token?.includes('still working')).length,1);
});

test('does not repeat progress on rapid follow-ups or speak progress for an already completed turn',t=>{
 const f=fixture(t),{c,ws,desk}=f.call();
 for(let n=0;n<3;n++){
  ws.input({type:'prompt',voicePrompt:'Follow-up '+n,last:true});const turn=desk.sent.filter(m=>m.type==='turn').at(-1);
  desk.input({type:'stage',sessionId:c.id,turnId:turn.turnId,generation:turn.generation,stage:'executiveStartedAt',at:f.time()});
  f.advance(1500);desk.input({type:'result',sessionId:c.id,turnId:turn.turnId,generation:turn.generation,text:'Result '+n});
 }
 assert.equal(ws.sent.filter(m=>m.token?.includes('still working')).length,1);
 f.advance(5000);assert.equal(ws.sent.at(-1).token,'Result 2');
});

test('observed split date and time are delivered as one utterance without guessing or persistence',t=>{
 const f=fixture(t),{ws,desk,c}=f.call({settle:false});
 ws.input({type:'prompt',voicePrompt:'Create a calendar event for a power 5th called call my wife.',last:true});
 f.advance(2727);assert(!desk.sent.some(m=>m.type==='turn'));
 ws.input({type:'prompt',voicePrompt:'From 12 30 to 12 4.',last:true});f.advance(1139);
 ws.input({type:'prompt',voicePrompt:'5.',last:true});f.advance(VOICE_SETTLE_MS-1);
 assert(!desk.sent.some(m=>m.type==='turn'));assert(!ws.sent.some(m=>m.token?.includes('still working')));
 f.advance(1);const turns=desk.sent.filter(m=>m.type==='turn');assert.equal(turns.length,1);
 assert.equal(turns[0].text,'Create a calendar event for a power 5th called call my wife. From 12 30 to 12 4. 5.');
 assert.equal(c.turns,1);assert.equal(c.utterance,null);
 ws.close();assert.doesNotMatch(JSON.stringify(f.gateway.db.prepare('SELECT * FROM voice_calls').all()),/power|wife|12 30/);
});

test('interim speech postpones dispatch but never enters the forwarded text',t=>{
 const f=fixture(t),{ws,desk}=f.call({settle:false});
 ws.input({type:'prompt',voicePrompt:'Create an event.',last:true});f.advance(2000);
 ws.input({type:'prompt',voicePrompt:'UNFINALIZED',last:false});f.advance(4000);
 assert(!desk.sent.some(m=>m.type==='turn'));
 ws.input({type:'interrupt'});
 ws.input({type:'prompt',voicePrompt:'Tomorrow at noon.',last:true});f.advance(VOICE_SETTLE_MS);
 assert.equal(desk.sent.find(m=>m.type==='turn').text,'Create an event. Tomorrow at noon.');
});

test('partial barge-in cancels pending work immediately but preserves unanswered words',t=>{
 const f=fixture(t),{ws,desk,c}=f.call({settle:false});
 ws.input({type:'prompt',voicePrompt:'First question',last:true});f.advance(VOICE_SETTLE_MS);
 const turn=desk.sent.find(m=>m.type==='turn');
 ws.input({type:'prompt',voicePrompt:'Actually',last:false});assert.equal(c.pending,null);
 desk.input({type:'result',sessionId:c.id,turnId:turn.turnId,generation:turn.generation,text:'STALE'});
 assert(!ws.sent.some(m=>m.token==='STALE'));
 ws.input({type:'prompt',voicePrompt:'A different question',last:true});f.advance(VOICE_SETTLE_MS);
 assert.equal(desk.sent.filter(m=>m.type==='turn').at(-1).text,'First question A different question');
});

test('calendar request survives successive late continuations until a result is submitted',t=>{
 const f=fixture(t),{ws,desk,c}=f.call({settle:false});
 ws.input({type:'prompt',voicePrompt:'Create a calendar event.',last:true});f.advance(VOICE_SETTLE_MS);
 const first=desk.sent.filter(m=>m.type==='turn').at(-1);
 ws.input({type:'prompt',voicePrompt:'Call My Wife on October fifth.',last:true});f.advance(VOICE_SETTLE_MS);
 const second=desk.sent.filter(m=>m.type==='turn').at(-1);
 assert.equal(second.text,'Create a calendar event. Call My Wife on October fifth.');
 ws.input({type:'prompt',voicePrompt:'From twelve thirty to twelve forty-five.',last:true});f.advance(VOICE_SETTLE_MS);
 const third=desk.sent.filter(m=>m.type==='turn').at(-1);
 assert.equal(third.text,'Create a calendar event. Call My Wife on October fifth. From twelve thirty to twelve forty-five.');
 for(const old of [first,second])desk.input({type:'result',sessionId:c.id,turnId:old.turnId,generation:old.generation,text:'STALE'});
 assert(!ws.sent.some(m=>m.token==='STALE'));
 desk.input({type:'result',sessionId:c.id,turnId:third.turnId,generation:third.generation,text:'Readback. Should I create it?'});
 ws.input({type:'prompt',voicePrompt:'Cancel the event.',last:true});f.advance(VOICE_SETTLE_MS);
 assert.equal(desk.sent.filter(m=>m.type==='turn').at(-1).text,'Cancel the event.');
 ws.close();assert.doesNotMatch(JSON.stringify(f.gateway.db.prepare('SELECT * FROM voice_calls').all()),/October|Wife|twelve/);
});

test('an interruption without a final continuation never resubmits the cancelled request',t=>{
 const f=fixture(t),{ws,desk}=f.call({settle:false});
 ws.input({type:'prompt',voicePrompt:'Create an event.',last:true});f.advance(VOICE_SETTLE_MS);
 ws.input({type:'interrupt'});f.advance(5000);
 assert.equal(desk.sent.filter(m=>m.type==='turn').length,1);
 ws.close();f.advance(5000);assert.equal(desk.sent.filter(m=>m.type==='turn').length,1);
});

test('late continuation still obeys total utterance size and fragment limits',t=>{
 const f=fixture(t),{ws,desk}=f.call({settle:false});
 ws.input({type:'prompt',voicePrompt:'x'.repeat(1800),last:true});f.advance(VOICE_SETTLE_MS);
 ws.input({type:'prompt',voicePrompt:'y'.repeat(200),last:true});f.advance(VOICE_SETTLE_MS);
 assert.equal(f.voice.calls.size,0);assert.equal(desk.sent.filter(m=>m.type==='turn').length,1);
 const g=fixture(t),b=g.call({settle:false});
 for(let n=0;n<9;n++){
  b.desk.input({type:'heartbeat'});b.ws.input({type:'prompt',voicePrompt:'part '+n,last:true});g.advance(VOICE_SETTLE_MS);
 }
 assert.equal(g.voice.calls.size,0);assert.equal(b.desk.sent.filter(m=>m.type==='turn').length,8);
});

test('a confirmation and immediate correction remain one non-exact confirmation turn',t=>{
 const f=fixture(t),{ws,desk}=f.call({settle:false});
 ws.input({type:'prompt',voicePrompt:'Yes.',last:true});f.advance(1000);
 ws.input({type:'prompt',voicePrompt:'Actually, no.',last:true});f.advance(VOICE_SETTLE_MS);
 assert.equal(desk.sent.filter(m=>m.type==='turn').length,1);
 assert.equal(desk.sent.find(m=>m.type==='turn').text,'Yes. Actually, no.');
});

test('buffered speech is dropped on disconnect, desktop loss and expiry',t=>{
 for(const reason of ['disconnect','desktop-loss','expiry']){
  const f=fixture(t),{ws,desk,c}=f.call({settle:false});
  ws.input({type:'prompt',voicePrompt:'UNSENT',last:true});
  if(reason==='disconnect')ws.close();else if(reason==='desktop-loss')desk.close();else c.expires=f.time()+1;
  f.advance(VOICE_SETTLE_MS);assert(!desk.sent.some(m=>m.type==='turn'));assert.equal(c.utterance,null);
 }
});

test('utterance limits fail closed before dispatch and duplicates are not appended',t=>{
 const f=fixture(t),{ws,desk,c}=f.call({settle:false});
 const p={type:'prompt',voicePrompt:'Same fragment',last:true};ws.input(p);ws.input(p);
 assert.equal(c.utterance.parts.length,1);
 for(let n=0;n<8;n++)ws.input({type:'prompt',voicePrompt:'Part '+n,last:true});
 assert.equal(f.voice.calls.size,0);assert(!desk.sent.some(m=>m.type==='turn'));
 const g=fixture(t),b=g.call({settle:false});
 b.ws.input({type:'prompt',voicePrompt:'x'.repeat(1500),last:true});b.ws.input({type:'prompt',voicePrompt:'y'.repeat(501),last:true});
 assert.equal(g.voice.calls.size,0);assert(!b.desk.sent.some(m=>m.type==='turn'));
});
