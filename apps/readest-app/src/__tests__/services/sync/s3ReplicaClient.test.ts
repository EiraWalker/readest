import { describe, expect, test, vi } from 'vitest';
import { HlcGenerator, hlcPack, mergeReplica } from '@/libs/crdt';
import { CryptoSession } from '@/libs/crypto/session';
import { S3ReplicaClient } from '@/services/sync/s3ReplicaClient';
import { ReplicaSyncManager } from '@/services/sync/replicaSyncManager';
import { FileSyncError } from '@/services/sync/file/provider';
import type { FileEntry, FileSyncProvider } from '@/services/sync/file/provider';
import type { CipherEnvelope, FieldsObject, ReplicaRow } from '@/types/replica';

const SPACE = 'personal-space';
const ALG = 'pbkdf2-600k-sha256';
const NOW = 1_700_000_000_000;

const makeProvider = () => {
  const files = new Map<string, string>();
  const provider: FileSyncProvider = {
    rootPath: '/private',
    readText: vi.fn(async (path) => files.get(path) ?? null),
    readBinary: vi.fn(async () => null),
    head: vi.fn(async (path) => (files.has(path) ? { etag: files.get(path) } : null)),
    list: vi.fn(async (path) => {
      const entries = new Map<string, FileEntry>();
      for (const name of files.keys()) {
        if (!name.startsWith(`${path}/`)) continue;
        const rest = name.slice(path.length + 1);
        const part = rest.split('/')[0]!;
        entries.set(part, { name: part, path: `${path}/${part}`, isDirectory: rest.includes('/') });
      }
      return Array.from(entries.values());
    }),
    writeText: vi.fn(async (path, text) => {
      files.set(path, text);
    }),
    writeBinary: vi.fn(async () => {}),
    ensureDir: vi.fn(async () => {}),
    deleteDir: vi.fn(async (path) => {
      for (const name of files.keys()) {
        if (name === path || name.startsWith(`${path}/`)) files.delete(name);
      }
    }),
  };
  return { provider, files };
};

const row = (
  replicaId: string,
  deviceId = 'a',
  physicalMs = NOW,
  fields?: FieldsObject,
): ReplicaRow => {
  const t = hlcPack(physicalMs, 0, deviceId);
  return {
    user_id: SPACE,
    kind: 'settings',
    replica_id: replicaId,
    fields_jsonb: fields ?? { theme: { v: replicaId, t, s: deviceId } },
    manifest_jsonb: null,
    deleted_at_ts: null,
    reincarnation: null,
    updated_at_ts: t,
    schema_version: 1,
  };
};

const makeClient = (provider: FileSyncProvider, deviceId: string, now = NOW) =>
  new S3ReplicaClient({ provider, spaceId: SPACE, deviceId, now: () => now });

