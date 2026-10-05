import { useCallback, useSyncExternalStore } from 'react';
import { dateInZone } from '../shared/google';

// Find a calendar boundary in the requested zone, not now + 24 elapsed hours.
export function nextLocalDateBoundary(now:number,zone:string):number {
 const today=dateInZone(new Date(now),zone);
 let low=now,high=now+48*60*60*1000;
 while(high-low>1){const middle=Math.floor((low+high)/2);if(dateInZone(new Date(middle),zone)===today)low=middle;else high=middle;}
 return high;
}

// One renderer clock for all mounted date consumers. Ticks are local only;
// subscribers are notified only when their IANA calendar date changes.
export class CalendarClock {
 private zones=new Map<string,{day:string;boundary:number;listeners:Set<()=>void>}>();
 private timer:ReturnType<typeof setTimeout>|undefined;
 private last=0;
 today=(zone:string)=>dateInZone(new Date(Date.now()),zone);
 refresh=()=>{
  const now=Date.now(),backwards=now<this.last;this.last=now;
  for(const [zone,state] of this.zones){
   const day=dateInZone(new Date(now),zone),changed=day!==state.day;
   if(changed||backwards||now>=state.boundary)state.boundary=nextLocalDateBoundary(now,zone);
   state.day=day;if(changed)for(const listener of state.listeners)listener();
  }
  this.schedule();
 };
 private schedule(){
  clearTimeout(this.timer);this.timer=undefined;
  if(!this.zones.size)return;
  const boundary=Math.min(...Array.from(this.zones.values(),s=>s.boundary));
  // A single inexpensive consistency check also catches OS clock adjustments.
  this.timer=setTimeout(this.refresh,Math.max(1,Math.min(30_000,boundary-Date.now())));
 }
 subscribe=(zone:string,listener:()=>void)=>{
  const first=!this.zones.size;
  let state=this.zones.get(zone);
  if(!state){state={day:this.today(zone),boundary:nextLocalDateBoundary(Date.now(),zone),listeners:new Set()};this.zones.set(zone,state);}
  state.listeners.add(listener);
  if(first){window.addEventListener('focus',this.refresh);window.addEventListener('pageshow',this.refresh);document.addEventListener('visibilitychange',this.refresh);}
  this.refresh();
  return()=>{
   state.listeners.delete(listener);if(!state.listeners.size)this.zones.delete(zone);
   if(!this.zones.size){window.removeEventListener('focus',this.refresh);window.removeEventListener('pageshow',this.refresh);document.removeEventListener('visibilitychange',this.refresh);}
   this.schedule();
  };
 };
}
export const calendarClock=new CalendarClock();
export function useLocalToday(zone:string){
 const subscribe=useCallback((listener:()=>void)=>calendarClock.subscribe(zone,listener),[zone]);
 const snapshot=useCallback(()=>calendarClock.today(zone),[zone]);
 return useSyncExternalStore(subscribe,snapshot);
}
