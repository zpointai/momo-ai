import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { root, toolchain, runNative } from './native-toolchain.mjs';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('The pinned native toolchain requires Windows x64.');
const directory = path.join(root, '.release-local', 'toolchains');
await mkdir(directory, { recursive: true });
const archive = path.join(directory, toolchain.name + '.zip');
if (!existsSync(archive)) {
  const response = await fetch(`https://github.com/mstorsjo/llvm-mingw/releases/download/${toolchain.release}/${toolchain.name}.zip`);
  if (!response.ok || !response.body) throw new Error('Native toolchain download failed: ' + response.status);
  await pipeline(response.body, createWriteStream(archive + '.download'));
  await rename(archive + '.download', archive);
}
const digest = createHash('sha256');
for await (const chunk of createReadStream(archive)) digest.update(chunk);
if (digest.digest('hex') !== toolchain.sha256) throw new Error('Native toolchain archive checksum mismatch; nothing was extracted.');
const result = spawnSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', archive, '-C', directory], { shell: false, windowsHide: true, stdio: 'inherit' });
if (result.status !== 0) throw new Error('Native toolchain extraction failed.');
console.log(runNative('x86_64-w64-mingw32-clang++', ['--version']).split('\n')[0]);
console.log('Checksum-verified LLVM-MinGW is ready inside .release-local/toolchains. No system installation or PATH change.');
