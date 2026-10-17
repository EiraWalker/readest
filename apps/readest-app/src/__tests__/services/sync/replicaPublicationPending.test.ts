import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ReplicaSyncContext } from '@/services/sync/replicaSync';
import type { CipherEnvelope, ReplicaRow } from '@/types/replica';

const state = vi.hoisted(
  (): {
    context: ReplicaSyncContext | null;
    credentials: boolean;
    identity: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
    encrypt: ReturnType<typeof vi.fn<(value: string) => Promise<CipherEnvelope>>>;
    push: ReturnType<typeof vi.fn<(rows: ReplicaRow[]) => Promise<ReplicaRow[]>>>;
  } => ({
    context: null,
    credentials: false,
    identity: vi.fn(async () => 'private-space'),
    encrypt: vi.fn(async () => ({ c: 'cipher', i: 'iv', s: 'salt', alg: 'test', h: 'hash' })),
    push: vi.fn(async (rows) => rows),
  }),
);
vi.mock('@/utils/access', () => ({ getUserID: () => state.identity() }));
vi.mock('@/services/sync/replicaSync', () => ({ getReplicaSync: () => state.context }));
vi.mock('@/services/sync/syncCategories', () => ({
  isSyncCategoryEnabled: () => true,
  isCredentialsSyncEnabled: () => state.credentials,
}));
vi.mock('@/libs/crypto/session', () => ({
  cryptoSession: { isUnlocked: () => true, encryptField: (value: string) => state.encrypt(value) },
}));

import { HlcGenerator } from '@/libs/crdt';
import { ReplicaSyncManager } from '@/services/sync/replicaSyncManager';
import { clearReplicaAdapters, registerReplicaAdapter } from '@/services/sync/replicaRegistry';
import { opdsCatalogAdapter } from '@/services/sync/adapters/opdsCatalog';
import {
  hasPendingReplicaPublication,
  publishReplicaDelete,
  publishReplicaManifest,
  publishReplicaUpsert,
} from '@/services/sync/replicaPublish';

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Uninitialized deferred');
  };
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const upsert = () =>
  publishReplicaUpsert(
    'opds_catalog',
    {
      id: 'catalog',
      name: 'Local edit',
      url: 'https://example.invalid/opds',
      password: 'synthetic',
    },
    'catalog',
  );

beforeEach(() => {
  state.credentials = false;
  state.identity.mockReset().mockResolvedValue('private-space');
  state.encrypt
    .mockReset()
    .mockResolvedValue({ c: 'cipher', i: 'iv', s: 'salt', alg: 'test', h: 'hash' });
  state.push.mockReset().mockImplementation(async (rows) => rows);
  const hlc = new HlcGenerator('device');
  state.context = {
    hlc,
    deviceId: 'device',
    manager: new ReplicaSyncManager({
      hlc,
      client: { push: (rows) => state.push(rows), pull: async () => [], pullBatch: async () => [] },
      cursorStore: { get: () => null, set: () => {} },
    }),
  };
  clearReplicaAdapters();
  registerReplicaAdapter(opdsCatalogAdapter);
});

afterEach(async () => {
  await state.context?.manager.flush();
  state.context = null;
  clearReplicaAdapters();
});

test.each([
  'upsert',
  'delete',
  'manifest',
])('%s protects the local edit before identity resolves', async (operation) => {
  const identity = deferred<string | null>();
  state.identity.mockReturnValue(identity.promise);
  const pending =
    operation === 'upsert'
      ? upsert()
      : operation === 'delete'
        ? publishReplicaDelete('opds_catalog', 'catalog')
        : publishReplicaManifest('opds_catalog', 'catalog', []);
  expect(hasPendingReplicaPublication('opds_catalog', 'catalog')).toBe(true);
  expect(state.context?.manager.hasPendingRow('opds_catalog', 'catalog')).toBe(false);
  identity.resolve('private-space');
  await pending;
  expect(hasPendingReplicaPublication('opds_catalog', 'catalog')).toBe(false);
  expect(state.context?.manager.hasPendingRow('opds_catalog', 'catalog')).toBe(true);
});

test('overlapping preparations remain protected until both finish', async () => {
  const firstIdentity = deferred<string | null>();
  const secondIdentity = deferred<string | null>();
  state.identity
    .mockReturnValueOnce(firstIdentity.promise)
    .mockReturnValueOnce(secondIdentity.promise);
  const first = upsert();
  const second = upsert();
  firstIdentity.resolve('private-space');
  await first;
  expect(hasPendingReplicaPublication('opds_catalog', 'catalog')).toBe(true);
  secondIdentity.resolve('private-space');
  await second;
  expect(hasPendingReplicaPublication('opds_catalog', 'catalog')).toBe(false);
});

test('encryption preparation is protected before the row enters the manager', async () => {
  state.credentials = true;
  const cipher = deferred<CipherEnvelope>();
  state.encrypt.mockReturnValue(cipher.promise);
  const pending = upsert();
  await vi.waitFor(() => expect(state.encrypt).toHaveBeenCalledOnce());
  expect(hasPendingReplicaPublication('opds_catalog', 'catalog')).toBe(true);
  expect(state.context?.manager.hasPendingRow('opds_catalog', 'catalog')).toBe(false);
  cipher.resolve({ c: 'cipher', i: 'iv', s: 'salt', alg: 'test', h: 'hash' });
  await pending;
  expect(hasPendingReplicaPublication('opds_catalog', 'catalog')).toBe(false);
  expect(state.context?.manager.hasPendingRow('opds_catalog', 'catalog')).toBe(true);
});

test('identity failure releases preparation protection without queueing a row', async () => {
  state.identity.mockRejectedValue(new Error('Synthetic identity failure'));
  await expect(upsert()).rejects.toThrow('Synthetic identity failure');
  expect(hasPendingReplicaPublication('opds_catalog', 'catalog')).toBe(false);
  expect(state.context?.manager.hasPendingRow('opds_catalog', 'catalog')).toBe(false);
});

test('a slower earlier encryption cannot replace the later edit in the upload queue', async () => {
  state.credentials = true;
  const olderCipher = deferred<CipherEnvelope>();
  const envelope = { c: 'cipher', i: 'iv', s: 'salt', alg: 'test', h: 'hash' };
  state.encrypt.mockImplementation(async (value) =>
    value === 'older' ? olderCipher.promise : envelope,
  );
  const older = publishReplicaUpsert(
    'opds_catalog',
    {
      id: 'catalog',
      name: 'Older edit',
      url: 'https://example.invalid/opds',
      password: 'older',
    },
    'catalog',
  );
  await vi.waitFor(() => expect(state.encrypt).toHaveBeenCalledWith('older'));
  await publishReplicaUpsert(
    'opds_catalog',
    {
      id: 'catalog',
      name: 'Newer edit',
      url: 'https://example.invalid/opds',
      password: 'newer',
    },
    'catalog',
  );
  olderCipher.resolve(envelope);
  await older;
  await state.context?.manager.flush();
  expect(state.push.mock.calls[0]?.[0][0]?.fields_jsonb['name']?.v).toBe('Newer edit');
});
