import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import twilio from 'twilio';
import { WebSocketServer } from 'ws';
import { GatewayError, digest } from './gateway.mjs';

export const VOICE = { inbound:'/twilio/voice/inbound', auth:'/twilio/voice/auth', ended:'/twilio/voice/ended', session:'/twilio/voice/session/', desktop:'/desktop/voice' };
export const VOICE_SETTLE_MS = 3000;
const offline = "Mo is currently offline and can't access your workspace.";
const sid = v => /^CA[a-fA-F0-9]{32}$/.test(v ?? '');
const fail = (status, code) => { throw new GatewayError(status, code); };
const send = (ws, value) => { if (ws?.readyState === 1 && ws.bufferedAmount < 32768) ws.send(JSON.stringify(value)); else throw new Error('VOICE_DISCONNECTED'); };
export function pinVerifier(pin, salt = randomBytes(16).toString('hex')) {
 if (!/^\d{6,12}$/.test(pin) || !/^[a-f0-9]{32}$/.test(salt)) throw new Error('INVALID_VOICE_PIN');
 return `scrypt:${salt}:${scryptSync(pin, salt, 32, { N:32768,r:8,p:1,maxmem:64*1024*1024 }).toString('hex')}`;
}
export function verifyPin(pin, verifier) {
 if (!/^\d{6,12}$/.test(pin ?? '') || !/^scrypt:[a-f0-9]{32}:[a-f0-9]{64}$/.test(verifier ?? '')) return false;
 const [,salt,key] = verifier.split(':');
 return timingSafeEqual(Buffer.from(pinVerifier(pin,salt).split(':')[2],'hex'),Buffer.from(key,'hex'));
}
export function endXml(message = 'This call cannot be connected.') {
 const response = new twilio.twiml.VoiceResponse(); response.say({voice:'alice'},message); response.hangup(); return response.toString();
}

