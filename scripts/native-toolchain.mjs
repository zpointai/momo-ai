import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const toolchain = Object.freeze({ release: '20260922', clang: '23.1.2', name: 'llvm-mingw-20260922-ucrt-x86_64', sha256: 'e3ad77d117a4bea19a7a3b333341824d79a5a371004a10e25b8504e7b3047666' });
export const toolchainDirectory = path.join(root, '.release-local', 'toolchains', toolchain.name);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// Deliberately exclude ambient compiler flags, SDK/library paths and developer settings.
export function runNative(tool, args) {
  const executable = path.join(toolchainDirectory, 'bin', tool + '.exe');
  if (process.platform !== 'win32' || process.arch !== 'x64' || !existsSync(executable)) throw new Error('Run npm run setup:native on Windows x64 first.');
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(SystemRoot|SystemDrive|WINDIR|COMSPEC|TEMP|TMP|NUMBER_OF_PROCESSORS)$/i.test(key)));
  env.PATH = path.join(toolchainDirectory, 'bin') + path.delimiter + path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const result = spawnSync(executable, args, { cwd: root, env, shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${tool} failed: ${result.error?.message ?? ''}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  return result.stdout;
}

export async function inspectNative(binaryPath, manifestPath) {
  const binary = await readFile(binaryPath), pe = binary.readUInt32LE(0x3c);
  if (binary.toString('ascii', 0, 2) !== 'MZ' || binary.readUInt32LE(pe) !== 0x4550 || binary.readUInt16LE(pe + 4) !== 0x8664) throw new Error('Native output is not an AMD64 Windows PE executable.');
  const report = runNative('llvm-readobj', ['--coff-imports', '--coff-load-config', '--file-headers', '--coff-resources', binaryPath]);
  const dependencies = [...new Set([...report.matchAll(/^  Name: (\S+\.dll)$/gmi)].map(match => match[1]))];
  const allowed = /^(?:(?:KERNEL32|USER32|SHELL32|ole32|OLEAUT32|ADVAPI32|dwmapi|UIAutomationCore)\.dll|api-ms-win-crt-[\w-]+\.dll)$/i;
  if (!dependencies.length || dependencies.some(name => !allowed.test(name))) throw new Error('Unexpected native dependency: ' + dependencies.join(', '));
  for (const flag of ['IMAGE_DLL_CHARACTERISTICS_DYNAMIC_BASE', 'IMAGE_DLL_CHARACTERISTICS_NX_COMPAT', 'IMAGE_DLL_CHARACTERISTICS_HIGH_ENTROPY_VA', 'CF_INSTRUMENTED']) {
    if (!report.includes(flag)) throw new Error('Missing native hardening: ' + flag);
  }
  const table = pe + 24 + binary.readUInt16LE(pe + 20);
  let resource;
  for (let i = 0; i < binary.readUInt16LE(pe + 6); i++) {
    const section = table + i * 40;
    if (binary.toString('ascii', section, section + 8).replace(/\0/g, '') === '.rsrc') resource = binary.subarray(binary.readUInt32LE(section + 20), binary.readUInt32LE(section + 20) + binary.readUInt32LE(section + 16));
  }
  const manifest = await readFile(manifestPath);
  if (!resource?.includes(manifest) || !manifest.toString().includes('level="asInvoker" uiAccess="false"')) throw new Error('Native embedded privilege manifest mismatch.');
  return { dependencies, architecture: 'x64', runtime: 'static-llvm-mingw-ucrt', sha256: sha256(binary), bytes: binary.length, embeddedManifest: { level: 'asInvoker', uiAccess: false }, hardening: ['ASLR', 'DEP', 'high-entropy VA', 'CFG'] };
}

export async function buildNative({ name, sources, manifest, resource, defines = [], libraries, gui = false }) {
  if (!runNative('x86_64-w64-mingw32-clang++', ['--version']).includes('clang version ' + toolchain.clang)) throw new Error('Native compiler version differs from the pinned release.');
  const directory = path.join(root, '.release-local', 'native-build', name), output = path.join(root, 'dist-electron', name);
  await mkdir(directory, { recursive: true }); await mkdir(output, { recursive: true });
  const rc = path.join(directory, 'resources.rc'), res = path.join(directory, 'resources.o');
  await writeFile(rc, `${resource ? '#include "' + resource + '"\n' : ''}1 24 "${manifest}"\n`);
  runNative('x86_64-w64-mingw32-windres', ['-I', root, '-I', path.dirname(path.join(root, manifest)), '-i', rc, '-o', res]);
  const next = path.join(directory, `momo-${name}.exe`);
  runNative('x86_64-w64-mingw32-clang++', ['-std=c++17', '-O2', '-DNDEBUG', '-DUNICODE', '-D_UNICODE', '-DWIN32_LEAN_AND_MEAN', '-DNOMINMAX',
    '-Wall', '-Wextra', '-Werror', '-Wno-missing-field-initializers', '-fstack-protector-strong', '-mguard=cf', '-static',
    `-ffile-prefix-map=${root}=.`, '-Wl,--dynamicbase,--nxcompat,--high-entropy-va,--no-insert-timestamp,--strip-debug',
    '-Wl,-Map,' + path.join(directory, 'link.map'), ...defines, ...(gui ? ['-municode', '-mwindows'] : []), ...sources, res, ...libraries.map(lib => '-l' + lib), '-o', next]);
  const inspection = await inspectNative(next, path.join(root, manifest));
  await writeFile(path.join(directory, 'inspection.json'), JSON.stringify({ toolchain, ...inspection }, null, 2) + '\n');
  await rename(next, path.join(output, `momo-${name}.exe`));
  return inspection;
}
