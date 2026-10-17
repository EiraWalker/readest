import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('@/hooks/useAppRouter', () => ({ useAppRouter: () => ({ push: h.push }) }));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ envConfig: {}, appService: null }) }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (key: string) => key }));
vi.mock('@/hooks/useQuotaStats', () => ({
  useQuotaStats: () => ({ userProfilePlan: 'free', quotas: [] }),
}));
vi.mock('@/hooks/useCloudSyncStatus', () => ({
  useCloudSyncStatus: () => ({ providers: [], label: 'Sync off' }),
}));
vi.mock('@/hooks/useTransferQueue', () => ({
  useTransferQueue: () => ({
    stats: {},
    hasActiveTransfers: false,
    setIsTransferQueueOpen: vi.fn(),
  }),
}));
vi.mock('@/app/library/components/BackupWindow', () => ({ setBackupDialogVisible: vi.fn() }));
vi.mock('@/app/library/components/CacheManagerWindow', () => ({
  setCacheManagerDialogVisible: vi.fn(),
}));
vi.mock('@/app/library/components/MigrateDataWindow', () => ({
  setMigrateDataDirDialogVisible: vi.fn(),
}));
vi.mock('@/components/AboutWindow', () => ({ setAboutDialogVisible: vi.fn() }));

import SettingsMenu from '@/app/library/components/SettingsMenu';

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

it('opens private sync management without offering official sign in', () => {
  vi.stubEnv('NEXT_PUBLIC_PRIVATE_S3', 'true');
  render(<SettingsMenu onPullLibrary={vi.fn()} />);
  expect(screen.queryByText('Sign In')).toBeNull();
  expect(screen.queryByText('Upgrade to Readest Premium')).toBeNull();
  fireEvent.click(screen.getByText('Manage Sync'));
  expect(h.push).toHaveBeenCalledWith('/user?section=sync');
});
