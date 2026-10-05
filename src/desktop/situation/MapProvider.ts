/** Map rendering is independent of native weather/routing/aircraft adapters. */
export interface MapProvider {
  id: string;
  name: string;
  style: string;
  attribution: string;
  satellite: boolean;
  requestAllowed(url: string): boolean;
}
export const openFreeMap: MapProvider = {
  id: 'openfreemap', name: 'OpenFreeMap', style: 'https://tiles.openfreemap.org/styles/dark',
  attribution: 'OpenFreeMap · © OpenMapTiles · © OpenStreetMap contributors', satellite: false,
  requestAllowed(raw) { try { const u = new URL(raw); return u.protocol === 'https:' && u.hostname === 'tiles.openfreemap.org' && !u.port && !u.username && !u.password && !u.search; } catch { return false; } },
};