describe('S3 replica transport', () => {
  test('two windows on one device merge concurrent pushes under the browser lock', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'locks');
    const queues = new Map<string, Promise<unknown>>();
    const request = vi.fn((name: string, operation: () => Promise<unknown>) => {
      const pending = (queues.get(name) ?? Promise.resolve()).then(operation);
      queues.set(
        name,
        pending.catch(() => {}),
      );
      return pending;
    });
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request } });
    try {
      const { provider } = makeProvider();
      const firstWindow = makeClient(provider, 'same-device');
      const secondWindow = makeClient(provider, 'same-device');

      await Promise.all([
        firstWindow.push([row('first', 'same-device')]),
        secondWindow.push([row('second', 'same-device')]),
      ]);

      expect((await firstWindow.pull('settings', null)).map((record) => record.replica_id)).toEqual(
        ['first', 'second'],
      );
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      if (original) Object.defineProperty(navigator, 'locks', original);
      else Reflect.deleteProperty(navigator, 'locks');
    }
  });

  test('keeps cumulative device state across pushes and a restart', async () => {
    const { provider } = makeProvider();
    await makeClient(provider, 'a').push([row('first')]);
    await makeClient(provider, 'a').push([row('second')]);
    expect(
      (await makeClient(provider, 'b').pull('settings', null)).map((r) => r.replica_id),
    ).toEqual(['first', 'second']);
  });

  test('independent devices never overwrite one another and merge with the existing CRDT rules', async () => {
    const { provider, files } = makeProvider();
    const a = makeClient(provider, 'a');
    const b = makeClient(provider, 'b');
    const first = row('singleton');
    const second = row('singleton', 'b', NOW + 1, {
      language: { v: 'zh', t: hlcPack(NOW + 1, 0, 'b'), s: 'b' },
    });
    await Promise.all([a.push([first]), b.push([second])]);
    expect(files.size).toBe(2);
    expect(await a.pull('settings', null)).toEqual([mergeReplica(first, second)]);
  });

  test('discovers a newly uploaded lower-clock row after a higher global cursor', async () => {
    const { provider } = makeProvider();
    const reader = makeClient(provider, 'reader');
    const high = row('new-clock', 'fast', NOW + 1000);
    await makeClient(provider, 'fast').push([high]);
    await reader.pull('settings', null);
    const late = row('late-clock', 'slow', NOW - 1000);
    await makeClient(provider, 'slow').push([late]);
    expect(await reader.pull('settings', high.updated_at_ts)).toContainEqual(late);
  });

  test('does not replay an unchanged row on a second incremental pull', async () => {
    const { provider } = makeProvider();
    const saved = row('singleton');
    await makeClient(provider, 'writer').push([saved]);
    const reader = makeClient(provider, 'reader');
    const pulled = await reader.pull('settings', null);
    expect(pulled).toEqual([saved]);
    for (const pulledRow of pulled) reader.acknowledgePull(pulledRow);

    expect(await reader.pull('settings', saved.updated_at_ts)).toEqual([]);
  });

  test('rejects a returned row after a newer local push completes and permits its fresh replacement', async () => {
    const { provider } = makeProvider();
    const client = makeClient(provider, 'a');
    const saved = row('singleton');
    await client.push([saved]);
    const pulled = (await client.pull('settings', null))[0]!;
    expect(client.canApplyPull(pulled)).toBe(true);
    const t = hlcPack(NOW + 1, 0, 'a');
    const replacement = row('singleton', 'a', NOW + 1, {
      theme: { v: 'newer-edit', t, s: 'a' },
    });
    await client.push([replacement]);

    expect(client.canApplyPull(pulled)).toBe(false);
    const fresh = (await client.pull('settings', null))[0]!;
    expect(fresh).toEqual(replacement);
    expect(client.canApplyPull(fresh)).toBe(true);
  });

  test('rejects a returned row after its credential policy generation is invalidated', async () => {
    const { provider } = makeProvider();
    await makeClient(provider, 'writer').push([row('singleton')]);
    const reader = makeClient(provider, 'reader');
    const pulled = (await reader.pull('settings', null))[0]!;
    expect(reader.canApplyPull(pulled)).toBe(true);
    reader.clearPullAcknowledgements();

    expect(reader.canApplyPull(pulled)).toBe(false);
  });

  test('does not accept rows that were not returned by the same client', async () => {
    const { provider } = makeProvider();
    const client = makeClient(provider, 'a');
    const saved = row('singleton');
    await client.push([saved]);
    const pulled = (await client.pull('settings', null))[0]!;

    expect(client.canApplyPull(pulled)).toBe(true);
    expect(client.canApplyPull(structuredClone(pulled))).toBe(false);
    expect(makeClient(provider, 'other').canApplyPull(pulled)).toBe(false);
  });

  test('a later successful application makes an earlier returned row stale', async () => {
    const { provider } = makeProvider();
    const writer = makeClient(provider, 'writer');
    const saved = row('singleton', 'writer');
    await writer.push([saved]);
    const reader = makeClient(provider, 'reader');
    const earlier = (await reader.pull('settings', null))[0]!;
    const t = hlcPack(NOW + 1, 0, 'writer');
    await writer.push([
      row('singleton', 'writer', NOW + 1, { theme: { v: 'newer-remote', t, s: 'writer' } }),
    ]);
    const later = (await reader.pull('settings', null))[0]!;
    reader.acknowledgePull(later);

    expect(reader.canApplyPull(earlier)).toBe(false);
    expect(reader.canApplyPull(later)).toBe(true);
  });

  test('failed and unrelated local pushes do not invalidate an otherwise current returned row', async () => {
    const { provider } = makeProvider();
    const client = makeClient(provider, 'a');
    const saved = row('singleton');
    await client.push([saved]);
    const pulled = (await client.pull('settings', null))[0]!;
    vi.mocked(provider.writeText).mockRejectedValueOnce(new FileSyncError('offline', 'NETWORK'));
    await expect(client.push([row('singleton', 'a', NOW + 1)])).rejects.toThrow('offline');
    expect(client.canApplyPull(pulled)).toBe(true);
    await client.push([row('unrelated', 'a', NOW + 2)]);

    expect(client.canApplyPull(pulled)).toBe(true);
  });

  test('revocation rejects an old cipher token without blocking a freshly reset row', async () => {
    const { provider } = makeProvider();
    const client = makeClient(provider, 'a');
    const salt = await client.createReplicaKey(ALG);
    const t = hlcPack(NOW, 0, 'a');
    await client.push([
      row('singleton', 'a', NOW, {
        theme: { v: 'saved', t, s: 'a' },
        password: {
          v: { c: 'cipher', i: 'iv', s: salt.saltId, alg: 'aes-256-gcm', h: 'hash' },
          t,
          s: 'a',
        },
      }),
    ]);
    const beforeReset = (await client.pull('settings', null))[0]!;
    expect(client.canApplyPull(beforeReset)).toBe(true);
    await client.forgetReplicaKeys();

    expect(client.canApplyPull(beforeReset)).toBe(false);
    const reset = (await client.pull('settings', null))[0]!;
    expect(reset.fields_jsonb['password']).toBeUndefined();
    expect(client.canApplyPull(reset)).toBe(true);
  });

  test('incremental discovery returns only the row whose lower-clock field changed', async () => {
    const { provider } = makeProvider();
    const reader = makeClient(provider, 'reader');
    const unchanged = row('unchanged', 'fast', NOW + 2000);
    const high = row('singleton', 'fast', NOW + 1000);
    await makeClient(provider, 'fast').push([unchanged, high]);
    for (const pulledRow of await reader.pull('settings', null)) reader.acknowledgePull(pulledRow);
    const late = row('singleton', 'slow', NOW - 1000, {
      language: { v: 'zh', t: hlcPack(NOW - 1000, 0, 'slow'), s: 'slow' },
    });
    await makeClient(provider, 'slow').push([late]);

    expect(await reader.pull('settings', unchanged.updated_at_ts)).toEqual([
      mergeReplica(high, late),
    ]);
  });

  test('does not echo its last successful push over a newer local edit', async () => {
    const { provider } = makeProvider();
    const client = makeClient(provider, 'a');
    const saved = row('singleton');
    await client.push([saved]);
    for (const pulledRow of await client.pull('settings', null)) client.acknowledgePull(pulledRow);
    const published = row('singleton', 'a', NOW + 1);
    await client.push([published]);

    expect(await client.pull('settings', saved.updated_at_ts)).toEqual([]);
  });

  test('retries rows without an apply acknowledgement and always permits a full replay', async () => {
    const { provider } = makeProvider();
    const saved = row('singleton');
    await makeClient(provider, 'writer').push([saved]);
    const reader = makeClient(provider, 'reader');
    const pulled = await reader.pull('settings', null);
    expect(await reader.pull('settings', saved.updated_at_ts)).toEqual([saved]);
    reader.acknowledgePull(pulled[0]!);
    expect(await reader.pull('settings', saved.updated_at_ts)).toEqual([]);
    expect(await reader.pull('settings', null)).toEqual([saved]);
  });

  test('isolates acknowledged wire state from later full-replay decryption mutations', async () => {
    const { provider } = makeProvider();
    const saved = row('singleton');
    await makeClient(provider, 'writer').push([saved]);
    const reader = makeClient(provider, 'reader');
    const first = await reader.pull('settings', null);
    reader.acknowledgePull(first[0]!);
    const replay = await reader.pull('settings', null);
    replay[0]!.fields_jsonb['theme']!.v = 'local-decrypted-value';

    expect(await reader.pull('settings', saved.updated_at_ts)).toEqual([]);
  });

  test('policy invalidation rejects late acknowledgements and preserves its successful pushes', async () => {
    const { provider } = makeProvider();
    const saved = row('remote');
    await makeClient(provider, 'writer').push([saved]);
    const reader = makeClient(provider, 'reader');
    const oldPolicy = await reader.pull('settings', null);
    reader.acknowledgePull(oldPolicy[0]!);
    const own = row('own', 'reader', NOW + 1);
    await reader.push([own]);
    reader.clearPullAcknowledgements();
    reader.acknowledgePull(oldPolicy[0]!);

    const replayed = await reader.pull('settings', own.updated_at_ts);
    expect(replayed).toEqual([own, saved]);
    for (const pulledRow of replayed) reader.acknowledgePull(pulledRow);
    expect(await reader.pull('settings', own.updated_at_ts)).toEqual([]);
  });

  test('a pull already reading an old snapshot cannot echo it after a newer push completes', async () => {
    const { provider, files } = makeProvider();
    const client = makeClient(provider, 'a');
    const saved = row('singleton');
    await client.push([saved]);
    for (const pulledRow of await client.pull('settings', null)) client.acknowledgePull(pulledRow);
    const snapshotPath = Array.from(files.keys())[0]!;
    let releaseRead = () => {};
    let notifyRead = () => {};
    const release = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const captured = new Promise<void>((resolve) => {
      notifyRead = resolve;
    });
    let holdRead = true;
    vi.mocked(provider.readText).mockImplementation(async (path) => {
      const text = files.get(path) ?? null;
      if (path === snapshotPath && holdRead) {
        holdRead = false;
        notifyRead();
        await release;
      }
      return text;
    });
    const pulling = client.pull('settings', saved.updated_at_ts);
    await captured;
    const t = hlcPack(NOW + 1, 0, 'a');
    await client.push([row('singleton', 'a', NOW + 1, { theme: { v: 'newer-edit', t, s: 'a' } })]);
    releaseRead();

    expect(await pulling).toEqual([]);
  });

  test('object key order alone does not replay acknowledged rows', async () => {
    const { provider, files } = makeProvider();
    const t = hlcPack(NOW, 0, 'writer');
    const saved = row('singleton', 'writer', NOW, {
      theme: { v: { first: 1, second: 2 }, t, s: 'writer' },
    });
    await makeClient(provider, 'writer').push([saved]);
    const reader = makeClient(provider, 'reader');
    const pulled = await reader.pull('settings', null);
    reader.acknowledgePull(pulled[0]!);
    const reordered = {
      ...saved,
      fields_jsonb: { theme: { s: 'writer', t, v: { second: 2, first: 1 } } },
    };
    files.set(
      Array.from(files.keys())[0]!,
      JSON.stringify({
        format: 1,
        spaceId: SPACE,
        deviceId: 'writer',
        kind: 'settings',
        rows: [reordered],
      }),
    );

    expect(await reader.pull('settings', saved.updated_at_ts)).toEqual([]);
  });

  test('a metadata-only push does not acknowledge cumulative credentials it never submitted', async () => {
    const { provider } = makeProvider();
    const initial = makeClient(provider, 'a');
    const salt = await initial.createReplicaKey(ALG);
    const t = hlcPack(NOW, 0, 'a');
    const saved = row('singleton', 'a', NOW, {
      theme: { v: 'saved', t, s: 'a' },
      password: {
        v: { c: 'cipher', i: 'iv', s: salt.saltId, alg: 'aes-256-gcm', h: 'hash' },
        t,
        s: 'a',
      },
    });
    await initial.push([saved]);
    const restarted = makeClient(provider, 'a');
    const pulled = await restarted.pull('settings', null);
    restarted.acknowledgePull(pulled[0]!);
    const newer = hlcPack(NOW + 1, 0, 'a');
    const patch = row('singleton', 'a', NOW + 1, {
      theme: { v: 'newer-metadata', t: newer, s: 'a' },
    });
    await restarted.push([patch]);
    restarted.clearPullAcknowledgements();

    expect(await restarted.pull('settings', patch.updated_at_ts)).toEqual([
      mergeReplica(saved, patch),
    ]);
  });

  test.each([
    'font',
    'dictionary',
    'texture',
  ])('a successful %s metadata push without a manifest remains available for binary repair', async (kind) => {
    const { provider } = makeProvider();
    const client = makeClient(provider, 'a');
    const metadata = { ...row('binary-resource'), kind };
    await client.push([metadata]);

    expect(await client.pull(kind, metadata.updated_at_ts)).toEqual([metadata]);
    expect(await client.pull(kind, metadata.updated_at_ts)).toEqual([metadata]);
  });

  test('discovers a lower-clock field on an existing row without losing the newer field', async () => {
    const { provider } = makeProvider();
    const reader = makeClient(provider, 'reader');
    const high = row('singleton', 'fast', NOW + 1000);
    await makeClient(provider, 'fast').push([high]);
    await reader.pull('settings', null);
    const late = row('singleton', 'slow', NOW - 1000, {
      language: { v: 'zh', t: hlcPack(NOW - 1000, 0, 'slow'), s: 'slow' },
    });
    await makeClient(provider, 'slow').push([late]);
    expect(await reader.pull('settings', high.updated_at_ts)).toEqual([mergeReplica(high, late)]);
  });

  test('serializes simultaneous pushes from the same device', async () => {
    const { provider } = makeProvider();
    const client = makeClient(provider, 'a');
    await Promise.all([client.push([row('first')]), client.push([row('second')])]);
    expect(await client.pull('settings', null)).toHaveLength(2);
  });

  test('a failed write stays queued and a retry includes earlier successful state', async () => {
    const { provider } = makeProvider();
    const client = makeClient(provider, 'a');
    await client.push([row('first')]);
    vi.mocked(provider.writeText).mockRejectedValueOnce(new FileSyncError('offline', 'NETWORK'));
    const manager = new ReplicaSyncManager({
      client,
      hlc: new HlcGenerator('a', () => NOW),
      cursorStore: { get: () => null, set: () => {} },
      debounceMs: 60_000,
    });
    manager.markDirty(row('second'));
    await expect(manager.flush()).rejects.toThrow('offline');
    expect(manager.pendingCount()).toBe(1);
    await manager.flush();
    expect(manager.pendingCount()).toBe(0);
    expect(await client.pull('settings', null)).toHaveLength(2);
  });

  test.each([
    'json',
    'schema',
    'owner',
    'kind',
    'row',
  ] as const)('a remote %s error can be retried after repair without editing the original dirty row', async (corruption) => {
    const { provider, files } = makeProvider();
    const client = makeClient(provider, 'a');
    await client.push([row('first')]);
    const path = Array.from(files.keys())[0]!;
    const original = files.get(path)!;
    const broken = {
      json: '{broken',
      schema: JSON.stringify({
        format: 1,
        spaceId: SPACE,
        deviceId: 'a',
        kind: 'settings',
        rows: null,
      }),
      owner: original.replace('"deviceId":"a"', '"deviceId":"another-device"'),
      kind: original.replace('"kind":"settings"', '"kind":"font"'),
      row: original.replace(`"user_id":"${SPACE}"`, '"user_id":"another-space"'),
    }[corruption];
    files.set(path, broken);
    const manager = new ReplicaSyncManager({
      client,
      hlc: new HlcGenerator('a', () => NOW),
      cursorStore: { get: () => null, set: () => {} },
      debounceMs: 60_000,
    });
    manager.markDirty(row('second'));
    await expect(manager.flush()).rejects.toMatchObject({ code: 'SERVER' });
    expect(manager.pendingCount()).toBe(1);
    files.set(path, original);
    await manager.flush();
    expect(manager.pendingCount()).toBe(0);
    expect(await client.pull('settings', null)).toHaveLength(2);
  });

  test('returns every requested kind in a batch and resolves a lazy provider', async () => {
    const { provider } = makeProvider();
    const resolveProvider = vi.fn(async () => provider);
    const client = new S3ReplicaClient({
      provider: resolveProvider,
      spaceId: SPACE,
      deviceId: 'a',
    });
    const first = row('singleton');
    await client.push([first]);
    expect(
      await client.pullBatch([
        { kind: 'settings', since: first.updated_at_ts },
        { kind: 'font', since: null },
      ]),
    ).toEqual([
      { kind: 'settings', rows: [first] },
      { kind: 'font', rows: [] },
    ]);
    expect(resolveProvider).toHaveBeenCalled();
  });

  test('fails a pull rather than returning a partial snapshot when one device object cannot be read', async () => {
    const { provider } = makeProvider();
    const client = makeClient(provider, 'a');
    await client.push([row('first')]);
    vi.mocked(provider.readText).mockRejectedValueOnce(new FileSyncError('offline', 'NETWORK'));
    await expect(client.pull('settings', null)).rejects.toThrow('offline');
  });

  test('rejects another library identity and refuses malformed cumulative state', async () => {
    const { provider, files } = makeProvider();
    const client = makeClient(provider, 'a');
    await expect(
      client.push([{ ...row('first'), user_id: 'another-space' }]),
    ).rejects.toMatchObject({ code: 'VALIDATION' });
    expect(files.size).toBe(0);
    await client.push([row('first')]);
    const path = Array.from(files.keys())[0]!;
    files.set(path, '{broken');
    await expect(client.pull('settings', null)).rejects.toThrow();
  });

  test('refuses a partial row envelope instead of confirming a damaged snapshot', async () => {
    const { provider, files } = makeProvider();
    const client = makeClient(provider, 'a');
    await client.push([row('singleton')]);
    const path = Array.from(files.keys())[0]!;
    files.set(path, files.get(path)!.replace('"v":"singleton",', ''));
    await expect(client.pull('settings', null)).rejects.toThrow();
  });

  test('preserves an existing row tombstone while accepting a stale live row from another device', async () => {
    const { provider } = makeProvider();
    const first = row('singleton');
    const deleted = {
      ...first,
      deleted_at_ts: hlcPack(NOW + 10, 0, 'a'),
      updated_at_ts: hlcPack(NOW + 10, 0, 'a'),
    };
    await makeClient(provider, 'a').push([deleted]);
    await makeClient(provider, 'b').push([first]);
    expect(await makeClient(provider, 'c').pull('settings', null)).toEqual([
      mergeReplica(deleted, first),
    ]);
  });
});

