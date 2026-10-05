import { grantSchema,type AgentGrant,type AgentState,type WorkflowPolicy } from '../../src/shared/orchestration';
import { eventDraftSchema,type EventDraft } from '../../src/shared/calendar-actions';
import { AppError } from '../errors';
export function validatePolicy(policy:WorkflowPolicy){
 if(policy.enabled&&['L3','L4'].includes(policy.level))throw new AppError('permission_denied','L3 external automation and L4 delegation are not enabled in this build.');
 if(policy.schedule.enabled&&(policy.family!=='briefing'||!policy.accountId))throw new AppError('invalid_input','Only an account-scoped briefing can be scheduled.');
 if(policy.level==='L2'&&!policy.accountId)throw new AppError('invalid_input','Local automation needs an account scope.');
}
export function grantAllows(state:AgentState,grant:AgentGrant,draft:EventDraft,now:number){
 if(!grantSchema.safeParse(grant).success||!eventDraftSchema.safeParse(draft).success)return false;
 return !state.config.paused&&state.config.enabled&&grant.status==='active'&&grant.tool==='calendar.create'&&grant.toolVersion===1&&grant.accountId===draft.accountId&&grant.uses<grant.maxUses&&now>=+new Date(grant.notBefore)&&now<+new Date(grant.expiresAt)&&draft.title.startsWith(grant.titlePrefix)&&draft.time.kind==='timed'&&+new Date(draft.time.start)>=now&&+new Date(draft.time.end)-+new Date(draft.time.start)<=grant.maxDurationMinutes*60000;
}
// The registered external connector can be exercised with an injected executor in tests.
// Production always passes externalEnabled=false; UI cannot change this build capability.
export async function executeGrantedCalendar(state:AgentState,grant:AgentGrant,draft:EventDraft,options:{externalEnabled:boolean;now:number;reserve():Promise<void>;revalidate():Promise<boolean>;clock?:()=>number;execute():Promise<unknown>}){
 const initialUses=grant.uses;const initialGrant=JSON.stringify(grant);const initialDraft=JSON.stringify(draft);const now=()=>options.clock?.()??options.now;
 if(!options.externalEnabled||!grantAllows(state,grant,draft,now()))throw new AppError('permission_denied','No active matching external grant.');
 if(!await options.revalidate())throw new AppError('permission_denied','Material calendar preconditions changed.');
 if(!grantAllows(state,grant,draft,now())||JSON.stringify(grant)!==initialGrant||JSON.stringify(draft)!==initialDraft)throw new AppError('permission_denied','Grant or proposal changed during validation.');
 await options.reserve();if(grant.uses!==initialUses+1||!grantAllows(state,{...grant,uses:initialUses},draft,now())||JSON.stringify({...grant,uses:initialUses})!==initialGrant||JSON.stringify(draft)!==initialDraft)throw new AppError('permission_denied','Grant reservation or proposal changed before dispatch.');return options.execute();
}
