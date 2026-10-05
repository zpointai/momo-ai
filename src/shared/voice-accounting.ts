import type { AssistantRun } from './assistant';

export function voiceUsageStates(run:AssistantRun){
 return (run.calls?.length?run.calls:[{dispatched:!!run.dispatchedAt,usage:run.usage}]).map(call=>({
  state:!call.dispatched?'Not dispatched':call.usage?'Dispatched / usage known':'Dispatched / usage unknown',
  receivedAfterCancellation:'receivedAfterCancellation' in call&&call.receivedAfterCancellation===true,
 }));
}
