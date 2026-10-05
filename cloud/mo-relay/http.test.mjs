// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import twilio from 'twilio';
import { pinVerifier } from './voice.mjs';
test('actual HTTP gateway validates before empty TwiML, exposes no secrets and never replies with SMS',{timeout:15000},async()=>{
 const folder=await mkdtemp(path.join(tmpdir(),'momo-relay-http-')),probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const token=randomBytes(32).toString('hex'),pairing=randomBytes(32).toString('hex'),account='AC'+'a'.repeat(32),number='+12025550101',sender='+12025550102',origin='https://synthetic.example';
 const child=spawn(process.execPath,['server.mjs'],{cwd:import.meta.dirname,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATABASE_PATH:path.join(folder,'relay.sqlite'),PUBLIC_ORIGIN:origin,TWILIO_ACCOUNT_SID:account,TWILIO_NUMBER:number,TWILIO_MESSAGING_SERVICE_SID:'MG'+'b'.repeat(32),TWILIO_AUTH_TOKEN:token,PAIRING_TOKEN:pairing,PAIRING_EXPIRES_AT:new Date(Date.now()+600000).toISOString(),ALLOWED_SENDERS:sender,VOICE_ENABLED:'true',VOICE_OWNER_PHONE:sender,VOICE_PIN_VERIFIER:pinVerifier('82461937')},stdio:['ignore','pipe','pipe'],windowsHide:true});let logs='';child.stdout.on('data',v=>{logs+=v;});child.stderr.on('data',v=>{logs+=v;});
 try{await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('exit',()=>reject(Error('GATEWAY_START_FAILED')));});
  const params={AccountSid:account,MessageSid:'SM'+'c'.repeat(32),From:sender,To:number,Body:'SYNTHETIC inbound HTTP fixture',NumMedia:'0'},body=new URLSearchParams(params).toString(),url=`http://127.0.0.1:${port}/twilio/inbound`,headers={'Content-Type':'application/x-www-form-urlencoded','X-Twilio-Signature':twilio.getExpectedTwilioSignature(token,origin+'/twilio/inbound',params)};
  const response=await fetch(url,{method:'POST',headers,body});assert.equal(response.status,200);assert.equal(await response.text(),'<Response></Response>');
  assert.equal((await fetch(url,{method:'POST',headers:{...headers,'X-Twilio-Signature':'bad'},body})).status,403);
  assert.equal((await fetch(url)).status,405);assert.equal((await fetch(url+'?different=1',{method:'POST',headers,body})).status,415);
  assert.equal((await fetch(`http://127.0.0.1:${port}/desktop/lease`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,401);
  assert(!logs.includes(token)&&!logs.includes(pairing)&&!logs.includes(params.Body));
  const voice={AccountSid:account,CallSid:'CA'+'d'.repeat(32),From:sender,To:number,Direction:'inbound'};
  const voicePost=(route,params)=>fetch(`http://127.0.0.1:${port}`+route,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','X-Twilio-Signature':twilio.getExpectedTwilioSignature(token,origin+route,params)},body:new URLSearchParams(params)});
  const gather=await voicePost('/twilio/voice/inbound',voice);assert.equal(gather.status,200);const xml=await gather.text(),challenge=/challenge=([a-f0-9]{48})/.exec(xml)?.[1];assert(challenge);
  const authenticated=await voicePost('/twilio/voice/auth?challenge='+challenge,{...voice,Digits:'82461937'});assert.equal(authenticated.status,200);assert.match(await authenticated.text(),/Mo is currently offline/);
  assert(!logs.includes('82461937')&&!logs.includes('Digits'));
 }finally{child.kill();await new Promise(r=>child.once('exit',r));assert(path.resolve(folder).startsWith(path.resolve(tmpdir())+path.sep));await rm(folder,{recursive:true,force:true});}
});
