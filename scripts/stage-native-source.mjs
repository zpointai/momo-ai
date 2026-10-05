import { copyFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from './native-toolchain.mjs';

// Ship the complete project helper sources and their standalone build recipes.
export async function stageNativeSource() {
  const destination = path.join(root, 'dist-electron', 'native-source');
  const files = ['LICENSE', 'scripts/native-toolchain.mjs', 'scripts/setup-native-toolchain.mjs', 'scripts/build-desktop-observer.mjs', 'scripts/build-relay-setup.mjs'];
  for (const directory of ['native/desktop-observer', 'native/relay-setup']) {
    for (const file of await readdir(path.join(root, directory))) files.push(directory + '/' + file);
  }
  for (const file of files) { await mkdir(path.dirname(path.join(destination, file)), { recursive: true }); await copyFile(path.join(root, file), path.join(destination, file)); }
  await writeFile(path.join(destination, 'README.txt'), 'MoMo native helpers: complete MIT project source and build recipes.\nRequires Windows 10/11 x64 and Node.js 24+. No npm dependencies or Visual Studio installation are needed for these two helpers.\nFrom this directory run:\n  node scripts/setup-native-toolchain.mjs\n  node scripts/build-desktop-observer.mjs\n  node scripts/build-relay-setup.mjs\nThe setup step downloads and verifies the pinned LLVM-MinGW release into this directory.\nOutputs and identity manifests are under dist-electron. The desktop pins helper hashes for security; to use modified helpers with MoMo, rebuild the full application from its MIT source so that its embedded expected identities are refreshed.\nNo restriction is imposed on modifying, relinking or debugging these sources or the accompanying LGPL API declarations.\n');
}
