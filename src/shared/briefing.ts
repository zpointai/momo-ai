import { z } from 'zod';
import { schedulingStatus } from './scheduling';
import type { AgentRun } from './orchestration';
import { ownerWork } from './executive-work';

export const eligibilityIssueSchema=z.object({code:z.string(),message:z.string(),target:z.enum(['accounts','automation','ai','usage','limits']),label:z.string()}).strict();
export type EligibilityIssue=z.infer<typeof eligibilityIssueSchema>;
export const briefingEligibilitySchema=z.object({accountId:z.string().nullable(),checkedAt:z.string().datetime(),eligible:z.boolean(),issues:z.array(eligibilityIssueSchema),activeRunId:z.string().nullable(),exposure:z.object({unknown:z.number(),tokensKnown:z.number(),tokensMissing:z.number(),provisional:z.number(),missingHistoricRate:z.number()}).strict().optional()}).strict();
export type BriefingEligibility=z.infer<typeof briefingEligibilitySchema>;

/** Presentation only: never changes a retained run or its audit status. */
export function workflowPresentation(run:AgentRun){
 if(run.executive||run.desktopResponsibility){const w=ownerWork(run);return {label:w.label,group:['working','assigned','ready-for-mo','waiting'].includes(w.state)?'progress' as const:['needs-owner','prepared','approval-required','blocked','stale'].includes(w.state)?'review' as const:'history' as const,detail:w.blockers[0]??w.nextStep};}
 if(run.responsibility){const r=run.responsibility;return{label:r.status==='waiting'?'Waiting for update':r.status==='needs-decision'?'Needs review':r.status[0].toUpperCase()+r.status.slice(1),group:['waiting','queued','processing'].includes(r.status)?'progress' as const:['needs-decision','expired'].includes(r.status)?'review' as const:'history' as const,detail:r.waitingReason};}
 if(run.scheduling)return schedulingStatus(run);
 const noDispatch=!run.calls.length&&!run.result;
 const stopped=noDispatch&&!!run.error&&/spending|unpriced|WORKFLOW_BUDGET_EXHAUSTED|request guard|reservation|price bound/i.test(run.error);
 if(stopped)return{label:'Not started',group:'history' as const,detail:'No provider call or output was recorded. A dispatch control blocked this attempt.'};
 if(run.status==='queued'||run.status==='running')return{label:run.status==='queued'?'Queued':'In progress',group:'progress' as const,detail:run.status==='queued'?'Waiting in the workflow queue':run.checkpoint==='Preflight'?'Checking dispatch requirements':run.checkpoint.includes('quality')?'Reviewing the generated result':run.calls.some(c=>c.provider==='deepseek')?'Preparing the bounded result':'Assessing the supplied context'};
 if(run.status==='review'||run.findings.some(f=>f.severity==='review'))return{label:'Needs review',group:'review' as const,detail:run.decision?.reasons.includes('INSUFFICIENT_CONTEXT')?'More context is needed. Review the supplied coverage and sources.':run.result?'Output is held for review. Check its sources.':'Review the saved coverage and sources.'};
 if(run.proposals?.some(p=>p.status==='pending'&&Date.parse(p.expiresAt)>Date.now()))return{label:'Task review available',group:'review' as const,detail:'A local task proposal awaits your review. No task action is authorized by viewing it.'};
 const labels={complete:'Completed',partial:'Incomplete',failed:'Failed',cancelled:'Cancelled',interrupted:'Interrupted',budget_exhausted:'Limit reached'};
 return{label:labels[run.status as keyof typeof labels]??'Needs review',group:'history' as const,detail:run.error??''};
}
