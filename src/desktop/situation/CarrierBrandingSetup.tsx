import { useRef, useState } from 'react';
import { logoTokenSchema } from '../../shared/carrierBranding';
import type { SituationCommand, SituationSnapshot } from '../../shared/situation';

export function CarrierBrandingSetup({ snapshot, enabled, change, busy, dirty, command }: { snapshot: SituationSnapshot; enabled: boolean; change(enabled: boolean): void; busy: boolean; dirty: boolean; command(input: SituationCommand, success: string): Promise<boolean> }) {
  const input = useRef<HTMLInputElement>(null), [valid, setValid] = useState(false), [remove, setRemove] = useState(false);
  const credential = snapshot.carrierBranding?.credential ?? 'missing', blocked = busy || dirty;
  return <section className="settings-card situation-settings-section"><h2>Carrier logos</h2><p role="status">{credential === 'configured' ? 'Token protected' : credential === 'error' ? 'Token unavailable' : 'Optional · not connected'}</p>
    <label className="setting-row"><span>Show verified carrier logos<small>Optional Logo.dev images. Flight tracking works without them.</small></span><input type="checkbox" checked={enabled} onChange={event => change(event.target.checked)} disabled={busy || credential !== 'configured'}/></label>
    <p>Uses the operator website supplied by FlightAware. Unknown carriers keep a code or aircraft symbol. Saving or enabling sends no request; logos load after your next flight Refresh.</p>
    <details className="situation-add-editor"><summary>Manage Logo.dev token</summary><p>Choose the free Community plan and copy its publishable key beginning <strong>pk_</strong>. This image token is protected on this computer and is sent in image URLs; do not use a secret sk_ key.</p>
      <p><a href="https://www.logo.dev/signup" target="_blank" rel="noreferrer">Create a Logo.dev account</a> · <a href="https://www.logo.dev/pricing" target="_blank" rel="noreferrer">Current plans</a></p>
      <label>Publishable image token<input type="password" ref={input} autoComplete="new-password" spellCheck={false} maxLength={183} onChange={event => setValid(logoTokenSchema.safeParse(event.target.value.trim()).success)}/></label>
      <button type="button" className="secondary" disabled={blocked || !snapshot.protectionAvailable || !valid} onClick={() => { const token = input.current?.value.trim() ?? ''; if (input.current) input.current.value = ''; setValid(false); void command({ action: 'save-carrier-logo-token', token }, 'Logo token protected. Enable carrier logos and Apply when ready.'); }}>Protect logo token</button>
      {credential !== 'missing' && <button type="button" className="text-button" disabled={blocked} onClick={() => setRemove(true)}>Remove logo token</button>}
      {remove && <div className="situation-remove-key"><p>Remove the local logo token? Flights will keep working.</p><button type="button" className="secondary" disabled={blocked} onClick={() => { setRemove(false); void command({ action: 'remove-carrier-logo-token' }, 'Logo token removed. Carrier logos are off.'); }}>Remove token</button><button type="button" className="text-button" onClick={() => setRemove(false)}>Keep token</button></div>}
      <p>Apply or cancel other edits before changing a token. Personal Community use is currently free; browser caching follows Logo.dev’s headers. No logos are downloaded into MoMo’s files.</p>
      <p>With logos enabled, a new operator may require one FlightAware lookup ($0.015), retained for this app session for up to 24 hours. It uses your existing FlightAware spending limit. Image delivery uses the Logo.dev allowance.</p>
    </details>
  </section>;
}