/** Speech transport only. Text is held in memory; SQLite retains content-free replay/cost metadata. */
export class VoiceGateway {
 constructor(gateway, config = {}) {
  this.gateway=gateway; this.now=gateway.now; this.config=config; this.calls=new Map(); this.desktop=null;
  if (config.enabled && (!/^\+[1-9]\d{7,14}$/.test(config.ownerPhone ?? '') || !/^scrypt:[a-f0-9]{32}:[a-f0-9]{64}$/.test(config.pinVerifier ?? ''))) throw Error('INVALID_VOICE_CONFIGURATION');
  gateway.db.exec('CREATE TABLE IF NOT EXISTS voice_calls (sid TEXT PRIMARY KEY, started INTEGER NOT NULL, connected INTEGER, ended INTEGER, seconds INTEGER NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0)');
  if(!gateway.db.prepare('PRAGMA table_info(voice_calls)').all().some(c=>c.name==='diagnostics'))gateway.db.exec('ALTER TABLE voice_calls ADD COLUMN diagnostics TEXT');
  // A process restart invalidates every call; an old signed webhook cannot reauthenticate it.
  gateway.db.prepare('UPDATE voice_calls SET ended=? WHERE ended IS NULL').run(this.now());
  this.timer=setInterval(()=>this.tick(),1000); this.timer.unref();
 }
 status() { return {configured:!!this.config.enabled,ownerConfigured:!!this.config.ownerPhone,pinConfigured:!!this.config.pinVerifier,desktopOnline:this.online(),activeCalls:[...this.calls.values()].filter(c=>c.connected).length,scope:'read-prepare',recording:false,observedAt:this.now(),desktopLastSeenAt:this.desktop?.seen??null}; }
 publishStatus(){try{send(this.desktop?.ws,{type:'status',voice:this.status()});}catch{/* Peer loss is handled by its connection lifecycle. */}}
 diagnostics(c){
  this.gateway.db.prepare('UPDATE voice_calls SET diagnostics=? WHERE sid=?').run(JSON.stringify(c.diagnostics),c.sid);
  if(c.connected)try{send(this.desktop?.ws,{type:'diagnostics',sessionId:c.id,diagnostics:c.diagnostics});}catch{/* Metadata cannot authorize a call. */}
 }
 online() { return !!this.desktop?.ready && this.desktop.ws.readyState===1 && this.now()-this.desktop.seen<20000; }
 validate(route, raw, signature) {
  if (![VOICE.inbound,VOICE.ended].includes(route)&&!/^\/twilio\/voice\/auth\?challenge=[a-f0-9]{48}$/.test(route) || Buffer.byteLength(raw)>16384) fail(400,'INVALID_VOICE_REQUEST');
  this.gateway.rate('voice-webhook',60);
  const params=Object.create(null);
  for(const [key,value] of new URLSearchParams(raw)){if(key.length>100||value.length>4000||Object.hasOwn(params,key))fail(400,'INVALID_FORM');params[key]=value;}
  if(typeof signature!=='string'||signature.length>128||!twilio.validateRequest(this.gateway.config.authToken,signature,this.gateway.config.publicOrigin+route,params))fail(403,'INVALID_SIGNATURE');
  if(params.AccountSid!==this.gateway.config.accountSid||params.To!==this.gateway.config.number||!sid(params.CallSid))fail(403,'VOICE_BINDING_MISMATCH');
  return params;
 }
 webhook(route, raw, signature, requestUrl=route) {
  const receivedAt=this.now();
  const p=this.validate(requestUrl,raw,signature);
  if(!this.config.enabled||p.From!==this.config.ownerPhone)return endXml();
  if(route===VOICE.ended){this.end(this.calls.get(p.CallSid));return endXml('Goodbye.');}
  if(route===VOICE.inbound){
   if(p.Direction!=='inbound'||this.gateway.db.prepare('SELECT sid FROM voice_calls WHERE sid=?').get(p.CallSid))return endXml();
   this.gateway.rate('voice-owner-calls',3);
   const daily=this.gateway.db.prepare('SELECT count(*) n FROM voice_calls WHERE started>?').get(this.now()-86400000).n;
   if(daily>=12||this.calls.size)return endXml('Mo is unavailable. Please try again later.');
   this.gateway.db.prepare('INSERT INTO voice_calls(sid,started) VALUES(?,?)').run(p.CallSid,this.now());
   const call={sid:p.CallSid,id:randomUUID(),conversationId:randomUUID(),started:this.now(),expires:this.now()+120000,attempt:0,challenge:randomBytes(24).toString('hex'),authenticated:false,connected:false,turns:0,generation:0,lastActivity:this.now()};
   call.diagnostics={inboundAt:receivedAt,turns:[],interruptions:[],audibleStart:'not-observable'};
   this.calls.set(call.sid,call);this.diagnostics(call);return this.gather(call);
  }
  if(route!==VOICE.auth)fail(404,'NOT_FOUND');
  const call=this.calls.get(p.CallSid);
  if(!call||call.authenticated||call.expires<=this.now()||requestUrl!==VOICE.auth+'?challenge='+call.challenge){return endXml();}
  this.gateway.rate('voice-pin',6); call.attempt++;
  if(!verifyPin(p.Digits,this.config.pinVerifier)){
   if(call.attempt>=3){this.end(call);return endXml();}
   call.challenge=randomBytes(24).toString('hex');return this.gather(call);
  }
  if(!this.online()){this.end(call);return endXml(offline);}
  call.authenticated=true;call.expires=this.now()+10*60000;call.joinBy=this.now()+15000;call.ticket=randomBytes(32).toString('hex');call.ownerId=this.desktop.id;
  call.diagnostics.pinAuthenticatedAt=this.now();this.diagnostics(call);
  const response=new twilio.twiml.VoiceResponse();
  const relay=response.connect({action:this.gateway.config.publicOrigin+VOICE.ended,method:'POST'}).conversationRelay({url:this.gateway.config.publicOrigin.replace('https:','wss:')+VOICE.session,language:'en-US',ttsProvider:'Google',voice:'en-US-Journey-O',transcriptionProvider:'Deepgram',speechModel:'nova-3-general',interruptible:'speech',reportInputDuringAgentSpeech:'speech',dtmfDetection:false});
  relay.parameter({name:'voiceTicket',value:call.ticket});response.hangup();return response.toString();
 }
 gather(call) {
  const r=new twilio.twiml.VoiceResponse();
  // Rotate an opaque challenge per attempt; neither the PIN nor a verifier enters the URL.
  const action=this.gateway.config.publicOrigin+VOICE.auth+'?challenge='+call.challenge;
  r.gather({input:'dtmf',action,method:'POST',timeout:10,finishOnKey:'#',actionOnEmptyResult:true}).say({voice:'alice'},call.attempt?'Please try your access PIN again, followed by the pound key.':'Hi, this is Mo. Please enter your access PIN, followed by the pound key.');
  r.hangup();return r.toString();
 }
 authWebhook(rawUrl,raw,signature) {
  return this.webhook(VOICE.auth,raw,signature,rawUrl);
 }
 validateSocket(req) {
  if(req.method!=='GET')fail(405,'GET_REQUIRED');
  if(req.url===VOICE.desktop){this.gateway.authenticate('GET',VOICE.desktop,'',req.headers);return 'desktop';}
  if(req.url!==VOICE.session||!this.config.enabled)fail(404,'NOT_FOUND');
  this.gateway.rate('voice-upgrade',12);
  const signature=req.headers['x-twilio-signature'];
  const url=this.gateway.config.publicOrigin.replace('https:','wss:')+VOICE.session;
  if(typeof signature!=='string'||signature.length>128||!twilio.validateRequest(this.gateway.config.authToken,signature,url,{}))fail(403,'INVALID_SIGNATURE');
  return 'twilio';
 }
 attach(server) {
  const wss=new WebSocketServer({noServer:true,maxPayload:16384,perMessageDeflate:false});this.wss=wss;
  server.on('upgrade',(req,socket,head)=>{
   try {const kind=this.validateSocket(req);wss.handleUpgrade(req,socket,head,ws=>kind==='desktop'?this.connectDesktop(ws):this.connectTwilio(ws));}
   catch{socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');}
  });
 }
 connectDesktop(ws) {
  if(this.desktop){this.endAll();this.desktop.ws.close(1000);}
  const d={ws,id:this.gateway.get('device').id,seen:this.now(),ready:false};this.desktop=d;
  send(ws,{type:'hello',version:1,deviceId:d.id,accountSid:this.gateway.config.accountSid,number:this.gateway.config.number,voice:this.status()});
  ws.on('message',(bytes,binary)=>{try{if(binary)throw Error();const m=JSON.parse(bytes.toString());
   if(this.desktop!==d)return;
   if(m.type==='ready'){d.ready=true;d.seen=this.now();this.publishStatus();return;}
   if(m.type==='heartbeat'){d.seen=this.now();send(ws,{type:'heartbeat'});this.publishStatus();return;}
   const c=[...this.calls.values()].find(c=>c.id===m.sessionId);
   if(!c||this.desktop!==d||c.ownerId!==d.id||!c.connected||c.expires<=this.now())return;
   const timing=c.diagnostics.turns.find(t=>t.id===m.turnId&&t.generation===m.generation);
   if(m.type==='stage'){
    if(!timing||!['desktopReceivedAt','executiveStartedAt','executiveCompletedAt','responseReturnedAt'].includes(m.stage)||!Number.isSafeInteger(m.at)||Math.abs(m.at-this.now())>600000)return;
    timing[m.stage]??=m.at;this.diagnostics(c);return;
   }
   if(m.type==='accepted'&&!c.accepted){c.accepted=true;send(c.ws,{type:'text',token:'Hi, this is Mo. What can I help you with?',last:true,interruptible:true});return;}
   if(m.type==='end'){this.end(c);return;}
   if(m.type!=='result')return;
   if(!c.pending||m.turnId!==c.pending.id||m.generation!==c.pending.generation){if(timing){timing.lateResultsRejected=(timing.lateResultsRejected??0)+1;this.diagnostics(c);}return;}
   timing.responseReceivedAt=this.now();
   c.pending=null;
   if(typeof m.text!=='string'||!m.text.trim()||m.text.length>1800)throw Error();
   // Strip SSML metacharacters: model output must never become a play/audio command.
   send(c.ws,{type:'text',token:m.text.replace(/[<>&]/g,' '),last:true,interruptible:true,preemptible:true});
   timing.submittedAt=this.now();this.diagnostics(c);
   send(ws,{type:'state',sessionId:c.id,state:'waiting'});
  }catch{ws.close(1008);}});
  const closed=()=>{if(this.desktop===d){this.desktop=null;this.endAll();}};ws.on('close',closed);ws.on('error',closed);
 }
 connectTwilio(ws) {
  let call=null;const socketConnectedAt=this.now();
  const setupTimer=setTimeout(()=>{if(!call)ws.close(1008);},5000);setupTimer.unref();
  ws.on('message',(bytes,binary)=>{const receivedAt=this.now();try{if(binary)throw Error();const m=JSON.parse(bytes.toString());
   if(m.type==='setup'){
    if(call){if(m.callSid===call.sid&&m.sessionId===call.providerSession)return;throw Error();}
    const c=this.calls.get(m.callSid);
    if(!c||!c.authenticated||c.connected||c.joinBy<this.now()||!this.online()||c.ownerId!==this.desktop.id||m.accountSid!==this.gateway.config.accountSid||m.from!==this.config.ownerPhone||m.to!==this.gateway.config.number||m.direction!=='inbound'||typeof m.customParameters?.voiceTicket!=='string'||digest(m.customParameters.voiceTicket)!==digest(c.ticket))throw Error();
    call=c;c.ws=ws;c.ticket=null;c.connected=true;c.connectedAt=this.now();c.providerSession=m.sessionId;c.lastActivity=this.now();
    c.diagnostics.socketConnectedAt=socketConnectedAt;
    this.gateway.db.prepare('UPDATE voice_calls SET connected=? WHERE sid=?').run(this.now(),c.sid);
    send(this.desktop.ws,{type:'session',session:{id:c.id,conversationId:c.conversationId,callSid:c.sid,ownerId:c.ownerId,startedAt:new Date(c.connectedAt).toISOString(),expiresAt:new Date(c.expires).toISOString(),scope:'read-prepare',authentication:'caller-and-pin'}});this.publishStatus();this.diagnostics(c);return;
   }
   const c=call;if(!c||!c.accepted||!this.calls.has(c.sid)||c.expires<=this.now())throw Error();
   c.lastActivity=this.now();
   if(m.type==='interrupt'){
    if(c.diagnostics.interruptions.length<40)c.diagnostics.interruptions.push({at:this.now(),...(typeof m.durationUntilInterruptMs==='number'&&Number.isFinite(m.durationUntilInterruptMs)&&m.durationUntilInterruptMs>=0?{durationMs:m.durationUntilInterruptMs}:{})});
    this.cancel(c,'interrupted');if(c.utterance)c.utterance.awaitingFinal=true;this.diagnostics(c);send(this.desktop.ws,{type:'state',sessionId:c.id,state:'waiting'});return;
   }
   if(m.type==='error'){this.end(c);return;}
   if(m.type!=='prompt'||typeof m.voicePrompt!=='string'||typeof m.last!=='boolean')return;
   if(m.voicePrompt.length>2000)throw Error();
   if(!m.last){c.partial=m.voicePrompt;if(c.utterance)c.utterance.lastActivity=this.now();if(c.pending)this.cancel(c,'superseded');return;}
   const text=m.voicePrompt.trim();c.partial=null;if(!text)return;
   const fingerprint=digest(text);if(c.lastPrompt===fingerprint&&this.now()-c.lastPromptAt<8000)return;
   if(c.pending)this.cancel(c,'superseded');
   c.lastPrompt=fingerprint;c.lastPromptAt=this.now();
   const u=c.utterance??{parts:[],lastActivity:this.now(),finalAt:receivedAt};
   u.parts.push(text);u.lastActivity=this.now();u.finalAt=receivedAt;u.awaitingFinal=false;c.utterance=u;
   if(u.parts.length>8||u.parts.join(' ').length>2000){this.end(c);return;}
  }catch{this.end(call);ws.close(1008);}});
  const closed=()=>{clearTimeout(setupTimer);this.end(call);};ws.on('close',closed);ws.on('error',closed);
 }
 flushUtterance(c){
  const u=c.utterance;
  if(!u||u.awaitingFinal||c.partial||this.now()-u.lastActivity<VOICE_SETTLE_MS)return;
  c.utterance=null;
  if(c.turns>=20){this.end(c);return;}
  this.cancel(c,'superseded');c.turns++;
  c.pending={id:randomUUID(),generation:c.generation,at:this.now(),parts:u.parts};
  const timing={id:c.pending.id,generation:c.generation,finalAt:u.finalAt};c.diagnostics.turns.push(timing);
  send(this.desktop.ws,{type:'turn',sessionId:c.id,turnId:c.pending.id,generation:c.generation,text:u.parts.join(' ')});
  timing.forwardedAt=this.now();this.diagnostics(c);
 }
 cancel(c,reason='superseded') {if(c.pending){
  // A continuation may arrive just after dispatch. Keep unanswered words, never a submitted reply.
  if(['superseded','interrupted'].includes(reason)&&!c.utterance)c.utterance={parts:[...c.pending.parts],lastActivity:this.now(),finalAt:this.now(),awaitingFinal:true};
  const timing=c.diagnostics.turns.find(t=>t.id===c.pending.id);if(timing){timing.cancelledAt=this.now();timing.cancelReason=reason;}try{send(this.desktop?.ws,{type:'cancel',sessionId:c.id,turnId:c.pending.id,reason});}catch{}c.pending=null;this.diagnostics(c);}c.generation++;}
 end(c,reason='disconnected') {
  if(!c||!this.calls.has(c.sid))return;
  this.cancel(c,reason);this.calls.delete(c.sid);c.diagnostics.endedAt=this.now();this.diagnostics(c);
  this.gateway.db.prepare('UPDATE voice_calls SET ended=?,seconds=?,turns=? WHERE sid=?').run(this.now(),c.connectedAt?Math.ceil((this.now()-c.connectedAt)/1000):0,c.turns,c.sid);
  try{send(this.desktop?.ws,{type:'ended',sessionId:c.id,endedAt:new Date(this.now()).toISOString()});}catch{}
  this.publishStatus();
  try{send(c.ws,{type:'end'});c.ws.close(1000);}catch{}
  c.partial=null;c.utterance=null;c.ticket=null;
 }
 endAll(){for(const c of this.calls.values())this.end(c);}
 tick(){
  if(this.desktop&&!this.online()&&this.now()-this.desktop.seen>=20000){this.desktop.ws.terminate();this.desktop=null;}
  for(const c of this.calls.values())if(c.expires<=this.now()||c.authenticated&&(!this.online()||!c.connected&&c.joinBy<this.now())||c.connected&&(!c.accepted&&this.now()-c.connectedAt>10000||this.now()-c.lastActivity>60000||c.pending&&this.now()-c.pending.at>90000))this.end(c);
  // STT can finalize mid-sentence. Only finalized text is joined; interim text delays dispatch.
  for(const c of this.calls.values())if(c.connected&&c.accepted&&this.online())try{this.flushUtterance(c);}catch{this.end(c);}
  // One content-free acknowledgement per pending turn; never imply a write succeeded.
  for(const c of this.calls.values())if(c.connected&&c.accepted&&this.online()&&c.pending&&!c.pending.acknowledged&&this.now()-c.pending.at>=1000&&!c.partial&&(c.lastProgressAt===undefined||this.now()-c.lastProgressAt>=30000)){
   const timing=c.diagnostics.turns.find(t=>t.id===c.pending.id&&t.generation===c.pending.generation);
   if(!timing?.executiveStartedAt)continue;
   try{send(c.ws,{type:'text',token:"I'm still working on your request.",last:true,interruptible:true,preemptible:true});c.pending.acknowledged=true;c.lastProgressAt=this.now();timing.progressSubmittedAt=this.now();this.diagnostics(c);}catch{this.end(c);}
  }
  this.gateway.db.prepare('DELETE FROM voice_calls WHERE started<?').run(this.now()-30*86400000);
 }
 close(){clearInterval(this.timer);this.endAll();this.desktop?.ws.terminate();for(const ws of this.wss?.clients??[])ws.terminate();this.wss?.close();}
}
