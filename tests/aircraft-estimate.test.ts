// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { aircraftDisplayPosition, aircraftEstimateHorizonMs, canEstimateAircraft } from '../src/shared/aircraftEstimate';
import { animateAircraftEstimate } from '../src/desktop/situation/aircraftMotion';
import type { AircraftPosition, SituationSnapshot } from '../src/shared/situation';
const epoch = Date.parse('2026-09-29T09:00:00Z');
const aircraft: AircraftPosition = { icao: '', flightAwareId: 'test-flight', trackedId: 'tracked', callsign: null, registration: null, position: { latitude: 0, longitude: 0 }, observedAt: new Date(epoch).toISOString(), groundSpeedKnots: 360, headingDegrees: 90, altitudeFeet: 36000, origin: null, destination: null };
const state = () => ({ config: { flightsEnabled: true }, reviewBlocked: false, flightAware: { credential: 'configured', result: { flights: [{ id: 'test-flight', status: 'En Route / On Time', cancelled: false, actualOn: null, actualIn: null }] }, position: { flightId: 'test-flight', position: { projected: false } } } }) as SituationSnapshot;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('uses the supplied speed and true heading on a sphere, without changing the observation', () => {
  const before = structuredClone(aircraft), value = aircraftDisplayPosition(aircraft, epoch + 60000, true);
  expect(value.mode).toBe('estimated'); expect(value.point[0]).toBeCloseTo(0.09993, 4); expect(value.point[1]).toBeCloseTo(0, 8); expect(aircraft).toEqual(before);
  const north = aircraftDisplayPosition({ ...aircraft, headingDegrees: 0 }, epoch + 60000, true); expect(north.point[0]).toBeCloseTo(0, 8); expect(north.point[1]).toBeCloseTo(0.09993, 4);
  const crossing = aircraftDisplayPosition({ ...aircraft, position: { longitude: 179.99, latitude: 0 } }, epoch + 60000, true); expect(crossing.point[0]).toBeLessThan(-179);
});
it('freezes at the five-minute horizon and rejects missing, implausible or future motion data', () => {
  const end = aircraftDisplayPosition(aircraft, epoch + aircraftEstimateHorizonMs, true);
  expect(end.mode).toBe('paused'); expect(aircraftDisplayPosition(aircraft, epoch + 800000, true)).toEqual(end);
  for (const patch of [{ groundSpeedKnots: null }, { groundSpeedKnots: 0 }, { groundSpeedKnots: Infinity }, { groundSpeedKnots: 1500 }, { headingDegrees: null }, { headingDegrees: -1 }, { observedAt: 'bad-date' }, { observedAt: new Date(epoch + 120000).toISOString() }]) expect(aircraftDisplayPosition({ ...aircraft, ...patch }, epoch + 60000, true)).toEqual({ point: [0, 0], mode: 'reported' });
  expect(aircraftDisplayPosition(aircraft, epoch + 60000, false).point).toEqual([0, 0]);
});
it('requires a matching airborne instance and never extrapolates projected, landed, blocked or disabled data', () => {
  expect(canEstimateAircraft(state(), aircraft)).toBe(true);
  for (const reason of ['landed', 'taxi', 'cancelled', 'projected', 'identity', 'disabled', 'blocked', 'error']) {
    const snapshot = state(), fa = snapshot.flightAware!;
    if (reason === 'landed') fa.result!.flights[0].status = 'Landed';
    if (reason === 'taxi') fa.result!.flights[0].status = 'Taxiing / Left Gate';
    if (reason === 'cancelled') fa.result!.flights[0].cancelled = true;
    if (reason === 'projected') fa.position!.position!.projected = true;
    if (reason === 'identity') fa.position!.flightId = 'other-flight';
    if (reason === 'disabled') snapshot.config.flightsEnabled = false;
    if (reason === 'blocked') snapshot.reviewBlocked = true;
    if (reason === 'error') fa.positionError = 'Unavailable';
    expect(canEstimateAircraft(snapshot, aircraft)).toBe(false);
  }
});
it('moves on animation frames, pauses when hidden, resumes without querying, and cancels cleanly', () => {
  let now = epoch + 30000, hidden = false, callback: FrameRequestCallback | undefined;
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  const request = vi.fn((fn: FrameRequestCallback) => { callback = fn; return 7; }), cancel = vi.fn(), update = vi.fn();
  vi.stubGlobal('requestAnimationFrame', request); vi.stubGlobal('cancelAnimationFrame', cancel);
  const stop = animateAircraftEstimate(aircraft, update, { enabled: true, reducedMotion: false, clock: () => now });
  const first = update.mock.calls.at(-1)![0].point[0]; now += 1000; callback!(1); expect(update.mock.calls.at(-1)![0].point[0]).toBeGreaterThan(first);
  hidden = true; document.dispatchEvent(new Event('visibilitychange')); expect(cancel).toHaveBeenCalledWith(7);
  const calls = request.mock.calls.length; now += 1000; hidden = false; document.dispatchEvent(new Event('visibilitychange')); expect(request.mock.calls.length).toBeGreaterThan(calls);
  now = epoch + aircraftEstimateHorizonMs; const requests = request.mock.calls.length; callback!(1); expect(update.mock.calls.at(-1)![0].mode).toBe('paused'); expect(request.mock.calls.length).toBe(requests);
  stop(); const count = update.mock.calls.length; document.dispatchEvent(new Event('visibilitychange')); expect(update.mock.calls.length).toBe(count);
});
it('keeps reduced-motion output at the reported point without a frame loop', () => {
  const request = vi.fn(), update = vi.fn(); vi.stubGlobal('requestAnimationFrame', request); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const stop = animateAircraftEstimate(aircraft, update, { enabled: true, reducedMotion: true, prior: [1, 1], clock: () => epoch + 60000 });
  expect(update).toHaveBeenCalledExactlyOnceWith({ point: [0, 0], mode: 'reported' }); expect(request).not.toHaveBeenCalled(); stop();
});
it('also respects the operating-system reduced-motion preference and releases its listener', () => {
  const media = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  vi.stubGlobal('matchMedia', vi.fn(() => media)); vi.stubGlobal('requestAnimationFrame', vi.fn()); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const update = vi.fn(), stop = animateAircraftEstimate(aircraft, update, { enabled: true, reducedMotion: false, clock: () => epoch + 60000 });
  expect(update).toHaveBeenCalledExactlyOnceWith({ point: [0, 0], mode: 'reported' }); expect(requestAnimationFrame).not.toHaveBeenCalled(); stop();
  expect(media.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
});
