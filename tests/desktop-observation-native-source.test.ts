// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error Build/audit script is intentionally JavaScript, outside the shipped app.
import { checkDesktopObserver } from '../scripts/check-desktop-observer.mjs';

it('audits production C++ calls, property vocabulary, protocol, manifest and static runtime', async () => {
  const result = await checkDesktopObserver();
  expect(result.prohibitedCallsFound).toEqual([]); expect(result.callablePatternInterfacesFound).toBe(0);
  expect(result.maximumPropertiesPerVisitedNode).toBeLessThanOrEqual(32);
  expect(result.propertyIds).not.toEqual(expect.arrayContaining(['ValueValue', 'HelpText', 'FullDescription', 'LegacyIAccessibleValue']));
});
it('has Win32 and raw direct-child catalog discovery without title collection or desktop descendants', () => {
  const source = readFileSync('native/desktop-observer/observation.cpp', 'utf8');
  expect(source).toContain('EnumWindows('); expect(source).toContain('GetFirstChildElement(root.Get()');
  expect(source.replace(/\/\/[^\n]*/g, '')).not.toMatch(/GetWindowText|FindAll|TreeScope_Descendants/);
});
it('uses private fixed resource packaging outside ASAR and keeps canonical output policy', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  expect(pkg.build.directories.output).toBe('release');
  expect(pkg.build.extraResources).toContainEqual({ from: 'dist-electron/desktop-observer', to: 'desktop-observer', filter: ['momo-desktop-observer.exe', 'identity.json'] });
  expect(pkg.build.files).toContain('!dist-electron/desktop-observer{,/**/*}');
  expect(readFileSync('scripts/build.mjs', 'utf8')).toContain('__MOMO_DESKTOP_OBSERVER_IDENTITY__');
});
