import type { Book, BookFileSyncConfirmation } from '@/types/book';
import type { EnvConfigType } from '@/services/environment';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { getPrivateS3Identity } from '@/services/sync/privateS3';
import { createAppLocalStore } from './appLocalStore';
import { buildBookFilePath } from './layout';

export type { BookFileSyncConfirmation } from '@/types/book';

const configuredScope = (): string | null => {
  const settings = useSettingsStore.getState().settings;
  const identity = getPrivateS3Identity(settings);
  const region = settings.s3.region?.trim();
  const credentialRef = settings.s3.credentialRef?.trim();
  return identity && region && credentialRef
    ? JSON.stringify([identity, region, credentialRef])
    : null;
};

const liveBook = (hash: string): Book | undefined =>
  useLibraryStore
    .getState()
    .library.find((candidate) => candidate.hash === hash && !candidate.deletedAt);

const matches = (
  current: BookFileSyncConfirmation | null | undefined,
  confirmed: BookFileSyncConfirmation,
): boolean =>
  current?.scope === confirmed.scope &&
  current.remotePath === confirmed.remotePath &&
  current.md5 === confirmed.md5;

/** Capture full content, not the import-time partial hash or file size. */
export const captureBookFileSync = async (
  envConfig: EnvConfigType,
  book: Book,
): Promise<BookFileSyncConfirmation | null> => {
  try {
    const scope = configuredScope();
    if (!scope || book.deletedAt) return null;
    const remotePath = buildBookFilePath('/', book);
    const appService = await envConfig.getAppService();
    const store = createAppLocalStore({
      appService,
      envConfig,
      settings: useSettingsStore.getState().settings,
    });
    const md5 = await store.getBookFileMD5!(book);
    if (!md5 || configuredScope() !== scope || buildBookFilePath('/', book) !== remotePath) {
      return null;
    }
    return { scope, remotePath, md5 };
  } catch {
    return null;
  }
};

/** Called only after upload or remote-content verification succeeded. */
export const confirmBookFileSync = async (
  envConfig: EnvConfigType,
  book: Book,
  confirmation: BookFileSyncConfirmation,
): Promise<void> => {
  try {
    const before = liveBook(book.hash);
    if (
      !before ||
      configuredScope() !== confirmation.scope ||
      buildBookFilePath('/', before) !== confirmation.remotePath
    ) {
      return;
    }
    const sourcePath = before.filePath;
    if (!matches(await captureBookFileSync(envConfig, before), confirmation)) return;
    // A hash read can overlap a deletion, rename or another reading update.
    const current = liveBook(book.hash);
    if (
      !current ||
      current.filePath !== sourcePath ||
      configuredScope() !== confirmation.scope ||
      buildBookFilePath('/', current) !== confirmation.remotePath
    ) {
      return;
    }
    const now = Date.now();
    await useLibraryStore.getState().updateBooks(envConfig, [
      {
        ...current,
        localFileSync: confirmation,
        uploadedAt: current.uploadedAt || now,
        downloadedAt: current.downloadedAt || now,
      },
    ]);
  } catch {
    // A local receipt must never turn a successful transfer into a failure.
  }
};

export const clearBookFileSync = async (envConfig: EnvConfigType, book: Book): Promise<void> => {
  try {
    const current = liveBook(book.hash);
    if (!current?.localFileSync) return;
    const { localFileSync: _confirmation, ...next } = current;
    await useLibraryStore.getState().updateBooks(envConfig, [next]);
  } catch {
    // Receipt persistence is best-effort and contains no transfer credentials.
  }
};

export const isBookFileSynced = async (envConfig: EnvConfigType, book: Book): Promise<boolean> => {
  try {
    const current = liveBook(book.hash);
    const confirmation = current?.localFileSync;
    if (
      !current ||
      !confirmation ||
      configuredScope() !== confirmation.scope ||
      buildBookFilePath('/', current) !== confirmation.remotePath
    ) {
      return false;
    }
    const sourcePath = current.filePath;
    const captured = await captureBookFileSync(envConfig, current);
    const latest = liveBook(book.hash);
    return (
      !!latest &&
      latest.filePath === sourcePath &&
      configuredScope() === confirmation.scope &&
      matches(captured, confirmation) &&
      matches(latest.localFileSync, confirmation) &&
      buildBookFilePath('/', latest) === confirmation.remotePath
    );
  } catch {
    return false;
  }
};
