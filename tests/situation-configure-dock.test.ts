// Synthetic fixtures only; addresses, identities, accounts and content are not user data.
// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { situationFitsDock } from '../src/desktop/situation/useConfigureDock';

afterEach(() => { document.body.replaceChildren(); });
function layout() {
  const page = document.createElement('main'), workspace = document.createElement('div');
  workspace.className = 'situation-workspace'; page.append(workspace); document.body.append(page);
  page.style.flex = '1 1 0px'; workspace.scrollTop = 37; workspace.scrollLeft = 8;
  // A layout-engine boundary: wrapping at the proposed width increases actual content height.
  let availableHeight = 1000, contentHeight = 920;
  Object.defineProperties(workspace, {
    clientHeight: { get: () => availableHeight }, clientWidth: { get: () => Number.parseFloat(page.style.flexBasis) },
    scrollHeight: { get: () => contentHeight + (Number.parseFloat(page.style.flexBasis) < 1500 ? 120 : 0) },
    scrollWidth: { get: () => workspace.clientWidth },
  });
  return { page, workspace, height: (n: number) => { availableHeight = n; }, content: (n: number) => { contentHeight = n; } };
}
it('admits the same layout only when the measured remaining width and height fit, including content changes', () => {
  const f = layout();
  expect(situationFitsDock(f.page, 1900)).toBe(true);
  expect(situationFitsDock(f.page, 1350)).toBe(false);
  f.height(860); expect(situationFitsDock(f.page, 1900)).toBe(false);
  f.height(1100); expect(situationFitsDock(f.page, 1350)).toBe(true);
  f.content(1120); expect(situationFitsDock(f.page, 1900)).toBe(false);
});
it('restores the original flex geometry and scroll position synchronously without replacing content', () => {
  const f = layout(), input = document.createElement('input'); f.workspace.append(input); input.value = 'Unsent'; input.focus();
  for (const width of [1900, 1350, 720, 1900]) situationFitsDock(f.page, width);
  expect(f.page.style.flex).toBe('1 1 0px'); expect(f.workspace.scrollTop).toBe(37); expect(f.workspace.scrollLeft).toBe(8);
  expect(f.page.firstElementChild).toBe(f.workspace); expect(document.activeElement).toBe(input); expect(input.value).toBe('Unsent');
});
it('uses the overlay conservatively when the Situation content is not yet measurable', () => {
  const f = layout(); f.height(0); expect(situationFitsDock(f.page, 1900)).toBe(false);
  expect(situationFitsDock(document.createElement('main'), 1900)).toBe(false);
});
