// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
// Isolated component fixtures only. Never used by the app or capture launcher.
import React from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {PlannerView} from '../src/desktop/PlannerView';
import {defaults,type DesktopBridge,type Snapshot} from '../src/shared/contracts';
import {emptyGoogle,type CalendarData,type CalendarEvent} from '../src/shared/google';
import {emptyWorkspace,type LocalTask} from '../src/shared/assistant';
import type {AssistantController} from '../src/desktop/AssistantViews';
import {layoutDay} from '../src/shared/planner';

beforeEach(()=>{localStorage.clear();localStorage.setItem('momo.planner.a',JSON.stringify({date:'2026-09-24',mode:'week'}));});
afterEach(cleanup);
function fixture(){
 const snapshot={version:'isolated-test',settings:{values:{...defaults,timezone:'Europe/Amsterdam'},revision:0},google:{...emptyGoogle,activeAccountId:'a',accounts:[{id:'a',email:'test@example.invalid',status:'connected',calendarWrite:true}]}} as Snapshot;
 const readCalendar=vi.fn<DesktopBridge['readCalendar']>(async q=>({ok:true,value:{...q,events:[],fetchedAt:'2026-09-24T10:00:00Z',cached:false,truncated:false,skipped:0}}));
 const calendarAction=vi.fn<DesktopBridge['calendarAction']>(async()=>({ok:true,value:{actions:[],review:null}}));
 const bridge={readCalendar,calendarAction} as unknown as DesktopBridge;
 const controller={workspace:{...emptyWorkspace,tasks:[]},task:vi.fn()} as unknown as AssistantController;
 return {snapshot,bridge,controller,review:vi.fn(),newTask:vi.fn(),settings:vi.fn(),readCalendar,calendarAction};
}
function data(q:Parameters<DesktopBridge['readCalendar']>[0],events:CalendarEvent[]=[],partial=false):CalendarData{return {...q,events,fetchedAt:'2026-09-24T10:00:00Z',cached:false,truncated:partial,skipped:0};}
function event(id:string,start='2026-09-24T08:00:00Z',end='2026-09-24T08:05:00Z'):CalendarEvent{return {id,title:'Isolated '+id,location:'',status:'confirmed',recurringEventId:null,originalStart:null,time:{kind:'timed',start,end,startTimezone:null,endTimezone:null}};}