describe('S3 replica passphrase keys', () => {
  test('the existing CryptoSession can encrypt and unlock on another device through S3', async () => {
    const { provider, files } = makeProvider();
    const store = {
      get: async () => null,
      set: async () => {},
      clear: async () => {},
      isAvailable: () => true,
    };
    const first = new CryptoSession({ client: makeClient(provider, 'a'), store, iterations: 1000 });
    await first.setup('personal-passphrase');
    const cipher = await first.encryptField('private-password');
    const t = hlcPack(NOW, 0, 'a');
    await makeClient(provider, 'a').push([
      row('singleton', 'a', NOW, { password: { v: cipher, t, s: 'a' } }),
    ]);
    expect(Array.from(files.entries()).some(([path]) => path.includes('/cipher/'))).toBe(true);
    const snapshots = Array.from(files.entries()).filter(([path]) => path.includes('/replicas/'));
    expect(snapshots.map(([, text]) => text).join('\n')).not.toContain(cipher.c);
    const pulled = await makeClient(provider, 'b').pull('settings', null);
    const remoteCipher = pulled[0]!.fields_jsonb['password']!.v as CipherEnvelope;
    expect(remoteCipher).toEqual(cipher);
    const second = new CryptoSession({
      client: makeClient(provider, 'b'),
      store,
      iterations: 1000,
    });
    await second.unlock('personal-passphrase', { verifyWith: remoteCipher });
    expect(await second.decryptField(remoteCipher)).toBe('private-password');
  });

  test('persists independent salts, lists newest first, and works after restart', async () => {
    const { provider } = makeProvider();
    const first = await makeClient(provider, 'a').createReplicaKey(ALG);
    const second = await makeClient(provider, 'b', NOW + 1).createReplicaKey(ALG);
    expect(await makeClient(provider, 'c').listReplicaKeys()).toEqual([second, first]);
    expect(first.alg).toBe(ALG);
    expect(atob(first.salt).length).toBe(16);
    expect(second.saltId).not.toBe(first.saltId);
  });

  test('forget removes ciphertext while preserving plain fields and prevents offline salt resurrection', async () => {
    const { provider, files } = makeProvider();
    const stale = makeClient(provider, 'offline', NOW + 50_000);
    const salt = await stale.createReplicaKey(ALG);
    const backup = new Map(files);
    const t = hlcPack(NOW, 0, 'offline');
    const encrypted = row('singleton', 'offline', NOW, {
      theme: { v: 'dark', t, s: 'offline' },
      password: {
        v: { c: 'cipher', i: 'iv', s: salt.saltId, alg: 'aes-256-gcm', h: 'hash' },
        t,
        s: 'offline',
      },
    });
    await stale.push([encrypted]);
    const active = makeClient(provider, 'active');
    await active.forgetReplicaKeys();
    expect(await active.listReplicaKeys()).toEqual([]);
    // An old device reconnects with a clock ahead of the forgetting device.
    for (const [path, text] of backup) files.set(path, text);
    await stale.push([encrypted]);
    expect(await makeClient(provider, 'new').listReplicaKeys()).toEqual([]);
    expect((await active.pull('settings', null))[0]?.fields_jsonb).toEqual({
      theme: encrypted.fields_jsonb['theme'],
    });
    const next = await makeClient(provider, 'new').createReplicaKey(ALG);
    expect(await active.listReplicaKeys()).toEqual([next]);
  });

  test('failed forget never reports success or revokes the current salt locally', async () => {
    const { provider } = makeProvider();
    const client = makeClient(provider, 'a');
    const salt = await client.createReplicaKey(ALG);
    vi.mocked(provider.writeText).mockRejectedValueOnce(new FileSyncError('offline', 'NETWORK'));
    await expect(client.forgetReplicaKeys()).rejects.toThrow('offline');
    expect(await client.listReplicaKeys()).toEqual([salt]);
  });

  test('creating a new salt from a stale device object does not re-upload its forgotten salts', async () => {
    const { provider, files } = makeProvider();
    const stale = makeClient(provider, 'stale');
    const forgotten = await stale.createReplicaKey(ALG);
    const backup = new Map(files);
    await makeClient(provider, 'active').forgetReplicaKeys();
    for (const [path, text] of backup) files.set(path, text);
    await stale.createReplicaKey(ALG);
    expect(Array.from(files.values()).join('\n')).not.toContain(forgotten.salt);
  });

  test('forget deletes current cipher objects without changing another device metadata or requiring CAS', async () => {
    const { provider, files } = makeProvider();
    const other = makeClient(provider, 'other');
    const salt = await other.createReplicaKey(ALG);
    const t = hlcPack(NOW, 0, 'other');
    await other.push([
      row('singleton', 'other', NOW, {
        theme: { v: 'dark', t, s: 'other' },
        password: {
          v: { c: 'remote-secret-cipher', i: 'iv', s: salt.saltId, alg: 'aes-256-gcm', h: 'hash' },
          t,
          s: 'other',
        },
      }),
    ]);
    const metadata = new Map(Array.from(files).filter(([path]) => path.includes('/replicas/')));
    await makeClient(provider, 'forgetting').forgetReplicaKeys();
    const currentObjects = Array.from(files.values()).join('\n');
    expect(currentObjects).not.toContain('remote-secret-cipher');
    expect(currentObjects).toContain('dark');
    expect(Array.from(files.keys()).filter((path) => path.includes('/cipher/'))).toEqual([]);
    for (const [path, text] of metadata) expect(files.get(path)).toBe(text);
  });

  test('forget preserves a concurrent plain-field edit without writing the other device snapshot', async () => {
    const { provider, files } = makeProvider();
    const client = makeClient(provider, 'a');
    const salt = await client.createReplicaKey(ALG);
    const t = hlcPack(NOW, 0, 'a');
    await client.push([
      row('singleton', 'a', NOW, {
        theme: { v: 'dark', t, s: 'a' },
        password: {
          v: { c: 'cipher', i: 'iv', s: salt.saltId, alg: 'aes-256-gcm', h: 'hash' },
          t,
          s: 'a',
        },
      }),
    ]);
    const metadataPath = Array.from(files.keys()).find((path) => path.includes('/replicas/'))!;
    vi.mocked(provider.deleteDir).mockImplementationOnce(async (prefix) => {
      const state = JSON.parse(files.get(metadataPath)!) as { rows: ReplicaRow[] };
      state.rows[0]!.fields_jsonb['language'] = {
        v: 'zh',
        t: hlcPack(NOW + 1, 0, 'a'),
        s: 'a',
      };
      files.set(metadataPath, JSON.stringify(state));
      for (const path of files.keys()) if (path.startsWith(`${prefix}/`)) files.delete(path);
    });
    vi.mocked(provider.writeText).mockClear();
    await makeClient(provider, 'forgetting').forgetReplicaKeys();
    expect((await client.pull('settings', null))[0]?.fields_jsonb['language']?.v).toBe('zh');
    expect(
      vi.mocked(provider.writeText).mock.calls.every(([path]) => !path.includes('/replicas/')),
    ).toBe(true);
    expect(Array.from(files.values()).join('\n')).not.toContain('"c":"cipher"');
  });

  test('forget reports a cleanup failure after the durable reset still invalidates old salts', async () => {
    const { provider } = makeProvider();
    const other = makeClient(provider, 'other');
    const salt = await other.createReplicaKey(ALG);
    const t = hlcPack(NOW, 0, 'other');
    await other.push([
      row('singleton', 'other', NOW, {
        password: {
          v: { c: 'cipher', i: 'iv', s: salt.saltId, alg: 'aes-256-gcm', h: 'hash' },
          t,
          s: 'other',
        },
      }),
    ]);
    vi.mocked(provider.deleteDir).mockRejectedValueOnce(new FileSyncError('offline', 'NETWORK'));
    const client = makeClient(provider, 'forgetting');
    await expect(client.forgetReplicaKeys()).rejects.toThrow('offline');
    expect(await client.listReplicaKeys()).toEqual([]);
  });

  test('a late cipher upload under a forgotten salt is ignored and cleaned on pull', async () => {
    const { provider, files } = makeProvider();
    const other = makeClient(provider, 'other');
    const salt = await other.createReplicaKey(ALG);
    const t = hlcPack(NOW, 0, 'other');
    await other.push([
      row('singleton', 'other', NOW, {
        password: {
          v: { c: 'late-cipher', i: 'iv', s: salt.saltId, alg: 'aes-256-gcm', h: 'hash' },
          t,
          s: 'other',
        },
      }),
    ]);
    const backup = new Map(Array.from(files).filter(([path]) => path.includes('/cipher/')));
    expect(backup.size).toBe(1);
    const active = makeClient(provider, 'active');
    await active.forgetReplicaKeys();
    for (const [path, text] of backup) files.set(path, text);
    expect((await active.pull('settings', null))[0]?.fields_jsonb['password']).toBeUndefined();
    expect(Array.from(files.keys()).filter((path) => path.includes('/cipher/'))).toEqual([]);
  });

  test('missing active cipher content fails a pull, while missing revoked content is harmless', async () => {
    const { provider, files } = makeProvider();
    const client = makeClient(provider, 'a');
    const salt = await client.createReplicaKey(ALG);
    const t = hlcPack(NOW, 0, 'a');
    await client.push([
      row('singleton', 'a', NOW, {
        password: {
          v: { c: 'cipher', i: 'iv', s: salt.saltId, alg: 'aes-256-gcm', h: 'hash' },
          t,
          s: 'a',
        },
      }),
    ]);
    for (const path of files.keys()) if (path.includes('/cipher/')) files.delete(path);
    await expect(client.pull('settings', null)).rejects.toThrow('cipher');
    await makeClient(provider, 'other').forgetReplicaKeys();
    expect((await client.pull('settings', null))[0]?.fields_jsonb['password']).toBeUndefined();
  });

  test('a failed cipher upload never publishes a broken metadata reference', async () => {
    const { provider, files } = makeProvider();
    const client = makeClient(provider, 'a');
    const salt = await client.createReplicaKey(ALG);
    const t = hlcPack(NOW, 0, 'a');
    vi.mocked(provider.writeText).mockRejectedValueOnce(new FileSyncError('offline', 'NETWORK'));
    await expect(
      client.push([
        row('singleton', 'a', NOW, {
          password: {
            v: { c: 'cipher', i: 'iv', s: salt.saltId, alg: 'aes-256-gcm', h: 'hash' },
            t,
            s: 'a',
          },
        }),
      ]),
    ).rejects.toThrow('offline');
    expect(Array.from(files.keys()).some((path) => path.includes('/replicas/'))).toBe(false);
  });

  test('refuses a malformed cipher reference instead of returning it as a plaintext field', async () => {
    const { provider, files } = makeProvider();
    const client = makeClient(provider, 'a');
    await client.push([row('singleton')]);
    const path = Array.from(files.keys())[0]!;
    files.set(
      path,
      files
        .get(path)!
        .replace(
          '"v":"singleton"',
          '"v":{"type":"readest-replica-cipher-v1","saltId":"../escape","id":"invalid"}',
        ),
    );
    await expect(client.pull('settings', null)).rejects.toThrow('reference');
  });
});
