import { z } from 'zod';
import { HlcGenerator, hlcCompare, mergeReplica } from '@/libs/crdt';
import { SyncError } from '@/libs/errors';
import { validateRow } from '@/libs/replicaSchemas';
import type { ReplicaKeyRow } from '@/libs/replicaSyncClient';
import { isCipherEnvelope } from '@/types/replica';
import type { Hlc, ReplicaRow } from '@/types/replica';
import { FileSyncError } from './file/provider';
import type { FileSyncProvider } from './file/provider';
import { withS3DeviceLock } from './withS3DeviceLock';

export interface S3ReplicaClientOptions {
  provider: FileSyncProvider | (() => Promise<FileSyncProvider>);
  spaceId: string;
  deviceId: string;
  now?: () => number;
}

const hlcSchema = z.custom<Hlc>(
  (value) => typeof value === 'string' && /^[0-9a-f]{13}-[0-9a-f]{8}-.+$/u.test(value),
);
const cipherEnvelopeSchema = z.object({
  c: z.string(),
  i: z.string(),
  s: z.string(),
  alg: z.string(),
  h: z.string(),
});
const cipherReferenceSchema = z.object({
  type: z.literal('readest-replica-cipher-v1'),
  saltId: z.string().uuid(),
  id: z.string().uuid(),
});
type CipherReference = z.infer<typeof cipherReferenceSchema>;
const isCipherReference = (value: unknown): value is CipherReference =>
  cipherReferenceSchema.safeParse(value).success;
const replicaRowSchema: z.ZodType<ReplicaRow> = z.object({
  user_id: z.string(),
  kind: z.string(),
  replica_id: z.string(),
  fields_jsonb: z.record(z.string(), z.object({ v: z.unknown(), t: hlcSchema, s: z.string() })),
  manifest_jsonb: z
    .object({
      files: z.array(
        z.object({
          filename: z.string(),
          byteSize: z.number().int().nonnegative(),
          partialMd5: z.string(),
          sha256: z.string().optional(),
          mtime: z.number().optional(),
        }),
      ),
      schemaVersion: z.number().int(),
    })
    .nullable(),
  deleted_at_ts: hlcSchema.nullable(),
  reincarnation: z.string().nullable(),
  updated_at_ts: hlcSchema,
  schema_version: z.number().int(),
});
const replicaStateSchema = z.object({
  format: z.literal(1),
  spaceId: z.string(),
  deviceId: z.string(),
  kind: z.string(),
  rows: z.array(replicaRowSchema),
});
const keyStateSchema = z.object({
  format: z.literal(1),
  spaceId: z.string(),
  deviceId: z.string(),
  resets: z.record(z.string(), hlcSchema),
  keys: z.array(
    z.object({
      saltId: z.string(),
      alg: z.string(),
      salt: z.string(),
      createdAt: z.string(),
      hlc: hlcSchema,
      resets: z.array(z.string()),
    }),
  ),
});
type KeyState = z.infer<typeof keyStateSchema>;
type KeySnapshot = { states: KeyState[]; resets: Set<string>; active: KeyState['keys'] };
type ActiveSalts = { active: readonly { saltId: string }[] };

const segment = (value: string): string => {
  if (!value || value === '.' || value === '..') {
    throw new SyncError('VALIDATION', 'An S3 sync identity must be a non-empty path segment');
  }
  return encodeURIComponent(value);
};

export const buildS3ReplicaBasePath = (rootPath: string, spaceId: string): string =>
  `${rootPath === '/' ? '' : rootPath}/Readest/sync/${segment(spaceId)}`;

const canonicalRow = (row: ReplicaRow): string =>
  JSON.stringify(row, (_key, value: unknown) =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  );

/**
 * S3 has no transactional replica table or server arrival cursor. Each device
 * therefore owns one cumulative object per kind; ordinary pushes never PUT
 * another device's object. Encrypted values live in separate immutable objects
 * so forgetting a passphrase can delete its cipher tree without rewriting any
 * concurrently edited metadata or relying on conditional PUT support.
 * Pull rediscovers all objects, regardless of the caller's
 * HLC, so an offline device's late, lower-clock fields cannot be skipped.
 */
export class S3ReplicaClient {
  private pending: Promise<unknown> = Promise.resolve();
  private readonly hlc: HlcGenerator;
  private readonly now: () => number;
  private readonly appliedRows = new Map<string, ReplicaRow>();
  private readonly localRows = new Map<string, ReplicaRow>();
  private readonly observedResetIds = new Set<string>();
  private readonly observedSaltResets = new Map<string, readonly string[]>();
  private acknowledgementGeneration = 0;
  private readonly returnedRows = new WeakMap<
    ReplicaRow,
    { row: ReplicaRow; generation: number }
  >();

