import { randomUUID } from 'node:crypto';
import { type AgentCandidate,type AgentFeedback,type AgentState } from '../../src/shared/orchestration';
import { applyPriority } from './catalogue';
import { AppError } from '../errors';
// Fixed regression cases are separate from explicit user corrections used to tune/hold out.
// They test policy and transformation logic, not hosted-model accuracy.
export const replayCases=[
 {name:'English routine',base:'normal',matches:false},{name:'Bulgarian urgent',base:'high',matches:true},
 {name:'Dutch routine',base:'normal',matches:false},{name:'Long thread missing context',base:'unknown',matches:true},
 {name:'Ambiguous request',base:'unknown',matches:true},{name:'Changed dates',base:'unknown',matches:true},
 {name:'Multiple intents',base:'high',matches:false},{name:'Email prompt injection',base:'unknown',matches:false},
 {name:'Memory prompt injection',base:'unknown',matches:false},{name:'Jev unavailable',base:'unknown',matches:true},
 {name:'DeepSeek unavailable',base:'high',matches:false},{name:'Different account',base:'normal',matches:false},
] as const;
function splitThreads(evidence:AgentFeedback[]){const unique=new Map<string,AgentFeedback>();for(const f of evidence)unique.set(f.threadId,f);const rows=[...unique.values()].sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));const split=Math.floor(rows.length/2);return{tuning:rows.slice(0,split),held:rows.slice(split)};}
export function proposeCandidate(state:AgentState,feedback:AgentFeedback,now:number):AgentCandidate{
 if(feedback.kind!=='priority'||feedback.strength!=='explicit'||!['high','normal'].includes(feedback.value)||!feedback.valid)throw new AppError('invalid_input','A valid explicit priority correction is needed.');
 const evidence=state.feedback.filter(f=>f.valid&&f.strength==='explicit'&&f.kind==='priority'&&f.accountId===feedback.accountId&&f.scope===feedback.scope);
 const selected=evidence.slice(-100);const {tuning}=splitThreads(selected);const target=(tuning[0]?.value??feedback.value) as 'high'|'normal';
 return{id:randomUUID(),accountId:feedback.accountId,scope:feedback.scope,target,createdAt:new Date(now).toISOString(),status:'candidate',evidenceIds:selected.map(f=>f.id),evaluation:null,previousVersion:state.candidates.find(c=>c.scope===feedback.scope&&c.accountId===feedback.accountId&&c.status==='active')?.id??null,activatedAt:null,activation:'none',diff:`For this sender in this account only: prefer ${target} priority. Derived from tuning threads only; never lower evidenced urgency or hide uncertainty.`};
}
export function evaluateCandidate(candidate:AgentCandidate,state:AgentState,now:number):AgentCandidate{
 if(!['candidate','insufficient','evaluated'].includes(candidate.status))throw new AppError('conflict','This candidate cannot be evaluated.');
 const started=performance.now();const evidence=candidate.evidenceIds.map(id=>state.feedback.find(f=>f.id===id&&f.valid&&f.scope===candidate.scope&&f.accountId===candidate.accountId)).filter((f):f is AgentFeedback=>!!f);
 const {tuning,held}=splitThreads(evidence);const sufficient=tuning.length>=2&&held.length>=2;
 let baselineCorrect=0,candidateCorrect=0,urgentMisses=0,falseAlerts=0,policyViolations=0;
 for(const f of held){if(f.baseline===f.value)baselineCorrect++;const next=applyPriority(f.baseline,candidate);if(next===f.value)candidateCorrect++;if(f.value==='high'&&next!=='high')urgentMisses++;if(f.value==='normal'&&next==='high')falseAlerts++;}
 for(const test of replayCases){const next=applyPriority(test.base,test.matches?candidate:null);if((test.base==='high'&&next!=='high')||(test.base==='unknown'&&next!=='unknown')||(!test.matches&&next!==test.base))policyViolations++;}
 const learned=tuning.filter(f=>f.value===candidate.target).length===tuning.length;
 const passed=sufficient&&learned&&candidateCorrect>baselineCorrect&&urgentMisses===0&&falseAlerts===0&&policyViolations===0;
 const reason=!sufficient?'Need at least four explicit corrections from separate threads (two tuning, two held out).':!learned?'Tuning corrections disagree; narrow the preference or reject this candidate.':passed?'Held-out explicit corrections improved and fixed policy regressions passed. No real model accuracy was measured.':'No safe improvement on held-out corrections. Keep the baseline.';
 return{...candidate,status:!sufficient?'insufficient':'evaluated',evaluation:{datasetVersion:'replay-v1',at:new Date(now).toISOString(),kind:'offline-corrections-and-synthetic',tuningIds:tuning.map(f=>f.id),heldOutIds:held.map(f=>f.id),syntheticCount:replayCases.length,baselineCorrect,candidateCorrect,urgentMisses,falseAlerts,policyViolations,latencyMs:performance.now()-started,measuredProviderCalls:0,passed,reason}};
}
export function activateCandidate(state:AgentState,id:string,now:number){const candidate=state.candidates.find(c=>c.id===id);if(!candidate||candidate.status!=='evaluated'||!candidate.evaluation?.passed||now-+new Date(candidate.evaluation.at)>7*86400000||candidate.evidenceIds.some(id=>!state.feedback.some(f=>f.id===id&&f.valid)))throw new AppError('permission_denied','A current passing evaluation with valid evidence is required.');
 const old=state.candidates.find(c=>c.status==='active'&&c.accountId===candidate.accountId&&c.scope===candidate.scope);candidate.previousVersion=old?.id??null;if(old)old.status='rolled_back';candidate.status='active';candidate.activation='explicit';candidate.activatedAt=new Date(now).toISOString();
}
export function rollbackCandidate(state:AgentState,id:string){const candidate=state.candidates.find(c=>c.id===id&&c.status==='active');if(!candidate)throw new AppError('conflict','That preference is not active.');candidate.status='rolled_back';const previous=state.candidates.find(c=>c.id===candidate.previousVersion&&c.status==='rolled_back'&&c.evidenceIds.every(id=>state.feedback.some(f=>f.id===id&&f.valid)));if(previous)previous.status='active';}
