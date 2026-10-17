import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { DEFAULT_SYSTEM_SETTINGS } from '@/services/constants';
import { useSettingsStore } from '@/store/settingsStore';
import { getPrivateS3Identity } from '@/services/sync/privateS3';
import type { SystemSettings } from '@/types/settings';

const boot = vi.hoisted(() => ({
  upgrade: vi.fn(async () => {}),
  restore: vi.fn(async () => false),
  initializeLock: vi.fn(),
  applyBackground: vi.fn(),
  applyEink: vi.fn(),
}));

vi.mock('@/utils/polyfill', () => ({}));
vi.mock('@/i18n/i18n', () => ({ default: { on: vi.fn(), off: vi.fn() } }));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ appService: null, envConfig: {} }) }));
vi.mock('@/context/AuthContext', () => ({ AuthProvider: () => null }));
vi.mock('@/context/PHContext', () => ({ CSPostHogProvider: () => null, initPostHog: vi.fn() }));
vi.mock('@/context/SyncContext', () => ({ SyncProvider: () => null }));
vi.mock('@/context/DropdownContext', () => ({ DropdownProvider: () => null }));
vi.mock('@/store/themeStore', () => ({ initSystemThemeListener: vi.fn(), loadDataTheme: vi.fn() }));
vi.mock('@/hooks/useSafeAreaInsets', () => ({ useSafeAreaInsets: vi.fn() }));
vi.mock('@/hooks/useSettingsSync', () => ({ useSettingsSync: vi.fn() }));
vi.mock('@/hooks/useResponsiveSize', () => ({ useDefaultIconSize: () => 16 }));
vi.mock('@/hooks/useBackgroundTexture', () => ({
  useBackgroundTexture: () => ({ applyBackgroundTexture: boot.applyBackground }),
}));
vi.mock('@/hooks/useEinkMode', () => ({ useEinkMode: () => ({ applyEinkMode: boot.applyEink }) }));
vi.mock('@/utils/misc', () => ({
  getLocale: () => 'en',
  getUserLang: () => 'en',
  stubTranslation: (key: string) => key,
}));
vi.mock('@/store/appLockStore', () => ({
  useAppLockStore: () => ({
    isInitialized: true,
    isUnlocked: true,
    initialize: boot.initializeLock,
  }),
}));
vi.mock('@/services/sync/replicaSettingsSync', () => ({ initSettingsSync: vi.fn() }));
vi.mock('@/libs/crypto/passphrase', () => ({ upgradeToKeychainIfAvailable: boot.upgrade }));
vi.mock('@/libs/crypto/session', () => ({ cryptoSession: { tryRestoreFromStore: boot.restore } }));
vi.mock('@/components/WindowResizeHandles', () => ({ default: () => null }));
vi.mock('@/components/WindowOutline', () => ({ default: () => null }));
vi.mock('@/components/AtmosphereOverlay', () => ({ default: () => null }));
vi.mock('@/components/AppLockScreen', () => ({ default: () => null }));
vi.mock('@/components/CarMediaLibraryBridge', () => ({ default: () => null }));
vi.mock('@/components/FileSyncReport', () => ({ default: () => null }));
vi.mock('@/components/settings/AppLockDialog', () => ({ default: () => null }));
vi.mock('@/components/PassphrasePrompt', () => ({ default: () => null }));
vi.mock('@/components/TelemetryConsentDialog', () => ({ default: () => null }));
vi.mock('@/components/command-palette', () => ({
  CommandPaletteProvider: () => null,
  CommandPalette: () => null,
}));

import Providers from '@/components/Providers';

const unhydrated = useSettingsStore.getInitialState().settings;
const configuredSettings = (): SystemSettings => ({
  ...unhydrated,
  ...DEFAULT_SYSTEM_SETTINGS,
  version: 1,
  s3: {
    ...DEFAULT_SYSTEM_SETTINGS.s3,
    enabled: true,
    endpoint: 'https://s3.example.test',
    bucket: 'native-passphrase-test',
    credentialRef: 'readest-private-s3:synthetic',
  },
});

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_PRIVATE_S3', 'true');
  vi.clearAllMocks();
  useSettingsStore.setState({ settings: unhydrated });
  boot.restore.mockImplementation(
    async () => !!getPrivateS3Identity(useSettingsStore.getState().settings),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

test('private boot waits for delayed settings and restores with the configured space', async () => {
  render(<Providers>{null}</Providers>);
  await act(async () => {
    await Promise.resolve();
  });
  expect(boot.restore).not.toHaveBeenCalled();

  await act(async () => useSettingsStore.getState().setSettings(configuredSettings()));
  await waitFor(() => expect(boot.restore).toHaveBeenCalledTimes(1));
  expect(await boot.restore.mock.results[0]?.value).toBe(true);
  expect(boot.upgrade).toHaveBeenCalledTimes(1);

  await act(async () =>
    useSettingsStore.getState().setSettings({
      ...useSettingsStore.getState().settings,
      telemetryEnabled: false,
    }),
  );
  expect(boot.restore).toHaveBeenCalledTimes(1);
});

test('a private disconnected space restores when its saved connection becomes ready', async () => {
  const settings = configuredSettings();
  useSettingsStore.setState({ settings: { ...settings, s3: { ...settings.s3, enabled: false } } });
  render(<Providers>{null}</Providers>);
  await act(async () => {
    await Promise.resolve();
  });
  expect(boot.restore).not.toHaveBeenCalled();

  await act(async () => useSettingsStore.getState().setSettings(settings));
  await waitFor(() => expect(boot.restore).toHaveBeenCalledTimes(1));
  expect(await boot.restore.mock.results[0]?.value).toBe(true);
});

test('standard builds retain the immediate one-time keychain boot path', async () => {
  vi.stubEnv('NEXT_PUBLIC_PRIVATE_S3', 'false');
  render(<Providers>{null}</Providers>);
  await waitFor(() => expect(boot.restore).toHaveBeenCalledTimes(1));
  await act(async () => useSettingsStore.getState().setSettings(configuredSettings()));
  expect(boot.upgrade).toHaveBeenCalledTimes(1);
  expect(boot.restore).toHaveBeenCalledTimes(1);
});
