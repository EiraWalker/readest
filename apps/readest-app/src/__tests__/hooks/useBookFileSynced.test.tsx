import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Book } from '@/types/book';
import { DEFAULT_SYSTEM_SETTINGS } from '@/services/constants';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useBookFileSynced } from '@/hooks/useBookFileSynced';

const h = vi.hoisted(() => ({
  envConfig: {},
  check: vi.fn(async () => true),
  active: undefined as ((active: boolean) => void) | undefined,
}));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ envConfig: h.envConfig }) }));
vi.mock('@/services/sync/file/bookFileSync', () => ({ isBookFileSynced: h.check }));
vi.mock('@/app/reader/hooks/useWindowActiveChanged', () => ({
  useWindowActiveChanged: (callback: (active: boolean) => void) => {
    h.active = callback;
  },
}));

const book: Book = {
  hash: 'synced-book',
  title: 'Book',
  author: 'Author',
  format: 'EPUB',
  createdAt: 1,
  updatedAt: 1,
  downloadedAt: 1,
  uploadedAt: 1,
  localFileSync: {
    scope: 'fixture',
    remotePath: '/Readest/books/synced-book/Book.epub',
    md5: 'abc',
  },
};

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_PRIVATE_S3', 'true');
  h.check.mockReset().mockResolvedValue(true);
  useSettingsStore.setState({
    settings: {
      ...useSettingsStore.getState().settings,
      ...DEFAULT_SYSTEM_SETTINGS,
      s3: {
        ...DEFAULT_SYSTEM_SETTINGS.s3,
        enabled: true,
        endpoint: 'https://s3.example.com',
        bucket: 'fixture',
        region: 'cn-north-1',
        credentialRef: 'readest-private-s3:fixture',
      },
    },
  });
  useLibraryStore.getState().setLibrary([book]);
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

it('rechecks the file when the window becomes active and drops the check after a change', async () => {
  const { result } = renderHook(() => useBookFileSynced(book));
  expect(result.current).toBe(false);
  await waitFor(() => expect(result.current).toBe(true));
  h.check.mockResolvedValueOnce(false);
  act(() => h.active?.(true));
  await waitFor(() => expect(result.current).toBe(false));
  expect(h.check).toHaveBeenCalledTimes(2);
});

it('ignores an earlier successful check after the connection is disabled', async () => {
  let resolve!: (synced: boolean) => void;
  h.check.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const { result } = renderHook(() => useBookFileSynced(book));
  act(() =>
    useSettingsStore.setState(({ settings }) => ({
      settings: { ...settings, s3: { ...settings.s3, enabled: false } },
    })),
  );
  await act(async () => {
    resolve(true);
  });
  expect(result.current).toBe(false);
});

it('uses the live receipt and row instead of an older details snapshot', async () => {
  const { result } = renderHook(() => useBookFileSynced(book));
  await waitFor(() => expect(result.current).toBe(true));
  act(() => useLibraryStore.getState().setLibrary([{ ...book, localFileSync: undefined }]));
  expect(result.current).toBe(false);
  act(() => useLibraryStore.getState().setLibrary([book]));
  await waitFor(() => expect(result.current).toBe(true));
  act(() => useLibraryStore.getState().setLibrary([]));
  expect(result.current).toBe(false);
});