  constructor(private readonly options: S3ReplicaClientOptions) {
    segment(options.spaceId);
    segment(options.deviceId);
    this.now = options.now ?? Date.now;
    this.hlc = new HlcGenerator(options.deviceId, this.now);
  }

  private provider(): Promise<FileSyncProvider> {
    return typeof this.options.provider === 'function'
      ? this.options.provider()
      : Promise.resolve(this.options.provider);
  }

  private base(provider: FileSyncProvider): string {
    return buildS3ReplicaBasePath(provider.rootPath, this.options.spaceId);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.pending.then(() =>
      withS3DeviceLock('replicas', this.options.spaceId, this.options.deviceId, operation),
    );
    this.pending = next.catch(() => {});
    return next;
  }

  private async write(provider: FileSyncProvider, path: string, value: unknown): Promise<void> {
    const parts = path.split('/').filter(Boolean);
    await provider.ensureDir(
      parts.slice(0, -1).map((_, i) => `/${parts.slice(0, i + 1).join('/')}`),
    );
    await provider.writeText(path, JSON.stringify(value), 'application/json');
  }

  private async list(provider: FileSyncProvider, folder: string): Promise<string[]> {
    try {
      return (await provider.list(folder))
        .filter((entry) => !entry.isDirectory && entry.name.endsWith('.json'))
        .map((entry) => {
          if (entry.path !== `${folder}/${entry.name}` || entry.name.includes('/')) {
            throw new SyncError('SERVER', 'Invalid S3 sync object path');
          }
          return entry.path;
        })
        .sort();
    } catch (error) {
      if (error instanceof FileSyncError && error.code === 'NOT_FOUND') return [];
      throw error;
    }
  }

  private async read<T>(
    provider: FileSyncProvider,
    path: string,
    schema: z.ZodType<T>,
    listed = false,
  ): Promise<T | null> {
    const text = await provider.readText(path);
    if (text === null) {
      if (listed) throw new SyncError('SERVER', 'An S3 sync object disappeared during pull');
      return null;
    }
    try {
      return schema.parse(JSON.parse(text));
    } catch (cause) {
      throw new SyncError('SERVER', 'Malformed S3 sync object', { cause });
    }
  }

  private validateRow(row: ReplicaRow): void {
    if (row.user_id !== this.options.spaceId) {
      throw new SyncError('VALIDATION', 'Replica belongs to a different S3 library');
    }
    const result = validateRow(row);
    if (!result.ok) throw new SyncError(result.code, result.message, { cause: result.cause });
    for (const { v } of Object.values(row.fields_jsonb)) {
      if (
        typeof v === 'object' &&
        v !== null &&
        'type' in v &&
        v.type === 'readest-replica-cipher-v1' &&
        !isCipherReference(v)
      ) {
        throw new SyncError('VALIDATION', 'Malformed S3 replica cipher reference');
      }
    }
  }

  private validateRemoteRow(row: ReplicaRow): void {
    try {
      this.validateRow(row);
    } catch (cause) {
      // A broken remote snapshot is not a permanent refusal of the healthy
      // local dirty row. No HTTP status: the manager must retry the batch.
      throw new SyncError(
        'SERVER',
        cause instanceof Error ? cause.message : 'Invalid S3 replica row',
        { cause },
      );
    }
  }

  private validateOwner(state: { spaceId: string; deviceId: string }, path: string): void {
    try {
      if (
        state.spaceId === this.options.spaceId &&
        path.endsWith(`/${segment(state.deviceId)}.json`)
      )
        return;
    } catch (cause) {
      throw new SyncError('SERVER', 'S3 sync object identity mismatch', { cause });
    }
    throw new SyncError('SERVER', 'S3 sync object identity mismatch');
  }

  private async keys(provider: FileSyncProvider): Promise<KeySnapshot> {
    const paths = await this.list(provider, `${this.base(provider)}/keys`);
    const states: KeyState[] = [];
    const resets = new Set<string>();
    for (const path of paths) {
      const state = (await this.read(provider, path, keyStateSchema, true))!;
      this.validateOwner(state, path);
      states.push(state);
      for (const [id, hlc] of Object.entries(state.resets)) {
        resets.add(id);
        this.hlc.observe(hlc);
      }
      for (const key of state.keys) this.hlc.observe(key.hlc);
    }
    const active = states
      .flatMap((state) => state.keys)
      .filter((key) => Array.from(resets).every((id) => key.resets.includes(id)))
      .sort((a, b) => hlcCompare(b.hlc, a.hlc));
    // Freshness checks are synchronous. Retain only observed revocation
    // metadata; every operation still discovers the actual remote key states.
    for (const id of resets) this.observedResetIds.add(id);
    for (const state of states) {
      for (const key of state.keys) {
        if (!this.observedSaltResets.has(key.saltId)) {
          this.observedSaltResets.set(key.saltId, [...key.resets]);
        }
      }
    }
    return { states, resets, active };
  }

