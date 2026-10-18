import { useEffect, useState } from 'react';
import type { Book } from '@/types/book';
import { useEnv } from '@/context/EnvContext';
import { useLibraryStore } from '@/store/libraryStore';
import { useSettingsStore } from '@/store/settingsStore';
import { useWindowActiveChanged } from '@/app/reader/hooks/useWindowActiveChanged';
import { getPrivateS3Identity } from '@/services/sync/privateS3';
import { buildBookFilePath } from '@/services/sync/file/layout';
import { isBookFileSynced } from '@/services/sync/file/bookFileSync';

/** Verify the visible file against this device's last successful upload. */
export const useBookFileSynced = (book: Book): boolean => {
  const { envConfig } = useEnv();
  const settings = useSettingsStore((state) => state.settings);
  const live = useLibraryStore((state) => {
    const index = state.hashIndex.get(book.hash);
    return index === undefined ? undefined : state.library[index];
  });
  const current = live ?? book;
  const [activation, setActivation] = useState(0);
  const [verified, setVerified] = useState<{ key: string; synced: boolean } | null>(null);
  const identity = getPrivateS3Identity(settings);
  const enabled = !!(
    live &&
    current.localFileSync &&
    identity &&
    settings.s3.region?.trim() &&
    settings.s3.credentialRef &&
    (current.downloadedAt || !current.uploadedAt) &&
    !current.deletedAt
  );
  const key = enabled
    ? JSON.stringify([
        identity,
        settings.s3.region?.trim(),
        settings.s3.credentialRef,
        current.localFileSync,
        current.filePath,
        buildBookFilePath('/', current),
        activation,
      ])
    : null;

  useWindowActiveChanged((active) => {
    if (active) setActivation((value) => value + 1);
  }, enabled);

  useEffect(() => {
    if (!key) return;
    let alive = true;
    void isBookFileSynced(envConfig, current).then((synced) => {
      if (alive) setVerified({ key, synced });
    });
    return () => {
      alive = false;
    };
    // Only file identity, receipt and activation changes require another read.
    // Reading progress and other metadata do not change the uploaded bytes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [envConfig, key]);

  return key !== null && verified?.key === key && verified.synced;
};
