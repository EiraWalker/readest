import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { ReplicaKeyRow } from '@/libs/replicaSyncClient';

const fixture = vi.hoisted(() => {
  const rows: ReplicaKeyRow[] = [];
  return { rows, clearStore: vi.fn(async () => {}), clearSample: vi.fn() };
});

vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (key: string) => key }));
vi.mock('@/store/settingsStore', () => ({ useSettingsStore: () => true }));
vi.mock('@/libs/replicaSyncClient', () => ({
  replicaSyncClient: {
    listReplicaKeys: async () => [...fixture.rows],
    forgetReplicaKeys: async () => {
      fixture.rows.length = 0;
    },
  },
}));
vi.mock('@/libs/crypto/passphrase', () => ({
  createPassphraseStore: () => ({ clear: fixture.clearStore }),
}));
vi.mock('@/services/sync/passphraseGate', () => ({
  clearVerificationSample: fixture.clearSample,
  ensurePassphraseUnlocked: vi.fn(),
}));

import { cryptoSession } from '@/libs/crypto/session';
import { SyncPassphraseSection } from '@/app/user/components/SyncPassphraseSection';

beforeEach(() => {
  vi.clearAllMocks();
  fixture.rows.splice(0, fixture.rows.length, {
    saltId: 'synthetic-salt',
    alg: 'pbkdf2-600k-sha256',
    salt: 'AAAAAAAAAAAAAAAAAAAAAA==',
    createdAt: '2026-10-17T00:00:00.000Z',
  });
  cryptoSession.lock();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

test.each([
  false,
  true,
])('native confirmation waits for the user, then respects %s', async (accepted) => {
  let answer: (value: boolean) => void = () => {
    throw new Error('Confirmation is not ready');
  };
  const pending = new Promise<boolean>((resolve) => {
    answer = resolve;
  });
  const confirm = vi.fn(() => pending);
  vi.stubGlobal('confirm', confirm);
  render(<SyncPassphraseSection />);
  const forget = await screen.findByRole('button', { name: 'Forgot passphrase' });
  await act(async () => {
    fireEvent.click(forget);
  });

  expect(confirm).toHaveBeenCalledTimes(1);
  expect(fixture.rows).toHaveLength(1);
  expect(fixture.clearStore).not.toHaveBeenCalled();
  expect(fixture.clearSample).not.toHaveBeenCalled();

  await act(async () => {
    answer(accepted);
  });
  expect(fixture.rows).toHaveLength(accepted ? 0 : 1);
  expect(fixture.clearStore).toHaveBeenCalledTimes(accepted ? 1 : 0);
  expect(fixture.clearSample).toHaveBeenCalledTimes(accepted ? 1 : 0);
  expect(
    screen.queryByText('Sync passphrase forgotten. All encrypted fields cleared.') !== null,
  ).toBe(accepted);
  expect(
    screen.getByRole('button', { name: accepted ? 'Set passphrase' : 'Forgot passphrase' }),
  ).toBeTruthy();
});

test.each([false, true])('browser synchronous confirmation still respects %s', async (accepted) => {
  vi.stubGlobal('confirm', () => accepted);
  render(<SyncPassphraseSection />);
  const forget = await screen.findByRole('button', { name: 'Forgot passphrase' });
  await act(async () => {
    fireEvent.click(forget);
  });
  expect(fixture.rows).toHaveLength(accepted ? 0 : 1);
  expect(fixture.clearStore).toHaveBeenCalledTimes(accepted ? 1 : 0);
  expect(fixture.clearSample).toHaveBeenCalledTimes(accepted ? 1 : 0);
});
