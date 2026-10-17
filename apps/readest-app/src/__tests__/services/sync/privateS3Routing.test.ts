import { afterEach, describe, expect, it, vi } from 'vitest';
import { hlcPack } from '@/libs/crdt';
import type { ReplicaRow } from '@/types/replica';

const clients = vi.hoisted(() => ({
  push: vi.fn(async () => []),
  pull: vi.fn(async () => []),
  pullBatch: vi.fn(async () => []),
  listReplicaKeys: vi.fn(async () => []),
  createReplicaKey: vi.fn(),
  forgetReplicaKeys: vi.fn(async () => {}),
  acknowledgePull: vi.fn<(row: ReplicaRow) => void>(),
  clearPullAcknowledgements: vi.fn(),
  canApplyPull: vi.fn<(row: ReplicaRow) => boolean>(() => policy.fresh),
}));
const policy = vi.hoisted(() => ({
  credentials: false,
  preparing: false,
  dirty: false,
  fresh: true,
}));
vi.mock('@/services/sync/syncCategories', () => ({
  isCredentialsSyncEnabled: () => policy.credentials,
}));
vi.mock('@/services/sync/replicaPublish', () => ({
  hasPendingReplicaPublication: () => policy.preparing,
}));
vi.mock('@/services/sync/replicaSync', () => ({
  getReplicaSync: () => ({ manager: { hasPendingRow: () => policy.dirty } }),
}));
vi.mock('@/services/sync/privateS3Runtime', () => ({
  getPrivateS3Runtime: async () => ({ replicaClient: clients }),
}));
vi.mock('@/utils/access', () => ({ getAccessToken: async () => null }));
import {
  acknowledgeReplicaPull,
  canApplyReplicaPull,
  ReplicaSyncClient,
} from '@/libs/replicaSyncClient';

const appliedRow: ReplicaRow = {
  user_id: 'private-space',
  kind: 'opds_catalog',
  replica_id: 'catalog',
  fields_jsonb: {},
  manifest_jsonb: null,
  deleted_at_ts: null,
  reincarnation: null,
  updated_at_ts: hlcPack(1_700_000_000_000, 0, 'device'),
  schema_version: 1,
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  policy.credentials = false;
  policy.preparing = false;
  policy.dirty = false;
  policy.fresh = true;
});

describe('private S3 replica routing', () => {
  it('defers projection during preparation, pending upload or a superseded response', async () => {
    vi.stubEnv('NEXT_PUBLIC_PRIVATE_S3', 'true');
    await expect(canApplyReplicaPull(appliedRow)).resolves.toBe(true);
    policy.preparing = true;
    await expect(canApplyReplicaPull(appliedRow)).resolves.toBe(false);
    policy.preparing = false;
    policy.dirty = true;
    await expect(canApplyReplicaPull(appliedRow)).resolves.toBe(false);
    policy.dirty = false;
    policy.fresh = false;
    await expect(canApplyReplicaPull(appliedRow)).resolves.toBe(false);
    policy.fresh = true;
    await expect(canApplyReplicaPull(appliedRow)).resolves.toBe(true);
    expect(clients.canApplyPull).toHaveBeenCalledWith(appliedRow);
  });

  it('leaves normal projection unguarded without accessing private storage', async () => {
    vi.stubEnv('NEXT_PUBLIC_PRIVATE_S3', 'false');
    await expect(canApplyReplicaPull(appliedRow)).resolves.toBe(true);
    expect(clients.canApplyPull).not.toHaveBeenCalled();
  });

  it('acknowledges the exact applied row only in private mode without official access', async () => {
    vi.stubEnv('NEXT_PUBLIC_PRIVATE_S3', 'true');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      await acknowledgeReplicaPull(appliedRow);
      expect(clients.acknowledgePull).toHaveBeenCalledExactlyOnceWith(appliedRow);
      expect(clients.acknowledgePull.mock.calls[0]?.[0]).toBe(appliedRow);
      vi.stubEnv('NEXT_PUBLIC_PRIVATE_S3', 'false');
      await acknowledgeReplicaPull(appliedRow);
      expect(clients.acknowledgePull).toHaveBeenCalledOnce();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('pulls categories and passphrase metadata without an official token or fetch', async () => {
    vi.stubEnv('NEXT_PUBLIC_PRIVATE_S3', 'true');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const client = new ReplicaSyncClient();
    await expect(client.pull('settings', null)).resolves.toEqual([]);
    await expect(client.pullBatch([{ kind: 'font', since: null }])).resolves.toEqual([]);
    await expect(client.listReplicaKeys()).resolves.toEqual([]);
    await expect(client.forgetReplicaKeys()).resolves.toBeUndefined();
    expect(clients.pull).toHaveBeenCalledWith('settings', null);
    expect(clients.forgetReplicaKeys).toHaveBeenCalledOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('replays previously skipped credentials on the next existing pull after a policy change', async () => {
    vi.stubEnv('NEXT_PUBLIC_PRIVATE_S3', 'true');
    const client = new ReplicaSyncClient();
    await client.pull('opds_catalog', null);
    clients.clearPullAcknowledgements.mockClear();
    clients.pull.mockClear();
    policy.credentials = true;
    await client.pull('opds_catalog', null);
    expect(clients.clearPullAcknowledgements).toHaveBeenCalledOnce();
    expect(clients.clearPullAcknowledgements.mock.invocationCallOrder[0]).toBeLessThan(
      clients.pull.mock.invocationCallOrder[0]!,
    );
    await client.pull('opds_catalog', null);
    expect(clients.clearPullAcknowledgements).toHaveBeenCalledOnce();
    policy.credentials = false;
    await client.pull('opds_catalog', null);
    expect(clients.clearPullAcknowledgements).toHaveBeenCalledTimes(2);
  });
});
