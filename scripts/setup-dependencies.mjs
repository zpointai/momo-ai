import { spawnSync } from 'node:child_process';
// Only these reviewed binary installers are needed. SQLite 13 ships Node-API
// prebuilds and must not be replaced by npm's implicit binding.gyp fallback.
for (const script of ['node_modules/electron/install.js', 'node_modules/esbuild/install.js']) {
  const result = spawnSync(process.execPath, [script], { stdio: 'inherit', windowsHide: true });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log('Reviewed dependency setup complete.');
