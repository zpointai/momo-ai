import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { root, buildNative } from './native-toolchain.mjs';

export async function buildRelaySetup() {
  const result = await buildNative({ name: 'relay-setup', sources: ['native/relay-setup/main.cpp'], manifest: 'native/relay-setup/setup.manifest', resource: 'native/relay-setup/setup.rc', gui: true, libraries: ['user32', 'shell32'] });
  const identity = { sha256: result.sha256, bytes: result.bytes };
  await writeFile(path.join(root, 'dist-electron/relay-setup/identity.json'), JSON.stringify(identity, null, 2) + '\n');
  return identity;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildRelaySetup(); console.log('Relay native secure setup LLVM-MinGW build completed.');
}
