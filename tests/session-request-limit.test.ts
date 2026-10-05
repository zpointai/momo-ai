// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { afterEach,expect,it,vi } from 'vitest';
const argv=[...process.argv];afterEach(()=>{process.argv=[...argv];vi.resetModules();});
it('enforces the temporary limit across both production HTTP providers before dispatch',async()=>{
 vi.resetModules();process.argv=[...argv,'--provider-request-limit=3','--development-usage'];const {ProviderHttp}=await import('../electron/ai/providers');const {sessionAccountingPurpose}=await import('../electron/ai/session-authority');const fetcher=vi.fn(async()=>new Response('{}'));const http=new ProviderHttp(fetcher);const signal=new AbortController().signal;
 for(const provider of ['jev','deepseek','jev'] as const)await http.post(provider,'isolated-key',{},signal);
 await expect(http.post('deepseek','isolated-key',{},signal)).rejects.toThrow('limit');expect(fetcher).toHaveBeenCalledTimes(3);expect(sessionAccountingPurpose()).toBe('development');
});
it('zero-request and no-inference review sessions cannot dispatch provider requests',async()=>{vi.resetModules();process.argv=[...argv,'--provider-request-limit=0','--no-paid-inference'];const {ProviderHttp}=await import('../electron/ai/providers');const fetcher=vi.fn();await expect(new ProviderHttp(fetcher).post('jev','isolated-key',{},new AbortController().signal)).rejects.toThrow('disabled');expect(fetcher).not.toHaveBeenCalled();});
