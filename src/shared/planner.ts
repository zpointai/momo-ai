import { addDays,dateInZone,dateSchema,eventOnDate,type CalendarEvent } from './google';
export type PlannerMode='day'|'week'|'month'|'agenda';
export function restorePlannerPreference(raw:unknown,today:string):{mode:PlannerMode;date:string;followToday:boolean}{
 const value=raw&&typeof raw==='object'?raw as Record<string,unknown>:{};
 const mode=(['day','week','month','agenda'].includes(String(value.mode))?value.mode:'week') as PlannerMode;
 const valid=dateSchema.safeParse(value.date).success;
 // Legacy literals have no intent signal. Preserve them as deliberate browsing.
 const followToday=value.followToday===true||!valid;
 return{mode,date:followToday?today:value.date as string,followToday};
}
export function weekStart(date:string){const day=new Date(date+'T12:00:00Z').getUTCDay();return addDays(date,-((day+6)%7));}
export function plannerRange(date:string,mode:PlannerMode){const start=mode==='month'?weekStart(date.slice(0,8)+'01'):mode==='week'?weekStart(date):date;const days=mode==='month'?42:mode==='week'?7:mode==='agenda'?30:1;return{start,end:addDays(start,days),days:Array.from({length:days},(_,i)=>addDays(start,i))};}
export function movePlanner(date:string,mode:PlannerMode,direction:number){if(mode!=='month')return addDays(date,direction*(mode==='week'?7:mode==='agenda'?30:1));const value=new Date(date+'T12:00:00Z');const day=value.getUTCDate();value.setUTCDate(1);value.setUTCMonth(value.getUTCMonth()+direction);const max=new Date(Date.UTC(value.getUTCFullYear(),value.getUTCMonth()+1,0)).getUTCDate();value.setUTCDate(Math.min(day,max));return value.toISOString().slice(0,10);}
export function dayLabel(date:string,format:Intl.DateTimeFormatOptions={weekday:'long',month:'long',day:'numeric'}){return new Intl.DateTimeFormat('en-GB',{timeZone:'UTC',...format}).format(new Date(date+'T12:00:00Z'));}
export function minutesInZone(instant:string,zone:string){const parts=new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(instant));return Number(parts.find(p=>p.type==='hour')!.value)*60+Number(parts.find(p=>p.type==='minute')!.value)+Number(parts.find(p=>p.type==='second')!.value)/60;}
export function layoutDay(events:CalendarEvent[],date:string,zone:string){
 const items=events.filter(e=>e.time.kind==='timed'&&eventOnDate(e,date,zone)).map(event=>{
  if(event.time.kind!=='timed')throw new Error('Expected timed event');
  const start=dateInZone(new Date(event.time.start),zone)<date?0:minutesInZone(event.time.start,zone);
  const end=dateInZone(new Date(event.time.end),zone)>date?1440:minutesInZone(event.time.end,zone);
  // Ordinary short events keep their exact duration and overlap allocation.
  // Reversed/repeated wall times use elapsed duration and are explicitly labelled
  // as clock changes in the UI; details retain the original offset-bearing times.
  const clockChange=end<=start;
  return{event,start,end:clockChange?Math.min(1440,start+(+new Date(event.time.end)-+new Date(event.time.start))/60000):end,clockChange,column:0,columns:1};
 }).sort((a,b)=>a.start-b.start||b.end-a.end||a.event.id.localeCompare(b.event.id));
 let group:typeof items=[];let boundary=-1;const flush=()=>{const width=Math.max(1,...group.map(x=>x.column+1));group.forEach(x=>x.columns=width);};
 for(const item of items){if(item.start>=boundary){flush();group=[];boundary=-1;}const active=group.filter(x=>x.end>item.start);while(active.some(x=>x.column===item.column))item.column++;group.push(item);boundary=Math.max(boundary,item.end);}flush();return items;
}
