// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { expect, it, vi } from 'vitest';
import { DeepSeekProcessor, type ProcessingOptions } from '../electron/agent/providers';
import type { GenerationAdapter } from '../electron/ai/generation';

it('the production DeepSeek adapter accepts only typed source spans, excludes reasoning and reserves one round',async()=>{
 const value={intent:'arrange',dateText:'next Thursday',timeText:'afternoon',durationText:'30 minutes',timezoneText:'',meetingText:'',ambiguity:[]};
 const generate=vi.fn(async()=>({finish:'stop',model:'deepseek-flash',usage:null,message:{role:'assistant',content:JSON.stringify(value),reasoning_content:'Protocol-only reasoning must not be retained.'}}));
 const provider=new DeepSeekProcessor(undefined,{generate} as unknown as GenerationAdapter);
 const beforeRound=vi.fn(async()=>{}),checkAuthority=vi.fn(async()=>{});
 const options={key:'ISOLATED',model:'deepseek-flash',route:'CALENDAR_REASONING',context:{items:[]},prompt:'Extract constraints',maxTokens:512,totalTokens:512,signal:new AbortController().signal,beforeRound,checkAuthority,usage:vi.fn(async()=>{})} as unknown as ProcessingOptions;
 expect(await provider.coordinate(options,'interpret')).toEqual(value);expect(beforeRound).toHaveBeenCalledTimes(1);expect(checkAuthority).toHaveBeenCalledTimes(2);expect(generate.mock.calls[0]).toHaveLength(1);
 generate.mockResolvedValueOnce({finish:'stop',model:'deepseek-flash',usage:null,message:{role:'assistant',content:JSON.stringify({...value,availability:'free',approved:true}),reasoning_content:''}});
 await expect(provider.coordinate(options,'interpret')).rejects.toThrow('Invalid scheduling candidate');
});
