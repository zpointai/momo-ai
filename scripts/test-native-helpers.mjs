import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root, inspectNative } from './native-toolchain.mjs';

const binary = name => path.join(root, 'dist-electron', name, `momo-${name}.exe`);
const observer = await inspectNative(binary('desktop-observer'), path.join(root, 'native/desktop-observer/observer.manifest'));
const relay = await inspectNative(binary('relay-setup'), path.join(root, 'native/relay-setup/setup.manifest'));
const identity = JSON.parse(await readFile(path.join(root, 'dist-electron/desktop-observer/identity.json'), 'utf8'));
assert.equal(observer.sha256, identity.sha256);
assert.equal(spawnSync(binary('desktop-observer'), [], { stdio: 'ignore', windowsHide: true }).status, 2, 'Observer must refuse non-pipe launch');
for (const args of [[], ['rest', '0'], ['pair', '0'], ['invalid', '0']]) {
  const result = spawnSync(binary('relay-setup'), args, { windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 1); assert.equal(result.stdout.length, 0, 'Invalid Relay owner must not return credentials');
}
const child = spawn(binary('desktop-observer'), [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const exit = new Promise(resolve => child.once('exit', code => resolve(code)));
let buffer = Buffer.alloc(0), waiter;
child.stdout.on('data', chunk => { buffer = Buffer.concat([buffer, chunk]); waiter?.(); });
const frame = async () => {
  const deadline = Date.now() + 10000;
  while (buffer.length < 4 || buffer.length < 4 + buffer.readUInt32LE(0)) {
    assert(Date.now() < deadline && child.exitCode === null, 'Native response missing');
    await new Promise(resolve => { const timer = setTimeout(resolve, 25); waiter = () => { clearTimeout(timer); resolve(); }; });
  }
  const length = buffer.readUInt32LE(0); assert(length <= 262144);
  const result = JSON.parse(buffer.subarray(4, length + 4)); buffer = buffer.subarray(length + 4);
  assert.equal(result.buildId, identity.buildId); assert.equal(result.protocol, 1);
  return result;
};
const request = (op, sequence, data) => {
  const body = Buffer.alloc(6 + data.length); body[0] = 1; body[1] = op; body.writeUInt32LE(sequence, 2); data.copy(body, 6);
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length); child.stdin.write(Buffer.concat([header, body]));
};
let session;
try {
  const parent = Buffer.alloc(4); parent.writeUInt32LE(process.pid);
  request(1, 1, parent);
  const ready = await frame();
  if (ready.kind === 'fault' && ['SELF_ELEVATED', 'INPUT_DESKTOP_RESTRICTED'].includes(ready.data.reason)) {
    // Hosted CI can be elevated/session-zero. Record this limitation, never claim UIA was exercised.
    session = { status: 'restricted-environment', reason: ready.data.reason };
    assert.equal(await exit, 5);
  } else {
    assert.equal(ready.kind, 'ready'); assert.equal(ready.data.architecture, 'x64');
    const target = Buffer.from('00000000-0000-4000-8000-000000000001');
    request(4, 2, target); const denied = await frame();
    assert.equal(denied.kind, 'fault'); assert.equal(denied.data.reason, 'TARGET_STALE');
    request(3, 3, target); const bound = await frame();
    assert.equal(bound.kind, 'bound'); assert.equal(bound.data.status, 'STALE');
    request(2, 99, Buffer.alloc(0)); // Wrong sequence must terminate before enumeration.
    const code = await Promise.race([exit, new Promise(resolve => setTimeout(() => resolve('timeout'), 3000))]);
    assert.equal(code, 0); assert.equal(buffer.length, 0);
    session = { status: 'PASS', comInitialization: true, ungrantedObservationDenied: true, staleAuthorizationDenied: true, invalidSequenceTerminated: true };
  }
} finally { child.stdin.destroy(); if (child.exitCode === null) child.kill(); }
await mkdir(path.join(root, 'artifacts-public'), { recursive: true });
const report = { observer, relay, observerNonPipeRejected: true, relayInvalidOwnerRejected: true, session, scope: 'Real native binaries; no owner window enumeration, observation, dialog input or credentials.' };
await writeFile(path.join(root, 'artifacts-public/native-helper-tests.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
