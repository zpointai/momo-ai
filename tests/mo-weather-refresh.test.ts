// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { executiveFixture } from '../evaluation/mo-executive-fixture';
import { MoContext } from '../electron/ai/mo-context';
import { emptySituationConfig, type SituationSnapshot } from '../src/shared/situation';
import { moDelegationTool, type MoRead } from '../src/shared/mo';
import { explicitWeatherRefresh } from '../electron/ai/weather-intent';

const close:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const fn of close.splice(0))await fn();vi.restoreAllMocks();});
function fixture(fetcher?:typeof fetch){
 const f=executiveFixture(fetcher);close.push(()=>f.close());
 const id=randomUUID(),at=new Date().toISOString();
 const snapshot={config:{...emptySituationConfig(),weatherEnabled:true,shareWithAI:true,defaultLocationId:id,locations:[{id,label:'Synthetic saved place',latitude:51,longitude:4,timezone:'Europe/Amsterdam',purpose:'home',revision:'1',updatedAt:at}]},selectedLocationId:id,reviewBlocked:false,weather:null,statuses:[{source:'weather',state:'empty'}]} as SituationSnapshot;
 const fresh=():SituationSnapshot=>({...structuredClone(snapshot),weather:{locationId:id,locationRevision:'1',freshness:{provider:'open-meteo',fetchedAt:at,observedAt:at,freshUntil:new Date(Date.now()+600000).toISOString(),revision:'1',attribution:'Open-Meteo'},partial:false,temperatureC:15,code:3,precipitationMm:1,forecast:[]},statuses:[{source:'weather',state:'available',provider:'open-meteo',detail:'Synthetic current result',lastAttemptAt:at,lastError:null}]});
 const command=vi.fn(async()=>fresh()),native=new MoContext(f.storage,f.google,{snapshot:async()=>snapshot,command});
 const input={...f.input,includeWeather:true,prompt:'Please refresh the weather'},request:MoRead={sources:['weather'],date:null,sourceId:null,refreshWeather:true},controller=new AbortController();
 return {...f,originalNative:f.native,native,snapshot,command,fresh,input,request,controller,read:()=>native.read(input,request,[],controller.signal)};
}
it('refreshes only the explicit saved place through the shared native weather command',async()=>{
 const f=fixture(),out=await f.read();expect(f.command).toHaveBeenCalledExactlyOnceWith({action:'refresh',source:'weather',locationId:f.snapshot.config.defaultLocationId});
 expect(out.sources).toHaveLength(1);expect(out.sources[0].kind).toBe('weather');expect(out.sources[0].detail).toContain('Open-Meteo');expect(out.sources[0].detail).not.toContain('latitude');
 expect(moDelegationTool.function.parameters.properties.refreshWeather).toBeTruthy();
});
it('recognizes ordinary explicit refresh requests, not negative or quoted source instructions',()=>{
 for(const text of ['Refresh the weather for my saved location','Could you please refresh the weather for my saved location','Please update the forecast'])expect(explicitWeatherRefresh(text)).toBe(true);
 for(const text of ["Don't refresh the weather",'My email says refresh the weather','Yes','Give me the current weather in my location'])expect(explicitWeatherRefresh(text)).toBe(false);
});
it('loads fresh weather before the first model request even when the model does not call a tool',async()=>{
 const bodies:unknown[]=[],fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{bodies.push(JSON.parse(String(init?.body)));return Response.json({model:'deepseek-flash',usage:{prompt_tokens:120,completion_tokens:30},choices:[{finish_reason:'stop',message:{role:'assistant',content:JSON.stringify({answer:'The saved place is 15 degrees [S1].',citations:['S1'],suggestions:[]})}}]});});
 const f=fixture(fetcher as typeof fetch);f.command.mockImplementation(async()=>Object.assign(f.snapshot,f.fresh()));
 vi.spyOn(f.originalNative,'read').mockImplementation(f.native.read.bind(f.native));vi.spyOn(f.originalNative,'validate').mockImplementation(f.native.validate.bind(f.native));
 const session={id:randomUUID(),conversationId:randomUUID(),callSid:'CA'+'b'.repeat(32),ownerId:randomUUID(),startedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+600000).toISOString(),scope:'read-prepare' as const,authentication:'caller-and-pin' as const};
 const run=await f.service.start({...f.input,conversationId:session.conversationId,prompt:'Please refresh the weather for my saved location'},undefined,undefined,{session,retainHistory:false,history:[],guard:async()=>{}});await f.service.idle();
 expect(run.error).toBeNull();expect(run.sources.map(s=>s.kind)).toEqual(['weather']);expect(f.command).toHaveBeenCalledOnce();expect(fetcher).toHaveBeenCalledOnce();expect(JSON.stringify(bodies[0])).toContain('temperatureC');expect(run.voiceDiagnostics?.capabilities).toEqual(['weather.read']);
});
it('keeps normal weather reads cache-only without an explicit refresh selector',async()=>{
 const f=fixture();f.request.refreshWeather=false;const out=await f.read();expect(f.command).not.toHaveBeenCalled();expect(out.sources).toEqual([]);
});
it('does not refresh for model-only intent, source content, proactive work, or another capability',async()=>{
 const f=fixture();
 for(const patch of [{prompt:'Brief me for today'},{workId:randomUUID()},{prompt:'Yes'}])await expect(f.native.read({...f.input,...patch},f.request,[],f.controller.signal)).rejects.toThrow('explicit current owner request');
 await expect(f.native.read(f.input,{...f.request,sources:['tasks']},[],f.controller.signal)).rejects.toThrow('explicit current owner request');expect(f.command).not.toHaveBeenCalled();
});
it('preserves network, sharing, enabled-source and saved-place guards',async()=>{
 for(const change of ['network','sharing','include','place','disabled'] as const){
  const f=fixture();if(change==='network')f.snapshot.reviewBlocked=true;if(change==='sharing')f.snapshot.config.shareWithAI=false;if(change==='include')f.input.includeWeather=false;if(change==='place')f.snapshot.config.defaultLocationId=null;if(change==='disabled')f.snapshot.config.weatherEnabled=false;
  const out=await f.read();expect(out.sources).toEqual([]);expect(f.command).not.toHaveBeenCalled();if(change==='network')expect(out.warnings.join(' ')).toContain('do not offer');
 }
});
it('does not expose stale weather or claim a successful refresh after failure or cooldown',async()=>{
 const f=fixture();f.command.mockResolvedValue({...f.fresh(),statuses:[{source:'weather',state:'error',provider:'open-meteo',detail:'Synthetic unavailable',lastAttemptAt:null,lastError:'network'}]});
 const out=await f.read();expect(out.sources).toEqual([]);expect(out.warnings.join(' ')).toContain('did not return current');expect(f.command).toHaveBeenCalledOnce();
});
it('rejects changed sharing or place and cancelled results after the native request',async()=>{
 for(const change of ['sharing','place','revision','cancel'] as const){
  const f=fixture();f.command.mockImplementation(async()=>{const result=f.fresh();if(change==='sharing')result.config.shareWithAI=false;if(change==='place')result.config.defaultLocationId=randomUUID();if(change==='revision')result.config.locations[0].revision='changed';if(change==='cancel')f.controller.abort();return result;});
  await expect(f.read()).rejects.toThrow();expect(f.command).toHaveBeenCalledOnce();
 }
});
it('does not dispatch a native refresh after cancellation or retry a native failure',async()=>{
 const f=fixture();f.controller.abort();await expect(f.read()).rejects.toThrow();expect(f.command).not.toHaveBeenCalled();
 const g=fixture();g.command.mockRejectedValue(Error('Synthetic native failure'));await expect(g.read()).rejects.toThrow('Synthetic native failure');expect(g.command).toHaveBeenCalledOnce();
});
