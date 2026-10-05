// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
import { afterEach,expect,it,vi } from 'vitest';
import { cleanup,fireEvent,render,screen } from '@testing-library/react';
import { HomeAutomationView,HomeAutomationSettings,type HomeController } from '../src/desktop/HomeAutomationView';
import { emptyHome,type HomeSnapshot } from '../src/shared/home-automation';
afterEach(cleanup);
it('offers an explicit remembered permission and lets the owner revoke it while controls are inactive',()=>{
  const home=fixture(),d=home.data!.devices[0];home.data!.mapping={identity:d.identity,model:d.model,endpoint:d.endpoint,interfaceId:d.interfaceId,alias:'Synthetic pilot',confirmedAt:d.seenAt};
  const host=document.createElement('div');document.body.append(host);const view=render(<HomeAutomationView home={home} active detailHost={host} openDetails={vi.fn()} settings={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:/Synthetic pilot/}));fireEvent.click(screen.getByRole('button',{name:'Remember direct control…'}));expect(home.command).toHaveBeenLastCalledWith({action:'grant',identity:d.identity,remember:true});
  home.data!.permission={identity:d.identity,model:d.model,endpoint:d.endpoint,interfaceId:d.interfaceId,power:true,brightness:true,confirmedAt:d.seenAt};
  view.rerender(<HomeAutomationView home={home} active detailHost={host} openDetails={vi.fn()} settings={vi.fn()}/>);
  expect(screen.queryByRole('button',{name:'Remember direct control…'})).toBeNull();fireEvent.click(screen.getByRole('button',{name:'Revoke control'}));expect(home.command).toHaveBeenLastCalledWith({action:'revoke'});view.unmount();host.remove();
});
function fixture():HomeController {
  const at=new Date().toISOString();
  const data:HomeSnapshot={...emptyHome(),devices:[{provider:'govee-lan',identity:'02:00:00:00:00:00:00:01',model:'H70C4',endpoint:'192.168.254.20',interfaceId:'fixture',category:'light',capability:'documented-light',seenAt:at,availability:'observed',state:{power:false,brightness:35,at}}],config:{interfaceId:'fixture',hueAddress:null},interfaces:[{id:'fixture',name:'Synthetic interface',address:'192.168.254.2',netmask:'255.255.255.0'}],grant:null,hue:null,busy:false,diagnostic:'Synthetic test data.',checkedAt:at};
  return {data,error:'',busy:false,command:vi.fn(async()=>true),refresh:vi.fn(async()=>{})};
}
it('starts read-only without invented connections, demo controls or a composer',()=>{
  const home=fixture();home.data!.devices=[];const view=render(<HomeAutomationView home={home} active detailHost={null} openDetails={vi.fn()} settings={vi.fn()}/>);
  expect(screen.getByText('Discovery required')).toBeTruthy();expect(screen.getByText('Local connection not established')).toBeTruthy();expect(screen.queryByRole('button',{name:'Set on'})).toBeNull();expect(view.container.querySelector('textarea')).toBeNull();expect(home.command).not.toHaveBeenCalledWith({action:'discover'});
});
it('puts exact identity in the shared Details host, with a separate mapping operation',()=>{
  const home=fixture(),host=document.createElement('div');document.body.append(host);
  const view=render(<HomeAutomationView home={home} active detailHost={host} openDetails={vi.fn()} settings={vi.fn()}/>);
  fireEvent.click(screen.getByRole('button',{name:/H70C4/}));expect(host.textContent).toContain('02:00:00:00:00:00:00:01');
  fireEvent.change(screen.getByLabelText('Pilot name'),{target:{value:'Synthetic pilot'}});fireEvent.click(screen.getByRole('button',{name:'Confirm exact identity…'}));
  expect(home.command).toHaveBeenCalledWith({action:'map',identity:'02:00:00:00:00:00:00:01',alias:'Synthetic pilot'});
  expect(screen.queryByRole('button',{name:'Grant direct control…'})).toBeNull();view.unmount();host.remove();
});
it('preserves selection through rerenders and closes native authority on view exit',()=>{
  const home=fixture(),props={home,active:true,detailHost:null,openDetails:vi.fn(),settings:vi.fn()};const view=render(<HomeAutomationView {...props}/>);
  fireEvent.click(screen.getByRole('button',{name:/H70C4/}));view.rerender(<HomeAutomationView {...props}/>);expect(screen.getByRole('button',{name:/H70C4/}).getAttribute('aria-pressed')).toBe('true');
  view.rerender(<HomeAutomationView {...props} active={false}/>);expect(home.command).toHaveBeenLastCalledWith({action:'select',identity:null});
});
it('requires explicit brightness submission, never sends from editing the field',()=>{
  const home=fixture(),d=home.data!.devices[0];home.data!.grant={id:crypto.randomUUID(),identity:d.identity,expiresAt:new Date(Date.now()+60_000).toISOString(),power:true,brightness:true};
  render(<HomeAutomationView home={home} active detailHost={null} openDetails={vi.fn()} settings={vi.fn()}/>);fireEvent.click(screen.getByRole('button',{name:/H70C4/}));vi.mocked(home.command).mockClear();
  fireEvent.change(screen.getByLabelText('Pilot brightness'),{target:{value:'64'}});expect(home.command).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Set brightness'}));expect(home.command).toHaveBeenCalledTimes(1);expect(home.command).toHaveBeenCalledWith({action:'control',identity:d.identity,grantId:home.data!.grant.id,operation:{kind:'brightness',value:64}});
});
it('requires private local setup and does not start discovery on settings render',()=>{
  const home=fixture();render(<HomeAutomationSettings home={home} active/>);expect(screen.getByLabelText('Hue bridge address').getAttribute('value')).toBe('');fireEvent.change(screen.getByLabelText('Hue bridge address'),{target:{value:'192.168.254.50'}});fireEvent.click(screen.getByRole('button',{name:'Save local setup'}));expect(home.command).toHaveBeenCalledWith({action:'configure',config:{interfaceId:'fixture',hueAddress:'192.168.254.50'}});expect(home.command).not.toHaveBeenCalledWith({action:'discover'});
});
it('offers identity confirmation again after the mapped network endpoint changes',()=>{
  const home=fixture(),d=home.data!.devices[0];home.data!.mapping={identity:d.identity,model:d.model,endpoint:'192.168.254.99',interfaceId:d.interfaceId,alias:'Synthetic pilot',confirmedAt:d.seenAt};
  const host=document.createElement('div');document.body.append(host);const view=render(<HomeAutomationView home={home} active detailHost={host} openDetails={vi.fn()} settings={vi.fn()}/>);
  expect(screen.queryByText('Synthetic pilot')).toBeNull();fireEvent.click(screen.getByRole('button',{name:/H70C4/}));expect(screen.getByLabelText('Pilot name')).toBeTruthy();expect(screen.queryByRole('button',{name:'Grant direct control…'})).toBeNull();view.unmount();host.remove();
});
it('retains setup drafts when native validation rejects saving',async()=>{
  const home=fixture();vi.mocked(home.command).mockResolvedValue(false);render(<HomeAutomationSettings home={home} active/>);fireEvent.change(screen.getByLabelText('Hue bridge address'),{target:{value:'invalid'}});fireEvent.click(screen.getByRole('button',{name:'Save local setup'}));await Promise.resolve();expect((screen.getByLabelText('Hue bridge address') as HTMLInputElement).value).toBe('invalid');
});

