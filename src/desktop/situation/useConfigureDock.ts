import { useLayoutEffect, useState, type RefObject } from 'react';

/** Measure the existing container rules at the proposed dock width, before paint.
 * Restore immediately: no cloned workspace, map recreation or visible probe frame.
 */
export function situationFitsDock(page: HTMLElement, availableWidth: number): boolean {
  const workspace = page.querySelector<HTMLElement>('.situation-workspace');
  if (!workspace || availableWidth <= 0 || workspace.clientHeight === 0) return false;
  const previous = page.style.flex, scrollTop = workspace.scrollTop, scrollLeft = workspace.scrollLeft;
  try {
    page.style.flex = `0 0 ${availableWidth}px`;
    return workspace.scrollHeight <= workspace.clientHeight + 1 && workspace.scrollWidth <= workspace.clientWidth + 1;
  } finally {
    page.style.flex = previous;
    workspace.scrollTop = scrollTop; workspace.scrollLeft = scrollLeft;
  }
}

export function useConfigureDock(split: RefObject<HTMLDivElement | null>, active: boolean, paneWidth: number) {
  const [fits, setFits] = useState(false);
  useLayoutEffect(() => {
    const host = split.current, page = host?.querySelector<HTMLElement>('.page');
    if (!active || !host || !page) return;
    const measure = () => {
      const divider = host.querySelector<HTMLElement>('.assistant-divider');
      const dividerWidth = divider ? Number.parseFloat(getComputedStyle(divider).width) : 0;
      setFits(situationFitsDock(page, host.clientWidth - paneWidth - dividerWidth));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    // Content, fonts, height, sidebar and dock resizing can all change admission.
    page.querySelectorAll('.situation-workspace,.situation-heading,.situation-board,.situation-card,.situation-workspace>footer').forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, [split, active, paneWidth]);
  return fits;
}
