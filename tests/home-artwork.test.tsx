// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import { DeviceArtwork,resolveDeviceArtwork,originalDeviceArtwork,authorizedDeviceArtwork,type AuthorizedArtwork } from '../src/desktop/DeviceArtwork';
import { HomeAutomationView,homeObservation,type HomeController } from '../src/desktop/HomeAutomationView';
import { emptyHome,type HomeDevice,type HomeSnapshot } from '../src/shared/home-automation';
afterEach(cleanup);
const d:HomeDevice={provider:'govee-lan',identity:'02:00:00:00:00:00:00:01',model:'H70C4',endpoint:'192.168.254.20',interfaceId:'synthetic',category:'light',capability:'documented-light',seenAt:new Date().toISOString(),availability:'observed',state:{power:false,brightness:40,at:new Date().toISOString()}};
it('resolves authorized art first, then original, then category without affecting identity',()=>{
  const query={vendor:'Govee',model:'H70C4',category:'light' as const};
  expect(authorizedDeviceArtwork).toHaveLength(0);expect(resolveDeviceArtwork(query).source).toBe('MOMO_ORIGINAL');
  const approved:AuthorizedArtwork={...query,asset:'./assets/home-approved.svg',label:'Approved',source:'OFFICIAL_AUTHORIZED',provenance:{source:'Owner-provided test license',permission:'Synthetic test permission',obtainedAt:'2026-10-04'}};
  expect(resolveDeviceArtwork(query,[approved]).source).toBe('OFFICIAL_AUTHORIZED');expect(resolveDeviceArtwork(query,[{...approved,provenance:{...approved.provenance,permission:''}}]).source).toBe('MOMO_ORIGINAL');
  expect(resolveDeviceArtwork(query,[],'restrained').source).toBe('CATEGORY_FALLBACK');
  expect(resolveDeviceArtwork(query,[approved],'restrained').source).toBe('OFFICIAL_AUTHORIZED');
  expect(resolveDeviceArtwork({...query,model:'H9999'}).source).toBe('CATEGORY_FALLBACK');expect(resolveDeviceArtwork({...query,vendor:'Unknown'}).source).toBe('CATEGORY_FALLBACK');
  expect(originalDeviceArtwork.every(a=>a.provenance.creator==='MoMo'&&a.asset.startsWith('./assets/home-'))).toBe(true);
});
it('renders model-specific originals and falls back when an asset cannot load',()=>{
  const view=render(<DeviceArtwork vendor="Govee" model="H70C4" category="light" size="hero"/>);
  expect(screen.getByRole('img',{name:'Decorative string lights illustration'})).toBeTruthy();fireEvent.error(view.container.querySelector('img')!);expect(screen.getByRole('img',{name:'Light category icon'})).toBeTruthy();
  view.rerender(<DeviceArtwork vendor="Govee" model="H61C3" category="light"/>);expect(screen.getByRole('img',{name:'Generic lighting illustration'})).toBeTruthy();
  view.rerender(<DeviceArtwork category="sensor"/>);expect(screen.getByRole('img',{name:'Sensor category icon'})).toBeTruthy();
  view.rerender(<DeviceArtwork vendor="Govee" model="H70C4" category="light" size="thumbnail" presentation="restrained"/>);
  expect(screen.getByRole('img',{name:'Light category icon'})).toBeTruthy();expect(view.container.querySelector('img')).toBeNull();
});
it('keeps stale native unavailable observations distinct from actual identity conflict or error',()=>{
  expect(homeObservation({...d,availability:'unavailable'})).toMatchObject({fresh:false,label:'Refresh required',tone:'stale'});
  expect(homeObservation({...d,availability:'unavailable',state:null}).label).toBe('Not currently observed');
  expect(homeObservation({...d,availability:'ambiguous'})).toMatchObject({label:'Identity conflict',tone:'warning'});
  expect(homeObservation(d)).toMatchObject({fresh:true,label:'Observed recently',tone:'positive'});
});
it('keeps two recent items compact with full history available and gives stale controls an explanation',()=>{
  const device={...d,availability:'unavailable' as const};const binding={identity:d.identity,model:d.model,endpoint:d.endpoint,interfaceId:d.interfaceId};
  const data:HomeSnapshot={...emptyHome(),config:{interfaceId:'synthetic',hueAddress:null},devices:[device],interfaces:[],mapping:{...binding,alias:'Test Lights',confirmedAt:d.seenAt},permission:{...binding,power:true,brightness:true,confirmedAt:d.seenAt},grant:null,hue:null,busy:false,diagnostic:'',checkedAt:d.seenAt,receipts:Array.from({length:4},(_,i)=>({id:`synthetic-${i}`,identity:d.identity,alias:'Test Lights',at:d.seenAt,operation:{kind:'power',value:false},sent:true,before:d.state,after:d.state,outcome:'observed-different',physical:'confirmed',note:'Synthetic receipt'}))};
  const home:HomeController={data,busy:false,error:'',command:vi.fn(async()=>true),refresh:vi.fn(async()=>{})};
  const view=render(<HomeAutomationView home={home} active detailHost={null} openDetails={vi.fn()} settings={vi.fn()}/>);
  expect(view.container.querySelector('.home-device-art--hero')).toBeNull();expect(view.container.querySelector('.home-workspace img')).toBeNull();
  expect(view.container.querySelector('.home-reader-title .home-device-art--thumbnail')).toBeTruthy();
  expect(view.container.querySelector('.home-device-list .home-device-art--icon')).toBeTruthy();
  expect(screen.getByText('Govee · H70C4 · Verified')).toBeTruthy();expect(screen.getByText('Verified device')).toBeTruthy();
  expect(screen.getByText('Refresh to control')).toBeTruthy();expect(screen.getByRole('switch').getAttribute('aria-describedby')).toBe('home-control-reason');expect(view.container.querySelectorAll('.home-receipts>details')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button',{name:'View history (4)'}));expect(view.container.querySelectorAll('.home-receipts>details')).toHaveLength(4);expect(screen.getByText('Direct control · Remembered')).toBeTruthy();expect(screen.getByText('Not integrated with MoMo')).toBeTruthy();expect(screen.queryByText('Unavailable')).toBeNull();
  home.error='Local operation could not be confirmed.';view.rerender(<HomeAutomationView home={home} active detailHost={null} openDetails={vi.fn()} settings={vi.fn()}/>);expect(screen.getByRole('alert').textContent).toBe(home.error);
});
