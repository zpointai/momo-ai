import { dateInZone } from './google';
import type { AgentRun,WorkflowPolicy } from './orchestration';
/** The scheduler's existing local-minute and same-day deduplication rule. */
export function scheduledWindow(policy:WorkflowPolicy,runs:AgentRun[],now:number){
 const parts=new Intl.DateTimeFormat('en-GB',{timeZone:policy.schedule.timezone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now));
 const minutes=Number(parts.find(x=>x.type==='hour')!.value)*60+Number(parts.find(x=>x.type==='minute')!.value);
 const due=policy.schedule.hour*60+policy.schedule.minute,day=dateInZone(new Date(now),policy.schedule.timezone);
 const already=runs.some(r=>!r.background&&r.event.trigger==='schedule'&&r.policy.id===policy.id&&dateInZone(new Date(r.createdAt),policy.schedule.timezone)===day);
 return{eligible:minutes>=due&&minutes<=due+120&&!already,reason:already?'A scheduled run is already recorded for this local date.':minutes<due?'Before today’s scheduled window.':minutes>due+120?'Today’s two-hour catch-up window has closed.':'Inside the current scheduled window.',day};
}
