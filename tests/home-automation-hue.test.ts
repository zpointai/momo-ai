// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { EventEmitter } from 'node:events';
import { afterEach,expect,it,vi } from 'vitest';
const mocks=vi.hoisted(()=>({connect:vi.fn(),get:vi.fn()}));
vi.mock('node:net',()=>({default:{createConnection:mocks.connect}}));
vi.mock('node:https',()=>({default:{get:mocks.get}}));
import { checkHue } from '../electron/home-automation/hue';
afterEach(()=>{vi.useRealTimers();vi.clearAllMocks();});
const emitter=()=>Object.assign(new EventEmitter(),{destroy:vi.fn()});
it('bounds TCP failure without claiming the cause or calling HTTPS',async()=>{
  vi.useFakeTimers();const socket=emitter();mocks.connect.mockReturnValue(socket);const pending=checkHue('192.168.254.50',new AbortController().signal);await vi.advanceTimersByTimeAsync(3001);expect(await pending).toMatchObject({network:'unreachable',tls:'not-checked',identity:'unverified'});expect(socket.destroy).toHaveBeenCalled();expect(mocks.get).not.toHaveBeenCalled();
});
it('preserves strict TLS on reachable hosts and does not pair or redirect',async()=>{
  const socket=emitter(),request=emitter();mocks.connect.mockReturnValue(socket);mocks.get.mockReturnValue(request);const pending=checkHue('192.168.254.50',new AbortController().signal);socket.emit('connect');await vi.waitFor(()=>expect(mocks.get).toHaveBeenCalled());expect(mocks.get.mock.calls[0][0]).toMatchObject({hostname:'192.168.254.50',port:443,path:'/api/newdeveloper',rejectUnauthorized:true,agent:false});request.emit('error',Object.assign(new Error(),{code:'CERT_HAS_EXPIRED'}));expect(await pending).toMatchObject({network:'reachable',tls:'unverified',identity:'unverified',pairing:'not-paired'});
});
it('bounds a silent HTTPS response separately from the TCP check',async()=>{
  vi.useFakeTimers();const socket=emitter(),request=emitter();mocks.connect.mockReturnValue(socket);mocks.get.mockReturnValue(request);const pending=checkHue('192.168.254.50',new AbortController().signal);socket.emit('connect');await vi.advanceTimersByTimeAsync(3001);expect(await pending).toMatchObject({network:'reachable',tls:'unverified'});expect(request.destroy).toHaveBeenCalled();
});
