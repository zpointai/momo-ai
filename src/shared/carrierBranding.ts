import { z } from 'zod';

export const carrierIdentitySchema = z.object({
  icao: z.string().regex(/^[A-Z]{3}$/).nullable(), iata: z.string().regex(/^[A-Z0-9]{2}$/).nullable(),
  name: z.string().max(160).nullable(), callsign: z.string().max(160).nullable(), domain: z.string().max(253).nullable(),
}).strict();
export type CarrierIdentity = z.infer<typeof carrierIdentitySchema>;
export const logoTokenSchema = z.string().regex(/^pk_[A-Za-z0-9_-]{8,180}$/, 'Use the Logo.dev publishable key beginning pk_.');
export const carrierBrandSchema = z.object({
  carrier: carrierIdentitySchema, source: z.enum(['logo-dev', 'none']), resolvedAt: z.string().datetime(),
  availability: z.enum(['ready', 'disabled', 'not-configured', 'unverified', 'unavailable']), imageUrl: z.string().max(1024).nullable(),
}).strict();
export type CarrierBrand = z.infer<typeof carrierBrandSchema>;
export const carrierBrandStateSchema = z.object({ credential: z.enum(['missing', 'configured', 'error']), brands: z.array(carrierBrandSchema).max(8) }).strict();
/** Normalize the exact operator website, including a bare hostname. Never guess from a name. */
export function carrierDomain(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  try {
    const value = raw.trim();
    const url = new URL(/^[a-z0-9.-]+\.[a-z]{2,63}(?:\/[^\s]*)?$/i.test(value) ? 'https://' + value : value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) || /(?:^|\.)(?:localhost|local|invalid|test|example|facebook\.com|instagram\.com|wikipedia\.org|twitter\.com|x\.com)$/.test(host)) return null;
    return host;
  } catch { return null; }
}
export function allowedCarrierImage(raw: string): boolean {
  try {
    const url = new URL(raw), domain = url.pathname.slice(1);
    return url.protocol === 'https:' && url.hostname === 'img.logo.dev' && !url.port && !url.username && !url.password && !url.hash
      && carrierDomain('https://' + domain) === domain && logoTokenSchema.safeParse(url.searchParams.get('token')).success
      && url.searchParams.get('size') === '128' && url.searchParams.get('format') === 'png' && url.searchParams.get('theme') === 'dark' && url.searchParams.get('fallback') === '404'
      && [...url.searchParams.keys()].length === 5;
  } catch { return false; }
}
