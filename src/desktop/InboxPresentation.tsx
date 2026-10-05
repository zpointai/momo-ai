import { ChevronDown, Sparkles } from 'lucide-react';
import type { AgentRun } from '../shared/orchestration';

export function senderName(from:string) {
  const bracket=from.indexOf('<');
  return bracket>0?from.slice(0,bracket).trim().replace(/^"|"$/g,''):from;
}

export function assessmentStatus(run:AgentRun|undefined,stale:boolean,dismissed:boolean,summary:boolean,projection?:{status:'active'|'dismissed'|'resolved';priority:'high'|'normal'|'unknown'}|null) {
  if(stale)return 'Source changed';
  if(projection?.status==='resolved')return 'Resolved';
  if(dismissed)return 'Dismissed';
  if(run?.decision){const priority=projection?.priority??run.decision.priority;return priority==='high'?'Needs attention':priority==='normal'?'Normal priority':'Priority unresolved';}
  if(run&&['queued','running'].includes(run.status))return 'In progress';
  return summary?'Saved summary':'Not assessed';
}

export function assessmentPendingText(run?:AgentRun) {
  if(!run)return 'No generated assessment for this message. Opening mail does not ask MoMo to assess it.';
  if(['queued','running'].includes(run.status))return 'MoMo is reviewing the selected context…';
  if(run.decision?.reasons.includes('INSUFFICIENT_CONTEXT'))return 'The generated assessment had too little context to determine priority. Review the message before choosing a follow-up.';
  if(run.decision?.priority==='unknown')return 'The generated assessment did not establish a priority. Review the source and its coverage before choosing a follow-up.';
  return 'This request has no saved written assessment. Review its status and source context before using it.';
}

export function InsightHeading({status}:{status:string}) {
  return <summary className="insight-heading"><Sparkles size={17}/><strong>MoMo insight</strong><span className="insight-state">{status}</span><ChevronDown size={15} className="insight-chevron"/></summary>;
}
