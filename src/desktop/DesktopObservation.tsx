import { useEffect, useRef, useState } from 'react';
import { Monitor, RefreshCw, Shield, Square, Play, X } from 'lucide-react';
import type { DesktopBridge } from '../shared/contracts';
import { desktopObservationLimits as limits, type DesktopObservationCommand, type DesktopObservationState, type NodeObservation } from '../shared/desktop-observation';
import type { SettingsSave } from './SettingsEditing';
import './desktop-observation.css';

type Value<T = unknown> = { state: 'known'; value: T } | { state: 'unknown' | 'unsupported' | 'unavailable' | 'redacted' };
export function observationValue(value: Value): string {
  if (value.state !== 'known') return value.state[0].toUpperCase() + value.state.slice(1);
  if (typeof value.value === 'boolean') return value.value ? 'Yes' : 'No';
  if (Array.isArray(value.value)) return value.value.join(', ') || 'None';
  if (typeof value.value === 'object' && value.value) {
    const rect = value.value as { x: number; y: number; width: number; height: number };
    return `${Math.round(rect.x)}, ${Math.round(rect.y)} · ${Math.round(rect.width)} × ${Math.round(rect.height)}`;
  }
  return String(value.value);
}
const words = (value: string) => value.toLowerCase().replaceAll('_', ' ').replaceAll('-', ' ');
const seconds = (expiry: string, now: number) => Math.max(0, Math.ceil((Date.parse(expiry) - now) / 1000));
const empty = (enabled: boolean): DesktopObservationState => ({ capability: 'desktop.observe', enabled, status: enabled ? 'AVAILABLE' : 'RESTRICTED', reason: enabled ? 'SESSION_REQUIRED' : 'PERMISSION_DISABLED', session: null, catalog: null, tree: null, diagnostics: [] });
type Props = { bridge?: DesktopBridge; active: boolean; enabled: boolean; revision: number; saving: boolean; save: SettingsSave };

