import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_S3_SETTINGS, DEFAULT_SYSTEM_SETTINGS } from '@/services/constants';
import { useSettingsStore } from '@/store/settingsStore';

const h = vi.hoisted(() => ({
  list: vi.fn(async () => []),
  saveSettings: vi.fn(async () => {}),
  setSecureItem: vi.fn(),
  clearSecureItem: vi.fn(async () => ({ success: true })),
  dispatch: vi.fn(),
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: { getAppService: async () => ({ saveSettings: h.saveSettings }) } }),
}));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (key: string) => key }));
vi.mock('@/utils/settingsSync', () => ({ broadcastGlobalSettings: vi.fn() }));
vi.mock('@/utils/event', () => ({ eventDispatcher: { dispatch: h.dispatch } }));
vi.mock('@/utils/bridge', () => ({
  setSecureItem: h.setSecureItem,
  getSecureItem: vi.fn(),
  clearSecureItem: h.clearSecureItem,
}));
vi.mock('@/services/sync/providers/s3/S3Provider', () => ({
  createS3Provider: () => ({ list: h.list }),
}));
vi.mock('@/components/settings/integrations/FileSyncForm', () => ({ default: () => null }));

import S3Form from '@/components/settings/integrations/S3Form';

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_PRIVATE_S3', 'true');
  vi.clearAllMocks();
  h.setSecureItem.mockResolvedValue({ success: true });
  h.saveSettings.mockResolvedValue();
  useSettingsStore.setState({
    settings: {
      ...useSettingsStore.getState().settings,
      ...DEFAULT_SYSTEM_SETTINGS,
      version: 1,
      s3: { ...DEFAULT_S3_SETTINGS },
    },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

const connect = () => {
  render(<S3Form />);
  fireEvent.change(screen.getByLabelText('Endpoint'), {
    target: { value: 'https://s3.cn-north-1.qiniucs.com' },
  });
  fireEvent.change(screen.getByLabelText('Bucket'), { target: { value: 'private-books' } });
  fireEvent.change(screen.getByLabelText('Access Key ID'), { target: { value: 'TEST_ACCESS' } });
  fireEvent.change(screen.getByLabelText('Secret Access Key'), {
    target: { value: 'TEST_SECRET' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
};

describe('S3 connection credentials', () => {
  test('standard web connects with its existing local-settings behavior and never calls native storage', async () => {
    vi.stubEnv('NEXT_PUBLIC_PRIVATE_S3', 'false');
    vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'web');
    h.setSecureItem.mockRejectedValue(new Error('No native bridge on web'));
    connect();

    await waitFor(() => expect(h.saveSettings).toHaveBeenCalled());
    expect(h.setSecureItem).not.toHaveBeenCalled();
    const saved = useSettingsStore.getState().settings.s3;
    expect(saved.enabled).toBe(true);
    expect(saved.accessKeyId).toBe('TEST_ACCESS');
    expect(saved.secretAccessKey).toBe('TEST_SECRET');
    expect(saved.credentialRef).toBeUndefined();
  });

  test('standard Tauri connects using native storage without plaintext settings', async () => {
    vi.stubEnv('NEXT_PUBLIC_PRIVATE_S3', 'false');
    vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'tauri');
    connect();

    await waitFor(() => expect(h.saveSettings).toHaveBeenCalled());
    expect(h.setSecureItem).toHaveBeenCalled();
    const saved = useSettingsStore.getState().settings.s3;
    expect(saved.enabled).toBe(true);
    expect(saved.credentialRef).toMatch(/^readest-private-s3:/);
    expect(saved.accessKeyId).toBeUndefined();
    expect(saved.secretAccessKey).toBeUndefined();
  });

  test('a private library refuses to connect its existing data to a different space', async () => {
    vi.stubEnv('NEXT_PUBLIC_PRIVATE_S3', 'true');
    const current = useSettingsStore.getState().settings;
    useSettingsStore.setState({
      settings: {
        ...current,
        s3: { ...current.s3, endpoint: 'https://s3.example.com', bucket: 'original-space' },
      },
    });
    connect();
    await waitFor(() =>
      expect(h.dispatch).toHaveBeenCalledWith(
        'toast',
        expect.objectContaining({
          type: 'error',
          message: expect.stringContaining('separate library'),
        }),
      ),
    );
    expect(h.list).not.toHaveBeenCalled();
    expect(h.setSecureItem).not.toHaveBeenCalled();
    expect(h.saveSettings).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().settings.s3.bucket).toBe('original-space');
  });

  test('stores keys natively and enables sync using only a local reference', async () => {
    const configured = vi.fn();
    window.addEventListener('private-s3-configured', configured, { once: true });
    connect();

    await waitFor(() => expect(h.saveSettings).toHaveBeenCalled());
    expect(h.setSecureItem).toHaveBeenCalledWith({
      key: expect.stringMatching(/^readest-private-s3:/),
      value: JSON.stringify({ accessKeyId: 'TEST_ACCESS', secretAccessKey: 'TEST_SECRET' }),
    });
    const saved = useSettingsStore.getState().settings;
    expect(saved.s3.enabled).toBe(true);
    expect(saved.s3.credentialRef).toMatch(/^readest-private-s3:/);
    expect(saved.s3.accessKeyId).toBeUndefined();
    expect(saved.s3.secretAccessKey).toBeUndefined();
    expect(configured).toHaveBeenCalledOnce();
    expect(JSON.stringify(h.saveSettings.mock.calls)).not.toContain('TEST_SECRET');
  });

  test('secure storage failure keeps sync disabled and never writes a plaintext fallback', async () => {
    h.setSecureItem.mockResolvedValue({ success: false, error: 'Keychain unavailable' });
    connect();

    await waitFor(() =>
      expect(h.dispatch).toHaveBeenCalledWith(
        'toast',
        expect.objectContaining({
          type: 'error',
        }),
      ),
    );
    expect(h.saveSettings).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().settings.s3.enabled).toBe(false);
  });
});