  private ownKeys(snapshot: KeySnapshot): KeyState {
    return (
      snapshot.states.find((state) => state.deviceId === this.options.deviceId) ?? {
        format: 1,
        spaceId: this.options.spaceId,
        deviceId: this.options.deviceId,
        resets: {},
        keys: [],
      }
    );
  }

  private async cleanRevokedCipher(
    provider: FileSyncProvider,
    snapshot: KeySnapshot,
  ): Promise<void> {
    if (!snapshot.resets.size) return;
    const folder = `${this.base(provider)}/cipher`;
    let entries;
    try {
      entries = await provider.list(folder);
    } catch (error) {
      if (error instanceof FileSyncError && error.code === 'NOT_FOUND') return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      if (entry.path !== `${folder}/${entry.name}` || entry.name.includes('/')) {
        throw new SyncError('SERVER', 'Invalid S3 cipher directory');
      }
      // A concurrent setup may have added a new salt since the initial list.
      // Keys are committed before ciphertext, so re-read before deleting it.
      if (!snapshot.active.some((key) => segment(key.saltId) === entry.name)) {
        const current = await this.keys(provider);
        if (!current.active.some((key) => segment(key.saltId) === entry.name)) {
          await provider.deleteDir(entry.path);
        }
      }
    }
  }

  private cipherPath(provider: FileSyncProvider, reference: CipherReference): string {
    return `${this.base(provider)}/cipher/${segment(reference.saltId)}/${reference.id}.json`;
  }

  private async externalizeCipher(
    provider: FileSyncProvider,
    row: ReplicaRow,
  ): Promise<ReplicaRow> {
    const fields_jsonb = { ...row.fields_jsonb };
    for (const [name, field] of Object.entries(fields_jsonb)) {
      if (!isCipherEnvelope(field.v)) continue;
      const reference: CipherReference = {
        type: 'readest-replica-cipher-v1',
        saltId: field.v.s,
        id: crypto.randomUUID(),
      };
      // Cipher first, reference last: a failed upload must never publish a
      // metadata reference to content that has not reached the object store.
      await this.write(provider, this.cipherPath(provider, reference), field.v);
      fields_jsonb[name] = { ...field, v: reference };
    }
    return { ...row, fields_jsonb };
  }

  private async hydrateCipher(
    provider: FileSyncProvider,
    row: ReplicaRow,
    keys: KeySnapshot,
  ): Promise<ReplicaRow> {
    const clean = this.withoutForgottenCipher(row, keys);
    const fields_jsonb = { ...clean.fields_jsonb };
    for (const [name, field] of Object.entries(fields_jsonb)) {
      if (!isCipherReference(field.v)) continue;
      const reference = field.v;
      const cipher = await this.read(
        provider,
        this.cipherPath(provider, reference),
        cipherEnvelopeSchema,
      );
      if (!cipher) {
        // Forget may have removed the immutable object between the key scan
        // and GET. That is a valid reset, not a damaged active replica.
        const current = await this.keys(provider);
        if (!current.active.some((key) => key.saltId === reference.saltId)) {
          delete fields_jsonb[name];
          continue;
        }
        throw new SyncError('SERVER', 'Missing S3 replica cipher object');
      }
      if (cipher.s !== reference.saltId) {
        throw new SyncError('SERVER', 'S3 cipher salt identity mismatch');
      }
      fields_jsonb[name] = { ...field, v: cipher };
    }
    return { ...clean, fields_jsonb };
  }

  private withoutForgottenCipher(row: ReplicaRow, keys: ActiveSalts): ReplicaRow {
    const salts = new Set(keys.active.map((key) => key.saltId));
    return {
      ...row,
      fields_jsonb: Object.fromEntries(
        Object.entries(row.fields_jsonb).filter(([, envelope]) => {
          if (isCipherEnvelope(envelope.v)) return salts.has(envelope.v.s);
          if (isCipherReference(envelope.v)) return salts.has(envelope.v.saltId);
          return true;
        }),
      ),
    };
  }

  private rowKey(row: ReplicaRow): string {
    return `${row.kind}\0${row.replica_id}`;
  }