it('keeps genuine five-minute spans and nonoverlapping allocation instead of enlarging them',()=>{
 const a=event('first'),b=event('second','2026-09-24T08:06:00Z','2026-09-24T08:09:00Z');
 const items=layoutDay([a,b],'2026-09-24','Europe/Amsterdam');
 expect(items.map(i=>i.end-i.start)).toEqual([5,3]);expect(items.every(i=>i.columns===1)).toBe(true);
});
it('requests each exact view range and does not turn subsequent navigation into forced refreshes',async()=>{
 const f=fixture();render(<PlannerView {...f}/>);await screen.findByText('0 events loaded');
 expect(f.readCalendar).toHaveBeenLastCalledWith(expect.objectContaining({accountId:'a',startDate:'2026-09-21',endDate:'2026-09-28',refresh:false}));
 fireEvent.click(screen.getByRole('button',{name:'Refresh',exact:true}));await waitFor(()=>expect(f.readCalendar).toHaveBeenLastCalledWith(expect.objectContaining({refresh:true})));
 await screen.findByText('0 events loaded');fireEvent.click(screen.getByRole('button',{name:'Month',exact:true}));
 await waitFor(()=>expect(f.readCalendar).toHaveBeenLastCalledWith(expect.objectContaining({startDate:'2026-08-31',endDate:'2026-10-12',refresh:false})));
 fireEvent.click(screen.getByRole('button',{name:'Agenda',exact:true}));await waitFor(()=>expect(f.readCalendar).toHaveBeenLastCalledWith(expect.objectContaining({startDate:'2026-09-24',endDate:'2026-10-24',refresh:false})));
 fireEvent.click(screen.getByRole('button',{name:'Today',exact:true}));expect(screen.getByRole('button',{name:'Agenda',exact:true}).getAttribute('aria-pressed')).toBe('true');
});
it('rejects late range responses and results with the wrong account identity',async()=>{
 const f=fixture(),pending:Array<{query:Parameters<DesktopBridge['readCalendar']>[0];resolve:(r:Awaited<ReturnType<DesktopBridge['readCalendar']>>)=>void}>=[];
 f.readCalendar.mockImplementation(query=>new Promise(resolve=>pending.push({query,resolve})));
 render(<PlannerView {...f}/>);fireEvent.click(screen.getByRole('button',{name:'Month',exact:true}));
 await act(async()=>{pending[1].resolve({ok:true,value:data(pending[1].query,[event('current')])});});
 expect(await screen.findByRole('button',{name:/Isolated current/})).toBeTruthy();
 await act(async()=>{pending[0].resolve({ok:true,value:data(pending[0].query,[event('stale')])});});
 expect(screen.queryByRole('button',{name:/Isolated stale/})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Day',exact:true}));await act(async()=>{pending[2].resolve({ok:true,value:{...data(pending[2].query,[event('wrong account')]),accountId:'b'}});});
 expect(await screen.findByRole('alert')).toHaveProperty('textContent',expect.stringContaining('did not match'));expect(screen.queryByRole('button',{name:/wrong account/})).toBeNull();
});
it('offers full compact-event titles, retains partial coverage and shows exact source details without another read',async()=>{
 const f=fixture();f.readCalendar.mockImplementation(async q=>({ok:true,value:data(q,[event('short appointment')],true)}));
 render(<PlannerView {...f}/>);await screen.findByText('1 event loaded · Partial results');
 fireEvent.click(screen.getByText(/Short events & clock changes/));
 const button=screen.getAllByRole('button',{name:/Isolated short appointment/})[0];fireEvent.click(button);
 const detail=screen.getByRole('complementary',{name:'Event details'});expect(within(detail).getByRole('heading',{name:'Isolated short appointment'})).toBeTruthy();
 expect(within(detail).getByText('test@example.invalid')).toBeTruthy();expect(within(detail).getByText(/Partial range coverage/)).toBeTruthy();expect(f.readCalendar).toHaveBeenCalledTimes(1);
 fireEvent.click(within(detail).getByRole('button',{name:'Done'}));expect(screen.queryByRole('complementary',{name:'Event details'})).toBeNull();
});
it('opens and cancels blank event preparation without a native write, preserving times across presentation changes',async()=>{
 const f=fixture();render(<PlannerView {...f}/>);await screen.findByText('0 events loaded');
 fireEvent.click(screen.getByRole('button',{name:'New event',exact:true}));const start=screen.getByLabelText('Event start') as HTMLInputElement;const original=start.value;
 fireEvent.click(screen.getByRole('checkbox',{name:'All day',exact:true}));fireEvent.click(screen.getByRole('checkbox',{name:'All day',exact:true}));expect((screen.getByLabelText('Event start') as HTMLInputElement).value).toBe(original);
 fireEvent.click(screen.getByRole('button',{name:'Month',exact:true}));expect((screen.getByLabelText('Event start') as HTMLInputElement).value).toBe(original);
 fireEvent.click(screen.getByRole('button',{name:'Cancel',exact:true}));expect(screen.queryByRole('textbox',{name:'Event title'})).toBeNull();expect(f.calendarAction.mock.calls.every(([q])=>q.action==='list')).toBe(true);
});
it('keeps task review in place and does not mutate a task when selecting it',async()=>{
 const f=fixture();f.controller.workspace.tasks=[{id:'isolated-task',accountId:'a',revision:4,title:'Isolated local task',due:{kind:'none'},status:'open',createdAt:'2026-09-24T10:00:00Z',remindedAt:null} as LocalTask];
 render(<PlannerView {...f}/>);await screen.findByText('0 events loaded');fireEvent.click(screen.getByRole('button',{name:'Local tasks',exact:true}));fireEvent.click(screen.getByRole('button',{name:'Review task: Isolated local task'}));expect(f.review).toHaveBeenCalledWith(expect.objectContaining({id:'isolated-task',accountId:'a',task:expect.objectContaining({revision:4})}));expect(f.controller.task).not.toHaveBeenCalled();
});
it('unmounts the original account before applying a late read to the new account',async()=>{
 const f=fixture();let resolve!: (r:Awaited<ReturnType<DesktopBridge['readCalendar']>>)=>void;
 f.readCalendar.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));const view=render(<PlannerView key="a" {...f}/>);
 const next={...f.snapshot,google:{...f.snapshot.google,activeAccountId:'b',accounts:[{...f.snapshot.google.accounts[0],id:'b',email:'second@example.invalid'}]}};
 view.rerender(<PlannerView key="b" {...f} snapshot={next}/>);await screen.findByText('0 events loaded');await act(async()=>resolve({ok:true,value:data({accountId:'a',startDate:'2026-09-21',endDate:'2026-09-28',timezone:'Europe/Amsterdam'},[event('old account')])}));expect(screen.queryByRole('button',{name:/old account/})).toBeNull();
});
