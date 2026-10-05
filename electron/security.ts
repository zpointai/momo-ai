import path from 'node:path';
import { allowedCarrierImage } from '../src/shared/carrierBranding';
export const appOrigin = 'app://momo';
export const devOrigin = 'http://127.0.0.1:5173';
/** Owner-clicked public attribution/setup pages only; never arbitrary provider URLs or keys. */
export function allowedSituationLink(raw: string): boolean {
  return ['https://www.logo.dev/', 'https://www.logo.dev/signup', 'https://www.logo.dev/pricing', 'https://www.flightaware.com/', 'https://open-meteo.com/', 'https://avioadsb.org/', 'https://avioadsb.org', 'https://creativecommons.org/licenses/by/4.0/', 'https://my.tomtom.com/', 'https://my.tomtom.com', 'https://www.tomtom.com/legal/en_gb/product-attributions/'].includes(raw);
}
export const productionCsp = "default-src 'none'; script-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://tiles.openfreemap.org https://img.logo.dev; font-src 'self'; connect-src 'self' https://tiles.openfreemap.org; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
export interface Sender { sender: { id: number }; senderFrame: { url: string; parent: unknown } | null }
export function isTrustedSender(event: Sender, windowId: number, development: boolean): boolean {
  if (event.sender.id !== windowId || !event.senderFrame || event.senderFrame.parent !== null) return false;
  try {
    const url = new URL(event.senderFrame.url);
    if (url.username || url.password) return false;
    return development ? url.origin === devOrigin : url.protocol === 'app:' && url.hostname === 'momo' && !url.port && url.pathname === '/index.html';
  } catch { return false; }
}
export function allowedRequest(raw: string, development: boolean): boolean {
  try {
    const url = new URL(raw);
    if (url.username || url.password) return false;
    if (url.protocol === 'app:' && url.hostname === 'momo' && !url.port) return true;
    // Only a validated publishable logo URL and anonymous basemap may leave the renderer.
    if (allowedCarrierImage(raw)) return true;
    if(url.protocol==='https:'&&url.hostname==='tiles.openfreemap.org'&&!url.port&&!url.search)return true;
    if(url.protocol==='blob:'&&url.pathname.startsWith('app://momo/'))return true;
    return development && (url.origin === devOrigin || url.origin === 'ws://127.0.0.1:5173');
  } catch { return false; }
}
export function assetPath(raw: string, root: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'app:' || url.hostname !== 'momo' || url.port || url.username || url.password) return null;
    const decoded = decodeURIComponent(url.pathname);
    if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').includes('..')) return null;
    const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\//, '');
    if (relative !== 'index.html' && !/^assets\/[a-zA-Z0-9_.-]+\.(js|css|woff2|png|svg)$/.test(relative) && !/^fonts\/[a-zA-Z0-9_.-]+\.ttf$/.test(relative) && !/^brand\/momo-app-amber\.(png|svg|ico)$/.test(relative) && !/^brand\/mo\/mo-(portrait|welcome|rig-(body|head|left-arm|right-arm|left-eye|right-eye|mouth|happy-left|happy-right|happy-mouth))\.png$/.test(relative)) return null;
    const resolved = path.resolve(root, relative);
    return resolved.startsWith(path.resolve(root) + path.sep) ? resolved : null;
  } catch { return null; }
}
