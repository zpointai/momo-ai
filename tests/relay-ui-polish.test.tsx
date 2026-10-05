// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { relayAvailability, receiptPresentation, voiceMetadata } from '../src/desktop/relay-status';
import { RelayAvailability } from '../src/desktop/RelayAvailability';
import { RelayView, type RelayController } from '../src/desktop/RelayView';
import type { RelayTransportState } from '../src/shared/relay-transport';
import type { RelayReceipt } from '../src/shared/relay';
import { defaultVoiceConfig } from '../src/shared/voice';
afterEach(() => { cleanup(); vi.useRealTimers(); });
const now = Date.parse('2026-10-02T12:00:00Z');
function ready(): RelayTransportState {
 return { config: { version: 1, revision: 0, enabled: true, accountSid: 'AC'+'a'.repeat(32), number: '+12025550101', numberSid:'PN'+'b'.repeat(32), messagingServiceSid:'MG'+'c'.repeat(32), campaignSid:'QE'+'d'.repeat(32), gatewayOrigin:'https://synthetic.invalid',region:'us1',edge:'dublin', voice:{...defaultVoiceConfig,enabled:true} }, credentials:'configured',gateway:'healthy',paired:true,deviceId:null,lastSync:new Date(now).toISOString(),pending:0,lastSeen:null,inboundReady:true,campaign:'pending',checkedAt:null,outboundReady:false,liveAuthorization:false,reason:'Synthetic',allowedSenders:[],payloadHours:24,tombstoneDays:30,voice:{channel:'online',call:'none',sessionId:null,lastSeenAt:now,gateway:{configured:true,ownerConfigured:true,pinConfigured:true,desktopOnline:true,activeCalls:0,scope:'read-prepare',recording:false,observedAt:now}} };
}
it('keeps Voice, inbound and registration-blocked outbound independent', () => {
 const s=relayAvailability(ready(),now);expect(s.voice.label).toBe('Ready to receive your call');expect(s.inbound.label).toBe('Ready');expect(s.outbound.label).toBe('Unavailable — registration pending');expect(s.gateway.label).toBe('Connected');
});
it.each(['configured','ownerConfigured','pinConfigured'] as const)('requires verified Voice %s', key => { const s=ready();s.voice!.gateway![key]=false;expect(relayAvailability(s,now).voice.label).toBe('Voice setup incomplete'); });
it('expires stale and future observations and never infers listening or speaking', () => {
 const s=ready();expect(relayAvailability(s,now+20001).voice.tone).not.toBe('ready');expect(relayAvailability(s,now+120001).inbound.label).toBe('Offline');expect(relayAvailability(s,now-1).voice.tone).not.toBe('ready');
 s.voice!.call='processing';s.voice!.sessionId=crypto.randomUUID();expect(relayAvailability(s,now).voice.label).toBe('Processing request');s.voice!.call='waiting';expect(relayAvailability(s,now).voice.label).toBe('Waiting for you');s.voice!.call='connected';expect(relayAvailability(s,now).voice.label).toBe('Mo connected');s.voice!.sessionId=null;expect(relayAvailability(s,now).call.label).toBe('No call active');
});
it('requires enabled Voice, pairing, an online desktop and channel', () => {
 const s=ready();s.config!.voice!.enabled=false;expect(relayAvailability(s,now).voice.label).toBe('Voice disabled');s.config!.voice!.enabled=true;s.paired=false;expect(relayAvailability(s,now).voice.label).toBe('Confirm desktop pairing');s.paired=true;s.voice!.gateway!.desktopOnline=false;expect(relayAvailability(s,now).voice.label).toBe('Desktop offline');s.voice!.gateway!.desktopOnline=true;s.voice!.channel='offline';expect(relayAvailability(s,now).voice.label).toBe('Voice channel offline');
});
it('outbound requires fresh current authorization after registration', () => {
 const s=ready();s.campaign='unverified';expect(relayAvailability(s,now).outbound.label).toContain('registration required');s.campaign='rejected';expect(relayAvailability(s,now).outbound.label).toContain('registration rejected');s.campaign='approved';expect(relayAvailability(s,now).outbound.label).toBe('Sending authorization required');s.outboundReady=true;s.checkedAt=new Date(now).toISOString();expect(relayAvailability(s,now).outbound.tone).toBe('ready');expect(relayAvailability(s,now+300001).outbound.tone).not.toBe('ready');
});
it('expires readiness without a native notification', async () => {
 vi.useFakeTimers();vi.setSystemTime(now);render(<RelayAvailability state={ready()}/>);expect(screen.getByText('Ready to receive your call')).toBeTruthy();await vi.advanceTimersByTimeAsync(25000);expect(screen.queryByText('Ready to receive your call')).toBeNull();
});
it('shows metadata without call text and preserves the selected call through filtering', () => {
 const transport=ready();transport.voice!.diagnostics={inboundAt:now-4000,endedAt:now,turns:[],interruptions:[],audibleStart:'not-observable'};
 expect(voiceMetadata(transport)?.duration).toBe(4);
 const relay:RelayController={data:{provider:'twilio',connection:'not-configured',lastSync:null,transport,receipts:[],responsibilities:[],totalReceipts:0},busy:false,error:'',command:vi.fn(),refresh:vi.fn()};
 render(<RelayView relay={relay} tasks={[]} accountId={null} active detailHost={null} details={vi.fn()} activity={vi.fn()} settings={vi.fn()} workflowSettings={vi.fn()} openSource={vi.fn()}/>);
 fireEvent.click(screen.getByRole('button',{name:/Owner call/}));expect(screen.getByText('Conversation history is off. Call text is not retained.',{exact:false})).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Messages',exact:true}));expect(screen.getByText('Call ended')).toBeTruthy();expect(screen.queryByText(/Listening|Speaking/)).toBeNull();
});
it('uses existing Work/Mo handoff for retained Voice proposals without rendering prompts', () => {
 const openWork=vi.fn(),askWork=vi.fn(),relay={data:{provider:'twilio',connection:'not-configured',lastSync:null,receipts:[],responsibilities:[],totalReceipts:0},busy:false,error:'',command:vi.fn(),refresh:vi.fn()} as RelayController;
 render(<RelayView relay={relay} tasks={[]} accountId={null} active detailHost={null} details={vi.fn()} activity={vi.fn()} settings={vi.fn()} workflowSettings={vi.fn()} openSource={vi.fn()} openWork={openWork} askWork={askWork} voiceWork={[{id:'retained-work',at:new Date(now).toISOString(),state:'Prepared for review'}]}/>);
 fireEvent.click(screen.getByRole('button',{name:/Work from your call/}));fireEvent.click(screen.getAllByRole('button',{name:'Open in Work'})[0]);fireEvent.click(screen.getAllByRole('button',{name:'Discuss with Mo'})[0]);expect(openWork).toHaveBeenCalledWith('retained-work');expect(askWork).toHaveBeenCalledWith('retained-work');
});
it('prioritizes delivery failures over prepared state', () => { expect(receiptPresentation({disposition:'prepared',dispatch:{status:'undelivered'}} as RelayReceipt).label).toBe('Failed · review needed'); });

it('projects a new observation immediately between freshness ticks', () => {
 vi.useFakeTimers();vi.setSystemTime(now);const stale=ready();stale.voice!.lastSeenAt=now-30000;stale.voice!.gateway!.observedAt=now-30000;
 const {rerender}=render(<RelayAvailability state={stale}/>);vi.setSystemTime(now+1000);const fresh=ready();fresh.voice!.lastSeenAt=now+1000;fresh.voice!.gateway!.observedAt=now+1000;rerender(<RelayAvailability state={fresh}/>);expect(screen.getByText('Ready to receive your call')).toBeTruthy();
});
