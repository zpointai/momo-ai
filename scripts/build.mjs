import { build } from 'esbuild';
import { build as viteBuild } from 'vite';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildDesktopObserver } from './build-desktop-observer.mjs';
import { buildRelaySetup } from './build-relay-setup.mjs';
const observerIdentity = await buildDesktopObserver();
const relaySetupIdentity = await buildRelaySetup();
const common = { bundle: true, platform: 'node', format: 'cjs', target: 'node24', sourcemap: false, external: ['electron', 'better-sqlite3'], logLevel: 'warning' };
await mkdir('dist-electron', { recursive: true });
for (const [input, output] of [['electron/main.ts','main.cjs'], ['electron/preload.ts','preload.cjs'], ['electron/storage/worker.ts','storage-worker.cjs']]) {
  await build({ ...common, define: { __MOMO_DESKTOP_OBSERVER_IDENTITY__: JSON.stringify(observerIdentity), __MOMO_RELAY_SETUP_IDENTITY__: JSON.stringify(relaySetupIdentity) }, entryPoints: [input], outfile: 'dist-electron/' + output });
}
const graph = [];
await viteBuild({ plugins: [{ name: 'momo-renderer-boundary', moduleParsed(info) {
  const id = info.id.replaceAll('\\', '/');
  graph.push(id);
  if (/\/electron\/|\/src\/(hooks|lib|mocks|pages)\/|\/node_modules\/(firebase|@firebase|@google\/genai|@react-oauth\/google)\//.test(id)) throw new Error('Privileged or legacy renderer dependency: ' + id);
} }] });
// MapLibre 6 resolves its default worker only on HTTP(S). Bundle the worker for
// Electron's app:// origin; no CDN script, eval, or remote code is admitted.
await build({ entryPoints: ['node_modules/maplibre-gl/dist/maplibre-gl-worker.mjs'], bundle: true, platform: 'browser', format: 'esm', target: 'chrome144', minify: true, sourcemap: false, outfile: 'dist/assets/maplibre-worker.js' });
const canary = process.env.MOMO_BUILD_CANARY || 'MOMO_TEST_SECRET_CANARY_928571';
for (const name of await readdir('dist/assets')) {
  if (!/\.(js|css)$/.test(name)) continue;
  const content = await readFile(path.join('dist/assets', name), 'utf8');
  if (content.includes(canary) || /generativelanguage\.googleapis|GEMINI_API_KEY|AIza[0-9A-Za-z_-]{30,}/.test(content)) throw new Error('Forbidden provider/credential content in renderer');
}
await writeFile('dist-electron/renderer-boundary.json', JSON.stringify({ checkedModules: graph.length, forbiddenImports: 0, credentialCanaryFound: false }, null, 2));
console.log('Desktop build and renderer isolation check passed.');
