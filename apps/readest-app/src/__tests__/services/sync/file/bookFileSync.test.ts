import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { Book, BookFileSyncConfirmation } from '@/types/book';
import type { AppService } from '@/types/system';
import type { EnvConfigType } from '@/services/environment';
import { DEFAULT_SYSTEM_SETTINGS } from '@/services/constants';
import { useSettingsStore } from '@/store/settingsStore';
import { useLibraryStore } from '@/store/libraryStore';
import {
  captureBookFileSync,
  clearBookFileSync,
  confirmBookFileSync,
  isBookFileSynced,
} from '@/services/sync/file/bookFileSync';

const book: Book = {
  hash: 'local-book',
  format: 'EPUB',
  title: 'Book',
  sourceTitle: 'Book',
  author: 'A',
  createdAt: 1,
  updatedAt: 1,
};
let bytes: string;
let disk: string;
let appService: AppService;
let envConfig: EnvConfigType;

const localFile = () => {
  const content = new TextEncoder().encode(bytes);
  return {
    size: content.byteLength,
    slice: (start: number, end: number) => ({
      arrayBuffer: async () => content.slice(start, end).buffer,
    }),
  } as unknown as File;
};
const liveBook = () => useLibraryStore.getState().library[0]!;

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_PRIVATE_S3', 'true');
  bytes = 'abc';
  disk = JSON.stringify([book]);
  useSettingsStore.setState({
    settings: {
      ...useSettingsStore.getState().settings,
      ...DEFAULT_SYSTEM_SETTINGS,
      s3: {
        enabled: true,
        endpoint: 'https://s3.example.com',
        bucket: 'private-books',
        region: 'north',
        credentialRef: 'readest-private-s3:test',
      },
    },
  });
  useLibraryStore.getState().setLibrary([{ ...book }]);
  appService = {
    exists: vi.fn(async () => true),
    openFile: vi.fn(async () => localFile()),
    saveLibraryBooks: vi.fn(async (books: Book[]) => {
      disk = JSON.stringify(books);
    }),
  } as unknown as AppService;
  envConfig = { getAppService: vi.fn(async () => appService) } as unknown as EnvConfigType;
});

afterEach(() => vi.unstubAllEnvs());

test('persists confirmed bytes across a reload while preserving the live reading row', async () => {
  const confirmation = await captureBookFileSync(envConfig, book);
  expect(confirmation).toMatchObject({
    remotePath: '/Readest/books/local-book/Book.epub',
    md5: '900150983cd24fb0d6963f7d28e17f72',
  });
  useLibraryStore.getState().setLibrary([{ ...book, progress: [7, 10], updatedAt: 9 }]);
  await confirmBookFileSync(envConfig, book, confirmation!);
  expect(liveBook()).toMatchObject({
    localFileSync: confirmation,
    progress: [7, 10],
    updatedAt: 9,
  });
  expect(liveBook().uploadedAt).toBeGreaterThan(0);
  expect(liveBook().downloadedAt).toBeGreaterThan(0);
  useLibraryStore.getState().setLibrary(JSON.parse(disk) as Book[]);
  expect(await isBookFileSynced(envConfig, liveBook())).toBe(true);
});

test('detects same-size changes and does not confirm a file changed during upload', async () => {
  const confirmation = await captureBookFileSync(envConfig, book);
  await confirmBookFileSync(envConfig, book, confirmation!);
  bytes = 'abd';
  expect(await isBookFileSynced(envConfig, liveBook())).toBe(false);
  await clearBookFileSync(envConfig, book);
  expect(liveBook().localFileSync).toBeUndefined();
  expect((JSON.parse(disk) as Book[])[0]?.localFileSync).toBeUndefined();
  expect(liveBook().uploadedAt).toBeGreaterThan(0);
  const next = await captureBookFileSync(envConfig, book);
  bytes = 'abe';
  await confirmBookFileSync(envConfig, book, next!);
  expect(liveBook().localFileSync).toBeUndefined();
});

test('rejects confirmations from a disabled, changed space, credentials, region or path', async () => {
  const settings = useSettingsStore.getState().settings;
  const confirmation = await captureBookFileSync(envConfig, book);
  await confirmBookFileSync(envConfig, book, confirmation!);
  const confirmed = { ...liveBook() };
  vi.mocked(appService.openFile).mockClear();
  vi.mocked(appService.saveLibraryBooks).mockClear();
  for (const patch of [
    { enabled: false },
    { endpoint: 'https://elsewhere.example.com' },
    { bucket: 'another-space' },
    { region: 'south' },
    { credentialRef: 'readest-private-s3:replacement' },
  ]) {
    useSettingsStore.setState({ settings: { ...settings, s3: { ...settings.s3, ...patch } } });
    useLibraryStore.getState().setLibrary([{ ...confirmed }]);
    expect(await isBookFileSynced(envConfig, confirmed)).toBe(false);
    useLibraryStore.getState().setLibrary([{ ...book }]);
    await confirmBookFileSync(envConfig, book, confirmation!);
    expect(liveBook().localFileSync).toBeUndefined();
  }
  useSettingsStore.setState({ settings });
  useLibraryStore.getState().setLibrary([{ ...confirmed, sourceTitle: 'Renamed' }]);
  expect(await isBookFileSynced(envConfig, liveBook())).toBe(false);
  await confirmBookFileSync(envConfig, book, confirmation!);
  expect(liveBook().localFileSync).toEqual(confirmation);
  expect(appService.openFile).not.toHaveBeenCalled();
  expect(appService.saveLibraryBooks).not.toHaveBeenCalled();
});

