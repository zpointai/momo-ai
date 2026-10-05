import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = process.cwd();
const roots = process.argv.slice(2);
const walk = directory => fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const file = path.join(directory, entry.name);
  if (entry.isSymbolicLink()) throw Error('Symbolic links are not allowed in scan inputs');
  return entry.isDirectory() ? walk(file) : [file];
});
const git = roots.length ? null : spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', windowsHide: true });
if (git && git.status !== 0) throw Error('Run from the public repository root, or pass explicit scan directories');
const files = roots.length ? roots.flatMap(p => fs.statSync(p).isDirectory() ? walk(p) : [p]) : [...new Set(git.stdout.split('\0').filter(Boolean))];
const rules = [
  ['provider-key', /(?:sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|GOCSPX-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{30,}|FlyV1\s+[A-Za-z0-9_+/=-]{20,})/g],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g],
  ['owner-path', /[A-Za-z]:[\\/]+Users[\\/]+[^\s"'`<>\x00]+/gi],
  ['google-client-id', /\b\d+-[a-z0-9]+\.apps\.googleusercontent\.com/g],
  ['twilio-id', /\b(?:AC|SK|MG)[a-fA-F0-9]{32}\b/g],
  ['private-relay', /https?:\/\/[^\s"'`<>]+\.fly\.dev[^\s"'`<>]*/g],
];
const findings = [];
for (const file of files) {
  const relative = path.relative(root, path.resolve(file)).replaceAll('\\', '/');
  if (/(?:^|\/)(?:\.env(?!\.example$)|client_secret[^/]*\.json)|\.(?:sqlite(?:-wal|-shm)?|db|pfx|p12|pem|key)$/i.test(relative)) findings.push({ detector: 'prohibited-file', file: relative });
  const bytes = fs.readFileSync(file);
  for (const encoding of ['utf8', 'utf16le']) {
    const content = bytes.toString(encoding);
    for (const [detector, regex] of rules) for (const match of content.matchAll(regex)) {
      if (detector === 'owner-path' && /[\\/](?:YOUR_NAME|Public|Default)(?:[\\/]|$)/.test(match[0])) continue;
      findings.push({ detector, file: relative, encoding, line: content.slice(0, match.index).split('\n').length, fingerprint: createHash('sha256').update(match[0]).digest('hex') });
    }
  }
}
console.log(JSON.stringify({ scannedFiles: files.length, findings }, null, 2));
if (findings.length) process.exitCode = 1;
