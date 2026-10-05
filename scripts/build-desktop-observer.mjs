import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function buildDesktopObserver() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Desktop Observer requires the existing Windows x64 MSVC v142 toolchain and SDK 10.0.19041.0; no tooling is installed automatically.');
  const vswhere = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (!existsSync(vswhere)) throw new Error('Missing Visual Studio Installer vswhere.exe. Install/configure MSVC v142 x64 and Windows SDK 10.0.19041.0 explicitly.');
  const located = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { shell: false, windowsHide: true, encoding: 'utf8' });
  const installation = located.stdout?.trim();
  const msbuild = installation && path.join(installation, 'MSBuild', 'Current', 'Bin', 'MSBuild.exe');
  if (located.status !== 0 || !msbuild || !path.isAbsolute(msbuild) || !existsSync(msbuild)) throw new Error('A usable Visual Studio C++ MSBuild installation was not found. No fallback or installation was attempted.');
  const inputs = ['desktop-observer.vcxproj', 'observer.manifest', 'protocol.h', 'observation.h', 'observation.cpp', 'main.cpp'];
  const digest = createHash('sha256');
  for (const name of inputs) { digest.update(name); digest.update(await readFile(path.join(root, 'native', 'desktop-observer', name))); }
  const buildId = digest.digest('hex');
  const result = spawnSync(msbuild, [path.join(root, 'native', 'desktop-observer', 'desktop-observer.vcxproj'), '/nologo', '/v:minimal', '/p:Configuration=Release', '/p:Platform=x64', `/p:ObserverBuildId=${buildId}`], { cwd: root, shell: false, windowsHide: true, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Desktop Observer native build failed. Required: MSVC v142 x64, Windows SDK 10.0.19041.0 with UIAutomation/Win32 libraries.');
  const directory = path.join(root, 'dist-electron', 'desktop-observer');
  const binary = await readFile(path.join(directory, 'momo-desktop-observer.exe'));
  const pe = binary.readUInt32LE(0x3c);
  if (binary.toString('ascii', 0, 2) !== 'MZ' || binary.readUInt32LE(pe) !== 0x4550 || binary.readUInt16LE(pe + 4) !== 0x8664) throw new Error('Desktop Observer output is not an AMD64 Windows PE executable.');
  const identity = { protocol: 1, helperVersion: '0.1.0', buildId, sha256: createHash('sha256').update(binary).digest('hex'), architecture: 'x64', runtime: 'static-msvc', bytes: binary.length };
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'identity.json'), JSON.stringify(identity, null, 2) + '\n');
  return identity;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildDesktopObserver(); console.log('Desktop Observer x64 static-runtime build and identity manifest completed.');
}
