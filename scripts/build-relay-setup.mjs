import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function buildRelaySetup() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Relay secure setup requires the existing Windows x64 MSVC toolchain.');
  const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!existsSync(vswhere)) throw new Error('The existing Visual Studio C++ toolchain is unavailable.');
  const located = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { shell: false, windowsHide: true, encoding: 'utf8' });
  const installation = located.stdout?.trim();
  const msbuild = installation && path.join(installation, 'MSBuild', 'Current', 'Bin', 'MSBuild.exe');
  if (located.status !== 0 || !msbuild || !path.isAbsolute(msbuild) || !existsSync(msbuild)) throw new Error('A usable Visual Studio C++ MSBuild installation was not found.');
  const result = spawnSync(msbuild, [path.join(root, 'native', 'relay-setup', 'relay-setup.vcxproj'), '/nologo', '/v:minimal', '/p:Configuration=Release', '/p:Platform=x64'], { cwd: root, shell: false, windowsHide: true, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Relay native secure setup build failed.');
  const directory = path.join(root, 'dist-electron', 'relay-setup');
  const binary = await readFile(path.join(directory, 'momo-relay-setup.exe'));
  const pe = binary.readUInt32LE(0x3c);
  if (binary.toString('ascii', 0, 2) !== 'MZ' || binary.readUInt32LE(pe) !== 0x4550 || binary.readUInt16LE(pe + 4) !== 0x8664) throw new Error('Relay secure setup output is not an AMD64 Windows executable.');
  const identity = { sha256: createHash('sha256').update(binary).digest('hex'), bytes: binary.length };
  await writeFile(path.join(directory, 'identity.json'), JSON.stringify(identity, null, 2) + '\n');
  return identity;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildRelaySetup(); console.log('Relay native secure setup build completed.');
}
