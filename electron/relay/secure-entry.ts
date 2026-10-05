import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../errors';

type Purpose = 'rest' | 'pair';
type Identity = { sha256: string; bytes: number };
declare const __MOMO_RELAY_SETUP_IDENTITY__: Identity;
const builtIdentity = typeof __MOMO_RELAY_SETUP_IDENTITY__ === 'undefined' ? null : __MOMO_RELAY_SETUP_IDENTITY__;
const invalid = () => new AppError('invalid_input', 'Secure setup returned an invalid value. No secret was logged.');

function decode(purpose: Purpose, bytes: Buffer): Record<string, string> {
  if (bytes.length < 12 || bytes.length > 524 || !bytes.subarray(0, 4).equals(Buffer.from('MR01'))) throw invalid();
  const firstLength = bytes.readUInt32LE(4), secondLength = bytes.readUInt32LE(8);
  if (firstLength > 256 || secondLength > 256 || bytes.length !== 12 + firstLength + secondLength) throw invalid();
  if (bytes.subarray(12).some(value => value < 0x21 || value > 0x7e)) throw invalid();
  const first = bytes.toString('ascii', 12, 12 + firstLength), second = bytes.toString('ascii', 12 + firstLength);
  if (purpose === 'pair') {
    if (firstLength < 32 || secondLength !== 0) throw invalid();
    return { token: first };
  }
  if (!/^SK[a-fA-F0-9]{32}$/.test(first) || secondLength < 16) throw invalid();
  return { apiKeySid: first, secret: second };
}

/** Owner-only Win32 dialog. Secrets travel over a private pipe, never the renderer or shell. */
export async function secureRelayEntry(purpose: Purpose, options: { resourceRoot: string; ownerWindow: string; identity?: Identity }): Promise<Record<string, string>> {
  const identity = options.identity ?? builtIdentity;
  const executable = path.resolve(options.resourceRoot, 'relay-setup', 'momo-relay-setup.exe');
  try {
    if (!identity || !/^[1-9][0-9]{0,19}$/.test(options.ownerWindow)) throw new Error();
    const actual = await realpath(executable);
    if (actual.toLowerCase() !== executable.toLowerCase()) throw new Error();
    const binary = await readFile(actual);
    if (binary.length !== identity.bytes || createHash('sha256').update(binary).digest('hex') !== identity.sha256) throw new Error();
  } catch {
    throw new AppError('unavailable', 'The native Relay setup component is missing or could not be verified. Repair the MoMo installation.');
  }
  return new Promise((resolve, reject) => {
    execFile(executable, [purpose, options.ownerWindow], {
      // This is an interactive Windows-subsystem executable: no console to hide.
      shell: false, windowsHide: false, timeout: 600000, maxBuffer: 1024, encoding: 'buffer',
      env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR },
    }, (error, stdout, stderr) => {
      try {
        if (error?.code === 2) throw new AppError('cancelled', 'Secure setup cancelled.');
        if (error || stderr.length) throw new AppError('unavailable', 'The secure setup window could not finish. No credentials were saved. Check for a Windows or antivirus alert before retrying.');
        resolve(decode(purpose, stdout));
      } catch (failure) {
        reject(failure instanceof AppError ? failure : invalid());
      } finally {
        stdout?.fill(0); stderr?.fill(0);
      }
    });
  });
}
