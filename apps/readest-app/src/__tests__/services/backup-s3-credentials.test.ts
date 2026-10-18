import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SYSTEM_SETTINGS } from '@/services/constants';
import type { SystemSettings } from '@/types/settings';
import type { AppService } from '@/types/system';

const mocks = vi.hoisted(() => ({
  entries: [] as { name: string; content: string }[],
  secure: new Map<string, string>(),
  invoke: vi.fn(),
  get: vi.fn(),
  set: vi.fn(),
  clear: vi.fn(),
}));

vi.mock('@/utils/bridge', () => ({
  getSecureItem: mocks.get,
  setSecureItem: mocks.set,
  clearSecureItem: mocks.clear,
}));
vi.mock('@/services/environment', () => ({ isTauriAppPlatform: () => true }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke, Channel: class {} }));
vi.mock('@/utils/zip', () => ({ configureZip: vi.fn() }));
vi.mock('@/services/statistics/statisticsDb', () => ({
  StatisticsDb: {
    open: async () => ({
      getEventsForPush: async () => ({ books: [], events: [] }),
      applyRemoteEvents: async () => {},
    }),
  },
}));
vi.mock('@zip.js/zip.js', () => ({
  BlobReader: class {},
  Uint8ArrayWriter: class {},
  ZipReader: class {
    async getEntries() {
      return mocks.entries.map(({ name, content }) => ({
        filename: name,
        directory: false,
        getData: async () => new TextEncoder().encode(content),
      }));
    }
    async close() {}
  },
}));

import { createBackupZipToFile, restoreFromBackupZip } from '@/services/backupService';
import { resolveS3Credentials } from '@/services/sync/providers/s3/credentials';

const keys = { accessKeyId: 'BACKUP_TEST_ACCESS', secretAccessKey: 'BACKUP_TEST_SECRET' };
const sourceRef = 'readest-private-s3:source-device';
const connection = {
  enabled: true,
  endpoint: 'https://s3.example.com',
  region: 'north',
  bucket: 'personal-books',
};
const defaultSettings = DEFAULT_SYSTEM_SETTINGS as SystemSettings;
const settings = (s3: SystemSettings['s3']): SystemSettings => ({
  ...structuredClone(defaultSettings),
  s3,
});

function device(initial: SystemSettings) {
  let persisted = JSON.stringify(initial);
  const saveSettings = vi.fn(async (value: SystemSettings) => {
    persisted = JSON.stringify(value);
  });
  const app = {
    loadLibraryBooks: async () => [],
    saveLibraryBooks: async () => {},
    loadSettings: async () => JSON.parse(persisted) as SystemSettings,
    saveSettings,
    resolveFilePath: async () => '/sandbox/Books',
    readDirectory: async () => [],
  } as unknown as AppService;
  return {
    app,
    saveSettings,
    read: () => JSON.parse(persisted) as SystemSettings,
    json: () => persisted,
  };
}

function backupWith(s3: SystemSettings['s3']) {
  mocks.entries = [
    { name: 'library.json', content: '[]' },
    { name: 'settings.json', content: JSON.stringify(settings(s3)) },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_PRIVATE_S3', 'true');
  mocks.entries = [];
  mocks.secure.clear();
  mocks.get.mockImplementation(async ({ key }: { key: string }) => ({
    value: mocks.secure.get(key),
  }));
  mocks.set.mockImplementation(async ({ key, value }: { key: string; value: string }) => {
    mocks.secure.set(key, value);
    return { success: true };
  });
  mocks.clear.mockImplementation(async ({ key }: { key: string }) => {
    mocks.secure.delete(key);
    return { success: true };
  });
  mocks.invoke.mockImplementation(
    async (_command: string, args: { entries: typeof mocks.entries }) => {
      mocks.entries = args.entries;
    },
  );
});
afterEach(() => vi.unstubAllEnvs());

