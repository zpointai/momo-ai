import dgram from 'node:dgram';
import os from 'node:os';
import { z } from 'zod';
import { homeIdentitySchema, homeModelSchema, localAddressSchema, type HomeDevice, type HomeInterface, type HomeState, type LightOperation } from '../../src/shared/home-automation';
import { AppError } from '../errors';

export const GOVEE_SOURCE='https://app-h5.govee.com/user-manual/wlan-guide';
// MoMo budgets, not vendor response-time guarantees. Two ordinary probes cover a missed window.
export const GOVEE_TIMING={scanWindowMs:1600,scanProbes:2,statusWindowMs:450,sessionMs:20_000} as const;
export class GoveeIdentityError extends AppError {constructor(){super('permission_denied','The observed device identity or endpoint changed. Review the device before controlling it.');}}
export function waitForLan(ms:number,signal:AbortSignal) {
  return new Promise<void>((resolve,reject)=>{if(signal.aborted){reject(new AppError('unavailable','Local operation cancelled.'));return;}const abort=()=>{clearTimeout(timer);reject(new AppError('unavailable','Local operation cancelled.'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);signal.addEventListener('abort',abort,{once:true});});
}
// Conservative subset verified in the rendered official LAN supported-products guide, 2026-10-03.
// This is documentation evidence, not a claim about a particular firmware or physical target.
const documentedLights=new Set(['H61C3','H6022','H609D','H70C4','H6061','H70B1','H70C2','H61BE','H61A2']);
export function listHomeInterfaces():HomeInterface[] {
  return Object.entries(os.networkInterfaces()).flatMap(([name,entries])=>
    /vpn|virtual|vethernet|vmware|hyper-v|wsl|tailscale|zerotier|loopback|bluetooth|docker|tunnel|tap|tun\d/i.test(name)?[]:
    (entries??[]).filter(e=>e.family==='IPv4'&&!e.internal&&localAddressSchema.safeParse(e.address).success)
      .map(e=>({id:`${name}:${e.address}/${e.netmask}`,name:name.slice(0,80),address:e.address,netmask:e.netmask}))).slice(0,32);
}
const ipv4=(ip:string)=>ip.split('.').reduce((value,byte)=>(value<<8)|Number(byte),0)>>>0;
export function allowedOrigin(address:string,iface:HomeInterface) {
  if(!localAddressSchema.safeParse(address).success||address===iface.address)return false;
  const mask=ipv4(iface.netmask),host=ipv4(address),network=(ipv4(iface.address)&mask)>>>0;
  return ((host&mask)>>>0)===network&&host!==network&&host!==((network|~mask)>>>0);
}
const scanData=z.object({ip:localAddressSchema,device:homeIdentitySchema,sku:homeModelSchema});
const stateData=z.object({onOff:z.union([z.literal(0),z.literal(1)]).optional(),brightness:z.number().int().min(1).max(100).optional()});
export type GoveePacket={kind:'scan';identity:string;model:string;endpoint:string}|{kind:'state';state:Omit<HomeState,'at'>};
export function parseGoveePacket(bytes:Buffer,origin:string,iface:HomeInterface):GoveePacket|null {
  if(bytes.length>2048||!allowedOrigin(origin,iface))return null;
  try {
    const raw=JSON.parse(bytes.toString('utf8'));
    if(raw?.msg?.cmd==='scan') {const p=scanData.safeParse(raw.msg.data);return p.success&&p.data.ip===origin?{kind:'scan',identity:p.data.device,model:p.data.sku,endpoint:origin}:null;}
    if(raw?.msg?.cmd==='devStatus') {const p=stateData.safeParse(raw.msg.data);return p.success&&(p.data.onOff!==undefined||p.data.brightness!==undefined)?{kind:'state',state:{power:p.data.onOff===undefined?null:p.data.onOff===1,brightness:p.data.brightness??null}}:null;}
  } catch { /* Untrusted UDP input is ignored. */ }
  return null;
}
export function deviceFromScan(packet:Extract<GoveePacket,{kind:'scan'}>,iface:HomeInterface,now=Date.now()):HomeDevice {
  const documented=documentedLights.has(packet.model);
  return {provider:'govee-lan',identity:packet.identity,model:packet.model,endpoint:packet.endpoint,interfaceId:iface.id,category:documented?'light':'unknown',capability:documented?'documented-light':'unknown',seenAt:new Date(now).toISOString(),availability:'observed',state:null};
}
export function mergeScan(devices:Map<string,HomeDevice>,next:HomeDevice) {
  const previous=devices.get(next.identity);
  if(previous&&(previous.endpoint!==next.endpoint||previous.model!==next.model||previous.availability==='ambiguous')) next.availability='ambiguous';
  for(const device of devices.values())if(device.identity!==next.identity&&device.endpoint===next.endpoint){device.availability='ambiguous';next.availability='ambiguous';}
  if(devices.size<128||previous)devices.set(next.identity,next);
}
export interface HomeLanSession { scan():Promise<HomeDevice[]>; state(device:HomeDevice):Promise<HomeState|null>; send(device:HomeDevice,operation:LightOperation):Promise<void>; close():void }
export interface HomeLan { open(iface:HomeInterface,signal:AbortSignal):Promise<HomeLanSession> }
const packet=(cmd:string,data:unknown)=>Buffer.from(JSON.stringify({msg:{cmd,data}}));
export class GoveeLan implements HomeLan {
  async open(iface:HomeInterface,signal:AbortSignal):Promise<HomeLanSession> {
    if(signal.aborted)throw new AppError('unavailable','Local operation cancelled.');
    const socket=dgram.createSocket({type:'udp4',reuseAddr:false});
    let closed=false;
    const pending=new Set<(error:Error)=>void>();
    const stop=(error=new AppError('unavailable','Local operation cancelled.'))=>{if(closed)return;closed=true;clearTimeout(deadline);for(const reject of pending)reject(error);pending.clear();try{socket.close();}catch{/* bind may not have finished */}signal.removeEventListener('abort',abort);};
    const abort=()=>stop(); signal.addEventListener('abort',abort,{once:true});
    const deadline=setTimeout(()=>stop(new AppError('unavailable','The bounded LAN session expired. Refresh before trying again.')),GOVEE_TIMING.sessionMs);
    socket.on('error',error=>stop(new AppError('unavailable',(error as NodeJS.ErrnoException).code==='EADDRINUSE'?'UDP 4002 is in use. Close the other LAN lighting controller yourself, then retry.':'The selected local interface or UDP socket is unavailable.')));
    try {
      await new Promise<void>((resolve,reject)=>{pending.add(reject);socket.bind(4002,'0.0.0.0',()=>{pending.delete(reject);resolve();});});
      socket.addMembership('239.255.255.250',iface.address);socket.setMulticastInterface(iface.address);socket.setMulticastTTL(1);
    }catch(error){stop();throw error;}
    const send=async(bytes:Buffer,port:number,host:string)=>{
      if(closed||signal.aborted)throw new AppError('unavailable','Local operation cancelled.');
      await new Promise<void>((resolve,reject)=>socket.send(bytes,port,host,error=>error?reject(error):resolve()));
    };
    const collect=<T>(duration:number,handle:(p:GoveePacket,address:string)=>void,start:()=>Promise<void>,value:()=>T)=>new Promise<T>((resolve,reject)=>{
      let finished=false;let received=0;
      const done=(error?:Error)=>{if(finished)return;finished=true;clearTimeout(timer);socket.off('message',message);pending.delete(fail);if(error)reject(error);else resolve(value());};
      const fail=(error:Error)=>done(error);
      const message=(bytes:Buffer,origin:dgram.RemoteInfo)=>{if(++received>2048){done(new AppError('unavailable','Too many LAN responses. Discovery stopped.'));return;}const p=parseGoveePacket(bytes,origin.address,iface);if(p)try{handle(p,origin.address);}catch(error){done(error instanceof Error?error:new AppError('unavailable','Invalid LAN observation.'));}};
      pending.add(fail);socket.on('message',message);const timer=setTimeout(()=>done(),duration);void start().catch(fail);
    });
    return {
      scan:async()=>{const devices=new Map<string,HomeDevice>();return collect(GOVEE_TIMING.scanWindowMs*GOVEE_TIMING.scanProbes,p=>{if(p.kind==='scan')mergeScan(devices,deviceFromScan(p,iface));},async()=>{for(let probe=0;probe<GOVEE_TIMING.scanProbes;probe++){if(probe)await waitForLan(GOVEE_TIMING.scanWindowMs,signal);await send(packet('scan',{account_topic:'reserve'}),4001,'239.255.255.250');}},()=>[...devices.values()]);},
      state:async device=>{let state:HomeState|null=null;return collect(GOVEE_TIMING.statusWindowMs,(p,address)=>{
        if(p.kind==='scan'&&((p.identity===device.identity&&(p.model!==device.model||p.endpoint!==device.endpoint))||(p.endpoint===device.endpoint&&p.identity!==device.identity))){device.availability='ambiguous';throw new GoveeIdentityError();}
        if(p.kind==='state'&&address===device.endpoint)state={...p.state,at:new Date().toISOString()};
      },()=>send(packet('devStatus',{}),4003,device.endpoint),()=>state);},
      send:async(device,operation)=>send(packet(operation.kind==='power'?'turn':'brightness',{value:operation.kind==='power'?(operation.value?1:0):operation.value}),4003,device.endpoint),
      close:()=>stop(),
    };
  }
}
