// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
import React,{useState} from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {TimeZoneSelector} from '../src/desktop/TimeZoneSelector';
import {findTimeZones,supportedTimeZones,validTimeZone,zonePreview} from '../src/shared/timezones';
beforeEach(()=>{vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({x:30,y:80,width:360,height:38}));});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
HTMLElement.prototype.scrollIntoView=()=>{};
it('discovers named zones, human spellings, UTC and a preserved valid alias',()=>{
 const zones=supportedTimeZones('US/Eastern');
 for(const q of ['Amsterdam','soFIA','Europe/London','new york','New_York','Tokyo','UTC','Kolkata'])expect(findTimeZones(zones,q).length,q).toBeGreaterThan(0);
 expect(zones).toContain('US/Eastern');expect(supportedTimeZones('Not/AZone')).not.toContain('Not/AZone');
 expect(validTimeZone('Invalid/Zone')).toBe(false);
 expect(zonePreview('Asia/Calcutta',new Date('2026-01-01T00:00:00Z'))).toContain('05:30');
 expect(zonePreview('Europe/London',new Date('2026-01-01T00:00:00Z'))).toContain('GMT');
 expect(zonePreview('Europe/London',new Date('2026-07-01T00:00:00Z'))).toContain('GMT+01:00');
});
it('opens on the saved zone, supports keyboard selection, Escape, no-results and one-shot computer zone without submitting',()=>{
 const submit=vi.fn(),changes=vi.fn();
 function Test(){const[v,set]=useState('Europe/Amsterdam');return <form onSubmit={submit}><TimeZoneSelector saved="Europe/Amsterdam" value={v} change={z=>{set(z);changes(z);}} invalid={false} disabled={false}/><button>Apply</button></form>;}
 render(<Test/>);const input=screen.getByRole('combobox',{name:'Time zone'});
 fireEvent.click(screen.getByRole('button',{name:'Browse time zones'}));expect(screen.getByRole('option',{selected:true}).textContent).toContain('Europe/Amsterdam');expect(changes).not.toHaveBeenCalled();
 fireEvent.change(input,{target:{value:'new york'}});expect(screen.getAllByRole('option')).toHaveLength(1);fireEvent.keyDown(input,{key:'Enter'});expect((input as HTMLInputElement).value).toBe('America/New_York');expect(screen.queryByRole('listbox')).toBeNull();expect(document.activeElement).toBe(input);
 fireEvent.keyDown(input,{key:'ArrowDown'});fireEvent.keyDown(input,{key:'ArrowUp'});expect(input.getAttribute('aria-activedescendant')).toBeTruthy();fireEvent.keyDown(input,{key:'Escape'});expect(input.getAttribute('aria-expanded')).toBe('false');
 fireEvent.change(input,{target:{value:'zz-unavailable'}});expect(screen.getByRole('status').textContent).toContain('No matching zones');fireEvent.keyDown(input,{key:'Enter'});expect(submit).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Use computer’s time zone'}));expect((input as HTMLInputElement).value).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);expect(submit).not.toHaveBeenCalled();
});
