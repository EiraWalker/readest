import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { hlcPack } from '@/libs/crdt';
import { DEFAULT_SYSTEM_SETTINGS } from '@/services/constants';
import type { ReplicaRow } from '@/types/replica';
import type { SystemSettings } from '@/types/settings';

const boot = vi.hoisted(() => ({
  pull: vi.fn(),
  publish: vi.fn(),
  service: {},
  envConfig: {},
}));
vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService: boot.service, envConfig: boot.envConfig }),
}));
vi.mock('@/hooks/useSyncIdentity', () => ({ useSyncIdentity: () => 'private-space' }));
// The fake manager below supplies rows without transport delivery tokens.
// This suite exercises bootstrap ordering; delivery validity is tested separately.
vi.mock('@/libs/replicaSyncClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/libs/replicaSyncClient')>()),
  canApplyReplicaPull: async () => true,
  acknowledgeReplicaPull: async () => {},
}));
vi.mock('@/utils/access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/access')>()),
  getUserID: async () => 'private-space',
}));
vi.mock('@/services/sync/replicaSync', () => ({
  getReplicaSync: () => ({ manager: { pull: boot.pull } }),
  subscribeReplicaSyncReady: () => () => {},
}));
vi.mock('@/services/sync/replicaPublish', () => ({
  publishReplicaUpsert: (...args: unknown[]) => boot.publish(...args),
  publishReplicaDelete: vi.fn(),
  publishReplicaManifest: vi.fn(),
}));

import { useReplicaPull, __resetReplicaPullForTests } from '@/hooks/useReplicaPull';
import { __resetSettingsSyncForTests, initSettingsSync } from '@/services/sync/replicaSettingsSync';
import { useSettingsStore } from '@/store/settingsStore';

const localSettings = (): SystemSettings =>
  ({
    ...DEFAULT_SYSTEM_SETTINGS,
    globalViewSettings: {
      ...DEFAULT_SYSTEM_SETTINGS.globalViewSettings,
      userStylesheet: 'local-saved',
    },
    s3: {
      ...DEFAULT_SYSTEM_SETTINGS.s3,
      enabled: true,
      endpoint: 'https://s3.cn-north-1.qiniucs.com',
      bucket: 'private-library',
    },
  }) as SystemSettings;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv('NEXT_PUBLIC_PRIVATE_S3', 'true');
  __resetReplicaPullForTests();
  __resetSettingsSyncForTests();
  boot.publish.mockReset();
  boot.pull.mockReset();
  boot.pull.mockResolvedValue([]);
  // These tests exercise pull/publish ordering; crypto behavior is covered by
  // the CryptoSession suite. Keep hashing on the same microtask queue.
  vi.spyOn(crypto.subtle, 'digest').mockResolvedValue(new Uint8Array(32).buffer);
  const settings = localSettings();
  useSettingsStore.setState({ settings, saveSettings: vi.fn(async () => {}) });
  initSettingsSync(settings);
});

afterEach(() => {
  cleanup();
  __resetReplicaPullForTests();
  __resetSettingsSyncForTests();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const runBootPull = async () => {
  const view = renderHook(() => useReplicaPull({ kinds: ['settings'], delayMs: 0 }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  return view;
};

describe('private settings bootstrap through the existing pull hook', () => {
  test('an empty space receives preferences loaded from disk', async () => {
    await runBootPull();
    expect(boot.publish).toHaveBeenCalledWith(
      'settings',
      expect.objectContaining({
        patch: expect.objectContaining({
          globalViewSettings: expect.objectContaining({ userStylesheet: 'local-saved' }),
        }),
      }),
      'singleton',
    );
  });

  test('an existing space applies its preferences before enabling local publishing', async () => {
    const t = hlcPack(1_700_000_000_000, 0, 'other-device');
    const remote: ReplicaRow = {
      user_id: 'private-space',
      kind: 'settings',
      replica_id: 'singleton',
      fields_jsonb: {
        'globalViewSettings.userStylesheet': { v: 'remote-choice', t, s: 'other-device' },
      },
      manifest_jsonb: null,
      deleted_at_ts: null,
      reincarnation: null,
      updated_at_ts: t,
      schema_version: 1,
    };
    boot.pull.mockResolvedValue([remote]);
    await runBootPull();
    expect(useSettingsStore.getState().settings.globalViewSettings.userStylesheet).toBe(
      'remote-choice',
    );
    expect(boot.publish).not.toHaveBeenCalled();
  });

  test('a failed initial pull can seed after navigating back and retrying', async () => {
    boot.pull.mockRejectedValueOnce(new Error('offline'));
    const first = await runBootPull();
    expect(boot.publish).not.toHaveBeenCalled();
    first.unmount();
    await runBootPull();
    expect(boot.pull).toHaveBeenCalledTimes(2);
    expect(boot.publish).toHaveBeenCalled();
  });

  test('the existing online trigger retries a failed first pull without navigation', async () => {
    boot.pull.mockRejectedValueOnce(new Error('offline'));
    await runBootPull();
    expect(boot.publish).not.toHaveBeenCalled();
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(boot.pull).toHaveBeenCalledTimes(2);
    expect(boot.publish).toHaveBeenCalled();
  });
});
