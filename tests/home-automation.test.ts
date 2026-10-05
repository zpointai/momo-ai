// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { describe,it,expect,vi } from 'vitest';
import { emptyHome,homeCommandSchema,homeSnapshotSchema,localAddressSchema,type HomeDevice,type HomeStored } from '../src/shared/home-automation';
import { allowedOrigin,deviceFromScan,mergeScan,parseGoveePacket,type HomeLanSession } from '../electron/home-automation/govee';
import { HomeAutomationService } from '../electron/home-automation/service';
import { invokeOperation } from '../electron/ipc/operations';
import { resolveRoute,moduleAvailability,modules } from '../src/shared/modules';
import { searchSettings } from '../src/shared/settings-catalogue';
const iface={id:'fixture',name:'Synthetic network',address:'192.168.254.2',netmask:'255.255.255.0'};
const identity='02:00:00:00:00:00:00:01';
const now=Date.parse('2026-10-03T12:00:00Z');
const state={power:true,brightness:42,at:new Date(now).toISOString()};
const scan={kind:'scan' as const,identity,model:'H70C4',endpoint:'192.168.254.20'};
const device=():HomeDevice=>({...deviceFromScan(scan,iface,now),state:{...state}});
const bytes=(cmd:string,data:unknown)=>Buffer.from(JSON.stringify({msg:{cmd,data}}));
function harness(initial:HomeStored=emptyHome()) {
  let stored=structuredClone(initial),clock=now,current=[iface],visible=true,enabled=true;
  const send=vi.fn(async()=>{}),confirm=vi.fn(async()=>true),read=vi.fn(async()=>({...state}));
  let found=[device()];
  const session:HomeLanSession={scan:vi.fn(async()=>structuredClone(found)),state:read,send,close:vi.fn()};
  const open=vi.fn(async()=>session);
  const save=vi.fn(async(value:HomeStored)=>{stored=structuredClone(value);});
  const hue=vi.fn(async()=>({checkedAt:new Date(now).toISOString(),network:'reachable' as const,tls:'unverified' as const,identity:'unverified' as const,pairing:'not-paired' as const,resourceAccess:'not-authorized' as const,note:'TCP reachable; TLS identity unverified.'}));
  const service=new HomeAutomationService({load:async()=>stored,save},{confirm,enabled:async()=>enabled,visible:()=>visible},{open},()=>current,()=>clock,hue);
  const setup=async()=>{await service.command({action:'configure',config:{interfaceId:iface.id,hueAddress:null}});await service.command({action:'discover'});await service.command({action:'select',identity});await service.command({action:'map',identity,alias:'Synthetic pilot'});return service.command({action:'grant',identity});};
  const control=async()=>{const s=await service.snapshot();return service.command({action:'control',identity,grantId:s.grant!.id,operation:{kind:'brightness',value:60}});};
  return {service,session,send,confirm,read,open,save,hue,setup,control,stored:()=>stored,setFound:(value:HomeDevice[])=>{found=value;},advance:()=>{clock+=31*60_000;},removeInterface:()=>{current=[];},hide:()=>{visible=false;},disable:()=>{enabled=false;}};
}
describe('bounded Govee protocol',()=>{
  it('checks response origin, private subnet, packet size and identity',()=>{
    const valid=bytes('scan',{ip:scan.endpoint,device:identity,sku:scan.model});
    expect(parseGoveePacket(valid,scan.endpoint,iface)).toEqual(scan);
    for(const origin of ['192.168.253.20','8.8.8.8','192.168.254.255','192.168.254.0',iface.address])expect(parseGoveePacket(valid,origin,iface)).toBeNull();
    expect(parseGoveePacket(Buffer.alloc(2049),scan.endpoint,iface)).toBeNull();
    expect(parseGoveePacket(Buffer.from('{broken'),scan.endpoint,iface)).toBeNull();
    expect(parseGoveePacket(bytes('scan',{ip:scan.endpoint,device:'bad',sku:'H70C4'}),scan.endpoint,iface)).toBeNull();
    expect(allowedOrigin('127.0.0.1',iface)).toBe(false);
  });
  it('retains unknown fields of state as unknown and rejects invalid brightness',()=>{
    expect(parseGoveePacket(bytes('devStatus',{onOff:0}),scan.endpoint,iface)).toEqual({kind:'state',state:{power:false,brightness:null}});
    for(const brightness of [0,101,1.5,'70'])expect(parseGoveePacket(bytes('devStatus',{brightness}),scan.endpoint,iface)).toBeNull();
    expect(parseGoveePacket(bytes('turn',{value:1}),scan.endpoint,iface)).toBeNull();
  });
  it('deduplicates identities and fails closed on conflicting identities/endpoints',()=>{
    const found=new Map<string,HomeDevice>();mergeScan(found,device());mergeScan(found,device());expect(found.size).toBe(1);
    mergeScan(found,{...device(),endpoint:'192.168.254.21'});expect(found.get(identity)?.availability).toBe('ambiguous');
    mergeScan(found,device());expect(found.get(identity)?.availability).toBe('ambiguous');
    const conflict=new Map<string,HomeDevice>();mergeScan(conflict,device());mergeScan(conflict,{...device(),identity:'02:00:00:00:00:00:00:02'});
    expect([...conflict.values()].every(d=>d.availability==='ambiguous')).toBe(true);
  });
  it('does not infer light capabilities from arbitrary H-series models',()=>{
    for(const model of ['H7127','H7161','H9999'])expect(deviceFromScan({...scan,model},iface).category).toBe('unknown');
  });
});
describe('home authority and reconciliation',()=>{
  it('remembers an explicit exact-device permission across closure and restart without replaying commands',async()=>{
    const h=harness();await h.setup();const accepted=await h.service.command({action:'grant',identity,remember:true});
    expect(accepted.grant?.expiresAt).toBeNull();expect(h.stored().permission).toMatchObject({identity,model:'H70C4',endpoint:scan.endpoint,power:true,brightness:true});
    expect(h.confirm).toHaveBeenLastCalledWith('Allow direct light controls',expect.stringContaining('Remember'),expect.stringContaining('until you revoke'));
    h.service.stop();expect((await h.service.snapshot()).grant).toBeNull();
    expect((await h.service.command({action:'select',identity})).grant?.expiresAt).toBeNull();
    const restarted=harness(h.stored());expect((await restarted.service.snapshot()).grant).toBeNull();
    await restarted.service.command({action:'select',identity});expect((await restarted.service.snapshot()).grant).toBeNull();
    const s=await restarted.service.command({action:'discover'});expect(s.grant).toMatchObject({identity,expiresAt:null});
    expect(restarted.confirm).not.toHaveBeenCalled();expect(restarted.send).not.toHaveBeenCalled();
  });
  it('retains remembered permission past 30 minutes but requires fresh discovery and owner presence',async()=>{
    const h=harness();await h.setup();await h.service.command({action:'grant',identity,remember:true});h.advance();h.service.stop();
    await h.service.command({action:'select',identity});expect((await h.service.snapshot()).grant).toBeNull();expect(h.stored().permission).toBeTruthy();
    const restarted=harness(h.stored());await restarted.service.command({action:'discover'});restarted.hide();
    expect((await restarted.service.command({action:'select',identity})).grant).toBeNull();expect(restarted.send).not.toHaveBeenCalled();
  });
  it('keeps remembered approval through an offline scan but clears it on changed binding or ambiguity',async()=>{
    const offline=harness();await offline.setup();await offline.service.command({action:'grant',identity,remember:true});offline.setFound([]);
    expect((await offline.service.command({action:'discover'})).grant).toBeNull();expect(offline.stored().permission).toBeTruthy();
    offline.setFound([device()]);expect((await offline.service.command({action:'discover'})).grant?.expiresAt).toBeNull();
    for(const changed of [{...device(),endpoint:'192.168.254.21'},{...device(),availability:'ambiguous' as const}]){
      const h=harness();await h.setup();await h.service.command({action:'grant',identity,remember:true});h.setFound([changed]);const s=await h.service.command({action:'discover'});
      expect(s.grant).toBeNull();expect(s.permission).toBeNull();expect(h.send).not.toHaveBeenCalled();
    }
  });
  it('explicit revocation is persisted and cannot silently recreate remembered authority',async()=>{
    const h=harness();await h.setup();await h.service.command({action:'grant',identity,remember:true});await h.service.command({action:'revoke'});
    const restarted=harness(h.stored());await restarted.service.command({action:'discover'});const s=await restarted.service.command({action:'select',identity});
    expect(s.permission).toBeNull();expect(s.grant).toBeNull();expect(restarted.send).not.toHaveBeenCalled();
  });
  it('does not remember permission when the native confirmation is cancelled',async()=>{
    const h=harness();await h.setup();h.confirm.mockResolvedValueOnce(false);await h.service.command({action:'grant',identity,remember:true});expect(h.stored().permission).toBeFalsy();expect(h.send).not.toHaveBeenCalled();
  });
  it('keeps multiple H70C4 lights separate and denies a grant for the unmatched identity',async()=>{
    const h=harness(),other={...device(),identity:'02:00:00:00:00:00:00:02',endpoint:'192.168.254.21'};
    h.setFound([device(),other]);const s=await h.setup();
    expect(s.devices).toHaveLength(2);expect(s.mapping?.identity).toBe(identity);
    await h.service.command({action:'select',identity:other.identity});
    await expect(h.service.command({action:'grant',identity:other.identity})).rejects.toThrow('confirmed pilot');
    expect(h.send).not.toHaveBeenCalled();expect((await h.service.snapshot()).grant).toBeNull();
  });
  it('records one power send and a later observation without claiming physical acceptance',async()=>{
    const h=harness(),s=await h.setup();h.read.mockResolvedValue({...state,power:false});
    const result=await h.service.command({action:'control',identity,grantId:s.grant!.id,operation:{kind:'power',value:false}});
    expect(result.receipts[0]).toMatchObject({operation:{kind:'power',value:false},sent:true,outcome:'observed-match',physical:'unconfirmed',after:{power:false}});
    expect(h.send).toHaveBeenCalledTimes(1);
    expect(h.confirm).toHaveBeenLastCalledWith('First physical light test',expect.any(String),expect.stringContaining('No automatic restoration'));
  });
  it('starts empty, without network or implicit control permission',async()=>{
    const h=harness();const s=await h.service.snapshot();expect(s.devices).toEqual([]);expect(s.grant).toBeNull();expect(h.open).not.toHaveBeenCalled();expect(homeSnapshotSchema.safeParse(s).success).toBe(true);
  });
  it('requires exact owner mapping and a separate native grant',async()=>{
    const h=harness();const s=await h.setup();expect(h.confirm).toHaveBeenCalledTimes(2);expect(s.mapping?.identity).toBe(identity);expect(s.grant?.identity).toBe(identity);expect(h.send).not.toHaveBeenCalled();
  });
  it('denies unbound, wrong identity, forged and revoked grants',async()=>{
    const h=harness();const s=await h.setup();
    for(const c of [{identity,grantId:crypto.randomUUID()},{identity:'02:00:00:00:00:00:00:02',grantId:s.grant!.id}])await expect(h.service.command({action:'control',...c,operation:{kind:'power',value:false}})).rejects.toThrow();
    await h.service.command({action:'revoke'});await expect(h.service.command({action:'control',identity,grantId:s.grant!.id,operation:{kind:'power',value:false}})).rejects.toThrow();expect(h.send).not.toHaveBeenCalled();
  });
  it('cannot map or grant a non-light/unknown capability',async()=>{
    const h=harness();h.setFound([{...device(),category:'unknown',capability:'unknown',model:'H7161'}]);await expect(h.setup()).rejects.toThrow('documented light');expect(h.confirm).not.toHaveBeenCalled();
  });
  it('native cancellation of mapping leaves everything read-only',async()=>{const h=harness();h.confirm.mockResolvedValue(false);await expect(h.setup()).rejects.toThrow();expect((await h.service.snapshot()).mapping).toBeNull();});
  it('denies expired grants, changed interfaces, hidden app and disabled module',async()=>{
    for(const condition of ['advance','removeInterface','hide','disable'] as const){const h=harness();await h.setup();h[condition]();await expect(h.control()).rejects.toThrow();expect(h.send).not.toHaveBeenCalled();}
  });
  it('rechecks the physical identity on the network before sending',async()=>{
    const h=harness();await h.setup();h.setFound([{...device(),endpoint:'192.168.254.21'}]);await expect(h.control()).rejects.toThrow();expect(h.send).not.toHaveBeenCalled();expect((await h.service.snapshot()).grant).toBeNull();
  });
  it('rejects stale target when another device now owns its endpoint',async()=>{
    const h=harness();await h.setup();h.setFound([{...device(),identity:'02:00:00:00:00:00:00:02'}]);await expect(h.control()).rejects.toThrow();expect(h.send).not.toHaveBeenCalled();
  });
  it('never changes an unavailable response to off',async()=>{
    const h=harness();await h.setup();h.setFound([]);const s=await h.service.command({action:'discover'});expect(s.devices[0].availability).toBe('unavailable');expect(s.devices[0].state?.power).toBe(true);expect(s.grant).toBeNull();
  });
  it('confirms the first exact operation and records sent vs observed vs physical',async()=>{
    const h=harness();await h.setup();h.read.mockResolvedValue({...state,brightness:60});const s=await h.control();
    expect(h.confirm).toHaveBeenCalledTimes(3);expect(h.send).toHaveBeenCalledTimes(1);expect(s.receipts[0]).toMatchObject({sent:true,outcome:'observed-match',physical:'unconfirmed'});
    await expect(h.control()).rejects.toThrow('Record the previous');expect(h.send).toHaveBeenCalledTimes(1);
    const confirmed=await h.service.command({action:'physical-result',receiptId:s.receipts[0].id,confirmed:true});expect(confirmed.receipts[0].physical).toBe('confirmed');expect(h.send).toHaveBeenCalledTimes(1);
  });
  it('records a different external controller state without restoration',async()=>{
    const h=harness();await h.setup();const s=await h.control();expect(s.receipts[0].outcome).toBe('observed-different');expect(s.devices[0].state?.brightness).toBe(42);expect(h.send).toHaveBeenCalledTimes(1);
  });
  it('preserves unavailable post-send outcomes and never retries',async()=>{
    const h=harness();await h.setup();h.read.mockResolvedValue(null!).mockResolvedValueOnce({...state}).mockResolvedValueOnce({...state});const s=await h.control();expect(s.receipts[0]).toMatchObject({sent:true,outcome:'sent-unconfirmed',after:null});expect(h.send).toHaveBeenCalledTimes(1);
  });
  it('cancels pending writes on revoke, selection change or closure',async()=>{
    for(const action of ['revoke','select','stop'] as const){const h=harness();await h.setup();let release!:()=>void;h.session.scan=()=>new Promise(resolve=>{release=()=>resolve([device()]);});const pending=h.control();await vi.waitFor(()=>expect(release).toBeTypeOf('function'));if(action==='stop')h.service.stop();else await h.service.command(action==='select'?{action,identity:null}:{action});release();await expect(pending).rejects.toThrow();expect(h.send).not.toHaveBeenCalled();}
  });
  it('does not queue simultaneous controls while a native confirmation is open',async()=>{
    const h=harness();await h.setup();let release!:(b:boolean)=>void;h.confirm.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));const pending=h.control();await vi.waitFor(()=>expect(release).toBeTypeOf('function'));await expect(h.control()).rejects.toThrow('never queued');release(false);await pending;expect(h.send).not.toHaveBeenCalled();
  });
  it('never restores grants or pending writes after restart',async()=>{
    const h=harness();await h.setup();const restarted=harness(h.stored());const s=await restarted.service.snapshot();expect(s.mapping).not.toBeNull();expect(s.grant).toBeNull();expect(s.devices[0].availability).toBe('unavailable');expect(restarted.send).not.toHaveBeenCalled();
  });
  it('keeps Hue network, TLS, identity, pairing and resource facts separate',async()=>{
    const h=harness();await h.service.command({action:'configure',config:{interfaceId:iface.id,hueAddress:'192.168.254.50'}});const s=await h.service.command({action:'hue-check'});expect(s.hue).toMatchObject({network:'reachable',tls:'unverified',identity:'unverified',pairing:'not-paired',resourceAccess:'not-authorized'});expect(h.send).not.toHaveBeenCalled();
  });
  it('retains mapping and permission but denies freshness after a status timeout',async()=>{
    const h=harness();await h.setup();await h.service.command({action:'grant',identity,remember:true});h.read.mockResolvedValue(null!);
    const s=await h.service.command({action:'discover'});expect(s.mapping).toBeTruthy();expect(s.permission).toBeTruthy();expect(s.devices[0]).toMatchObject({availability:'unavailable',state:{power:true}});expect(s.grant).toBeNull();expect(h.send).not.toHaveBeenCalled();
  });
  it('keeps immediate differing evidence and reconciles a later match without another write',async()=>{
    const h=harness();await h.setup();h.read.mockResolvedValue({...state,brightness:60}).mockResolvedValueOnce(state).mockResolvedValueOnce(state).mockResolvedValueOnce(state);
    const s=await h.control(),r=s.receipts[0];expect(r).toMatchObject({sent:true,outcome:'observed-match',physical:'unconfirmed',after:{brightness:60},reconciliation:{stage:'observed-match',observations:[{brightness:42},{brightness:60}]}});expect(h.send).toHaveBeenCalledTimes(1);
    expect(homeSnapshotSchema.safeParse(s).success).toBe(true);
  });
  it('retains old observation while checking and distinguishes cancellation from physical confirmation',async()=>{
    const h=harness();await h.setup();let release!:(s:typeof state)=>void;
    h.read.mockResolvedValueOnce(state).mockResolvedValueOnce(state).mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const pending=h.control();await vi.waitFor(()=>expect(release).toBeTypeOf('function'));const during=await h.service.snapshot();expect(during.devices[0].state).toEqual(state);expect(during.receipts[0]).toMatchObject({sent:true,after:null,physical:'unconfirmed',reconciliation:{stage:'checking'}});
    await h.service.command({action:'cancel'});release(state);const s=await pending;expect(s.receipts[0].reconciliation?.stage).toBe('cancelled');expect(s.grant).toBeNull();expect(h.send).toHaveBeenCalledTimes(1);
  });
  it('reports a disappeared target, changed identity and changed endpoint after send without retries',async()=>{
    for(const changed of [[],[{...device(),identity:'02:00:00:00:00:00:00:02'}],[{...device(),endpoint:'192.168.254.21'}]]){
      const h=harness();await h.setup();await h.service.command({action:'grant',identity,remember:true});h.send.mockImplementation(async()=>{h.setFound(changed);});const s=await h.control();
      expect(s.receipts[0].reconciliation?.stage).toBe(changed.length?'identity-invalidated':'state-unknown');expect(s.grant).toBeNull();expect(h.send).toHaveBeenCalledTimes(1);if(!changed.length)expect(s.permission).toBeTruthy();else expect(s.permission).toBeNull();
    }
  });
  it('reports bounded settle timeout while preserving the immediate differing observation',async()=>{
    const h=harness();await h.setup();h.read.mockResolvedValue(null!).mockResolvedValueOnce(state).mockResolvedValueOnce(state).mockResolvedValueOnce(state);
    const s=await h.control();expect(s.receipts[0]).toMatchObject({outcome:'sent-unconfirmed',after:state,reconciliation:{stage:'state-unknown',reason:'status_timeout',observations:[state]}});expect(s.devices[0].availability).toBe('unavailable');expect(h.send).toHaveBeenCalledTimes(1);
  });
  it('takes a fresh external state as current truth without altering historical command evidence',async()=>{
    const h=harness();await h.setup();const s=await h.control(),receipt=structuredClone(s.receipts[0]);h.read.mockResolvedValue({...state,power:false,brightness:75});
    const refreshed=await h.service.command({action:'discover'});expect(refreshed.devices[0].state).toMatchObject({power:false,brightness:75});expect(refreshed.receipts[0]).toEqual(receipt);expect(h.send).toHaveBeenCalledTimes(1);
  });
  it('does not replay an interrupted check on restart',async()=>{
    const h=harness();await h.setup();const s=await h.control();s.receipts[0].reconciliation!.stage='checking';s.receipts[0].reconciliation!.finishedAt=null;
    const restarted=harness(s),snapshot=await restarted.service.snapshot();expect(snapshot.receipts[0].reconciliation?.stage).toBe('state-unknown');expect(restarted.open).not.toHaveBeenCalled();expect(restarted.send).not.toHaveBeenCalled();
  });
});
describe('IPC and navigation',()=>{
  it('admits only fixed native operations, never arbitrary network payloads',async()=>{
    for(const input of [{action:'control',identity,grantId:crypto.randomUUID(),operation:{kind:'brightness',value:0}},{action:'discover',host:'8.8.8.8'},{action:'control',identity,grantId:crypto.randomUUID(),operation:{kind:'color',value:100}},{action:'configure',config:{interfaceId:null,hueAddress:'example.com'}}])expect(homeCommandSchema.safeParse(input).success).toBe(false);
    for(const ip of ['127.0.0.1','169.254.169.254','8.8.8.8'])expect(localAddressSchema.safeParse(ip).success).toBe(false);
    const execute=vi.fn();expect((await invokeOperation('momo:home:command',{action:'discover'},false,execute)).ok).toBe(false);expect(execute).not.toHaveBeenCalled();
  });
  it('registers a workspace and Settings without model tools or workflows',()=>{
    expect(resolveRoute('#home-automation').page).toBe('home-automation');expect(resolveRoute('#settings/home-automation').section).toBe('home-automation');expect(modules.find(m=>m.id==='home-automation')).toMatchObject({tools:[],workflows:[]});expect(moduleAvailability('home-automation',['home-automation'],[]).enabled).toBe(false);expect(searchSettings('govee')[0].section).toBe('home-automation');
  });
});
