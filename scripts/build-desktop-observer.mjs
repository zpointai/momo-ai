import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { root, buildNative, toolchain } from './native-toolchain.mjs';

export async function buildDesktopObserver() {
  const inputs = ['observer.manifest', 'protocol.h', 'observation.h', 'observation.cpp', 'main.cpp'].map(name => 'native/desktop-observer/' + name);
  inputs.push('scripts/build-desktop-observer.mjs', 'scripts/native-toolchain.mjs');
  const digest = createHash('sha256').update(JSON.stringify(toolchain));
  for (const name of inputs) { digest.update(name); digest.update(await readFile(path.join(root, name))); }
  const buildId = digest.digest('hex');
  const result = await buildNative({ name: 'desktop-observer', sources: ['native/desktop-observer/main.cpp', 'native/desktop-observer/observation.cpp'], manifest: 'native/desktop-observer/observer.manifest', defines: [`-DOBSERVER_BUILD_ID="${buildId}"`], libraries: ['ole32', 'oleaut32', 'uiautomationcore', 'user32', 'dwmapi', 'advapi32', 'uuid'] });
  const identity = { protocol: 1, helperVersion: '0.1.0', buildId, sha256: result.sha256, architecture: result.architecture, runtime: result.runtime, bytes: result.bytes };
  await writeFile(path.join(root, 'dist-electron/desktop-observer/identity.json'), JSON.stringify(identity, null, 2) + '\n');
  return identity;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildDesktopObserver(); console.log('Desktop Observer LLVM-MinGW build and identity manifest completed.');
}
