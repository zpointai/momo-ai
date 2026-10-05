// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { EventEmitter } from 'node:events';
import { afterEach,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({create:vi.fn()}));
vi.mock('node:dgram',()=>({default:{createSocket:mocks.create}}));
import { GoveeLan } from '../electron/home-automation/govee';
afterEach(()=>{vi.useRealTimers();vi.clearAllMocks();});
const iface={id:'synthetic',name:'Synthetic interface',address:'192.168.254.2',netmask:'255.255.255.0'};
function socket(){const s=Object.assign(new EventEmitter(),{bind:vi.fn((_port:number,_host:string,callback:()=>void)=>queueMicrotask(callback)),close:vi.fn(),addMembership:vi.fn(),setMulticastInterface:vi.fn(),setMulticastTTL:vi.fn(),send:vi.fn((_bytes:Buffer,_port:number,_host:string,callback:(error:Error|null)=>void)=>callback(null))});mocks.create.mockReturnValue(s);return s;}
it('uses one exclusive receive port, selected multicast interface and bounded scan',async()=>{
  vi.useFakeTimers();const s=socket();const session=await new GoveeLan().open(iface,new AbortController().signal);expect(mocks.create).toHaveBeenCalledWith({type:'udp4',reuseAddr:false});expect(s.bind).toHaveBeenCalledWith(4002,'0.0.0.0',expect.any(Function));expect(s.addMembership).toHaveBeenCalledWith('239.255.255.250',iface.address);const pending=session.scan();await vi.advanceTimersByTimeAsync(3201);expect(await pending).toEqual([]);expect(s.send).toHaveBeenCalledTimes(2);expect(JSON.parse(s.send.mock.calls[0][0].toString())).toEqual({msg:{cmd:'scan',data:{account_topic:'reserve'}}});session.close();expect(s.close).toHaveBeenCalledTimes(1);
});
it('returns an actionable port-conflict error without reuse or process termination',async()=>{
  const s=socket();s.bind.mockImplementation(()=>{queueMicrotask(()=>s.emit('error',Object.assign(new Error(),{code:'EADDRINUSE'})));});await expect(new GoveeLan().open(iface,new AbortController().signal)).rejects.toThrow('UDP 4002 is in use');expect(s.close).toHaveBeenCalledTimes(1);
});
it('aborts active scans and enforces the overall socket lifetime',async()=>{
  vi.useFakeTimers();const s=socket(),abort=new AbortController();const session=await new GoveeLan().open(iface,abort.signal);const pending=session.scan();const rejected=expect(pending).rejects.toThrow('cancelled');abort.abort();await rejected;expect(s.close).toHaveBeenCalledTimes(1);
  const second=socket();await new GoveeLan().open(iface,new AbortController().signal);await vi.advanceTimersByTimeAsync(20_001);expect(second.close).toHaveBeenCalledTimes(1);
});
const scanBytes=(id='02:00:00:00:00:00:00:01',ip='192.168.254.20')=>Buffer.from(JSON.stringify({msg:{cmd:'scan',data:{device:id,ip,sku:'H70C4'}}}));
it('aggregates a pilot missed by the first probe, delayed responses, duplicates and malformed input',async()=>{
  vi.useFakeTimers();const s=socket(),session=await new GoveeLan().open(iface,new AbortController().signal),pending=session.scan();
  await vi.advanceTimersByTimeAsync(1700);s.emit('message',Buffer.from('{bad'),{address:'192.168.254.20'});s.emit('message',scanBytes(),{address:'192.168.254.20'});s.emit('message',scanBytes(),{address:'192.168.254.20'});
  await vi.advanceTimersByTimeAsync(1501);const found=await pending;expect(found).toHaveLength(1);expect(found[0]).toMatchObject({model:'H70C4',availability:'observed'});expect(s.send).toHaveBeenCalledTimes(2);session.close();
});
it('keeps ambiguity across probes and cancels the second probe without network retry',async()=>{
  vi.useFakeTimers();const s=socket(),abort=new AbortController(),session=await new GoveeLan().open(iface,abort.signal),pending=session.scan();
  s.emit('message',scanBytes(),{address:'192.168.254.20'});await vi.advanceTimersByTimeAsync(1700);s.emit('message',scanBytes(undefined,'192.168.254.21'),{address:'192.168.254.21'});await vi.advanceTimersByTimeAsync(1501);expect((await pending)[0].availability).toBe('ambiguous');session.close();
  const second=socket(),cancel=new AbortController(),another=await new GoveeLan().open(iface,cancel.signal),scan=another.scan(),rejected=expect(scan).rejects.toThrow('cancelled');await vi.advanceTimersByTimeAsync(100);cancel.abort();await rejected;await vi.advanceTimersByTimeAsync(4000);expect(second.send).toHaveBeenCalledTimes(1);
});
it('times out status without inventing state and rejects conflicting identity during a status query',async()=>{
  vi.useFakeTimers();const s=socket(),session=await new GoveeLan().open(iface,new AbortController().signal);
  const d={provider:'govee-lan' as const,identity:'02:00:00:00:00:00:00:01',model:'H70C4',endpoint:'192.168.254.20',interfaceId:iface.id,category:'light' as const,capability:'documented-light' as const,seenAt:new Date().toISOString(),availability:'observed' as const,state:null};
  const pending=session.state(d);await vi.advanceTimersByTimeAsync(451);expect(await pending).toBeNull();
  const conflicting=session.state(d),rejected=expect(conflicting).rejects.toThrow('identity or endpoint changed');s.emit('message',scanBytes('02:00:00:00:00:00:00:02'),{address:d.endpoint});await rejected;session.close();
});
