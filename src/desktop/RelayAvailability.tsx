import { useEffect, useState } from 'react';
import { CircleAlert, MessageSquare, Monitor, Phone } from 'lucide-react';
import type { RelayTransportState } from '../shared/relay-transport';
import { relayAvailability, relayPresence, type RelayPresentation } from './relay-status';
import { MoPortrait } from './MoIdentity';

export function useRelayAvailability(state?: RelayTransportState) {
  const [now, setNow] = useState(Date.now);
  // Expire observations even when the native service has no new event to publish.
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(timer); }, []);
  return relayAvailability(state, Math.max(now, Date.now()));
}
export function RelayStatus({ value }: { value: RelayPresentation }) {
  return <span className="relay-status" data-tone={value.tone}>{value.label}</span>;
}
export function RelayAvailability({ state }: { state?: RelayTransportState }) {
  const value = useRelayAvailability(state);
  return <div className="relay-compact-availability" aria-label="Relay channel availability">
    <span><Phone size={15}/>Voice · <RelayStatus value={value.voice}/></span>
    <span><Monitor size={15}/>Desktop · <RelayStatus value={value.desktop}/></span>
    <span>Receiving · <RelayStatus value={value.inbound}/></span>
    <span>Sending · <RelayStatus value={value.outbound}/></span>
  </div>;
}

export function RelayPresence({ state }: { state?: RelayTransportState }) {
  const value = useRelayAvailability(state), presence = relayPresence(state);
  const elapsed = presence.elapsed === null ? null : `${Math.floor(presence.elapsed / 60).toString().padStart(2, '0')}:${(presence.elapsed % 60).toString().padStart(2, '0')}`;
  return <section className="relay-presence" aria-label="Mo remote presence" data-call-active={presence.authenticated}>
    <div className="relay-presence-heading"><MoPortrait state={presence.character}/><div><h3>{presence.title}</h3><p>{presence.stage}</p></div></div>
    {presence.authenticated ? <><div className="relay-live-call"><Phone size={18}/><div><strong>Owner call</strong><small>Authenticated session</small></div>{elapsed !== null && <span className="relay-call-elapsed" aria-label="Call elapsed" title="Elapsed since the call arrived">{elapsed}</span>}</div><p className="relay-presence-copy">{state?.config?.voice?.retainHistory ? 'Saved conversations are available in Mo history.' : 'History off · no transcript retained.'}</p></> : <><small className="relay-number-label">Your Mo number</small><strong className="relay-presence-number">{state?.config?.number || 'Not configured'}</strong><p className="relay-presence-copy">{value.voice.tone === 'ready' ? 'Call from your trusted phone. Your PIN protects the connection.' : 'Review availability in Relay Settings. Retained communications remain here.'}</p></>}
    <div className="relay-presence-desktop"><Monitor size={16}/><span>Desktop</span><RelayStatus value={value.desktop}/></div>
  </section>;
}

export function RelayMessaging({ state }: { state?: RelayTransportState }) {
  const value = useRelayAvailability(state);
  // Keep registration separate from connection failures; detailed policy remains in diagnostics.
  const registration = state?.config?.enabled && ['pending', 'rejected', 'unverified'].includes(state?.campaign ?? '');
  return <section className="relay-messaging" aria-label="Message readiness"><h3>Messages</h3>
    <div><MessageSquare size={18}/><span><small>Receiving</small><RelayStatus value={value.inbound}/></span></div>
    <div><CircleAlert size={18}/><span><small>Sending</small>{registration ? <><strong>Unavailable</strong><small>Registration required</small></> : <RelayStatus value={value.outbound}/>}</span></div>
  </section>;
}
