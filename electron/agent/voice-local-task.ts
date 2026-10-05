import type { AssistantRun, RunRequest } from '../../src/shared/assistant';
import { agentRunSchema } from '../../src/shared/orchestration';
import type { PendingVoiceTask } from '../ai/voice-confirmation';
import type { MoContext } from '../ai/mo-context';
import type { ExecutiveStore } from './mo-executive';
import { ensureVoiceProposalRoot, voiceWorkStore } from './voice-work';
import { finishExecutive } from './mo-executive';
import { hash } from './catalogue';
import { VoiceFailure } from '../ai/voice-failure';

/** Materialize an explicitly confirmed task through the existing Work/applyLocal transaction. */
export async function createVoiceLocalTask(store:ExecutiveStore,native:MoContext,input:RunRequest,assistant:AssistantRun,p:PendingVoiceTask,guard:()=>Promise<void>){
 const {state}=await native.authority(input),session=assistant.channel?.voice;
 const policy=state.policies.find(x=>x.family==='chat'&&x.accountId===input.accountId&&x.enabled);
 if(!session||!input.accountId||!input.includeLocal||!state.config.shareTasks||state.revision!==p.binding.authorityRevision||!policy||!['L1','L2'].includes(policy.level))throw new VoiceFailure('permission-source-denied','Local task creation is not permitted by the current native policy.');
 const memory=voiceWorkStore(store),draftRun=structuredClone(assistant);
 draftRun.status='succeeded';draftRun.result={answer:'Confirmed local task creation.',citations:[],suggestions:[{title:p.draft.title,sourceIds:[]}]};
 await ensureVoiceProposalRoot(memory.store,native,draftRun);await finishExecutive(memory.store,draftRun);
 const run=agentRunSchema.parse(await memory.store.agent('get',draftRun.executiveRunId));
 const base={id:p.nonce,taskId:p.taskId,accountId:input.accountId,draft:p.draft,sourceId:'owner',sourceRevision:hash(p.draft),expiresAt:new Date(p.expiresAt).toISOString(),policyVersion:policy.version,status:'pending' as const,authorization:'none' as const};
 const proposalHash=hash({id:base.id,taskId:base.taskId,accountId:base.accountId,draft:base.draft,sourceId:base.sourceId,sourceRevision:base.sourceRevision,expiresAt:base.expiresAt,policyVersion:base.policyVersion});
 run.proposals=[{...base,hash:proposalHash}];
 run.voiceAction={channel:'voice',sessionId:session.id,callSid:session.callSid,ownerId:session.ownerId,accountId:input.accountId,profile:'local',capability:'task.create',nonce:p.nonce,generation:p.binding.generation+1,authorityRevision:p.binding.authorityRevision,settingsRevision:p.binding.settingsRevision,confirmedAt:new Date().toISOString(),expiresAt:base.expiresAt,status:'confirmed',taskId:p.taskId};
 await guard();
 const receipt=agentRunSchema.parse(await store.agent('applyVoiceLocal',run));
 if(receipt.voiceAction?.status!=='created'||receipt.proposals[0]?.status!=='applied')throw new VoiceFailure('action-execution-failed','I could not verify that the local task was created. Review Work before trying again.');
 assistant.executiveRunId=receipt.id;
 return {taskId:p.taskId,rootId:receipt.id};
}
