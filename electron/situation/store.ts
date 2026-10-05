import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { emptySituationConfig, situationConfigSchema, weatherSnapshotSchema, trafficSnapshotSchema, flightSnapshotSchema, nearbyConditionSchema, requestRecordSchema, providerStatusSchema, type SituationRequestRecord } from '../../src/shared/situation';
import { AppError } from '../errors';
import { flightAwareAccessSchema } from '../../src/shared/flightAware';

export const situationStoreSchema = z.object({ version: z.literal(1), config: situationConfigSchema,
  flightAwareAccess: flightAwareAccessSchema.optional(),
  weather: z.array(weatherSnapshotSchema).max(12), traffic: z.array(trafficSnapshotSchema).max(8), flights: flightSnapshotSchema.nullable(),
  conditions: z.array(nearbyConditionSchema).max(24), requests: z.array(requestRecordSchema).max(2000), statuses: z.array(providerStatusSchema).max(21),
  aircraftAccess: z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), count: z.number().int().nonnegative(), retryAt: z.string().datetime() }).strict().optional(),
}).strict();
export type SituationRecord = z.infer<typeof situationStoreSchema>;
export const emptySituationRecord = (): SituationRecord => ({ version: 1, config: emptySituationConfig(), weather: [], traffic: [], flights: null, conditions: [], requests: [], statuses: [] });
export class SituationStore {
  private value: SituationRecord | undefined;
  constructor(private filename?: string) {}
  async appendRequest(record: SituationRequestRecord) {
    const value = requestRecordSchema.parse(record);
    if (this.filename) {
      await mkdir(path.dirname(this.filename), { recursive: true });
      // Append-only start/settlement records preserve history beyond the bounded UI projection.
      await appendFile(this.filename + '.requests.jsonl', JSON.stringify(value) + '\n', { mode: 0o600 });
    }
  }
  async get(): Promise<SituationRecord> {
    if (!this.value) {
      if (!this.filename) this.value = emptySituationRecord();
      else try {
        const bytes = await readFile(this.filename); if (bytes.length > 12000000) throw Error('Oversized store');
        this.value = situationStoreSchema.parse(JSON.parse(bytes.toString('utf8')));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') this.value = emptySituationRecord();
        else throw new AppError('unavailable', 'Situation View storage could not be read. Existing data was preserved.');
      }
    }
    return structuredClone(this.value);
  }
  async put(raw: SituationRecord) {
    const value = situationStoreSchema.parse(raw);
    if (this.filename) {
      const temporary = this.filename + '.' + randomUUID() + '.tmp';
      try { await mkdir(path.dirname(this.filename), { recursive: true }); await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await rename(temporary, this.filename); }
      catch { throw new AppError('unavailable', 'Situation View could not be saved. Previous data was preserved.'); }
      finally { await unlink(temporary).catch(() => undefined); }
    }
    this.value = value;
  }
}