describe('S3 credentials in library backups', () => {
  it('leaves credentials out without reading secure storage unless opted in', async () => {
    const source = device(settings({ ...connection, credentialRef: sourceRef }));
    mocks.secure.set(sourceRef, JSON.stringify(keys));
    await createBackupZipToFile(source.app, '/backup.zip');
    const snapshot = JSON.parse(
      mocks.entries.find((entry) => entry.name === 'settings.json')!.content,
    );
    expect(snapshot.s3).toEqual(connection);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it('restores an opted-in backup into a fresh device secure store and survives a settings reload', async () => {
    const source = device(settings({ ...connection, credentialRef: sourceRef }));
    mocks.secure.set(sourceRef, JSON.stringify(keys));
    await createBackupZipToFile(source.app, '/backup.zip', { includeCredentials: true });
    const snapshot = JSON.parse(
      mocks.entries.find((entry) => entry.name === 'settings.json')!.content,
    );
    expect(snapshot.s3).toEqual({ ...connection, ...keys });
    expect(source.json()).not.toContain(keys.secretAccessKey);
    mocks.secure.clear(); // Another device cannot read the source device's keychain.
    const target = device(settings({ ...defaultSettings.s3 }));
    expect(await restoreFromBackupZip(target.app, new Blob())).toMatchObject({
      settingsRestored: true,
    });
    const reloaded = target.read();
    expect(reloaded.s3).toMatchObject(connection);
    expect(reloaded.s3.credentialRef).toMatch(/^readest-private-s3:/);
    expect(reloaded.s3.credentialRef).not.toBe(sourceRef);
    expect(target.json()).not.toContain(keys.accessKeyId);
    expect(target.json()).not.toContain(keys.secretAccessKey);
    expect(await resolveS3Credentials(reloaded.s3)).toMatchObject(keys);
  });

  it('fails an opted-in backup when native credentials are unavailable instead of silently omitting settings', async () => {
    const source = device(settings({ ...connection, credentialRef: sourceRef }));
    await expect(
      createBackupZipToFile(source.app, '/backup.zip', { includeCredentials: true }),
    ).rejects.toThrow();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('updates keys for the same space and removes the replaced native entry only after settings save', async () => {
    const target = device(settings({ ...connection, credentialRef: sourceRef }));
    mocks.secure.set(sourceRef, JSON.stringify({ ...keys, secretAccessKey: 'OLD_TEST_SECRET' }));
    backupWith({ ...connection, ...keys });
    await restoreFromBackupZip(target.app, new Blob());
    expect(await resolveS3Credentials(target.read().s3)).toMatchObject(keys);
    expect(mocks.secure.has(sourceRef)).toBe(false);
    expect(target.saveSettings.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.clear.mock.invocationCallOrder[0]!,
    );
  });

  it('keeps an existing connection and keys when a backup belongs to another space', async () => {
    const target = device(
      settings({ ...connection, bucket: 'existing-books', credentialRef: sourceRef }),
    );
    const originalKeys = { ...keys, secretAccessKey: 'EXISTING_TEST_SECRET' };
    mocks.secure.set(sourceRef, JSON.stringify(originalKeys));
    backupWith({ ...connection, ...keys });
    await restoreFromBackupZip(target.app, new Blob());
    expect(target.read().s3.bucket).toBe('existing-books');
    expect(await resolveS3Credentials(target.read().s3)).toMatchObject(originalKeys);
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('removes a staged native key and keeps the previous connection when settings persistence fails', async () => {
    const target = device(settings({ ...connection, credentialRef: sourceRef }));
    mocks.secure.set(sourceRef, JSON.stringify(keys));
    target.saveSettings.mockRejectedValueOnce(new Error('disk full'));
    backupWith({ ...connection, ...keys });
    await expect(restoreFromBackupZip(target.app, new Blob())).rejects.toThrow();
    expect(target.read().s3.credentialRef).toBe(sourceRef);
    expect([...mocks.secure.keys()]).toEqual([sourceRef]);
  });

  it('reports native key-store failure without persisting a partial connection', async () => {
    const target = device(settings({ ...defaultSettings.s3 }));
    const original = target.json();
    mocks.set.mockResolvedValueOnce({ success: false });
    backupWith({ ...connection, ...keys });
    await expect(restoreFromBackupZip(target.app, new Blob())).rejects.toThrow();
    expect(target.json()).toBe(original);
    expect(target.saveSettings).not.toHaveBeenCalled();
  });

  it('rejects an incomplete credential pair before changing native storage or settings', async () => {
    const target = device(settings({ ...defaultSettings.s3 }));
    backupWith({ ...connection, accessKeyId: keys.accessKeyId });
    await expect(restoreFromBackupZip(target.app, new Blob())).rejects.toThrow();
    expect(mocks.set).not.toHaveBeenCalled();
    expect(target.saveSettings).not.toHaveBeenCalled();
  });

  it('restores opted-in credentials through the standard build settings contract', async () => {
    vi.stubEnv('NEXT_PUBLIC_PRIVATE_S3', 'false');
    const target = device(settings({ ...defaultSettings.s3 }));
    backupWith({ ...connection, ...keys });
    await restoreFromBackupZip(target.app, new Blob());
    expect(target.read().s3).toMatchObject({ ...connection, ...keys });
    expect(mocks.set).not.toHaveBeenCalled();
  });
});