  private rememberConfirmed(rows: Map<string, ReplicaRow>, row: ReplicaRow): void {
    const key = this.rowKey(row);
    const copy = structuredClone(row);
    const previous = rows.get(key);
    rows.set(key, previous ? mergeReplica(previous, copy) : copy);
  }

  private confirmedRow(row: ReplicaRow, keys: ActiveSalts): ReplicaRow | undefined {
    const local = this.localRows.get(this.rowKey(row));
    const applied = this.appliedRows.get(this.rowKey(row));
    const cleanLocal = local ? this.withoutForgottenCipher(local, keys) : undefined;
    const cleanApplied = applied ? this.withoutForgottenCipher(applied, keys) : undefined;
    return cleanLocal && cleanApplied
      ? mergeReplica(cleanApplied, cleanLocal)
      : (cleanLocal ?? cleanApplied);
  }

  async push(rows: ReplicaRow[]): Promise<ReplicaRow[]> {
    if (!rows.length) return [];
    // Validate the entire batch before any write, as the HTTP client does.
    rows = replicaRowSchema.array().parse(rows);
    for (const row of rows) this.validateRow(row);
    return this.serialize(async () => {
      const provider = await this.provider();
      const keys = await this.keys(provider);
      await this.cleanRevokedCipher(provider, keys);
      const accepted: ReplicaRow[] = [];
      const submitted: ReplicaRow[] = [];
      for (const kind of new Set(rows.map((row) => row.kind))) {
        const path = `${this.base(provider)}/replicas/${segment(kind)}/${segment(this.options.deviceId)}.json`;
        const state = await this.read(provider, path, replicaStateSchema);
        if (state) {
          this.validateOwner(state, path);
          if (state.kind !== kind) throw new SyncError('SERVER', 'Replica kind mismatch');
        }
        const cumulative = new Map<string, ReplicaRow>();
        for (const row of state?.rows ?? []) {
          this.validateRemoteRow(row);
          if (row.kind !== kind) throw new SyncError('SERVER', 'Replica kind mismatch');
          cumulative.set(row.replica_id, this.withoutForgottenCipher(row, keys));
        }
        for (const row of rows.filter((row) => row.kind === kind)) {
          const patch = this.withoutForgottenCipher(row, keys);
          const clean = await this.externalizeCipher(provider, patch);
          submitted.push(patch);
          const existing = cumulative.get(row.replica_id);
          const merged = existing ? mergeReplica(existing, clean) : clean;
          cumulative.set(row.replica_id, merged);
          accepted.push(merged);
        }
        await this.write(provider, path, {
          format: 1,
          spaceId: this.options.spaceId,
          deviceId: this.options.deviceId,
          kind,
          rows: Array.from(cumulative.values()),
        });
      }
      const current = await this.keys(provider);
      await this.cleanRevokedCipher(provider, current);
      const hydrated = await Promise.all(
        accepted.map((row) => this.hydrateCipher(provider, row, current)),
      );
      const local = await Promise.all(
        submitted.map((row) => this.hydrateCipher(provider, row, current)),
      );
      // A completed push describes state already present locally. Keep it as
      // a CRDT lower bound so a concurrent older pull cannot echo it back over
      // an edit made while the upload was running. A failed batch confirms none.
      // Only the submitted patch is known locally: the cumulative server row
      // may also contain old credential fields this device never decrypted.
      for (const row of local) this.rememberConfirmed(this.localRows, row);
      return hydrated;
    });
  }

  async pull(kind: string, since: Hlc | null): Promise<ReplicaRow[]> {
    return (await this.pullBatch([{ kind, since }]))[0]!.rows;
  }

  canApplyPull(row: ReplicaRow): boolean {
    const original = this.returnedRows.get(row);
    if (!original || original.generation !== this.acknowledgementGeneration) return false;
    const keys: ActiveSalts = {
      active: Array.from(this.observedSaltResets, ([saltId, resets]) => ({
        saltId,
        resets,
      })).filter((key) => Array.from(this.observedResetIds).every((id) => key.resets.includes(id))),
    };
    const clean = this.withoutForgottenCipher(original.row, keys);
    if (canonicalRow(clean) !== canonicalRow(original.row)) return false;
    const confirmed = this.confirmedRow(clean, keys);
    return !confirmed || canonicalRow(mergeReplica(clean, confirmed)) === canonicalRow(clean);
  }

  acknowledgePull(row: ReplicaRow): void {
    // Pull application mutates fields while decrypting. Only remember the
    // encrypted wire copy captured before returning it to the caller.
    const original = this.returnedRows.get(row);
    if (original?.generation === this.acknowledgementGeneration) {
      this.rememberConfirmed(this.appliedRows, original.row);
    }
  }

