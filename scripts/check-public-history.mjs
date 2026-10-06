import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const publicEmail = /^(?:[A-Za-z0-9+_.\[\]-]+@users\.noreply\.github\.com|noreply@github\.com)$/;

export function inspectCommitIdentities(log) {
  const findings = [];
  let commits = 0;
  for (const row of log.trim().split('\n').filter(Boolean)) {
    const [commit, author, committer] = row.replace(/\r$/, '').split('\0');
    if (!/^[a-f0-9]{40,64}$/.test(commit ?? '') || author === undefined || committer === undefined) {
      throw new Error('Malformed Git identity record');
    }
    commits++;
    for (const [role, email] of [['author', author], ['committer', committer]]) {
      if (!publicEmail.test(email)) {
        findings.push({ commit, role, fingerprint: createHash('sha256').update(email).digest('hex') });
      }
    }
  }
  if (!commits) throw new Error('No public history was checked');
  return { commits, findings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const shallow = spawnSync('git', ['rev-parse', '--is-shallow-repository'], { encoding: 'utf8', windowsHide: true });
  if (shallow.status !== 0 || shallow.stdout.trim() !== 'false') {
    throw new Error('Public identity audit requires complete Git history (fetch-depth: 0)');
  }
  const refs = process.argv.slice(2);
  const result = spawnSync('git', ['log', '--format=%H%x00%ae%x00%ce', ...(refs.length ? refs : ['HEAD']), '--'], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('Could not read public commit identities');
  const report = inspectCommitIdentities(result.stdout);
  console.log(JSON.stringify(report, null, 2));
  if (report.findings.length) process.exitCode = 1;
}