it('keeps remembered permission visible while stale controls are disabled and preserves observed power after a send',()=>{
  const home=fixture(),d=home.data!.devices[0],now=d.seenAt;
  home.data!.mapping={identity:d.identity,model:d.model,endpoint:d.endpoint,interfaceId:d.interfaceId,alias:'Test Lights',confirmedAt:now};
  home.data!.permission={identity:d.identity,model:d.model,endpoint:d.endpoint,interfaceId:d.interfaceId,power:true,brightness:true,confirmedAt:now};
  home.data!.grant={id:crypto.randomUUID(),identity:d.identity,expiresAt:null,power:true,brightness:true};
  const props={home,active:true,detailHost:null,openDetails:vi.fn(),settings:vi.fn()};const view=render(<HomeAutomationView {...props}/>);
  expect(screen.getByRole('heading',{name:'Test Lights'})).toBeTruthy();const toggle=screen.getByRole('switch',{name:'Light power'});
  expect(toggle.getAttribute('aria-checked')).toBe('false');fireEvent.click(toggle);expect(home.command).toHaveBeenLastCalledWith({action:'control',identity:d.identity,grantId:home.data!.grant.id,operation:{kind:'power',value:true}});
  expect(toggle.getAttribute('aria-checked')).toBe('false');
  d.state!.at=new Date(Date.now()-60_000).toISOString();view.rerender(<HomeAutomationView {...props}/>);
  expect(toggle.hasAttribute('disabled')).toBe(true);expect(screen.getByText('Direct control · Remembered')).toBeTruthy();expect(screen.getByText('Last observed power')).toBeTruthy();
  d.availability='unavailable';home.data!.grant=null;view.rerender(<HomeAutomationView {...props}/>);expect(screen.getByRole('heading',{name:'Test Lights'})).toBeTruthy();expect(screen.getByText('Direct control · Remembered')).toBeTruthy();
});
it('separates sent/readback/physical evidence and never exposes private details in the overview',()=>{
  const home=fixture(),d=home.data!.devices[0];home.data!.receipts=[{id:crypto.randomUUID(),identity:d.identity,alias:'',at:d.seenAt,operation:{kind:'power',value:true},sent:true,before:d.state,after:d.state,outcome:'observed-different',physical:'confirmed',note:'Private transport note'}];
  render(<HomeAutomationView home={home} active detailHost={null} openDetails={vi.fn()} settings={vi.fn()}/>);fireEvent.click(screen.getByRole('button',{name:/H70C4/}));
  expect(screen.getByText('Different state observed · Physically confirmed')).toBeTruthy();expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false');
  expect(screen.queryByText(d.identity)).toBeNull();expect(screen.queryByText(d.endpoint)).toBeNull();expect(screen.getByText('Read-only device')).toBeTruthy();
});
it('does not display a successful readback for a sent unconfirmed command',()=>{
  const home=fixture(),d=home.data!.devices[0];home.data!.receipts=[{id:crypto.randomUUID(),identity:d.identity,alias:'',at:d.seenAt,operation:{kind:'brightness',value:80},sent:true,before:d.state,after:null,outcome:'sent-unconfirmed',physical:'unconfirmed',note:''}];
  render(<HomeAutomationView home={home} active detailHost={null} openDetails={vi.fn()} settings={vi.fn()}/>);fireEvent.click(screen.getByRole('button',{name:/H70C4/}));expect(screen.getByText('Sent · awaiting observation')).toBeTruthy();expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(true);expect(screen.getAllByText('35%').length).toBeGreaterThan(0);
});

