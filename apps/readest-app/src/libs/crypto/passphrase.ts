import { SyncError } from '@/libs/errors';
import { isTauriAppPlatform } from '@/services/environment';
import { getPrivateS3Identity, isPrivateS3Mode } from '@/services/sync/privateS3';
import {
  clearSyncPassphrase,
  getSyncPassphrase,
  isSyncKeychainAvailable,
  setSyncPassphrase,
  setSecureItem,
  getSecureItem,
  clearSecureItem,
} from '@/utils/bridge';

export interface PassphraseStore {
  set(passphrase: string): Promise<void>;
  get(): Promise<string | null>;
  clear(): Promise<void>;
  isAvailable(): boolean;
}

/**
 * In-memory passphrase store. Lifetime is "this page load" — every
 * hard refresh wipes it. This is the default on web; the cipher
 * fingerprint heuristic in replicaPullAndApply.applyRow makes sure a
 * fresh page doesn't re-prompt on pull as long as the local copy's
 * lastSeenCipher matches the row's incoming cipher.
 *
 * The only path that still re-prompts after refresh is adding a new
 * credentialed catalog (the encrypt path needs an unlocked session).
 * That's an infrequent action; not worth the XSS surface of
 * persisting the passphrase to localStorage / sessionStorage.
 *
 * On Tauri, this store is replaced at boot by TauriPassphraseStore
 * via upgradeToKeychainIfAvailable; the OS keychain provides
 * cross-launch persistence on native without the XSS surface.
 */
export class EphemeralPassphraseStore implements PassphraseStore {
  private value: string | null = null;

  async set(passphrase: string): Promise<void> {
    this.value = passphrase;
  }

  async get(): Promise<string | null> {
    return this.value;
  }

  async clear(): Promise<void> {
    this.value = null;
  }

  isAvailable(): boolean {
    return true;
  }
}

/**
 * OS-keychain backed passphrase store. Calls the native-bridge plugin
 * commands wired in PR 4d:
 *   * macOS / Windows / Linux desktop → keyring crate (Security
 *     framework / Credential Manager / libsecret).
 *   * iOS → Security framework Keychain via SecItemAdd/Copy/Delete.
 *   * Android → EncryptedSharedPreferences (AndroidKeystore-derived
 *     AES-GCM master key).
 *
 * `set` is fail-loud: if the keychain rejects the write, the caller
 * sees the error so the UI can warn the user. `get` is fail-soft:
 * keychain errors return null so the gate falls back to prompting.
 */
export class TauriPassphraseStore implements PassphraseStore {
  private async privateKey(): Promise<string> {
    const { useSettingsStore } = await import('@/store/settingsStore');
    const spaceId = getPrivateS3Identity(useSettingsStore.getState().settings);
    if (!spaceId) throw new SyncError('CRYPTO_UNAVAILABLE', 'Private S3 is not configured');
    return `readest-private-s3:passphrase:${spaceId}`;
  }

  async set(passphrase: string): Promise<void> {
    const res = isPrivateS3Mode()
      ? await setSecureItem({ key: await this.privateKey(), value: passphrase })
      : await setSyncPassphrase({ passphrase });
    if (!res.success) {
      throw new SyncError(
        'CRYPTO_UNAVAILABLE',
        `OS keychain rejected the passphrase: ${res.error ?? 'unknown error'}`,
      );
    }
  }

  async get(): Promise<string | null> {
    try {
      if (isPrivateS3Mode()) {
        const res = await getSecureItem({ key: await this.privateKey() });
        return res.value ?? null;
      }
      const res = await getSyncPassphrase();
      if (res.error) {
        console.warn('[passphrase] keychain get failed', res.error);
        return null;
      }
      return res.passphrase ?? null;
    } catch (err) {
      console.warn('[passphrase] keychain get threw', err);
      return null;
    }
  }

  async clear(): Promise<void> {
    try {
      if (isPrivateS3Mode()) {
        await clearSecureItem({ key: await this.privateKey() });
        return;
      }
      await clearSyncPassphrase();
    } catch (err) {
      console.warn('[passphrase] keychain clear threw', err);
    }
  }

  isAvailable(): boolean {
    return true;
  }
}

let cached: PassphraseStore | null = null;

/**
 * Pick the right backend at boot. On Tauri, probe the native bridge
 * once and cache the result; if the keychain is reachable use it,
 * otherwise fall back to the ephemeral store. The probe is async; the
 * sync `createPassphraseStore` returns ephemeral immediately and
 * `upgradeToKeychainIfAvailable` swaps the cached backend in once the
 * probe resolves. CryptoSession reads the current backend each time
 * it touches storage, so the swap is transparent.
 */
export const createPassphraseStore = (): PassphraseStore => {
  if (cached) return cached;
  cached = new EphemeralPassphraseStore();
  return cached;
};

export const upgradeToKeychainIfAvailable = async (): Promise<PassphraseStore> => {
  const current = createPassphraseStore();
  if (current instanceof TauriPassphraseStore) return current;
  if (!isTauriAppPlatform()) return current;
  try {
    const res = await isSyncKeychainAvailable();
    if (res.available) {
      cached = new TauriPassphraseStore();
      return cached;
    }
  } catch (err) {
    console.warn('[passphrase] keychain probe threw, staying on ephemeral', err);
  }
  return current;
};

/** Test seam — reset the cached backend between specs. */
export const __resetPassphraseStoreForTests = (): void => {
  cached = null;
};
