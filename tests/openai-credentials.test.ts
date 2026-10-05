// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync,writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import { CredentialStore, type Protection } from '../electron/credentials/store';
import { AppError, failure } from '../electron/errors';
import { invokeOperation } from '../electron/ipc/operations';
import { allowedRequest, productionCsp } from '../electron/security';
import { channels,defaults, snapshotSchema, saveCredentialSchema, settingsSchema, providerSchema } from '../src/shared/contracts';
import { emptyGoogle } from '../src/shared/google';
import { NativeRouterReviewerDispatcher, NativeCredentialBoundaryError, publicRequestHash, type LockedAdvisoryRequest, type NativeApproval } from '../scripts/evaluation/router-reviewer/native-transport';
import { parseProviderJson } from '../scripts/evaluation/router-reviewer/strict-json';

// Only synthetic canaries. Real platform storage is tested separately in packaged Electron.
const canary = 'SYNTHETIC_OPENAI_SECRET_8f916ca821e3';
const dirs: string[] = [];
const encryptionKey = randomBytes(32);
const protection: Protection = { isEncryptionAvailable: () => true,
  encryptString(value) { const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',encryptionKey,iv);return Buffer.concat([iv,c.update(value),c.final(),c.getAuthTag()]); },
  decryptString(value) { const d=createDecipheriv('aes-256-gcm',encryptionKey,value.subarray(0,12));d.setAuthTag(value.subarray(-16));return Buffer.concat([d.update(value.subarray(12,-16)),d.final()]).toString(); },
};
function fixture() { const dir=mkdtempSync(path.join(os.tmpdir(),'momo-openai-test-'));dirs.push(dir);return{dir,store:new CredentialStore(dir,protection)}; }
afterEach(()=>{for(const dir of dirs.splice(0)){if(!path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'momo-openai-test-'))throw Error('UNSAFE_TEST_PATH');rmSync(dir,{recursive:true,force:true});}vi.restoreAllMocks();});
const snapshot=()=>snapshotSchema.parse({version:'test',settings:{revision:0,values:defaults},credentials:{deepseek:'missing',jev:'missing',minimax:'missing',openai:'configured'},protectionAvailable:true,networkEnabled:false,aiRequestsEnabled:false,storage:'ready',google:emptyGoogle});
const body={model:'gpt-6-luna',input:'Synthetic classification only.'};
const request=(id='r1'):LockedAdvisoryRequest=>({id,model:'gpt-6-luna',body,bodySha256:publicRequestHash(body),reservation:{usd:.002}});
const approval:NativeApproval={benchmark:'momo-router-reviewer-v1',ownerApproved:true,manifestSha256:'locked-hash',expiresAt:2000,ceilingUsd:.45};
const journal=()=>({reserve:vi.fn(async()=>{})});

