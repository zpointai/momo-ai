// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
// Controlled clocks and records are isolated fixtures; never normal-profile data.
import React from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {PlannerView} from '../src/desktop/PlannerView';
import {CalendarClock,calendarClock,nextLocalDateBoundary,useLocalToday} from '../src/desktop/calendarClock';
import {restorePlannerPreference} from '../src/shared/planner';
import {defaults,type DesktopBridge,type Snapshot} from '../src/shared/contracts';
import {emptyGoogle,type CalendarData} from '../src/shared/google';
import {emptyWorkspace} from '../src/shared/assistant';
import type {AssistantController} from '../src/desktop/AssistantViews';
const midnight='2026-09-24T21:59:59Z';
beforeEach(()=>{vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']});vi.setSystemTime(new Date(midnight));localStorage.clear();});
afterEach(()=>{cleanup();vi.useRealTimers();});
function fixture(pref:unknown={mode:'day',followToday:true,date:'2026-09-01'}){
 localStorage.setItem('momo.planner.a',JSON.stringify(pref));
 const snapshot={version:'isolated-test',settings:{values:{...defaults,timezone:'Europe/Amsterdam'},revision:0},google:{...emptyGoogle,activeAccountId:'a',accounts:[{id:'a',email:'clock@example.invalid',status:'connected',calendarWrite:true}]}} as Snapshot;
 const readCalendar=vi.fn<DesktopBridge['readCalendar']>(async q=>({ok:true,value:{...q,events:[],fetchedAt:new Date().toISOString(),cached:false,truncated:false,skipped:0}}));
 const calendarAction=vi.fn<DesktopBridge['calendarAction']>(async()=>({ok:true,value:{actions:[],review:null}}));
 return{snapshot,bridge:{readCalendar,calendarAction} as unknown as DesktopBridge,controller:{workspace:{...emptyWorkspace,tasks:[]},task:vi.fn()} as unknown as AssistantController,review:vi.fn(),newTask:vi.fn(),settings:vi.fn(),readCalendar,calendarAction};
}
const selected=()=> (screen.getByLabelText('Calendar date') as HTMLInputElement).value;
async function mount(f:ReturnType<typeof fixture>){let view!:ReturnType<typeof render>;await act(async()=>{view=render(<PlannerView {...f}/>);});return view;}
async function advance(ms:number){await act(async()=>{await vi.advanceTimersByTimeAsync(ms);});}
async function wake(at:string,event='focus'){await act(async()=>{vi.setSystemTime(new Date(at));if(event==='native')calendarClock.refresh();else if(event==='visibilitychange')document.dispatchEvent(new Event(event));else window.dispatchEvent(new Event(event));});}
it('advances a following day at local midnight without waiting for an unrelated render',async()=>{
 const f=fixture();await mount(f);expect(selected()).toBe('2026-09-24');await advance(1000);expect(selected()).toBe('2026-09-25');
 expect(f.readCalendar).toHaveBeenCalledTimes(2);expect(f.readCalendar).toHaveBeenLastCalledWith(expect.objectContaining({startDate:'2026-09-25',endDate:'2026-09-26',refresh:false}));
 expect(screen.getByRole('button',{name:'Day',exact:true}).getAttribute('aria-pressed')).toBe('true');
});
it('retains a deliberately browsed date while updating the independent current-day marker',async()=>{
 const f=fixture({mode:'week',date:'2026-09-23',followToday:false});const view=await mount(f);await advance(1000);
 expect(selected()).toBe('2026-09-23');expect(view.container.querySelector('.planner-dayhead .is-today')?.getAttribute('aria-label')).toContain('25');expect(f.readCalendar).toHaveBeenCalledTimes(1);
 expect(screen.getByText(/Selected 23 Sept?.*Today 25 Sept?/)).toBeTruthy();
});
it.each([['2026-09-30T21:59:59Z','2026-10-01'],['2026-12-31T22:59:59Z','2027-01-01']])('handles month/year boundaries from %s',async(at,date)=>{
 vi.setSystemTime(new Date(at));const f=fixture({mode:'month',followToday:true});await mount(f);await advance(1000);expect(selected()).toBe(date);expect(f.readCalendar).toHaveBeenCalledTimes(2);
});
it('uses real IANA midnight boundaries for 23-hour and 25-hour days',()=>{
 for(const [start,end,hours] of [['2026-03-28T23:00:00Z','2026-03-29T22:00:00Z',23],['2026-10-24T22:00:00Z','2026-10-25T23:00:00Z',25]] as const){expect(nextLocalDateBoundary(+new Date(start),'Europe/Amsterdam')).toBe(+new Date(end));expect((+new Date(end)-+new Date(start))/3600000).toBe(hours);}
});
it('recomputes a following date in a changed timezone and preserves a fixed selection',async()=>{
 vi.setSystemTime(new Date('2026-09-24T23:30:00Z'));const f=fixture(),v=await mount(f);expect(selected()).toBe('2026-09-25');
 const snapshot={...f.snapshot,settings:{...f.snapshot.settings,values:{...f.snapshot.settings.values,timezone:'America/Los_Angeles'}}};
 await act(async()=>{v.rerender(<PlannerView {...f} snapshot={snapshot}/>);});expect(selected()).toBe('2026-09-24');expect(f.readCalendar).toHaveBeenLastCalledWith(expect.objectContaining({timezone:'America/Los_Angeles',startDate:'2026-09-24'}));
 fireEvent.change(screen.getByLabelText('Calendar date'),{target:{value:'2026-09-20'}});await act(async()=>{v.rerender(<PlannerView {...f}/>);});expect(selected()).toBe('2026-09-20');
});
it.each(['focus','visibilitychange','pageshow','native'])('catches multiple missed days on %s without catch-up range requests',async(event)=>{
 const f=fixture();await mount(f);await wake('2026-09-28T10:00:00Z',event);expect(selected()).toBe('2026-09-28');expect(f.readCalendar).toHaveBeenCalledTimes(2);
});
it('Today reads the fresh instant before any timer/focus tick and restores follow intent',async()=>{
 const f=fixture({date:'2026-09-20',mode:'agenda'});await mount(f);vi.setSystemTime(new Date('2026-09-29T10:00:00Z'));
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Today',exact:true}));});expect(selected()).toBe('2026-09-29');expect(JSON.parse(localStorage.getItem('momo.planner.a')!).followToday).toBe(true);expect(screen.getByRole('button',{name:'Agenda',exact:true}).getAttribute('aria-pressed')).toBe('true');
 await wake('2026-09-30T10:00:00Z');expect(selected()).toBe('2026-09-30');
});
it('restores follow-today intent and preserves legacy/fixed date and view preferences',()=>{
 expect(restorePlannerPreference({mode:'month',date:'2026-09-23',followToday:true},'2026-09-25')).toEqual({mode:'month',date:'2026-09-25',followToday:true});
 for(const raw of [{mode:'agenda',date:'2026-09-23'},{mode:'agenda',date:'2026-09-23',followToday:false}])expect(restorePlannerPreference(raw,'2026-09-25')).toEqual({mode:'agenda',date:'2026-09-23',followToday:false});
 expect(restorePlannerPreference(null,'2026-09-25')).toEqual({mode:'week',date:'2026-09-25',followToday:true});
});
it('keeps unsaved title, editor dates, focus and time-grid scroll across rollover',async()=>{
 const f=fixture(),v=await mount(f);fireEvent.click(screen.getByRole('button',{name:'New event',exact:true}));
 fireEvent.change(screen.getByLabelText('Event title'),{target:{value:'Isolated unsaved text'}});fireEvent.change(screen.getByLabelText('Event start'),{target:{value:'2026-10-08T12:30'}});
 const title=screen.getByLabelText('Event title');title.focus();const grid=v.container.querySelector('.planner-time-scroll')!;grid.scrollTop=510;
 await advance(1000);expect(screen.getByLabelText('Event title')).toBe(title);expect((title as HTMLInputElement).value).toBe('Isolated unsaved text');expect((screen.getByLabelText('Event start') as HTMLInputElement).value).toBe('2026-10-08T12:30');expect(document.activeElement).toBe(title);expect(grid.scrollTop).toBe(510);expect(f.calendarAction.mock.calls.every(([q])=>q.action==='list')).toBe(true);
});
it('requests nothing on ordinary ticks or same-week date changes; Refresh stays in the chosen range',async()=>{
 vi.setSystemTime(new Date('2026-09-24T20:00:00Z'));const f=fixture({mode:'week',followToday:true});await mount(f);await advance(600_000);expect(f.readCalendar).toHaveBeenCalledTimes(1);
 await wake('2026-09-25T10:00:00Z');expect(selected()).toBe('2026-09-25');expect(f.readCalendar).toHaveBeenCalledTimes(1);
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Previous calendar range'})));const fixed=selected();
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Refresh',exact:true})));expect(selected()).toBe(fixed);expect(f.readCalendar).toHaveBeenLastCalledWith(expect.objectContaining({refresh:true}));
 await wake('2026-09-29T10:00:00Z');expect(selected()).toBe(fixed);const count=f.readCalendar.mock.calls.length;
 await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Next calendar range'})));expect(f.readCalendar).toHaveBeenCalledTimes(count+1);expect(f.readCalendar).toHaveBeenLastCalledWith(expect.objectContaining({refresh:false}));
});
it('rejects a late pre-midnight range response and shows correct today after an offline read',async()=>{
 const f=fixture();const pending:Array<{q:Parameters<DesktopBridge['readCalendar']>[0];resolve:(r:Awaited<ReturnType<DesktopBridge['readCalendar']>>)=>void}>=[];
 f.readCalendar.mockImplementation(q=>new Promise(resolve=>pending.push({q,resolve})));await mount(f);await advance(1000);
 await act(async()=>pending[1].resolve({ok:false,error:{code:'unavailable',message:'Isolated offline'}}));expect(selected()).toBe('2026-09-25');expect(screen.getByText('Calendar unavailable')).toBeTruthy();
 await act(async()=>pending[0].resolve({ok:true,value:{...pending[0].q,events:[],fetchedAt:midnight,cached:true,truncated:false,skipped:0} as CalendarData}));expect(screen.getByText('Calendar unavailable')).toBeTruthy();
});
it('shares one clock timer and stops it when the last consumer leaves',()=>{
 const clock=new CalendarClock(),a=vi.fn(),b=vi.fn();const offA=clock.subscribe('Europe/Amsterdam',a),offB=clock.subscribe('America/New_York',b);expect(vi.getTimerCount()).toBe(1);offA();expect(vi.getTimerCount()).toBe(1);offB();expect(vi.getTimerCount()).toBe(0);
});
it('updates any shared date-label consumer without unrelated rendering or historical timestamp changes',async()=>{
 function Label(){const today=useLocalToday('Europe/Amsterdam');return <><time data-testid="date">{today}</time><time data-testid="history">2026-09-23T10:00:00Z</time></>;}
 await act(async()=>{render(<Label/>);});await advance(1000);expect(screen.getByTestId('date').textContent).toBe('2026-09-25');expect(screen.getByTestId('history').textContent).toBe('2026-09-23T10:00:00Z');
});
it('initializes an unopened editor from fresh time, then retains its values on later opens',async()=>{
 const f=fixture();await mount(f);await wake('2026-09-28T10:00:00Z');fireEvent.click(screen.getByRole('button',{name:'New event',exact:true}));expect((screen.getByLabelText('Event start') as HTMLInputElement).value).toBe('2026-09-29T10:00');
 fireEvent.click(screen.getByRole('button',{name:'Cancel',exact:true}));await wake('2026-09-29T10:00:00Z');fireEvent.click(screen.getByRole('button',{name:'New event',exact:true}));expect((screen.getByLabelText('Event start') as HTMLInputElement).value).toBe('2026-09-29T10:00');
});
it('preserves an inspected event snapshot and its original source timestamp across a followed day change',async()=>{
 const f=fixture();f.readCalendar.mockImplementation(async q=>({ok:true,value:{...q,events:q.startDate==='2026-09-24'?[{id:'isolated-event',title:'Isolated inspected event',location:'',status:'tentative',recurringEventId:null,originalStart:null,time:{kind:'allDay',startDate:'2026-09-24',endDate:'2026-09-25'}}]:[],fetchedAt:midnight,cached:false,truncated:false,skipped:0}}));
 await mount(f);fireEvent.click(screen.getByRole('button',{name:/Isolated inspected event/}));const details=screen.getByRole('complementary',{name:'Event details'}),original=details.textContent;
 await advance(1000);expect(screen.getByRole('complementary',{name:'Event details'})).toBe(details);expect(details.textContent).toBe(original);expect(details.querySelector('[data-status=tentative]')).toBeTruthy();
});
it('catches forward and backward system-clock adjustments through the local consistency check',async()=>{
 const f=fixture();await mount(f);vi.setSystemTime(new Date('2026-09-28T12:00:00Z'));await advance(1000);expect(selected()).toBe('2026-09-28');
 vi.setSystemTime(new Date('2026-09-24T12:00:00Z'));await advance(30_000);expect(selected()).toBe('2026-09-24');
});
