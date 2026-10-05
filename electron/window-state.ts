import { readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { BrowserWindow, Display } from 'electron';
const boundsSchema = z.object({ x: z.number().int(), y: z.number().int(), width: z.number().int().min(980).max(10000), height: z.number().int().min(620).max(10000), maximized: z.boolean() }).strict();
export function restoreWindow(filename: string, displays: Display[]) {
  try {
    const saved = boundsSchema.parse(JSON.parse(readFileSync(filename, 'utf8')));
    const visible = displays.some(({ workArea: area }) => saved.x + 100 > area.x && saved.x < area.x + area.width - 100 && saved.y >= area.y && saved.y < area.y + area.height - 100);
    if (visible) return saved;
  } catch { /* Missing or invalid geometry uses the centered default. */ }
  return { width: 1366, height: 850, maximized: false };
}
export function rememberWindow(window: BrowserWindow, filename: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const save = () => {
    if (window.isDestroyed() || window.isMinimized()) return;
    try {
      const value = boundsSchema.parse({ ...window.getNormalBounds(), maximized: window.isMaximized() });
      mkdirSync(path.dirname(filename), { recursive: true });
      writeFileSync(filename + '.tmp', JSON.stringify(value)); renameSync(filename + '.tmp', filename);
    } catch { /* Geometry is optional; never prevent closing the application. */ }
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(save, 400); };
  window.on('resize', schedule); window.on('move', schedule);
  window.on('close', () => { clearTimeout(timer); save(); });
}

