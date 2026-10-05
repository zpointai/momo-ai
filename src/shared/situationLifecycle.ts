import type { SituationConfig } from './situation';

export const placeRoutes = (config: SituationConfig, id: string) => config.routes.filter(r => r.originId === id || r.destinationId === id);
export const canonicalZone = (zone: string) => new Intl.DateTimeFormat('en', { timeZone: zone }).resolvedOptions().timeZone;

/** Mutation validation only: existing files remain readable, including older duplicate clocks. */
export function configurationIssue(next: SituationConfig, previous: SituationConfig): string | null {
  for (const zone of next.timezones) {
    const old = previous.timezones.find(z => z.id === zone.id);
    if (old?.timezone === zone.timezone) continue;
    if (next.timezones.some(z => z.id !== zone.id && canonicalZone(z.timezone) === canonicalZone(zone.timezone))) return 'This time zone already has a clock. Edit the existing clock instead.';
  }
  for (const flight of next.trackedFlights) {
    const old = previous.trackedFlights.find(f => f.id === flight.id);
    if (old?.kind === flight.kind && old.identifier === flight.identifier) continue;
    if (next.trackedFlights.some(f => f.id !== flight.id && f.kind === flight.kind && f.identifier === flight.identifier)) return 'This flight is already tracked.';
  }
  return null;
}