test('does no local I/O without a complete private connection or a receipt', async () => {
  expect(await isBookFileSynced(envConfig, book)).toBe(false);
  const settings = useSettingsStore.getState().settings;
  for (const patch of [{ enabled: false }, { region: '' }, { credentialRef: '' }, { bucket: '' }]) {
    useSettingsStore.setState({ settings: { ...settings, s3: { ...settings.s3, ...patch } } });
    expect(await captureBookFileSync(envConfig, book)).toBeNull();
  }
  useSettingsStore.setState({ settings });
  vi.stubEnv('NEXT_PUBLIC_PRIVATE_S3', 'false');
  expect(await captureBookFileSync(envConfig, book)).toBeNull();
  expect(envConfig.getAppService).not.toHaveBeenCalled();
});

test('fails closed on missing files and I/O errors without changing the upload result', async () => {
  const confirmation = await captureBookFileSync(envConfig, book);
  await confirmBookFileSync(envConfig, book, confirmation!);
  vi.mocked(appService.exists).mockResolvedValue(false);
  expect(await isBookFileSynced(envConfig, liveBook())).toBe(false);
  expect(await captureBookFileSync(envConfig, book)).toBeNull();
  vi.mocked(appService.exists).mockResolvedValue(true);
  vi.mocked(appService.openFile).mockRejectedValue(new Error('file cannot be read'));
  expect(await captureBookFileSync(envConfig, book)).toBeNull();
  await expect(confirmBookFileSync(envConfig, book, confirmation!)).resolves.toBeUndefined();
  vi.mocked(appService.saveLibraryBooks).mockRejectedValue(new Error('cannot persist'));
  await expect(clearBookFileSync(envConfig, book)).resolves.toBeUndefined();
});

test('ignores a confirmation after the row or connection changed during hashing', async () => {
  const confirmation = (await captureBookFileSync(envConfig, book)) as BookFileSyncConfirmation;
  vi.mocked(appService.openFile).mockImplementationOnce(async () => {
    useLibraryStore.getState().setLibrary([{ ...book, deletedAt: 10 }]);
    return localFile();
  });
  await confirmBookFileSync(envConfig, book, confirmation);
  expect(liveBook()).toMatchObject({ deletedAt: 10 });
  expect(liveBook().localFileSync).toBeUndefined();
  useLibraryStore.getState().setLibrary([]);
  await confirmBookFileSync(envConfig, book, confirmation);
  await clearBookFileSync(envConfig, book);
  expect(useLibraryStore.getState().library).toEqual([]);
  const sourceA = { ...book, filePath: '/external/A.epub' };
  vi.mocked(appService.exists).mockImplementation(async (_path, base) => base === 'None');
  useLibraryStore.getState().setLibrary([sourceA]);
  vi.mocked(appService.openFile).mockImplementationOnce(async () => {
    useLibraryStore.getState().setLibrary([{ ...sourceA, filePath: '/external/B.epub' }]);
    return localFile();
  });
  await confirmBookFileSync(envConfig, sourceA, confirmation);
  expect.soft(liveBook().localFileSync).toBeUndefined();
  useLibraryStore.getState().setLibrary([{ ...sourceA, localFileSync: confirmation }]);
  vi.mocked(appService.openFile).mockImplementationOnce(async () => {
    useLibraryStore.getState().setLibrary([
      { ...sourceA, filePath: '/external/B.epub', localFileSync: confirmation },
    ]);
    return localFile();
  });
  expect.soft(await isBookFileSynced(envConfig, sourceA)).toBe(false);
  vi.mocked(appService.exists).mockResolvedValue(true);
  useLibraryStore.getState().setLibrary([{ ...book }]);
  vi.mocked(appService.openFile).mockImplementationOnce(async () => {
    const settings = useSettingsStore.getState().settings;
    useSettingsStore.setState({ settings: { ...settings, s3: { ...settings.s3, bucket: 'new' } } });
    return localFile();
  });
  await confirmBookFileSync(envConfig, book, confirmation);
  expect(liveBook().localFileSync).toBeUndefined();
  expect(appService.saveLibraryBooks).not.toHaveBeenCalled();
});