export function DesktopObservation({ bridge, active, enabled, revision, saving, save }: Props) {
  const [state, setState] = useState(() => empty(enabled)), [pending, setPending] = useState(''), [closing, setClosing] = useState(false);
  const [now, setNow] = useState(Date.now), [nextRequest, setNextRequest] = useState(0), [chosen, setChosen] = useState(''), [nodeId, setNodeId] = useState('');
  const [error, setError] = useState(''), [permissionBusy, setPermissionBusy] = useState(false);
  const generation = useRef(0), current = useRef(state), inFlight = useRef<{ requestId: string; sessionId?: string } | null>(null), statusBusy = useRef(false);
  const allowed = useRef(false);
  current.current = state;
  allowed.current = active && enabled;

  const clear = () => { current.current = empty(enabled); setState(current.current); setChosen(''); setNodeId(''); setPending(''); };
  const retire = async () => {
    ++generation.current;
    const request = inFlight.current, session = current.current.session;
    inFlight.current = null; clear(); setClosing(true);
    try {
      if (bridge && request) await bridge.desktopObservation({ action: 'cancel', requestId: crypto.randomUUID(), cancelRequestId: request.requestId, ...(request.sessionId ? { sessionId: request.sessionId } : {}) });
      // Also end if completion won the race with cancellation. A stale ID cannot end a new session.
      if (bridge && session) await bridge.desktopObservation({ action: 'end', requestId: crypto.randomUUID(), sessionId: session.id });
    } catch { /* Main also invalidates on renderer destruction; never retain content on transport failure. */ }
    finally { setClosing(false); }
  };

  useEffect(() => {
    const token = ++generation.current;
    clear(); setError('');
    if (active && bridge) {
      void bridge.desktopObservation({ action: 'status', requestId: crypto.randomUUID() }).then(result => {
        if (generation.current === token && result.ok) { current.current = result.value; setState(result.value); }
      }).catch(() => { if (generation.current === token) setError('Observation service unavailable. Reopen this panel to retry.'); });
    }
    return () => { void retire(); };
    // An explicit activity signal covers mounted-but-hidden Settings, tabs and search.
  }, [active, enabled, revision, bridge]);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      const time = Date.now(); setNow(time);
      const previous = current.current;
      if (previous.session && time >= Date.parse(previous.session.expiresAt)) { void retire(); return; }
      if (previous.tree && time >= Date.parse(previous.tree.expiresAt) || previous.catalog && time >= Date.parse(previous.catalog.expiresAt)) {
        const fresh = { ...previous, tree: previous.tree && time < Date.parse(previous.tree.expiresAt) ? previous.tree : null, catalog: previous.catalog && time < Date.parse(previous.catalog.expiresAt) ? previous.catalog : null };
        current.current = fresh; setState(fresh);
        if (!fresh.tree) setNodeId('');
        if (!fresh.catalog) setChosen('');
      }
    }, 250);
    return () => clearInterval(timer);
  }, [active]);

  useEffect(() => {
    if (!active || !enabled || !bridge) return;
    const timer = setInterval(() => {
      // Status reads main's ephemeral state only. Never starts native enumeration or observation.
      if (!current.current.session || inFlight.current || statusBusy.current) return;
      const token = generation.current; statusBusy.current = true;
      void bridge.desktopObservation({ action: 'status', requestId: crypto.randomUUID() }).then(result => {
        if (token !== generation.current || inFlight.current) return;
        if (result.ok) { current.current = result.value; setState(result.value); if (!result.value.tree) setNodeId(''); if (!result.value.catalog) setChosen(''); }
        else { void retire(); setError('Observation service unavailable. Start a new session to retry.'); }
      }).catch(() => { if (token === generation.current) { void retire(); setError('Observation service unavailable. Start a new session to retry.'); } }).finally(() => { statusBusy.current = false; });
    }, 1000);
    return () => clearInterval(timer);
  }, [active, enabled, bridge]);

  async function run(action: 'begin' | 'list' | 'authorize' | 'observe') {
    if (!bridge || !allowed.current || inFlight.current || closing || Date.now() < nextRequest) return;
    const session = current.current.session, targetId = action === 'authorize' ? chosen : session?.targetId;
    if (action !== 'begin' && !session || ['authorize', 'observe'].includes(action) && !targetId) return;
    const token = ++generation.current, requestId = crypto.randomUUID();
    const command = { action, requestId, ...(session ? { sessionId: session.id } : {}), ...(['authorize', 'observe'].includes(action) ? { targetId } : {}) } as DesktopObservationCommand;
    inFlight.current = { requestId, ...(session ? { sessionId: session.id } : {}) };
    setPending(action); setError(''); setNextRequest(Date.now() + limits.intervalMs + 50); setNodeId('');
    const cleared = { ...current.current, tree: null, ...(action === 'list' ? { catalog: null, session: session ? { ...session, targetId: null } : null } : {}) };
    current.current = cleared; setState(cleared); if (action === 'list') setChosen('');
    try {
      const result = await bridge.desktopObservation(command);
      if (token !== generation.current || !allowed.current) {
        if (result.ok && result.value.session) await bridge.desktopObservation({ action: 'end', requestId: crypto.randomUUID(), sessionId: result.value.session.id });
        return;
      }
      if (result.ok) { current.current = result.value; setState(result.value); setNodeId(result.value.tree?.nodes[0]?.id ?? ''); }
      else setError('The observation request could not complete. Stop the session and try again.');
    } catch { if (token === generation.current) { void retire(); setError('Observation service unavailable. Start a new session to retry.'); } }
    finally { if (token === generation.current) { inFlight.current = null; setPending(''); } }
  }
  async function permission() {
    setPermissionBusy(true); setError('');
    if (enabled) await retire();
    try { if (!await save({ desktopObservation: { enabled: !enabled } }, revision)) setError('Permission was not changed. Review the current setting and try again.'); }
    catch { setError('Permission could not be saved. Review the current setting and try again.'); }
    finally { setPermissionBusy(false); }
  }
  const tree = state.tree, catalog = state.catalog, session = state.session;
  const selected = tree?.nodes.find(node => node.id === nodeId);
  const target = catalog?.windows.find(window => window.targetId === session?.targetId);
  const blocked = !active || !enabled || !bridge || !!pending || closing || now < nextRequest;
  const depths = new Map<string, number>();
  for (const node of tree?.nodes ?? []) depths.set(node.id, node.parentId ? (depths.get(node.parentId) ?? 0) + 1 : 0);
  return <section className="desktop-observation" data-setting="desktop-observation" aria-label="Desktop Observation" tabIndex={-1}>
    <header className="observation-heading"><div><h2><Monitor size={19}/> Desktop Observation</h2><p>Inspect a window’s controls locally. Nothing is shared with AI or used to interact with it.</p></div><button className="secondary" onClick={() => void permission()} disabled={!active || !bridge || saving || permissionBusy} aria-label={enabled ? 'Disable Desktop Observation' : 'Enable Desktop Observation'}><Shield size={15}/>{permissionBusy ? 'Saving…' : enabled ? 'Disable' : 'Enable'}</button></header>
    <div className="observation-session" role="status"><strong>{!enabled ? 'Permission off' : pending ? ({ begin: 'Waiting for session approval…', list: 'Reading eligible windows…', authorize: 'Waiting for target approval…', observe: 'Observing controls…' }[pending]) : session ? 'Session active' : 'No active session'}</strong><span>{session ? `Ends in ${seconds(session.expiresAt, now)}s` : 'Explicit start required · 5 minute maximum'}</span><span className="observation-status">{state.status}</span></div>
    <div className="observation-commands"><button className="primary" disabled={blocked || !!session} onClick={() => void run('begin')}><Play size={14}/>Start observation</button><button className="secondary" disabled={!session && !pending || closing} onClick={() => void retire()}><Square size={13}/>Stop</button><button className="secondary" disabled={blocked || !session} onClick={() => void run('list')}><RefreshCw size={14}/>Refresh windows</button>{pending && <button className="secondary" onClick={() => void retire()}><X size={14}/>Cancel current request</button>}</div>
    {error && <p className="observation-message" role="alert">{error}</p>}
    {state.reason && !['SESSION_REQUIRED', 'PERMISSION_DISABLED', 'CANCELLED'].includes(state.reason) && <p className="observation-message">{words(state.reason)}. {state.reason === 'RATE_LIMITED' ? 'Wait a moment before refreshing.' : !session ? 'Start a new session to retry.' : 'Only the available controls can be shown.'}</p>}
    {!session?.targetId && <div className="observation-target"><label htmlFor="observation-window">Eligible window</label><div><select id="observation-window" value={chosen} disabled={blocked || !catalog} onChange={event => setChosen(event.target.value)}><option value="">{catalog ? `${catalog.windows.length} windows · choose a target` : session ? 'Refresh windows to choose a target' : 'Start a session to list windows'}</option>{catalog?.windows.map(window => <option value={window.targetId} key={window.targetId}>{observationValue(window.application)} · window {window.windowOrdinal} · PID {window.pid} · {observationValue(window.state)}</option>)}</select><button className="secondary" disabled={blocked || !chosen || !catalog} onClick={() => void run('authorize')}>Authorize target</button></div><p>{catalog ? `Catalog expires in ${seconds(catalog.expiresAt, now)}s · ${catalog.examinedCandidates} candidates checked${catalog.limitsHit.length ? ' · '+catalog.limitsHit.map(words).join(', ') : ''}` : 'Window titles and document contents are withheld.'}</p></div>}
    <div className="observation-inspector-heading"><div><h3>{target ? `${observationValue(target.application)} · window ${target.windowOrdinal}` : session?.targetId ? 'Authorized window' : 'Control inspector'}</h3><p>{tree ? `${tree.nodes.length} controls · ${tree.elapsedMs} ms · expires in ${seconds(tree.expiresAt, now)}s` : session?.targetId ? 'Ready for an explicit observation.' : 'Authorize one listed window to inspect its controls.'}</p></div><button className="secondary" disabled={blocked || !session?.targetId} onClick={() => void run('observe')}><RefreshCw size={14}/>{tree ? 'Refresh observation' : 'Observe'}</button></div>
    {session?.targetId && <div className="observation-selection"><span aria-label="Selected control">{selected ? <><strong>{selected.role} · {selected.id}</strong> — {observationValue(selected.name)}</> : 'Select a control to inspect its state.'}</span><span>Refresh windows to change target.</span></div>}
    <div className="observation-scroll" tabIndex={0} aria-label="Observation tree and node details">
      {tree ? <><div className="observation-summary"><span>{tree.status}</span><span>Foreground: {observationValue(tree.foreground)}</span><span>Contains keyboard focus: {observationValue(tree.containsKeyboardFocus)}</span><span>Focus: {tree.focus.state === 'in-target' ? tree.focus.nodeId : words(tree.focus.state)}</span>{[...tree.reasons, ...tree.limitsHit].map(reason => <span key={reason}>{words(reason)}</span>)}</div><div className="observation-columns"><div className="observation-tree" role="list" aria-label="Normalized controls">{tree.nodes.map(node => <div role="listitem" key={node.id}><button className="observation-node" aria-pressed={node.id === nodeId} onClick={() => setNodeId(node.id)} style={{ paddingInlineStart: 12 + (depths.get(node.id) ?? 0) * 12 }}><span className="observation-node-role">{node.role}</span><span>{node.name.state === 'known' ? node.name.value : <span className={'observation-value '+node.name.state}>{observationValue(node.name)}</span>}</span><small>{node.hasKeyboardFocus.state === 'known' && node.hasKeyboardFocus.value ? 'Focused' : node.enabled.state === 'known' && !node.enabled.value ? 'Disabled' : node.id}</small></button></div>)}</div><aside className="observation-node-detail" aria-label="Selected node details">{selected ? <NodeDetails node={selected}/> : <p>Select a control to inspect its state.</p>}</aside></div></> : <div className="observation-empty"><Monitor size={25}/><h3>{!enabled ? 'Observation is off' : !session ? 'No desktop session' : pending === 'observe' ? 'Reading the authorized window…' : 'No current observation'}</h3><p>{!enabled ? 'Enable to allow owner-approved, read-only sessions.' : !session ? 'Start when you need to inspect a window. Leaving this panel ends the session.' : 'Observations expire after 15 seconds. Refresh explicitly; earlier trees are cleared.'}</p></div>}
      <details className="observation-diagnostics"><summary>Session diagnostics & limits</summary><p>Up to {limits.windows} windows · {limits.nodes} nodes · depth {limits.depth} · {limits.treeMs / 1000}s tree budget. One request at a time; {limits.perMinute} per minute. Content stays in this session.</p>{state.diagnostics.length ? <ul>{state.diagnostics.slice(-8).map(event => <li key={event.requestId}>{new Date(event.at).toLocaleTimeString()} · {event.operation} · {event.status} · {event.elapsedMs} ms{event.reason ? ' · '+words(event.reason) : ''}{event.limitsHit.length ? ' · '+event.limitsHit.map(words).join(', ') : ''}</li>)}</ul> : <p>No retained session diagnostics.</p>}</details>
    </div>
  </section>;
}

function NodeDetails({ node }: { node: NodeObservation }) {
  const fields: [string, Value][] = [['Functional label', node.name], ['Enabled', node.enabled], ['Offscreen', node.offscreen], ['Keyboard focusable', node.keyboardFocusable], ['Has keyboard focus', node.hasKeyboardFocus], ['Selected', node.selected], ['Toggle', node.toggle], ['Expansion', node.expansion], ['Read-only', node.readOnly], ['Protected content', node.protectedContent], ['Bounds', node.bounds], ['Automation identifier', node.automationId], ['Class', node.className], ['Capabilities (data only)', node.patterns]];
  return <><h4>{node.role} <span>{node.id}</span></h4><dl>{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd className={'observation-value '+value.state}>{observationValue(value)}</dd></div>)}</dl><p className="observation-detail-note">Capability names describe availability only. No interaction is permitted.</p></>;
}
