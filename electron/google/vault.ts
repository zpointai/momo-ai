import { z } from 'zod';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Protection } from '../credentials/store';
import { AppError } from '../errors';
import { accountIdSchema } from '../../src/shared/google';
export const clientSchema = z.object({ client_id: z.string().regex(/^[a-zA-Z0-9._-]+\.apps\.googleusercontent\.com$/), client_secret: z.string().min(1).max(2048).optional() });
const tokenSchema = z.object({ access: z.string().min(1).max(8192), refresh: z.string().min(1).max(8192), expiresAt: z.number().finite(), scopes: z.array(z.string()).max(30) }).strict();
export const storedAccountSchema = z.object({ id: accountIdSchema, email: z.string().max(320), status: z.enum(['connected', 'reconnect']), token: tokenSchema }).strict();
export type StoredAccount = z.infer<typeof storedAccountSchema>;
const vaultSchema = z.object({ version: z.literal(1), client: clientSchema.nullable(), activeAccountId: accountIdSchema.nullable(), accounts: z.array(storedAccountSchema).max(8) }).strict();
export type VaultData = z.infer<typeof vaultSchema>;
export interface GoogleVault { read(): Promise<VaultData>; write(data: VaultData): Promise<void> }
export class ProtectedGoogleVault implements GoogleVault {
  constructor(private filename: string, private protection: Protection) {}
  async read(): Promise<VaultData> {
    try {
      const bytes = await readFile(this.filename);
      if (!this.protection.isEncryptionAvailable()) throw new Error('Protection unavailable');
      return vaultSchema.parse(JSON.parse(this.protection.decryptString(bytes)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, client: null, activeAccountId: null, accounts: [] };
      throw new AppError('unavailable', 'Google connection storage could not be unlocked. Existing data was preserved.');
    }
  }
  async write(data: VaultData): Promise<void> {
    if (!this.protection.isEncryptionAvailable()) throw new AppError('unavailable', 'Windows credential protection is unavailable. Google setup was not saved.');
    const encrypted = this.protection.encryptString(JSON.stringify(vaultSchema.parse(data)));
    await mkdir(path.dirname(this.filename), { recursive: true });
    const temporary = this.filename + '.' + randomUUID() + '.tmp';
    try { await writeFile(temporary, encrypted, { flag: 'wx', mode: 0o600 }); await rename(temporary, this.filename); }
    finally { encrypted.fill(0); await unlink(temporary).catch(() => undefined); }
  }
}

