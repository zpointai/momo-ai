import type { AircraftPosition } from '../../shared/situation';
import { aircraftDisplayPosition, type AircraftDisplayPosition, type AircraftPoint as Point } from '../../shared/aircraftEstimate';
/** Animate between two supplied observations only; never extrapolate a future position. */
export function aircraftMotion(from: Point, to: Point, progress: number): Point {
  const t = Math.max(0, Math.min(1, progress));
  const longitude = ((to[0] - from[0] + 540) % 360) - 180;
  return [((from[0] + longitude * t + 540) % 360) - 180, from[1] + (to[1] - from[1]) * t];
}
export function animateAircraft(from: Point, to: Point, update: (point: Point) => void, reducedMotion: boolean): () => void {
  if (reducedMotion || from.every((n, i) => n === to[i])) { update(to); return () => undefined; }
  const start = performance.now(); let frame = 0;
  const tick = (now: number) => { const progress = Math.min(1, (now - start) / 1000); update(aircraftMotion(from, to, progress)); if (progress < 1) frame = requestAnimationFrame(tick); };
  update(from); frame = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(frame);
}

/** Continue along reported speed/heading only within the bounded, visibly estimated horizon. */
export function animateAircraftEstimate(aircraft: AircraftPosition, update: (position: AircraftDisplayPosition) => void,
  options: { enabled: boolean; reducedMotion: boolean; prior?: Point; clock?: () => number }) {
  const clock = options.clock ?? Date.now, start = performance.now();
  const preference = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  let frame = 0, cancelled = false;
  const render = () => {
    const reducedMotion = options.reducedMotion || preference?.matches === true;
    const value = aircraftDisplayPosition(aircraft, clock(), options.enabled && !reducedMotion);
    const progress = Math.min(1, (performance.now() - start) / 1200);
    const point = options.prior && !reducedMotion && progress < 1 ? aircraftMotion(options.prior, value.point, progress) : value.point;
    update({ ...value, point });
    if (!cancelled && !document.hidden && !reducedMotion && (value.mode === 'estimated' || !!options.prior && progress < 1)) frame = requestAnimationFrame(render);
  };
  const visibility = () => { cancelAnimationFrame(frame); if (!document.hidden && !cancelled) render(); };
  document.addEventListener('visibilitychange', visibility);
  preference?.addEventListener('change', visibility);
  render();
  return () => { cancelled = true; cancelAnimationFrame(frame); document.removeEventListener('visibilitychange', visibility); preference?.removeEventListener('change', visibility); };
}
