import { useEffect, useState } from 'react';
import type { DesktopBridge } from '../shared/contracts';
import { relayTransportConfigSchema, type RelayTransportConfig } from '../shared/relay-transport';
import { useRelay } from './RelayView';
import { defaultVoiceConfig, type VoiceConfig } from '../shared/voice';
import { VoiceDiagnostics } from './VoiceDiagnostics';
import { RelayMessaging, RelayPresence, RelayStatus, useRelayAvailability } from './RelayAvailability';
import { MessageSquare, Monitor, Radio, ShieldCheck } from 'lucide-react';
const empty:RelayTransportConfig={version:1,revision:0,enabled:false,accountSid:'',number:'',numberSid:'',messagingServiceSid:'',campaignSid:'',gatewayOrigin:'',region:'us1',edge:'dublin'};
export function RelaySettings({bridge}:{bridge?:DesktopBridge}){
 const relay=useRelay(bridge),state=relay.data?.transport,availability=useRelayAvailability(state);
 const [draft,setDraft]=useState(empty),[dirty,setDirty]=useState(false),[error,setError]=useState('');
 const [accounts,setAccounts]=useState<{id:string;email:string;calendarWrite?:boolean}[]>([]);
 useEffect(()=>{void bridge?.getSnapshot().then(r=>{if(r.ok)setAccounts(r.value.google.accounts);});},[bridge]);
 useEffect(()=>{if(!dirty&&state?.config)setDraft(state.config);},[state?.config,dirty]);
 const field=(key:keyof RelayTransportConfig,value:string|boolean)=>{setDirty(true);setDraft({...draft,[key]:value});};
 const voice=draft.voice??defaultVoiceConfig;
 const voiceField=(patch:Partial<VoiceConfig>)=>{setDirty(true);setDraft({...draft,voice:{...voice,...patch}});};
 return <section className="settings-card relay-transport-settings" data-setting="relay"><h2>Relay</h2><p>Reach Mo by phone and keep incoming updates connected to your work.</p>
 {state?.synthetic&&<p className="fine-print" role="note">SYNTHETIC ISOLATED TRANSPORT TEST · no live Twilio account</p>}
 {relay.error&&<p role="alert" className="field-error">{relay.error}</p>}
 <div className="relay-settings-modules">
 <section className="relay-settings-module relay-settings-anchor"><h3><Radio size={20}/>Relay status</h3><strong className="relay-settings-number">{state?.config?.number || 'Number not configured'}</strong><small>Your Mo number</small><div className="relay-settings-connection"><div><Radio size={18}/><span><RelayStatus value={availability.gateway}/><small>Relay gateway</small></span></div><i aria-hidden="true"/><div><Monitor size={18}/><span><RelayStatus value={availability.desktop}/><small>Desktop</small></span></div></div><p className="fine-print">{state?.lastSync ? 'Last successful sync ' + new Date(state.lastSync).toLocaleString() : 'No successful sync this session'}</p></section>
 <section className="relay-settings-module relay-settings-voice"><h3>Mo Voice</h3><RelayPresence state={state}/><dl className="settings-facts"><div><dt>Owner caller</dt><dd>{state?.voice?.gateway ? state.voice.gateway.ownerConfigured ? 'Configured at gateway' : 'Not configured' : 'Caller configuration unavailable'}</dd></div><div><dt>Access PIN</dt><dd>{state?.voice?.gateway ? state.voice.gateway.pinConfigured ? 'Configured securely' : 'Not configured' : 'PIN status unavailable'}</dd></div><div><dt>Voice channel</dt><dd><RelayStatus value={availability.voice}/></dd></div><div><dt>Current call</dt><dd><RelayStatus value={availability.call}/></dd></div><div><dt>Conversation history</dt><dd>{state?.config?.voice?.retainHistory ? 'Saved in Mo history' : 'Off · no transcript retained'}</dd></div></dl><p className="fine-print">Audio is not recorded. Requested proposals remain in Work for review.</p></section>
 <section className="relay-settings-module relay-settings-messaging"><h3><MessageSquare size={20}/>Messaging</h3><RelayMessaging state={state}/><p><strong>Sender policy</strong><br/>{state?.allowedSenders.length ? state.allowedSenders.join(', ') : 'Sender list not available this session'}</p><p className="fine-print">Incoming payloads are held for up to {state?.payloadHours ?? 24} hours and deleted after desktop acknowledgment. Content-free replay metadata: {state?.tombstoneDays ?? 30} days. Twilio retention is separate.</p></section>
 <section className="relay-settings-module relay-settings-security"><h3><ShieldCheck size={20}/>Security / pairing</h3><strong className="relay-security-title">{state?.paired ? 'Paired to this desktop' : 'Desktop pairing needs review'}</strong><p>{state?.credentials === 'configured' ? 'Credentials protected on this Windows installation' : state?.credentials === 'error' ? 'Credential access needs attention' : 'Credentials not configured'}</p><p>{state?.voice?.gateway ? state.voice.gateway.ownerConfigured ? 'Trusted owner caller configured · PIN required' : 'Set up your trusted owner caller' : 'Caller configuration unavailable this session'}</p><p className="fine-print">Secret values never pass through this page.</p></section>
 </div>
 <details className="relay-settings-disclosure"><summary>Voice preferences and connection setup{dirty?' · Unsaved changes':''}</summary>
 <form onSubmit={e=>{e.preventDefault();const result=relayTransportConfigSchema.safeParse(draft);if(!result.success){setError('Check the Twilio SID formats, E.164 number and public HTTPS gateway origin.');return;}setError('');void relay.command({action:'configureTransport',config:draft}).then(ok=>{if(ok)setDirty(false);});}}>
 <h3>Voice preferences</h3>
 <label className="relay-consent"><input type="checkbox" checked={voice.enabled} onChange={e=>voiceField({enabled:e.target.checked})}/>Enable owner Voice on this desktop</label>
 <div className="relay-configuration-grid"><label>Voice account<select value={voice.accountId??''} onChange={e=>voiceField({accountId:e.target.value||null,allowLocalTaskCreate:false,allowCalendarCreate:false,...(!e.target.value?{includeGoogle:false}:{})})}><option value="">Local workspace</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.email}</option>)}</select></label></div>
 <label className="relay-consent"><input type="checkbox" checked={voice.includeGoogle} disabled={!voice.accountId} onChange={e=>voiceField({includeGoogle:e.target.checked,...(!e.target.checked?{allowCalendarCreate:false}:{})})}/>Include permitted Inbox and calendar</label>
 <label className="relay-consent"><input type="checkbox" checked={voice.includeLocal} onChange={e=>voiceField({includeLocal:e.target.checked,...(!e.target.checked?{allowLocalTaskCreate:false}:{})})}/>Include permitted tasks and Work</label>
 <label className="relay-consent"><input type="checkbox" checked={!!voice.allowLocalTaskCreate} disabled={!voice.accountId||!voice.includeLocal} onChange={e=>voiceField({allowLocalTaskCreate:e.target.checked})}/>Allow local task creation after exact spoken confirmation</label>
 <label className="relay-consent"><input type="checkbox" checked={!!voice.allowCalendarCreate} disabled={!voice.includeGoogle||!accounts.some(a=>a.id===voice.accountId&&a.calendarWrite)} onChange={e=>voiceField({allowCalendarCreate:e.target.checked})}/>Allow private calendar events after exact spoken confirmation</label>
 <label className="relay-consent"><input type="checkbox" checked={voice.includeWeather} onChange={e=>voiceField({includeWeather:e.target.checked})}/>Include eligible saved weather</label>
 <label className="relay-consent"><input type="checkbox" checked={voice.retainHistory} onChange={e=>voiceField({retainHistory:e.target.checked})}/>Save voice conversations in normal Mo history</label>
 <p className="fine-print">Calendar creation requires the selected account's Calendar event creation permission. Invitations, recurring events, calendar edits and message sending remain blocked. Confirmed events and their action receipts remain in Calendar; local tasks and proposals remain in Work. Audio is not recorded. Owner phone and PIN are configured securely at the gateway.</p>
 <h3>Account and gateway identifiers</h3><p>These identifiers are not secrets. Use the existing purchased number. Do not enter an Auth Token or API secret here.</p>
 <div className="relay-configuration-grid">{([['accountSid','Account SID (AC)'],['number','Purchased number (E.164)'],['numberSid','Phone Number SID (PN)'],['messagingServiceSid','Messaging Service SID (MG)'],['campaignSid','Campaign resource SID (QE)'],['gatewayOrigin','Mo Relay HTTPS origin']] as const).map(([key,label])=><label key={key}>{label}<input required value={draft[key]} maxLength={key==='gatewayOrigin'?240:40} autoComplete="off" onChange={e=>field(key,e.target.value)}/></label>)}<label>Provider region<select value={draft.region} disabled><option value="us1">US1 · A2P registration</option></select></label><label>REST API edge<select value={draft.edge} onChange={e=>field('edge',e.target.value)}><option value="dublin">Dublin</option><option value="frankfurt">Frankfurt</option><option value="ashburn">Ashburn</option></select></label></div>
 <label className="relay-consent"><input type="checkbox" checked={draft.enabled} onChange={e=>field('enabled',e.target.checked)}/>Enable authenticated desktop synchronization for this gateway</label>
 {error&&<p role="alert" className="field-error">{error}</p>}<button className="primary small" disabled={relay.busy||!dirty}>Save Relay configuration</button></form>

 </details>
 <details className="relay-settings-disclosure"><summary>Security and pairing</summary>
 <dl className="settings-facts"><div><dt>Desktop paired</dt><dd>{state?.paired?'Paired':'Pairing not confirmed this session'}</dd></div><div><dt>Credentials</dt><dd>{state?.credentials==='configured'?'Protected on this Windows installation':state?.credentials==='error'?'Credential access needs attention':'Not configured'}</dd></div><div><dt>Trusted caller</dt><dd>{state?.voice?.gateway?.ownerConfigured?'Owner caller configured · PIN required':'Caller configuration not confirmed'}</dd></div></dl>
 <h3>Secure setup and verification</h3><p>Dedicated API Key credentials stay encrypted on this Windows installation. The Twilio Account Auth Token belongs only in the cloud host’s secret store. Secret entry never passes through this page.</p>
 <div className="relay-setup-actions"><button className="secondary small" disabled={relay.busy} onClick={()=>void relay.command({action:'secureSetup',purpose:'rest'})}>Set REST API key securely</button><button className="secondary small" disabled={relay.busy||!state?.config?.enabled} onClick={()=>void relay.command({action:'secureSetup',purpose:'pair'})}>Pair desktop securely</button><button className="secondary small" disabled={relay.busy||!state?.config?.enabled} onClick={()=>void relay.command({action:'syncTransport'})}>Synchronize now</button><button className="secondary small" disabled={relay.busy||!state?.paired||state.credentials!=='configured'} onClick={()=>void relay.command({action:'checkReadiness'})}>Verify registration</button><button className="secondary small" disabled={relay.busy||state?.campaign!=='approved'||!state.inboundReady} onClick={()=>void relay.command({action:'authorizeOutbound'})}>Authorize live sending…</button></div>
 <p>Checks are bounded to once per minute. Approval is verified with Twilio and expires locally after five minutes. Live sending requires a separate native confirmation and exact review for every SMS. No message is sent during setup.</p>

 </details>
 <details className="relay-settings-disclosure relay-diagnostics"><summary>Advanced &amp; diagnostics</summary>
 <p>{state?.reason??'No connection diagnostic available.'}</p>
 <dl className="settings-facts">
 <div><dt>Provider</dt><dd>Twilio · selected</dd></div>
 <div><dt>Account SID</dt><dd>{state?.config?.accountSid||'Not configured'}</dd></div>
 <div><dt>Phone Number SID</dt><dd>{state?.config?.numberSid||'Not configured'}</dd></div>
 <div><dt>Messaging Service SID</dt><dd>{state?.config?.messagingServiceSid||'Not configured'}</dd></div>
 <div><dt>Campaign SID</dt><dd>{state?.config?.campaignSid||'Not configured'}</dd></div>
 <div><dt>Gateway origin</dt><dd>{state?.config?.gatewayOrigin||'Not configured'}</dd></div>
 <div><dt>Gateway state</dt><dd>{state?.gateway??'not-configured'}</dd></div>
 <div><dt>Campaign registration</dt><dd>{state?.campaign??'unverified'}</dd></div>
 <div><dt>Registration checked</dt><dd>{state?.checkedAt?new Date(state.checkedAt).toLocaleString():'Not checked this session'}</dd></div>
 <div><dt>Gateway last seen</dt><dd>{state?.lastSeen??'Not observed'}</dd></div>
 <div><dt>Cloud queue</dt><dd>{state?.pending??0} pending</dd></div>
 <div><dt>Voice route configured</dt><dd>{state?.voice?.gateway?String(state.voice.gateway.configured):'Not observed'}</dd></div>
 <div><dt>Voice WebSocket</dt><dd>{state?.voice?.channel??'disabled'}</dd></div>
 <div><dt>Gateway activeCalls</dt><dd>{state?.voice?.gateway?.activeCalls??'Not observed'}</dd></div>
 <div><dt>Desktop call state</dt><dd>{state?.voice?.call??'none'}</dd></div>
 <div><dt>Responsibility bindings</dt><dd>{relay.data?.responsibilities.length??0}</dd></div>
 </dl><VoiceDiagnostics voice={state?.voice}/>
 </details></section>;
}
