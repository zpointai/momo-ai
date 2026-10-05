// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { expect,it } from 'vitest';
import { latestGatewayVoice } from '../src/shared/voice';
import { voiceUsageStates } from '../src/shared/voice-accounting';
import { preparedVoiceAnswer,spokenText } from '../electron/ai/voice-output';
import type { AssistantRun } from '../src/shared/assistant';

it('newer native HTTP status wins over an old websocket hello, newer socket status wins next',()=>{
 const old={configured:true,ownerConfigured:true,pinConfigured:true,desktopOnline:false,activeCalls:0,scope:'read-prepare' as const,recording:false as const,observedAt:10};
 const http={...old,desktopOnline:true,activeCalls:1,observedAt:20};expect(latestGatewayVoice(old,http)).toEqual(http);
 const socket={...http,activeCalls:0,observedAt:30};expect(latestGatewayVoice(socket,http)).toEqual(socket);
});
for(const kind of ['reply','task','tracking'])it(`speaks ${kind} as prepared, never completed`,()=>{
 const result={answer:'I sent it. I created it. I updated it. Your email has been sent. The meeting is tomorrow.',citations:[],suggestions:kind==='task'?[{title:'Review',sourceIds:[]}]:[],...(kind==='reply'?{reply:{sourceId:'M1',body:'Hello'}}:{}),...(kind==='tracking'?{responsibility:{sourceId:'T1',objective:'Review'}}:{})};
 const spoken=spokenText(preparedVoiceAnswer(result));expect(spoken).toContain('prepared');expect(spoken).toContain('review');expect(spoken).toContain('meeting');expect(spoken).not.toMatch(/sent|created|updated/);
});
it('read-only turns cannot announce execution even without a proposal',()=>{expect(preparedVoiceAnswer({answer:'I sent it.',citations:[],suggestions:[]})).toBe('No action was taken.');});
for(const answer of ['Your event was created.','The event Call My Wife is now confirmed.','Your appointment has been successfully booked.','Done!','Hang on, I am still working on the creation of this event.'])it('rejects unverified completion or asynchronous promises: '+answer,()=>{
 expect(preparedVoiceAnswer({answer,citations:[],suggestions:[]})).toBe('No action was taken.');
});
it('preserves grounded descriptions of existing calendar evidence, not first-person execution claims',()=>{
 expect(preparedVoiceAnswer({answer:'The meeting is scheduled for tomorrow [E1].',citations:['E1'],suggestions:[]})).toContain('scheduled for tomorrow');
 expect(preparedVoiceAnswer({answer:'I created your event [E1].',citations:['E1'],suggestions:[]})).toBe('No action was taken.');
});
it('long speech keeps a bounded overview and removes identifiers, links and list formatting',()=>{
 const text=spokenText(Array.from({length:12},(_,i)=>`${i+1}. Item information [M1] https://private.test. More information.`).join('\n'));
 expect(text).not.toMatch(/https:|\[M1\]|\d+\./);expect(text).toContain('more detail');expect(text).not.toContain('Work');expect(text.split(/\s+/).length).toBeLessThan(120);
});
it('announces a prepared artifact once without repeating the model status notice',()=>{
 const result={answer:'I prepared a reply for your review. The reply is ready for your review. They prepared a proposal for Tuesday.',citations:[],suggestions:[],reply:{sourceId:'M1',body:'Does Tuesday work?'}};
 const spoken=preparedVoiceAnswer(result);expect(spoken.match(/review/g)).toHaveLength(1);expect(spoken).toContain('They prepared a proposal for Tuesday');
});
it('usage projection never invents tokens or retries for cancelled provider requests',()=>{
 const run={calls:[{dispatched:false,usage:null},{dispatched:true,usage:null},{dispatched:true,usage:{input:2,output:3},receivedAfterCancellation:true}]} as AssistantRun;
 expect(voiceUsageStates(run)).toEqual([{state:'Not dispatched',receivedAfterCancellation:false},{state:'Dispatched / usage unknown',receivedAfterCancellation:false},{state:'Dispatched / usage known',receivedAfterCancellation:true}]);
});
