import type { SituationLocation, SituationSnapshot } from '../../shared/situation';
export interface PlaceLabel { place: SituationLocation; nearby: SituationLocation[]; selected: boolean; role: 'origin' | 'destination' | null; }
/** Visual grouping only: keep each saved identity, and never claim a nearby locality is an address. */
export function mapPlaceLabels(snapshot: SituationSnapshot, project: (p: SituationLocation) => { x: number; y: number }): PlaceLabel[] {
  const route = snapshot.config.routes.find(r => r.id === snapshot.selectedRouteId);
  const labels: PlaceLabel[] = snapshot.config.locations.map(place => ({ place, nearby: [], selected: place.id === snapshot.selectedLocationId, role: place.id === route?.originId ? 'origin' : place.id === route?.destinationId ? 'destination' : null }));
  const removed = new Set<string>();
  for (const locality of labels.filter(v => !v.role && v.place.locality && !v.place.purpose)) {
    const a = project(locality.place);
    const endpoint = labels.filter(v => v.role && v.place.purpose).find(v => {
      const b = project(v.place), km = Math.hypot((v.place.latitude - locality.place.latitude) * 111, (v.place.longitude - locality.place.longitude) * 111 * Math.cos(locality.place.latitude * Math.PI / 180));
      return km < 2 && Math.abs(a.x - b.x) < 180 && Math.abs(a.y - b.y) < 70;
    });
    if (endpoint) { endpoint.nearby.push(locality.place); endpoint.selected ||= locality.selected; removed.add(locality.place.id); }
  }
  return labels.filter(v => !removed.has(v.place.id)).sort((a, b) => Number(b.selected) - Number(a.selected) || Number(!!b.role) - Number(!!a.role));
}