it('keeps observed, requested and completed-check states distinct without claiming physical success',()=>{
  const home=fixture(),d=home.data!.devices[0];home.busy=true;home.data!.busy=true;
  home.data!.receipts=[{id:crypto.randomUUID(),identity:d.identity,alias:'',at:d.seenAt,operation:{kind:'brightness',value:80},sent:true,before:d.state,after:null,outcome:'sent-unconfirmed',physical:'unconfirmed',note:'',reconciliation:{sentAt:d.seenAt,finishedAt:null,stage:'checking',reason:'send_completed_state_pending',observations:[]}}];
  const props={home,active:true,detailHost:null,openDetails:vi.fn(),settings:vi.fn()},view=render(<HomeAutomationView {...props}/>);fireEvent.click(screen.getByRole('button',{name:/H70C4/}));
  expect(screen.getByText('Last observed power')).toBeTruthy();expect(screen.getAllByText('Checking device…').length).toBeGreaterThan(0);expect(view.container.querySelector('.home-brightness-heading')?.textContent).toContain('35%');expect(view.container.querySelector('.home-requested')?.textContent).toContain('80%');expect(screen.getByRole('switch').hasAttribute('disabled')).toBe(true);
  home.busy=false;home.data!.busy=false;const r=home.data!.receipts[0];r.reconciliation!.stage='state-unknown';r.reconciliation!.reason='status_timeout';r.reconciliation!.finishedAt=d.seenAt;view.rerender(<HomeAutomationView {...props}/>);
  expect(view.container.querySelector('.home-requested')?.textContent).toContain('state unknown / refresh required');expect(screen.queryByText('Matching state observed')).toBeNull();expect(r.physical).toBe('unconfirmed');
});
it('shows bounded busy state and unknown devices without inventing a light category',()=>{
  const home=fixture();home.data!.busy=true;home.busy=true;home.data!.devices[0].category='unknown';home.data!.devices[0].capability='unknown';
  const view=render(<HomeAutomationView home={home} active detailHost={null} openDetails={vi.fn()} settings={vi.fn()}/>);
  expect(screen.getByText('Local operation in progress…')).toBeTruthy();expect(view.container.querySelector('.home-device-list .lucide-box')).toBeTruthy();expect(screen.getByRole('button',{name:'Discover / refresh'}).hasAttribute('disabled')).toBe(true);
  expect(home.command).not.toHaveBeenCalledWith({action:'discover'});expect(home.command).not.toHaveBeenCalledWith({action:'hue-check'});
});
