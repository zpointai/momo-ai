// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,within,waitFor} from '@testing-library/react';
import {RelayMessaging,RelayPresence} from '../src/desktop/RelayAvailability';
import {RelaySettings} from '../src/desktop/RelaySettings';
import {RelayView, type RelayController} from '../src/desktop/RelayView';
import {relayPresence} from '../src/desktop/relay-status';
import type {RelayTransportState} from '../src/shared/relay-transport';
import type {DesktopBridge} from '../src/shared/contracts';
import {defaultVoiceConfig} from '../src/shared/voice';

afterEach(()=>{cleanup();vi.useRealTimers();});
it.each(['offline','awaiting','connected'] as const)('keeps the unselected %s introduction truthful',mode=>{
 vi.useFakeTimers();vi.setSystemTime(now);const transport=state();
 if(mode!=='connected'){transport.voice=undefined;transport.lastSync=null;transport.gateway=mode==='offline'?'unavailable':'not-configured';}
 const relay={data:{provider:'twilio',connection:'configured',lastSync:null,transport,receipts:[],responsibilities:[],totalReceipts:0},busy:false,error:'',command:vi.fn(),refresh:vi.fn()} as RelayController;
 render(<RelayView relay={relay} tasks={[]} accountId={null} active detailHost={null} details={vi.fn()} activity={vi.fn()} settings={vi.fn()} workflowSettings={vi.fn()} openSource={vi.fn()}/>);
 expect(screen.getByRole('heading',{name:mode==='offline'?'Relay offline':mode==='connected'?'Your communications, connected.':'Your communications, in one place.'})).toBeTruthy();
 if(mode==='offline')expect(screen.getByText(/Remote events will resume when the connection returns/)).toBeTruthy();
});
const now=Date.parse('2026-10-02T14:00:00Z');
it('calendar Voice opt-in is separate and is cleared when Google sharing is removed',async()=>{
 const transport=state();transport.config!.voice={...defaultVoiceConfig,accountId:'accountA',includeGoogle:true};
 const command=vi.fn(async()=>({ok:true,value:{provider:'twilio',connection:'configured',lastSync:null,transport,receipts:[],responsibilities:[],totalReceipts:0}}));
 const bridge={relayCommand:command,getSnapshot:vi.fn(async()=>({ok:true,value:{google:{accounts:[{id:'accountA',email:'owner@example.test',calendarWrite:true}]}}}))} as unknown as DesktopBridge;
 render(<RelaySettings bridge={bridge}/>);await screen.findByRole('heading',{name:'Mo Voice'});fireEvent.click(screen.getByText('Voice preferences and connection setup'));
 const calendar=screen.getByRole('checkbox',{name:'Allow private calendar events after exact spoken confirmation'}) as HTMLInputElement;
 await waitFor(()=>expect(calendar.disabled).toBe(false));expect(calendar.checked).toBe(false);fireEvent.click(calendar);expect(calendar.checked).toBe(true);
 fireEvent.click(screen.getByRole('checkbox',{name:'Include permitted Inbox and calendar'}));expect(calendar.checked).toBe(false);expect(calendar.disabled).toBe(true);expect(command).toHaveBeenCalledTimes(1);
});
function state():RelayTransportState{return {config:{version:1,revision:0,enabled:true,accountSid:'AC'+'a'.repeat(32),number:'+12025550101',numberSid:'PN'+'b'.repeat(32),messagingServiceSid:'MG'+'c'.repeat(32),campaignSid:'QE'+'d'.repeat(32),gatewayOrigin:'https://synthetic.invalid',region:'us1',edge:'dublin',voice:{...defaultVoiceConfig,enabled:true}},credentials:'configured',gateway:'healthy',paired:true,deviceId:null,lastSync:new Date(now).toISOString(),pending:0,lastSeen:null,inboundReady:true,campaign:'pending',checkedAt:null,outboundReady:false,liveAuthorization:false,reason:'Synthetic registration pending',allowedSenders:[],payloadHours:24,tombstoneDays:30,voice:{channel:'online',call:'connected',sessionId:'11111111-1111-4111-8111-111111111111',lastSeenAt:now,gateway:{configured:true,ownerConfigured:true,pinConfigured:true,desktopOnline:true,activeCalls:1,scope:'read-prepare',recording:false,observedAt:now},diagnostics:{inboundAt:now-134000,turns:[],interruptions:[],audibleStart:'not-observable'}}};}
it.each([['connected','Connected','connected'],['processing','Processing','processing'],['waiting','Waiting for you','waiting']] as const)('maps authenticated %s to truthful Mo presence', (call,stage,character)=>{const s=state();s.voice!.call=call;expect(relayPresence(s,now)).toMatchObject({authenticated:true,title:'Connected to Mo',stage,character,elapsed:134});});
it('does not turn a gateway call count or stale/future session into connected Mo',()=>{const s=state();s.voice!.sessionId=null;expect(relayPresence(s,now)).toMatchObject({authenticated:false,character:'unavailable',elapsed:null});s.voice!.sessionId='11111111-1111-4111-8111-111111111111';expect(relayPresence(s,now+20001).authenticated).toBe(false);expect(relayPresence(s,now-1).authenticated).toBe(false);});
it('does not derive live elapsed time from ended or missing diagnostics',()=>{const s=state();s.voice!.diagnostics!.endedAt=now;expect(relayPresence(s,now).elapsed).toBeNull();s.voice!.diagnostics=undefined;expect(relayPresence(s,now).elapsed).toBeNull();});
it('shows one approved character, observed elapsed and no transcript, then expires presence',async()=>{vi.useFakeTimers();vi.setSystemTime(now);const {container}=render(<RelayPresence state={state()}/>);expect(screen.getByRole('heading',{name:'Connected to Mo'})).toBeTruthy();expect(screen.getByLabelText('Call elapsed').textContent).toBe('02:14');expect(container.querySelectorAll('.mo-character')).toHaveLength(1);expect(screen.getByText('History off · no transcript retained.')).toBeTruthy();expect(screen.queryByText(/Listening|Speaking/)).toBeNull();await vi.advanceTimersByTimeAsync(25000);expect(screen.queryByRole('heading',{name:'Connected to Mo'})).toBeNull();});
it('keeps receiving ready while registration prevents sending, without outage language',()=>{vi.useFakeTimers();vi.setSystemTime(now);render(<RelayMessaging state={state()}/>);expect(screen.getByText('Ready')).toBeTruthy();expect(screen.getByText('Unavailable')).toBeTruthy();expect(screen.getByText('Registration required')).toBeTruthy();expect(screen.queryByText(/outage|automatically|reconnect/i)).toBeNull();});
it('Settings modules and diagnostics use the same active call and keep secure controls unchanged',async()=>{vi.spyOn(Date,'now').mockReturnValue(now);const transport=state(),command=vi.fn(async()=>({ok:true,value:{provider:'twilio',connection:'configured',lastSync:null,transport,receipts:[],responsibilities:[],totalReceipts:0}}));const bridge={relayCommand:command,getSnapshot:vi.fn(async()=>({ok:true,value:{google:{accounts:[]}}}))} as unknown as DesktopBridge;const {container}=render(<RelaySettings bridge={bridge}/>);await screen.findByRole('heading',{name:'Connected to Mo'});for(const title of ['Relay status','Mo Voice','Messaging','Security / pairing'])expect(screen.getByRole('heading',{name:title,exact:true})).toBeTruthy();const diagnostics=screen.getByText('Advanced & diagnostics').closest('details')!;expect(diagnostics.open).toBe(false);fireEvent.click(within(diagnostics).getByText('Advanced & diagnostics'));expect(diagnostics.open).toBe(true);expect(within(diagnostics).getByText('connected',{exact:true})).toBeTruthy();expect(container.querySelector('input[type=password]')).toBeNull();expect(command).toHaveBeenCalledTimes(1);vi.restoreAllMocks();});
