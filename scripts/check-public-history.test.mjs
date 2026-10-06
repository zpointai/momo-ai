import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectCommitIdentities } from './check-public-history.mjs';

const commit = 'a'.repeat(40);
const row = (author, committer) => `${commit}\0${author}\0${committer}\n`;
test('accepts owner, contributor, Dependabot and GitHub noreply identities', () => {
  for (const email of ['211139952+zpointai@users.noreply.github.com', 'contributor@users.noreply.github.com', '49699333+dependabot[bot]@users.noreply.github.com']) {
    assert.deepEqual(inspectCommitIdentities(row(email, 'noreply@github.com')), { commits: 1, findings: [] });
  }
});
test('rejects private author and committer addresses without printing them', () => {
  const report = inspectCommitIdentities(row('owner@example.invalid', 'builder@example.invalid'));
  assert.deepEqual(report.findings.map(f => f.role), ['author', 'committer']);
  assert(!JSON.stringify(report).includes('@'));
  assert(report.findings.every(f => /^[a-f0-9]{64}$/.test(f.fingerprint)));
});
test('fails closed on malformed or empty history and deceptive domains', () => {
  assert.throws(() => inspectCommitIdentities(''));
  assert.throws(() => inspectCommitIdentities('invalid'));
  assert.equal(inspectCommitIdentities(row('user@users.noreply.github.com.invalid', 'noreply@github.com')).findings.length, 1);
});