  clearPullAcknowledgements(): void {
    this.appliedRows.clear();
    this.acknowledgementGeneration += 1;
  }

  async pullBatch(
    cursors: { kind: string; since: Hlc | null }[],
  ): Promise<{ kind: string; rows: ReplicaRow[] }[]> {
    if (!cursors.length) return [];
    const provider = await this.provider();
    const keys = await this.keys(provider);
    await this.cleanRevokedCipher(provider, keys);
    const results: { kind: string; rows: ReplicaRow[] }[] = [];
    for (const { kind } of cursors) {
      const merged = new Map<string, ReplicaRow>();
      const paths = await this.list(provider, `${this.base(provider)}/replicas/${segment(kind)}`);
      for (const path of paths) {
        const state = (await this.read(provider, path, replicaStateSchema, true))!;
        this.validateOwner(state, path);
        if (state.kind !== kind) throw new SyncError('SERVER', 'Replica kind mismatch');
        for (const row of state.rows) {
          this.validateRemoteRow(row);
          if (row.kind !== kind) throw new SyncError('SERVER', 'Replica kind mismatch');
          const clean = this.withoutForgottenCipher(row, keys);
          const existing = merged.get(row.replica_id);
          merged.set(row.replica_id, existing ? mergeReplica(existing, clean) : clean);
        }
      }
      results.push({ kind, rows: Array.from(merged.values()) });
    }
    const current = await this.keys(provider);
    const hydrated = await Promise.all(
      results.map(async ({ kind, rows }) => ({
        kind,
        rows: await Promise.all(rows.map((row) => this.hydrateCipher(provider, row, current))),
      })),
    );
    return hydrated.map(({ kind, rows }, index) => ({
      kind,
      rows: rows.flatMap((row) => {
        const confirmed = this.confirmedRow(row, current);
        const merged = this.withoutForgottenCipher(
          confirmed ? mergeReplica(confirmed, row) : row,
          current,
        );
        if (
          cursors[index]!.since !== null &&
          this.appliedRows.has(this.rowKey(row)) &&
          confirmed &&
          canonicalRow(confirmed) === canonicalRow(merged)
        ) {
          return [];
        }
        const returned = structuredClone(merged);
        this.returnedRows.set(returned, {
          row: structuredClone(merged),
          generation: this.acknowledgementGeneration,
        });
        return [returned];
      }),
    }));
  }

  async listReplicaKeys(): Promise<ReplicaKeyRow[]> {
    const provider = await this.provider();
    const keys = await this.keys(provider);
    await this.cleanRevokedCipher(provider, keys);
    return keys.active.map(({ saltId, alg, salt, createdAt }) => ({
      saltId,
      alg,
      salt,
      createdAt,
    }));
  }

  async createReplicaKey(alg: string): Promise<ReplicaKeyRow> {
    if (alg !== 'pbkdf2-600k-sha256')
      throw new SyncError('UNSUPPORTED_ALG', 'Unsupported salt algorithm');
    return this.serialize(async () => {
      const provider = await this.provider();
      const snapshot = await this.keys(provider);
      const state = this.ownKeys(snapshot);
      state.keys = state.keys.filter((key) =>
        Array.from(snapshot.resets).every((id) => key.resets.includes(id)),
      );
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      const row: ReplicaKeyRow = {
        saltId: crypto.randomUUID(),
        alg,
        salt: btoa(String.fromCharCode(...bytes)),
        createdAt: new Date(this.now()).toISOString(),
      };
      state.keys.push({ ...row, hlc: this.hlc.next(), resets: Array.from(snapshot.resets).sort() });
      await this.write(
        provider,
        `${this.base(provider)}/keys/${segment(this.options.deviceId)}.json`,
        state,
      );
      return row;
    });
  }

  /**
   * Reset markers remain durable in each device's own object. A salt is valid
   * only if it was created having observed every reset. An old offline object
   * cannot restore salts or ciphertext, even when its wall clock is ahead.
   */
  async forgetReplicaKeys(): Promise<void> {
    return this.serialize(async () => {
      const provider = await this.provider();
      const snapshot = await this.keys(provider);
      const state = this.ownKeys(snapshot);
      state.resets[crypto.randomUUID()] = this.hlc.next();
      state.keys = [];
      await this.write(
        provider,
        `${this.base(provider)}/keys/${segment(this.options.deviceId)}.json`,
        state,
      );
      const current = await this.keys(provider);
      await this.cleanRevokedCipher(provider, current);
    });
  }

  // Every list rediscovers remote devices and reset markers; there is no
  // session cache that can hide another device's passphrase reset.
  invalidateReplicaKeysCache(): void {}
}
