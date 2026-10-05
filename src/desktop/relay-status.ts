import type { RelayTransportState } from '../shared/relay-transport';
import type { RelayReceipt } from '../shared/relay';

export type RelayPresentation = { label: string; tone: 'attention' | 'blocked' | 'active' | 'ready' | 'idle' | 'unknown' };
const status = (label: string, tone: RelayPresentation['tone']): RelayPresentation => ({ label, tone });
export const recent = (at: number | undefined, now: number, limit = 20000) => at !== undefined && now >= at && now - at < limit;
/** Presentation only. Never grants transport or action authority. */
export function relayAvailability(state?: RelayTransportState, now = Date.now()) {
  const config = state?.config, voice = state?.voice, gatewayVoice = voice?.gateway;
  const syncFresh = recent(state?.lastSync ? Date.parse(state.lastSync) : undefined, now, 120000);
  const voiceFresh = voice?.channel === 'online' && recent(voice.lastSeenAt, now);
  const gatewayFresh = recent(gatewayVoice?.observedAt, now);
  const gatewayOnline = state?.gateway === 'healthy' && syncFresh || voiceFresh && gatewayFresh;
  const desktopOnline = !!state?.paired && (syncFresh || voiceFresh && gatewayFresh && !!gatewayVoice?.desktopOnline);
  const gateway = !config ? status('Needs setup', 'attention') : !config.enabled ? status('Disabled', 'idle') : gatewayOnline ? status('Connected', 'ready') : state?.gateway === 'unavailable' ? status('Offline', 'blocked') : status('Awaiting connection', 'unknown');
  const desktop = !config ? status('Needs setup', 'attention') : !state?.paired ? status('Pairing not confirmed', 'unknown') : desktopOnline ? status('Online', 'ready') : status('Offline', 'blocked');
  let call = status('No call active', 'idle');
  if (voiceFresh && voice?.sessionId && voice.call !== 'none') call = status(voice.call === 'processing' ? 'Processing request' : voice.call === 'waiting' ? 'Waiting for you' : 'Mo connected', voice.call === 'waiting' ? 'attention' : 'active');
  else if (gatewayFresh && gatewayVoice?.activeCalls) call = status('Call active at gateway', 'active');
  let readiness: RelayPresentation;
  if (!config?.voice?.enabled) readiness = status('Voice disabled', 'idle');
  else if (call.tone === 'active' || call.tone === 'attention') readiness = call;
  else if (!config.enabled) readiness = status('Relay disabled', 'idle');
  else if (!gatewayOnline) readiness = status('Waiting for gateway', 'blocked');
  else if (!state?.paired) readiness = status('Confirm desktop pairing', 'attention');
  else if (!gatewayFresh) readiness = status('Checking Voice availability', 'unknown');
  else if (!gatewayVoice?.configured || !gatewayVoice.ownerConfigured || !gatewayVoice.pinConfigured) readiness = status('Voice setup incomplete', 'attention');
  else if (!gatewayVoice.desktopOnline) readiness = status('Desktop offline', 'blocked');
  else if (!voiceFresh) readiness = status(voice?.channel === 'connecting' ? 'Connecting Voice' : 'Voice channel offline', 'blocked');
  else readiness = status('Ready to receive your call', 'ready');
  const inbound = !config ? status('Needs setup', 'attention') : !config.enabled ? status('Disabled', 'idle') : state?.inboundReady && syncFresh && state.paired && gatewayOnline ? status('Ready', 'ready') : status('Offline', 'blocked');
  const outbound = !config ? status('Unavailable — setup required', 'attention') : state?.campaign === 'pending' ? status('Unavailable — registration pending', 'blocked') : state?.campaign === 'rejected' ? status('Unavailable — registration rejected', 'blocked') : state?.campaign !== 'approved' ? status('Unavailable — registration required', 'blocked') : state.outboundReady && inbound.tone === 'ready' && recent(state.checkedAt ? Date.parse(state.checkedAt) : undefined, now, 300000) ? status('Ready for exact approval', 'ready') : inbound.tone !== 'ready' ? status('Unavailable — reconnect Relay', 'blocked') : status('Sending authorization required', 'attention');
  return { gateway, desktop, voice: readiness, call, inbound, outbound };
}
export function receiptPresentation(receipt: RelayReceipt): RelayPresentation {
  if (receipt.disposition === 'failed' || ['failed', 'undelivered'].includes(receipt.dispatch?.status ?? '')) return status('Failed · review needed', 'blocked');
  if (receipt.disposition === 'held') return status('Needs you', 'attention');
  if (receipt.dispatch) return status(receipt.dispatch.status === 'unknown' ? 'Delivery outcome unknown' : 'Reply ' + receipt.dispatch.status.replaceAll('-', ' '), receipt.dispatch.status === 'unknown' ? 'attention' : 'idle');
  if (receipt.disposition === 'prepared') return status('Reply ready for review', 'attention');
  return status(({ queued: 'Waiting for Mo', processing: 'Mo is working', cancelled: 'Cancelled', archived: 'Archived' } as const)[receipt.disposition], receipt.disposition === 'processing' ? 'active' : 'idle');
}
export function voiceMetadata(state?: RelayTransportState) {
  const d = state?.voice?.diagnostics;
  if (!d) return null;
  return { id: 'voice:' + d.inboundAt, at: new Date(d.inboundAt).toISOString(), ended: d.endedAt !== undefined, duration: d.endedAt !== undefined && d.endedAt >= d.inboundAt ? Math.round((d.endedAt - d.inboundAt) / 1000) : null, turns: d.turns.length };
}

/** Visual projection only: an authenticated desktop session is distinct from a gateway call count. */
export function relayPresence(state?: RelayTransportState, now = Date.now()) {
  const availability = relayAvailability(state, now), voice = state?.voice;
  const authenticated = !!voice?.sessionId && voice.channel === 'online' && recent(voice.lastSeenAt, now) && voice.call !== 'none';
  const stage = authenticated ? voice.call === 'processing' ? 'Processing' : voice.call === 'waiting' ? 'Waiting for you' : 'Connected' : availability.voice.label;
  const character = authenticated ? voice.call === 'processing' ? 'processing' : voice.call === 'waiting' ? 'waiting' : 'connected' : availability.voice.tone === 'ready' ? 'idle' : 'unavailable';
  const start = voice?.diagnostics?.inboundAt;
  const elapsed = authenticated && voice?.diagnostics?.endedAt === undefined && start !== undefined && now >= start ? Math.floor((now - start) / 1000) : null;
  return { authenticated, stage, character, elapsed, title: authenticated ? 'Connected to Mo' : availability.voice.tone === 'ready' ? 'Mo is reachable' : 'Mo remote presence' } as const;
}
