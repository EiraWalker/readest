import { afterEach, expect, it, vi } from 'vitest';
const bridge = vi.hoisted(() => ({
  setSecureItem: vi.fn(async () => ({ success: true })),
  getSecureItem: vi.fn(async () => ({ value: 'local-passphrase' })),
  clearSecureItem: vi.fn(async () => ({ success: true })),
  setSyncPassphrase: vi.fn(async () => ({ success: true })),
  getSyncPassphrase: vi.fn(async () => ({ passphrase: 'daily-account-passphrase' })),
  clearSyncPassphrase: vi.fn(),
  isSyncKeychainAvailable: vi.fn(),
}));
vi.mock('@/utils/bridge', () => bridge);
vi.mock('@/services/sync/privateS3', () => ({
  isPrivateS3Mode: () => true,
  getPrivateS3Identity: () => 'new-space',
}));
import { TauriPassphraseStore } from '@/libs/crypto/passphrase';
afterEach(() => vi.clearAllMocks());
it('stores and removes only the private space passphrase, leaving the daily account key alone', async () => {
  const store = new TauriPassphraseStore();
  await store.set('local-passphrase');
  expect(await store.get()).toBe('local-passphrase');
  await store.clear();
  expect(bridge.setSecureItem).toHaveBeenCalledWith({
    key: 'readest-private-s3:passphrase:new-space',
    value: 'local-passphrase',
  });
  expect(bridge.clearSecureItem).toHaveBeenCalledWith({
    key: 'readest-private-s3:passphrase:new-space',
  });
  expect(bridge.setSyncPassphrase).not.toHaveBeenCalled();
});
