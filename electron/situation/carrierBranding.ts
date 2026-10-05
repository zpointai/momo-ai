import { carrierBrandSchema, carrierDomain, logoTokenSchema, type CarrierBrand, type CarrierIdentity } from '../../src/shared/carrierBranding';

export interface CarrierBrandProvider { resolve(carrier: CarrierIdentity, token: string, now: number): CarrierBrand }
// Verified 2026-09-29: Baku airport's airline directory identifies J2 / Azerbaijan Airlines / azal.az.
// https://www.airport.az/en/airlines-directory/azerbaijan-airlines/
// The ICAO code must also match the exact FlightAware operator identity. This is image metadata only.
const verifiedDomains = [{ icao: 'AHY', iata: 'J2', name: 'Azerbaijan Airlines', domain: 'azal.az' }];
/** URL adapter only. Images are served directly from the CDN under its ordinary browser-cache headers. */
export class LogoDevCarrierBrandProvider implements CarrierBrandProvider {
  resolve(carrier: CarrierIdentity, token: string, now: number): CarrierBrand {
    const domain = carrier.domain ?? verifiedDomains.find(entry => entry.icao === carrier.icao && entry.iata === carrier.iata && entry.name.toLowerCase() === carrier.name?.toLowerCase())?.domain;
    const verified = !!carrier.icao && !!carrier.name && !!domain && carrierDomain('https://' + domain) === domain;
    const configured = logoTokenSchema.safeParse(token).success;
    const url = new URL('https://img.logo.dev/' + (domain ?? ''));
    url.search = new URLSearchParams({ token, size: '128', format: 'png', theme: 'dark', fallback: '404' }).toString();
    return carrierBrandSchema.parse({ carrier, source: 'logo-dev', resolvedAt: new Date(now).toISOString(), availability: !configured ? 'not-configured' : verified ? 'ready' : 'unverified', imageUrl: verified && configured ? url.href : null });
  }
}
