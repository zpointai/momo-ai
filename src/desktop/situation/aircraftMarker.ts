import type { AircraftPosition } from '../../shared/situation';
import { aircraftMetrics, aircraftIdentity } from '../../shared/flightTracking';

/** A north-facing vector, rotated by true track; independent from map label orientation. */
export function aircraftMarker(aircraft: AircraftPosition, label: string, selected: boolean, choose: () => void, positionStatus = 'Live position') {
  const button = document.createElement('button');
  button.className = 'situation-aircraft-marker' + (selected ? ' selected' : '') + (aircraft.trackedId ? ' tracked' : '');
  button.dataset.aircraft = aircraftIdentity(aircraft);
  if (positionStatus !== 'Live position') button.classList.add('is-last-known');
  button.setAttribute('aria-label', 'Flight details for ' + label);
  button.setAttribute('aria-pressed', String(selected));
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
  icon.style.transform = `rotate(${aircraft.headingDegrees ?? 0}deg)`;
  const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  shape.setAttribute('d', 'M12 1.5 14 9 21.5 13.5 21.5 16 14 13.5 14 19.5 17 21.5 17 23 12 21 7 23 7 21.5 10 19.5 10 13.5 2.5 16 2.5 13.5 10 9Z');
  icon.append(shape); button.append(icon); button.onclick = choose;
  const callout = document.createElement('span'); callout.className = 'situation-aircraft-callout';
  const title = document.createElement('strong'); title.textContent = label; callout.append(title);
  const metrics = aircraftMetrics(aircraft).slice(0, 2).filter(m => m.value !== null).map(m => m.value).join(' · ');
  if (metrics) { const line = document.createElement('small'); line.textContent = metrics; callout.append(line); }
  if (aircraft.callsign && aircraft.callsign !== label) { const line = document.createElement('small'); line.textContent = aircraft.callsign; callout.append(line); }
  const status = document.createElement('small'); status.className = 'situation-aircraft-position-status'; status.textContent = positionStatus; callout.append(status);
  button.append(callout);
  return button;
}
