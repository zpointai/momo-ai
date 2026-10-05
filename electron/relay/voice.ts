import { createHash, randomUUID, sign } from 'node:crypto';
import WebSocket from 'ws';
import type { AssistantService } from '../ai/service';
import type { AssistantRun } from '../../src/shared/assistant';
import type { RelayTransportConfig } from '../../src/shared/relay-transport';
import { voiceFrameSchema, type VoiceSession, type VoiceStatus, type VoiceCancelReason } from '../../src/shared/voice';
import { AppError } from '../errors';
import { spokenText } from '../ai/voice-output';
import { emptyVoiceCallContext } from '../ai/voice-context';
import { VoiceTaskConfirmation } from '../ai/voice-confirmation';
import { VoiceCalendarConfirmation } from '../ai/voice-calendar';
export { spokenText } from '../ai/voice-output';

export interface VoiceConnection {config:RelayTransportConfig;device:{id:string;privateKey:string}}

/** Uses the existing protected device identity and the one native AssistantService. */
export class DesktopVoice {
 private ws:WebSocket|null=null;private timer:ReturnType<typeof setInterval>|null=null;private checking=false;private stopped=true;private retryAt=0;private seen=0;
 private connection:VoiceConnection|null=null;private session:VoiceSession|null=null;private history:AssistantRun[]=[];private turns=new Set<string>();private sessions=new Set<string>();
 private pending:{id:string;generation:number;cancellation:{reason?:VoiceCancelReason;at?:number}}|null=null;private work:Promise<void>=Promise.resolve();
 private cleanup:Promise<void>=Promise.resolve();
 private context=emptyVoiceCallContext();private confirmation=new VoiceTaskConfirmation();private calendarConfirmation=new VoiceCalendarConfirmation();
 private status:VoiceStatus={gateway:null,channel:'disabled',call:'none',sessionId:null};
 constructor(private getConnection:()=>Promise<VoiceConnection|null>,private assistant:Pick<AssistantService,'start'|'cancel'|'idle'>,private notify:()=>void,private ended:(id:string,at:string)=>Promise<void>,private now=Date.now,private connect=(url:string,headers:Record<string,string>)=>new WebSocket(url,{headers,followRedirects:false,handshakeTimeout:10000,maxPayload:16384,perMessageDeflate:false})){}
 snapshot(){return structuredClone(this.status);}
 start(){if(this.timer)return;this.stopped=false;this.timer=setInterval(()=>void this.tick(),5000);this.timer.unref();void this.tick();}
 private update(patch:Partial<VoiceStatus>){if(JSON.stringify({...this.status,...patch})===JSON.stringify(this.status))return;Object.assign(this.status,patch);this.notify();}
 async tick(){
  if(this.stopped||this.checking)return;this.checking=true;
  try{
   const c=await this.getConnection();if(this.stopped)return;
   if(!c?.config.voice?.enabled){this.disconnect('disabled');return;}
   if(this.connection&&JSON.stringify(c.config)!==JSON.stringify(this.connection.config))this.disconnect();
   if(this.session&&Date.parse(this.session.expiresAt)<=this.now())this.finish(true,'expired');
   if(this.ws){if(this.now()-this.seen>20000){this.disconnect();return;}if(this.ws.readyState===WebSocket.OPEN)this.send({type:'heartbeat'});return;}
   if(this.now()<this.retryAt)return;this.retryAt=this.now()+15000;this.connection=c;
   const at=String(this.now()),nonce=randomUUID(),route='/desktop/voice',bodyHash=createHash('sha256').update('').digest('hex');
   const headers={'x-relay-device':c.device.id,'x-relay-time':at,'x-relay-nonce':nonce,'x-relay-signature':sign(null,Buffer.from(['GET',route,at,nonce,bodyHash].join('\n')),c.device.privateKey).toString('base64')};
   this.update({channel:'connecting'});this.seen=this.now();
   const ws=this.connect(c.config.gatewayOrigin.replace('https:','wss:')+route,headers);this.ws=ws;
   ws.on('message',(data,binary)=>{if(this.ws!==ws)return;try{if(binary||Buffer.byteLength(data.toString())>16384)throw Error();this.message(JSON.parse(data.toString()));}catch{this.disconnect();}});
   const closed=()=>{if(this.ws===ws)this.disconnect();};ws.on('close',closed);ws.on('error',closed);
  }catch{this.disconnect();}finally{this.checking=false;}
 }
 private send(value:unknown){if(this.ws?.readyState!==WebSocket.OPEN||this.ws.bufferedAmount>32768)throw new AppError('unavailable','Voice channel is offline.');this.ws.send(JSON.stringify(value));}
 private message(raw:unknown){
  const m=voiceFrameSchema.parse(raw);this.seen=this.now();this.update({lastSeenAt:this.seen});const c=this.connection!;
  if(m.type==='hello'){
   if(this.status.channel!=='connecting'||m.deviceId!==c.device.id||m.accountSid!==c.config.accountSid||m.number!==c.config.number)throw Error('VOICE_BINDING');
   this.update({gateway:m.voice,channel:'online'});this.send({type:'ready'});return;
  }
  if(this.status.channel!=='online')throw Error('VOICE_NOT_READY');
  if(m.type==='heartbeat')return;
  if(m.type==='status'){this.update({gateway:m.voice});return;}
  if(m.type==='session'){
   const s=m.session;
   if(this.session||this.sessions.has(s.id)||s.ownerId!==c.device.id||Date.parse(s.startedAt)>this.now()+5000||this.now()-Date.parse(s.startedAt)>15000||Date.parse(s.expiresAt)<=this.now()||Date.parse(s.expiresAt)-this.now()>600000)throw Error('VOICE_SESSION');
   this.sessions.add(s.id);if(this.sessions.size>100)this.sessions.delete(this.sessions.values().next().value!);
   this.session=s;this.history=[];this.context=emptyVoiceCallContext();this.confirmation.clear();this.calendarConfirmation.reset();this.turns.clear();this.update({sessionId:s.id,call:'connected'});this.send({type:'accepted',sessionId:s.id});return;
  }
  if(!this.session||m.sessionId!==this.session.id)return;
  if(m.type==='diagnostics'){this.update({diagnostics:m.diagnostics});return;}
  if(m.type==='ended'){this.finish(false);return;}
  if(m.type==='state'){if(!this.pending)this.update({call:m.state});return;}
  if(m.type==='cancel'){if(this.turns.has(m.turnId)){this.confirmation.clear();if(!m.reason||['interrupted','superseded'].includes(m.reason))this.calendarConfirmation.invalidateConfirmation();else this.calendarConfirmation.clear();}if(this.pending?.id===m.turnId){this.cancelPending(m.reason??'interrupted');this.update({call:'waiting'});}return;}
  if(this.turns.has(m.turnId))return;if(this.turns.size>=20)throw Error('VOICE_LIMIT');
  this.cancelPending('superseded');
  const job={id:m.turnId,generation:m.generation,cancellation:{} as {reason?:VoiceCancelReason;at?:number}},session=this.session;this.pending=job;this.turns.add(job.id);
  const stage=(name:string)=>this.send({type:'stage',sessionId:session.id,turnId:job.id,generation:job.generation,stage:name,at:this.now()});
  stage('desktopReceivedAt');
  this.work=this.work.catch(()=>{}).then(async()=>{
   const guard=async()=>{const current=await this.getConnection();if(this.pending!==job||this.session!==session||this.status.channel!=='online'||Date.parse(session.expiresAt)<=this.now()||!current||JSON.stringify(current.config)!==JSON.stringify(c.config)){job.cancellation.reason??=Date.parse(session.expiresAt)<=this.now()?'expired':'authority-changed';job.cancellation.at??=this.now();throw new AppError('cancelled','Voice authority expired or changed.');}};
   try{
    await guard();this.update({call:'processing'});stage('executiveStartedAt');
    const scope=c.config.voice!;
    const run=await this.assistant.start({id:job.id,conversationId:session.conversationId,mode:'chat',prompt:m.text,accountId:scope.accountId,includeGoogle:scope.includeGoogle,includeLocal:scope.includeLocal,includeWeather:scope.includeWeather},undefined,undefined,{session,retainHistory:scope.retainHistory,history:this.history,guard,cancellation:job.cancellation,context:this.context,confirmation:this.confirmation,calendarConfirmation:this.calendarConfirmation,generation:job.generation,allowLocalTaskCreate:scope.allowLocalTaskCreate,allowCalendarCreate:scope.allowCalendarCreate});
    await this.assistant.idle();if(this.pending===job)this.update({call:'waiting'});if(this.session===session&&this.status.channel==='online')stage('executiveCompletedAt');await guard();stage('responseReturnedAt');
    if(run.status==='succeeded'&&run.result){this.history=[run,...this.history].slice(0,3);this.send({type:'result',sessionId:session.id,turnId:job.id,generation:job.generation,text:run.voiceDiagnostics?.localAction?.status==='awaiting-confirmation'||run.voiceDiagnostics?.calendarAction?.status==='awaiting-confirmation'?run.result.answer:spokenText(run.result.answer)||'Please review the details in Work.'});}
    else this.send({type:'result',sessionId:session.id,turnId:job.id,generation:job.generation,text:run.voiceDiagnostics?.failureCategory==='confirmation-expired'?'That confirmation is no longer valid. Please ask me to prepare the action again.':run.voiceDiagnostics?.failureCategory==='session-limit'?"We've reached this test call's request limit. Let's stop here and review the results.":'I could not complete that request. Please review MoMo before repeating an action.'});
   }catch{this.confirmation.clear();if(job.cancellation.reason==='interrupted'||job.cancellation.reason==='superseded')this.calendarConfirmation.invalidateConfirmation();else this.calendarConfirmation.clear();if(this.pending===job&&this.session===session){try{this.send({type:'result',sessionId:session.id,turnId:job.id,generation:job.generation,text:'Mo is unavailable for that request. Please review MoMo and Work before repeating an action.'});}catch{this.disconnect();}}}
   finally{if(this.pending===job){this.pending=null;this.update({call:this.session?'waiting':'none'});}}
  });
 }
 private cancelPending(reason:VoiceCancelReason){if(this.pending){this.confirmation.clear();if(['interrupted','superseded'].includes(reason))this.calendarConfirmation.invalidateConfirmation();else this.calendarConfirmation.clear();this.pending.cancellation.reason??=reason;this.pending.cancellation.at??=this.now();this.assistant.cancel(this.pending.id);this.pending=null;}}
 private finish(tellGateway=true,reason:VoiceCancelReason='disconnected'){
  const s=this.session;if(!s)return;
  if(tellGateway){try{this.send({type:'end',sessionId:s.id});}catch{/* Disconnected. */}}
  this.cancelPending(reason);
  this.pending=null;this.session=null;this.history=[];this.context=emptyVoiceCallContext();this.confirmation.clear();this.calendarConfirmation.reset();this.turns.clear();this.update({sessionId:null,call:'none'});
  const at=new Date(this.now()).toISOString();this.cleanup=Promise.all([this.cleanup,this.work]).then(()=>this.ended(s.id,at)).catch(()=>{});
 }
 private disconnect(channel:VoiceStatus['channel']=this.stopped?'disabled':'offline'){this.finish(true,channel==='disabled'?'disabled':'disconnected');const ws=this.ws;this.ws=null;this.connection=null;ws?.terminate();this.update({channel,call:'none',sessionId:null,gateway:null});}
 stop(){this.stopped=true;if(this.timer)clearInterval(this.timer);this.timer=null;this.disconnect();}
 async idle(){await this.work;await this.cleanup;}
}
