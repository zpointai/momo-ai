import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const records = [];
const notices = [];
const bundled = new Set(JSON.parse(fs.readFileSync('scripts/bundled-dependencies.json', 'utf8')));
const allowed = /^(?:MIT(?:-0)?|ISC|Apache-2\.0|BSD-[234]-Clause|0BSD|CC0-1\.0|Unlicense|BlueOak-1\.0\.0|Python-2\.0|Unicode-3\.0|OFL-1\.1)$/;
fs.mkdirSync('artifacts-public', { recursive: true });
fs.mkdirSync('licenses/dependencies', { recursive: true });
for (const base of ['', 'cloud/mo-relay/']) {
  const lock = JSON.parse(fs.readFileSync(base + 'package-lock.json', 'utf8'));
  for (const [directory, metadata] of Object.entries(lock.packages)) {
    if (!directory) continue;
    const location = path.join(base, directory);
    const filename = path.join(location, 'package.json');
    if (!fs.existsSync(filename)) { if (!metadata.optional) records.push({ package: directory, scope: base || 'desktop', license: metadata.license ?? 'UNKNOWN', installed: false, review: true }); continue; }
    const pkg = JSON.parse(fs.readFileSync(filename, 'utf8'));
    const license = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type ?? 'UNKNOWN';
    const licenseFiles = fs.readdirSync(location).filter(name => /^(?:licen[cs]e|copying|notice)(?:[._-]|$)/i.test(name) && fs.statSync(path.join(location, name)).isFile());
    // Several packages carry the complete MIT grant in their README instead.
    const readme = fs.readdirSync(location).find(name => /^readme(?:\.|$)/i.test(name));
    if (!licenseFiles.length && readme) {
      const text = fs.readFileSync(path.join(location, readme), 'utf8');
      if (/Permission is hereby granted[\s\S]*THE SOFTWARE IS PROVIDED/i.test(text)) licenseFiles.push(readme);
    }
    const options = license.replace(/[()]/g, '').split(/ OR /);
    const review = !options.some(value => allowed.test(value)) || !licenseFiles.length;
    const record = { package: `${pkg.name}@${pkg.version}`, scope: base || 'desktop', development: metadata.dev === true && !bundled.has(`${pkg.name}@${pkg.version}`), license, installed: true, licenseFiles, review };
    records.push(record);
    if (!record.development) {
      const id = `${pkg.name.replace(/[^a-zA-Z0-9.-]/g, '_')}-${pkg.version}`;
      const dest = path.join('licenses/dependencies', id); fs.mkdirSync(dest, { recursive: true });
      for (const name of licenseFiles) { const data = fs.readFileSync(path.join(location, name)); fs.writeFileSync(path.join(dest, name), data); notices.push({ package: record.package, file: `${dest}/${name}`.replaceAll('\\', '/'), sha256: createHash('sha256').update(data).digest('hex') }); }
    }
  }
}
const report = { records, notices, reviewRequired: records.filter(r => r.review) };
fs.writeFileSync('artifacts-public/license-audit.json', JSON.stringify(report, null, 2) + '\n');
const runtime = [...new Map(records.filter(r => !r.development).map(r => [r.package, r])).values()].sort((a,b) => a.package.localeCompare(b.package));
fs.writeFileSync('THIRD_PARTY_NOTICES.md', '# Third-party notices\n\nMoMo source and project-owned artwork are MIT licensed. Dependencies retain their own licenses. Full shipped notices are under `licenses/dependencies`; font licenses are under `licenses/fonts`. Electron distributions also include `LICENSE` and `LICENSES.chromium.html`, which must remain with a Windows package. Native SQLite includes upstream SQLite code; the better-sqlite3 notice is retained.\n\nThis inventory is generated from the installed locked packages with `npm run license:audit`. Items marked REVIEW require resolution before publication. Build-only dependencies are recorded in the local report.\n\n| Package | License | Review |\n| --- | --- | --- |\n' + runtime.map(r => `| ${r.package} | ${r.license} | ${r.review ? 'REVIEW' : 'Metadata and notice present'} |`).join('\n') + '\n\nFonts: Geist, Instrument Serif and JetBrains Mono use SIL OFL 1.1. Lucide and MapLibre notices are retained with the dependency notices. Remote maps, weather, flight and logo services have separate usage terms; source licensing does not grant a service subscription or waive data restrictions.\n');
console.log(JSON.stringify({ packages: records.length, noticeFiles: notices.length, reviewRequired: report.reviewRequired }, null, 2));
fs.appendFileSync('THIRD_PARTY_NOTICES.md', '\nRuntime redistribution clearance is incomplete. Electron\'s bundled FFmpeg/Chromium notices and the native helpers\' Microsoft runtime obligations need component-level review before publication. See docs/RUNTIME_LICENSE_REVIEW.md.\n');
