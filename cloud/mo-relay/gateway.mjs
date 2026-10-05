import { DatabaseSync } from 'node:sqlite';
import { createHash, createPublicKey, randomUUID, timingSafeEqual, verify } from 'node:crypto';
import twilio from 'twilio';

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const same = (a,b) => a.length === b.length && timingSafeEqual(Buffer.from(a),Buffer.from(b));
const sid = (value,prefix) => new RegExp('^'+prefix+'[a-fA-F0-9]{32}$').test(value ?? '');
const phone = value => /^\+[1-9]\d{7,14}$/.test(value ?? '');
const terminal = new Set(['delivered','undelivered','failed']);
const ranks = { unknown:0, accepted:1, queued:2, sending:3, sent:4, delivered:5, undelivered:5, failed:5 };
export function progress(previous,next) { return terminal.has(previous) ? previous : (ranks[next]??0) >= (ranks[previous]??0) ? next : previous; }
export class GatewayError extends Error { constructor(status,code){super(code);this.status=status;} }
const fail = (status,code) => { throw new GatewayError(status,code); };
/** Single-owner transport only. Contains no model, task, context or approval dependencies. */
export class Gateway {
 constructor(config, filename, now=Date.now) {
  const url=new URL(config.publicOrigin);
  if(url.protocol!=='https:'||url.origin!==config.publicOrigin||!sid(config.accountSid,'AC')||!phone(config.number)||!sid(config.messagingServiceSid,'MG')||!config.authToken||!config.bootstrapToken||config.bootstrapToken.length<32||!Number.isFinite(config.bootstrapExpiresAt)||config.allowedSenders.length>20||!config.allowedSenders.every(phone))throw Error('INVALID_GATEWAY_CONFIGURATION');
  this.config={...config,payloadHours:Math.max(1,Math.min(24,config.payloadHours??24)),maxQueue:Math.max(1,Math.min(1000,config.maxQueue??200))};this.now=now;
  this.db=new DatabaseSync(filename);this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;
   CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, identity TEXT UNIQUE, digest TEXT NOT NULL, payload TEXT, created INTEGER NOT NULL, expires INTEGER NOT NULL, lease TEXT, lease_until INTEGER, acked INTEGER);
   CREATE TABLE IF NOT EXISTS state(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS nonces(id TEXT PRIMARY KEY,expires INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS rates(id TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);`);
 }
 close(){this.db.close();}
 transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 get(key){const r=this.db.prepare('SELECT payload FROM state WHERE id=?').get(key);return r?JSON.parse(r.payload):null;}
 set(key,value){this.db.prepare('INSERT INTO state VALUES(?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(key,JSON.stringify(value));}
 prune(){const now=this.now();this.db.prepare('UPDATE events SET payload=NULL,lease=NULL,lease_until=NULL WHERE expires<=? AND payload IS NOT NULL').run(now);this.db.prepare('DELETE FROM events WHERE created<? AND payload IS NULL').run(now-30*86400000);this.db.prepare('DELETE FROM nonces WHERE expires<?').run(now);this.db.prepare('DELETE FROM rates WHERE expires<?').run(now);this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');}
 rate(bucket,limit){const now=this.now(),id=bucket+':'+Math.floor(now/60000);const row=this.db.prepare('SELECT count FROM rates WHERE id=?').get(id);if((row?.count??0)>=limit)fail(429,'RATE_LIMIT');this.db.prepare('INSERT INTO rates VALUES(?,1,?) ON CONFLICT(id) DO UPDATE SET count=count+1').run(id,now+120000);}
 pair(token,body){return this.transaction(()=>{this.rate('pair',5);if(!same(digest(token),digest(this.config.bootstrapToken))||this.now()>this.config.bootstrapExpiresAt)fail(403,'PAIRING_DENIED');
  if(!/^[a-f0-9-]{36}$/.test(body.deviceId??'')||typeof body.publicKey!=='string'||body.publicKey.length>300)fail(400,'INVALID_DEVICE');
  let key;try{key=createPublicKey(body.publicKey);}catch{fail(400,'INVALID_DEVICE');}if(key.asymmetricKeyType!=='ed25519')fail(400,'INVALID_DEVICE');
  const prior=this.get('device');if(prior&&(prior.id!==body.deviceId||prior.publicKey!==body.publicKey))fail(409,'ALREADY_PAIRED');
  this.set('device',{id:body.deviceId,publicKey:body.publicKey,lastSeen:this.now()});return {paired:true,deviceId:body.deviceId};
 });}
 authenticate(method,route,body,headers){const device=this.get('device'),at=Number(headers['x-relay-time']),nonce=headers['x-relay-nonce'],signature=headers['x-relay-signature'];
  if(!device||headers['x-relay-device']!==device.id||!Number.isFinite(at)||Math.abs(this.now()-at)>60000||!/^[-a-f0-9]{36}$/.test(nonce??'')||typeof signature!=='string'||signature.length>128)fail(401,'DEVICE_AUTH_REQUIRED');
  const signed=[method,route,String(at),nonce,digest(body)].join('\n');let valid=false;try{valid=verify(null,Buffer.from(signed),device.publicKey,Buffer.from(signature,'base64'));}catch{/* No untrusted error logging. */}if(!valid)fail(401,'DEVICE_AUTH_REQUIRED');
  this.transaction(()=>{this.rate('device',90);if(this.db.prepare('SELECT id FROM nonces WHERE id=?').get(nonce))fail(409,'REPLAYED_REQUEST');this.db.prepare('INSERT INTO nonces VALUES(?,?)').run(nonce,this.now()+120000);device.lastSeen=this.now();this.set('device',device);});
 }
 webhook(route,raw,signature){
  if(!['/twilio/inbound','/twilio/status'].includes(route))fail(404,'NOT_FOUND');
  if(Buffer.byteLength(raw)>16384)fail(413,'REQUEST_TOO_LARGE');
  this.rate('webhook',120);
  const form=new URLSearchParams(raw),params=Object.create(null);for(const [key,value] of form){if(key.length>100||value.length>4000||Object.hasOwn(params,key))fail(400,'INVALID_FORM');params[key]=value;}
  // Exact public URL is pinned at provisioning; request path/query must match literally.
  // Never trust Host / Forwarded headers or normalize a different URL for validation.
  const url=this.config.publicOrigin+route;
  if(typeof signature!=='string'||signature.length>128||!twilio.validateRequest(this.config.authToken,signature,url,params))fail(403,'INVALID_SIGNATURE');
  if(params.AccountSid!==this.config.accountSid||!sid(params.MessageSid,'SM')||!phone(params.From)||!phone(params.To))fail(403,'BINDING_MISMATCH');
  const inbound=route==='/twilio/inbound';
  if((inbound?params.To:params.From)!==this.config.number||params.MessagingServiceSid&&params.MessagingServiceSid!==this.config.messagingServiceSid)fail(403,'BINDING_MISMATCH');
  if(inbound&&(!this.config.allowedSenders.includes(params.From)||params.NumMedia!=='0'||!params.Body?.trim()||params.Body.length>1600))fail(403,'SMS_INTAKE_POLICY');
  const status=params.MessageStatus;
  if(!inbound&&!Object.hasOwn(ranks,status))fail(400,'UNSUPPORTED_STATUS');
  const immutable=inbound?{account:params.AccountSid,from:params.From,to:params.To,body:params.Body,sid:params.MessageSid}:{account:params.AccountSid,from:params.From,to:params.To,sid:params.MessageSid,status,error:params.ErrorCode??''};
  const identity=params.MessageSid+':'+(inbound?'message':status+':'+(params.ErrorCode??'')),contentHash=digest(immutable);
  return this.transaction(()=>{
   const existing=this.db.prepare('SELECT id,digest FROM events WHERE identity=?').get(identity);if(existing){if(existing.digest!==contentHash)fail(409,'IDENTITY_CONTENT_CONFLICT');return {duplicate:true,id:existing.id};}
   const total=this.db.prepare('SELECT count(*) n FROM events').get().n,pending=this.db.prepare('SELECT count(*) n FROM events WHERE payload IS NOT NULL').get().n;
   if(total>=10000||pending>=this.config.maxQueue)fail(503,'QUEUE_FULL');
   const id=randomUUID(),now=this.now(),timestamp=new Date(now).toISOString();
   const event={version:1,eventId:id,provider:'twilio',providerAccount:params.AccountSid,channel:'sms',receiver:inbound?params.To:params.From,sender:inbound?params.From:params.To,providerTimestamp:timestamp,providerMessageId:params.MessageSid,kind:inbound?'message':'delivery',content:inbound?params.Body:'',authentication:{intakeId:id,mode:'gateway',verifiedAt:timestamp},...(!inbound?{delivery:{status,relatedMessageId:params.MessageSid}}:{})};
   this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,NULL,NULL,NULL)').run(id,identity,contentHash,JSON.stringify(event),now,now+this.config.payloadHours*3600000);
   this.set(inbound?'lastInbound':'lastCallback',{at:timestamp});return {id,duplicate:false};
  });
 }
 status(){const device=this.get('device');return {version:1,accountSid:this.config.accountSid,number:this.config.number,messagingServiceSid:this.config.messagingServiceSid,pairedDevice:device?.id??null,lastSeen:device?new Date(device.lastSeen).toISOString():null,pending:this.db.prepare('SELECT count(*) n FROM events WHERE payload IS NOT NULL').get().n,payloadHours:this.config.payloadHours,tombstoneDays:30,allowedSenders:this.config.allowedSenders,lastInbound:this.get('lastInbound')?.at??null,lastCallback:this.get('lastCallback')?.at??null,webhookValidation:true,localContextChecked:false};}
 lease(){return this.transaction(()=>{const now=this.now(),rows=this.db.prepare('SELECT id,payload FROM events WHERE payload IS NOT NULL AND expires>? AND (lease_until IS NULL OR lease_until<=?) ORDER BY created,rowid LIMIT 10').all(now,now);return {events:rows.map(row=>{const lease=randomUUID();this.db.prepare('UPDATE events SET lease=?,lease_until=? WHERE id=?').run(lease,now+60000,row.id);return {id:row.id,lease,event:JSON.parse(row.payload)};})};});}
 ack(items){if(!Array.isArray(items)||items.length>10)fail(400,'INVALID_ACK');return this.transaction(()=>{for(const item of items){if(typeof item.id!=='string'||typeof item.lease!=='string')fail(400,'INVALID_ACK');const row=this.db.prepare('SELECT lease,acked FROM events WHERE id=?').get(item.id);if(!row)fail(409,'ACK_NOT_FOUND');if(row.acked)continue;if(row.lease!==item.lease)fail(409,'LEASE_CHANGED');this.db.prepare('UPDATE events SET payload=NULL,acked=?,lease=NULL,lease_until=NULL WHERE id=?').run(this.now(),item.id);}return {acknowledged:true};});}
}
