import { rm } from 'node:fs/promises';
import path from 'node:path';
const root = process.cwd();
// The canonical owner package is replaced explicitly by packaging, not dev cleanup.
for (const name of ['dist','dist-electron','test-results']) {
  const target = path.resolve(root, name);
  if (!target.startsWith(root + path.sep) || path.dirname(target) !== root) throw new Error('Unsafe cleanup path');
  await rm(target, { recursive: true, force: true });
}