describe('OpenAI protected credential lifecycle',()=>{
  it('imports a bounded OpenAI key file through the native protected writer and exposes metadata only',async()=>{
    const {dir}=fixture(),vault=path.join(dir,'vault'),store=new CredentialStore(vault,protection),file=path.join(dir,'owner-key.txt');writeFileSync(file,canary+'\n');
    const result=await invokeOperation(channels.importCredential,{provider:'openai'},true,async()=>{await store.importFile('openai',file);return snapshot();});
    expect(result.ok).toBe(true);expect(JSON.stringify(result)).not.toContain(canary);expect(await store.read('openai')).toBe(canary);expect(readdirSync(vault)).toEqual(['openai.bin']);expect(readFileSync(path.join(vault,'openai.bin')).includes(canary)).toBe(false);
    const revision=await store.revision('openai');writeFileSync(file,'x'.repeat(4097));await expect(store.importFile('openai',file)).rejects.toThrow('4 KB');expect(await store.revision('openai')).toBe(revision);writeFileSync(file,'invalid key');await expect(store.importFile('openai',file)).rejects.toThrow('one API key');expect(await store.revision('openai')).toBe(revision);
  });
  it('adds only credential identity, never a model setting or enablement',()=>{
    expect(providerSchema.parse('openai')).toBe('openai');expect(saveCredentialSchema.parse({provider:'openai',secret:canary}).provider).toBe('openai');
    expect(settingsSchema.safeParse({...defaults,openaiEnabled:true}).success).toBe(false);
    expect(JSON.stringify(snapshot())).not.toContain(canary);
  });
  it('encrypts at rest, atomically replaces, removes and stores no old plaintext copies',async()=>{
    const{dir,store}=fixture();await store.save('openai',canary);expect(await store.status('openai')).toBe('configured');expect(await store.read('openai')).toBe(canary);
    expect(readFileSync(path.join(dir,'openai.bin')).includes(canary)).toBe(false);
    await store.save('openai',canary+'ROTATED');expect(await store.read('openai')).toBe(canary+'ROTATED');expect(readdirSync(dir)).toEqual(['openai.bin']);
    expect(JSON.stringify(store)).not.toContain(canary);
    await store.remove('openai');expect(await store.status('openai')).toBe('missing');await expect(store.read('openai')).rejects.toThrow('Import a working openai key');expect(readdirSync(dir)).toEqual([]);
  });
  it('preserves the old encrypted value if replacement fails and suppresses sensitive exceptions',async()=>{
    const{dir,store}=fixture();await store.save('openai',canary);const before=readFileSync(path.join(dir,'openai.bin'));
    const failing=new CredentialStore(dir,{...protection,encryptString(){throw new AppError('internal',canary);}});
    const error=await failing.save('openai',canary+'new').catch(e=>e);
    expect(JSON.stringify(failure(error))).not.toContain(canary);expect(error.cause).toBeUndefined();expect(readFileSync(path.join(dir,'openai.bin'))).toEqual(before);expect(readdirSync(dir)).toEqual(['openai.bin']);
  });
  it('fails closed without protection and rejects invalid key/provider/path input',async()=>{
    const{dir}=fixture();const store=new CredentialStore(dir,{...protection,isEncryptionAvailable:()=>false});await expect(store.save('openai',canary)).rejects.toThrow('No key was saved');
    for(const input of [{provider:'../openai',secret:canary},{provider:'openai',secret:'bad key'},{provider:'openai',secret:canary,readBack:true}])expect(saveCredentialSchema.safeParse(input).success).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});
describe('write-only IPC and renderer isolation',()=>{
  it('admits only narrow trusted credential writes and returns metadata only',async()=>{
    const{store}=fixture();const execute=vi.fn(async(raw:unknown)=>{const v=saveCredentialSchema.parse(raw);await store.save(v.provider,v.secret);return snapshot();});
    const value=await invokeOperation('momo:credentials:save',{provider:'openai',secret:canary},true,execute);
    expect(value.ok).toBe(true);expect(JSON.stringify(value)).not.toContain(canary);expect(await store.read('openai')).toBe(canary);
    execute.mockClear();for(const [channel,raw,trusted] of [['momo:credentials:read',{provider:'openai'},true],['momo:credentials:save',{provider:'openai',secret:canary},false],['momo:credentials:save',{provider:'openai',secret:canary,returnSecret:true},true]] as const)expect((await invokeOperation(channel,raw,trusted,execute)).ok).toBe(false);expect(execute).not.toHaveBeenCalled();
  });
  it('rejects secret-bearing output schemas and untrusted endpoints',async()=>{
    const response=await invokeOperation('momo:credentials:save',{provider:'openai',secret:canary},true,async()=>({...snapshot(),secret:canary}));
    expect(response.ok).toBe(false);expect(JSON.stringify(response)).not.toContain(canary);expect(allowedRequest('https://api.openai.com/v1/responses',false)).toBe(false);expect(productionCsp).toContain("connect-src 'self' https://tiles.openfreemap.org");expect(allowedRequest('https://api.tomtom.com/routing/1/calculateRoute',false)).toBe(false);
  });
  // Three real bundle builds can exceed five seconds on hosted Windows runners.
  it('keeps the benchmark credential transport outside every production bundle graph',{timeout:30_000},async()=>{
    for(const entry of ['electron/main.ts','electron/preload.ts','src/main.tsx']){
      const result=await build({entryPoints:[entry],bundle:true,write:false,metafile:true,platform:'node',format:'cjs',external:['electron','better-sqlite3'],loader:{'.css':'empty','.png':'empty','.svg':'empty'},logLevel:'silent'});
      expect(Object.keys(result.metafile!.inputs).some(p=>p.includes('scripts/evaluation/'))).toBe(false);
      const text=result.outputFiles!.map(f=>f.text).join('');if(entry!=='electron/main.ts'){expect(text).not.toContain('api.openai.com');expect(Object.keys(result.metafile!.inputs)).not.toContain('electron/ai/luna.ts');}else{expect(Object.keys(result.metafile!.inputs)).toContain('electron/ai/openai-test.ts');}expect(text).not.toContain(canary);
    }
  });
});
describe('authorized native benchmark secret boundary',()=>{
  it('rejects duplicate provider usage and escaped duplicate keys before parsing loses them',()=>{
    for(const raw of ['{"usage":{"input_tokens":10,"input_tokens":0}}','{"model":"jev","mo\\u0064el":"other"}'])expect(()=>parseProviderJson(raw)).toThrow('DUPLICATE_PROVIDER_JSON_KEY');
    expect(parseProviderJson('{"a":[{"x":1},{"x":2}]}')).toEqual({a:[{x:1},{x:2}]});
  });
  it('rejects missing approval before reading credentials or dispatching',async()=>{
    const read=vi.fn(),fetcher=vi.fn(),j=journal();const d=new NativeRouterReviewerDispatcher({read},'locked-hash',[request()],null,j,fetcher,()=>1000);
    await expect(d.dispatch('r1',new AbortController().signal)).rejects.toThrow('OWNER_APPROVAL_REQUIRED');expect(read).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();expect(j.reserve).not.toHaveBeenCalled();
  });
  it('reads a fresh protected key each request, honors replacement/removal and never exports headers',async()=>{
    const{store}=fixture();await store.save('openai',canary);const seen:string[]=[];
    const fetcher=vi.fn(async(_url:unknown,init?:RequestInit)=>{seen.push(new Headers(init?.headers).get('Authorization')!);expect(init?.redirect).toBe('error');return new Response('{"status":"completed","usage":{"input_tokens":3}}',{headers:{Authorization:'Bearer '+canary}});});
    const j=journal();const d=new NativeRouterReviewerDispatcher(store,'locked-hash',[request('r1'),request('r2'),request('r3')],approval,j,fetcher,()=>1000);
    const first=await d.dispatch('r1',new AbortController().signal);expect(first).not.toHaveProperty('headers');expect(JSON.stringify(first)).not.toContain(canary);
    await store.save('openai',canary+'ROTATED');await d.dispatch('r2',new AbortController().signal);expect(seen).toEqual(['Bearer '+canary,'Bearer '+canary+'ROTATED']);
    await store.remove('openai');await expect(d.dispatch('r3',new AbortController().signal)).rejects.toThrow('PROTECTED_CREDENTIAL_UNAVAILABLE');expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(j.reserve.mock.calls)).not.toContain(canary);expect(JSON.stringify(d)).not.toContain(canary);expect(first.requestSha256).toBe(publicRequestHash(body));
  });
  it('rejects raw, encoded, JSON-escaped and chunk-split credential echoes before diagnostic output',async()=>{
    const encodings=[canary,encodeURIComponent(canary),Buffer.from(canary).toString('base64'),[...canary].map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('')];
    for(const encoded of encodings){
      const payload=Buffer.from('{"text":"'+encoded+'"}');const fetcher=vi.fn(async()=>new Response(new ReadableStream({start(c){c.enqueue(payload.subarray(0,20));c.enqueue(payload.subarray(20));c.close();}})));
      const d=new NativeRouterReviewerDispatcher({read:async()=>canary},'locked-hash',[request()],approval,journal(),fetcher,()=>1000);
      const error=await d.dispatch('r1',new AbortController().signal).catch(e=>e);expect(error.code).toBe('CREDENTIAL_MATERIAL_REJECTED');expect(error.message).not.toContain(canary);expect(error.cause).toBeUndefined();
    }
  });
  it('sanitizes thrown exceptions and HTTP errors without consuming error bodies or response headers',async()=>{
    for(const impl of [async()=>{throw Error(canary);},async()=>{throw new NativeCredentialBoundaryError(canary);},async()=>new Response(canary,{status:401,headers:{Authorization:canary}})]){
      const d=new NativeRouterReviewerDispatcher({read:async()=>canary},'locked-hash',[request()],approval,journal(),vi.fn(impl),()=>1000);
      const error=await d.dispatch('r1',new AbortController().signal).catch(e=>e);expect(error.message).not.toContain(canary);expect(error.stack).not.toContain(canary);expect(error.cause).toBeUndefined();
    }
  });
  it('rejects journal errors, changed hashes and duplicate dispatch without retries or key reads',async()=>{
    const read=vi.fn(async()=>canary),fetcher=vi.fn(async()=>Response.json({ok:true}));
    const d=new NativeRouterReviewerDispatcher({read},'locked-hash',[request()],approval,{reserve:async()=>{throw Error(canary);}},fetcher,()=>1000);
    await expect(d.dispatch('r1',new AbortController().signal)).rejects.toThrow('ADMISSION_OR_JOURNAL_FAILED');expect(read).not.toHaveBeenCalled();expect(fetcher).not.toHaveBeenCalled();await expect(d.dispatch('r1',new AbortController().signal)).rejects.toThrow('DUPLICATE_DISPATCH');
    const changed=new NativeRouterReviewerDispatcher({read},'locked-hash',[{...request(),bodySha256:'changed'}],approval,journal(),fetcher,()=>1000);await expect(changed.dispatch('r1',new AbortController().signal)).rejects.toThrow('REQUEST_CHANGED');
  });
});
