import { createServer } from 'node:http';
import { Gateway, GatewayError } from './gateway.mjs';
import { VoiceGateway, VOICE } from './voice.mjs';
const required=name=>{const value=process.env[name];if(!value)throw Error('MISSING_GATEWAY_CONFIGURATION');return value;};
const gateway=new Gateway({publicOrigin:required('PUBLIC_ORIGIN'),accountSid:required('TWILIO_ACCOUNT_SID'),number:required('TWILIO_NUMBER'),messagingServiceSid:required('TWILIO_MESSAGING_SERVICE_SID'),authToken:required('TWILIO_AUTH_TOKEN'),bootstrapToken:required('PAIRING_TOKEN'),bootstrapExpiresAt:Date.parse(required('PAIRING_EXPIRES_AT')),allowedSenders:required('ALLOWED_SENDERS').split(',').map(x=>x.trim()),payloadHours:Number(process.env.PAYLOAD_HOURS??24)},process.env.DATABASE_PATH??'/data/relay.sqlite');
gateway.prune();setInterval(()=>gateway.prune(),60000).unref();
const voice=new VoiceGateway(gateway,{enabled:process.env.VOICE_ENABLED==='true',ownerPhone:process.env.VOICE_OWNER_PHONE,pinVerifier:process.env.VOICE_PIN_VERIFIER});
const server=createServer(async(req,res)=>{
 const reply=(code,body,type='application/json')=>{res.writeHead(code,{'Content-Type':type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(type==='application/json'?JSON.stringify(body):body);};
 try{
  if(req.url==='/health'&&req.method==='GET'){reply(200,{service:'mo-relay',version:1});return;}
  if(req.method!=='POST')throw new GatewayError(405,'POST_REQUIRED');
  let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>16384)throw new GatewayError(413,'REQUEST_TOO_LARGE');chunks.push(chunk);}const raw=Buffer.concat(chunks).toString('utf8');
  if([VOICE.inbound,VOICE.ended].includes(req.url)||req.url?.startsWith(VOICE.auth+'?')){
   if(req.headers['content-type']?.split(';')[0]!=='application/x-www-form-urlencoded')throw new GatewayError(415,'FORM_REQUIRED');
   const xml=req.url.startsWith(VOICE.auth+'?')?voice.authWebhook(req.url,raw,req.headers['x-twilio-signature']):voice.webhook(req.url,raw,req.headers['x-twilio-signature']);
   reply(200,xml,'text/xml');return;
  }
  if(req.url==='/twilio/inbound'||req.url==='/twilio/status'){
   if(req.headers['content-type']?.split(';')[0]!=='application/x-www-form-urlencoded')throw new GatewayError(415,'FORM_REQUIRED');
   gateway.webhook(req.url,raw,req.headers['x-twilio-signature']);reply(200,'<Response></Response>','text/xml');return;
  }
  if(req.headers['content-type']!=='application/json')throw new GatewayError(415,'JSON_REQUIRED');
  let body;try{body=JSON.parse(raw);}catch{throw new GatewayError(400,'INVALID_JSON');}
  if(req.url==='/desktop/pair'){reply(200,gateway.pair((req.headers.authorization??'').replace(/^Bearer /,''),body));return;}
  if(!['/desktop/status','/desktop/lease','/desktop/ack'].includes(req.url))throw new GatewayError(404,'NOT_FOUND');
  gateway.authenticate('POST',req.url,raw,req.headers);
  reply(200,req.url==='/desktop/status'?{...gateway.status(),voice:voice.status()}:req.url==='/desktop/lease'?gateway.lease():gateway.ack(body.items));
 }catch(error){reply(error instanceof GatewayError?error.status:500,{error:error instanceof GatewayError?error.message:'GATEWAY_FAILURE'});}
});
server.requestTimeout=10000;server.headersTimeout=10000;server.maxHeadersCount=40;
voice.attach(server);
server.listen(Number(process.env.PORT??8080),process.env.HOST??'0.0.0.0',()=>console.log('Mo Relay gateway started'));
process.on('SIGTERM',()=>{voice.close();server.close(()=>{gateway.close();process.exit(0);});});
