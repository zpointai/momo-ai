import { assessmentState } from './assessment';
import { workflowPresentation } from './briefing';
import type { AgentFeedback,AgentRun } from './orchestration';
export const terminalNativeStatus=(status:string)=>['succeeded','failed','denied','expired'].includes(status);
export const terminalConversationStatus=(status:string)=>['succeeded','failed','cancelled'].includes(status);
export function archivableWorkflow(run:AgentRun,feedback:readonly AgentFeedback[]=[]){
 if(!run.finishedAt||['queued','running','interrupted'].includes(run.status)||run.calls.some(c=>c.status!=='complete')||run.proposals.some(p=>p.status==='pending'))return false;
 if(!run.scheduling&&run.event.family==='email'&&assessmentState(run,feedback).status!=='active')return true;
 return workflowPresentation(run).group==='history';
}
