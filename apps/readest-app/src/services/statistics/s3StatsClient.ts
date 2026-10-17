import type {
  StatBookRecord,
  StatPageRecord,
  SyncClient,
  SyncData,
  SyncResult,
  SyncType,
} from '@/libs/sync';
import { ancestorsOf, buildBasePath } from '@/services/sync/file/layout';
import type { FileSyncProvider } from '@/services/sync/file/provider';
import { withS3DeviceLock } from '@/services/sync/withS3DeviceLock';

interface DeviceStatistics {
  version: 1;
  spaceId: string;
  deviceId: string;
  books: StatBookRecord[];
  pages: StatPageRecord[];
}

interface PullRound {
  pages: StatPageRecord[];
  books: StatBookRecord[];
}

interface PendingDelivery {
  watermark: number;
  result: SyncResult;
  pages: StatPageRecord[];
  books: StatBookRecord[];
}

const emptyResult = (): SyncResult => ({
  books: null,
  configs: null,
  notes: null,
  statBooks: [],
  statPages: [],
});

const eventKey = (page: StatPageRecord): string =>
  JSON.stringify([page.book_hash, page.page, page.start_time]);

const bookRecord = (book: StatBookRecord): StatBookRecord => ({
  book_hash: book.book_hash,
  title: book.title,
  authors: book.authors,
  deleted_at: book.deleted_at ?? null,
  ...(book.updated_at_ms !== undefined ? { updated_at_ms: book.updated_at_ms } : {}),
});

const pageRecord = (page: StatPageRecord): StatPageRecord => ({
  book_hash: page.book_hash,
  page: page.page,
  start_time: page.start_time,
  duration: page.duration,
  total_pages: page.total_pages,
  ext: page.ext ?? null,
  deleted_at: page.deleted_at ?? null,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isBook = (value: unknown): value is StatBookRecord =>
  isRecord(value) &&
  typeof value['book_hash'] === 'string' &&
  typeof value['title'] === 'string' &&
  typeof value['authors'] === 'string' &&
  (value['deleted_at'] == null || typeof value['deleted_at'] === 'string') &&
  (value['updated_at_ms'] === undefined ||
    (typeof value['updated_at_ms'] === 'number' && Number.isFinite(value['updated_at_ms'])));

const isPage = (value: unknown): value is StatPageRecord =>
  isRecord(value) &&
  typeof value['book_hash'] === 'string' &&
  (value['deleted_at'] == null || typeof value['deleted_at'] === 'string') &&
  ['page', 'start_time', 'duration', 'total_pages'].every(
    (key) => typeof value[key] === 'number' && Number.isFinite(value[key]),
  );

const parseStatistics = (text: string, spaceId: string, deviceId: string): DeviceStatistics => {
  const value: unknown = JSON.parse(text);
  if (
    !isRecord(value) ||
    value['version'] !== 1 ||
    value['spaceId'] !== spaceId ||
    value['deviceId'] !== deviceId ||
    !Array.isArray(value['books']) ||
    !value['books'].every(isBook) ||
    !Array.isArray(value['pages']) ||
    !value['pages'].every(isPage)
  ) {
    throw new Error('Invalid S3 statistics snapshot');
  }
  return { version: 1, spaceId, deviceId, books: value['books'], pages: value['pages'] };
};

const mergePages = (target: Map<string, StatPageRecord>, pages: StatPageRecord[]): void => {
  for (const input of pages) {
    const page = pageRecord(input);
    const key = eventKey(page);
    const previous = target.get(key);
    if (!previous || page.duration > previous.duration) target.set(key, page);
  }
};

/**
 * Each device owns a cumulative object, so concurrent devices never overwrite
 * one another. Pull cursors describe this receiver's delivery order, not device
 * clocks: discovering an old offline device must still deliver its events.
 */
export class S3StatsClient implements Pick<SyncClient, 'pushChanges' | 'pullChanges'> {
  readonly #directory: string;
  readonly #path: string;
  #writeLock: Promise<unknown> = Promise.resolve();
  #readLock: Promise<unknown> = Promise.resolve();
  readonly #seenPages = new Map<string, string>();
  readonly #seenBooks = new Map<string, string>();
  #round: PullRound | null = null;
  #pending: PendingDelivery | null = null;

  constructor(
    private readonly provider: FileSyncProvider,
    private readonly spaceId: string,
    private readonly deviceId: string,
  ) {
    this.#directory = `${buildBasePath(provider.rootPath)}/sync/${encodeURIComponent(spaceId)}/stats`;
    this.#path = `${this.#directory}/${encodeURIComponent(deviceId)}.json`;
  }

  pushChanges(payload: SyncData): Promise<SyncResult> {
    const operation = this.#writeLock.then(() =>
      withS3DeviceLock('stats', this.spaceId, this.deviceId, async () => {
        const existingText = await this.provider.readText(this.#path);
        const existing =
          existingText !== null ? parseStatistics(existingText, this.spaceId, this.deviceId) : null;
        const books = new Map(existing?.books.map((book) => [book.book_hash, book]) ?? []);
        const pages = new Map(existing?.pages.map((page) => [eventKey(page), page]) ?? []);
        for (const book of payload.statBooks ?? []) {
          const previous = books.get(book.book_hash);
          if (
            !previous ||
            previous.title !== book.title ||
            previous.authors !== book.authors ||
            (previous.deleted_at ?? null) !== (book.deleted_at ?? null)
          ) {
            books.set(book.book_hash, {
              ...bookRecord(book),
              // Changing another book must not refresh this book's LWW stamp.
              updated_at_ms: Math.max(Date.now(), (previous?.updated_at_ms ?? 0) + 1),
            });
          }
        }
        mergePages(pages, payload.statPages ?? []);
        const state: DeviceStatistics = {
          version: 1,
          spaceId: this.spaceId,
          deviceId: this.deviceId,
          books: [...books.values()].sort((a, b) => a.book_hash.localeCompare(b.book_hash)),
          pages: [...pages.values()].sort((a, b) => eventKey(a).localeCompare(eventKey(b))),
        };
        const body = JSON.stringify(state);
        if (body !== existingText && (state.books.length > 0 || state.pages.length > 0)) {
          await this.provider.ensureDir(ancestorsOf(this.#path));
          await this.provider.writeText(this.#path, body, 'application/json');
        }
        return emptyResult();
      }),
    );
    this.#writeLock = operation.catch(() => {});
    return operation;
  }

  pullChanges(
    since: number,
    type?: SyncType,
    book?: string,
    _metaHash?: string,
    limit = 1000,
  ): Promise<SyncResult> {
    const operation = this.#readLock.then(() => this.#pull(since, type, book, limit));
    this.#readLock = operation.catch(() => {});
    return operation;
  }

  async #pull(
    since: number,
    type: SyncType | undefined,
    book: string | undefined,
    limit: number,
  ): Promise<SyncResult> {
    if (type && type !== 'stats') throw new Error('S3 statistics only supports stats sync');
    if (this.#pending) {
      // A failed database apply leaves its cursor unchanged. Replay the exact
      // page until its caller acknowledges it by advancing that cursor.
      if (since < this.#pending.watermark) return this.#pending.result;
      for (const page of this.#pending.pages)
        this.#seenPages.set(eventKey(page), JSON.stringify(page));
      for (const metadata of this.#pending.books)
        this.#seenBooks.set(metadata.book_hash, JSON.stringify(metadata));
      this.#pending = null;
    }
    if (this.#round?.pages.length === 0) {
      this.#round = null;
      return emptyResult();
    }
    if (this.#round === null) {
      const books = new Map<string, StatBookRecord>();
      const pages = new Map<string, StatPageRecord>();
      const entries = await this.provider.list(this.#directory);
      // A cumulative object can change without changing this event. Stable
      // device order keeps equal-duration extension fields from oscillating.
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.isDirectory || !entry.name.endsWith('.json')) continue;
        const text = await this.provider.readText(`${this.#directory}/${entry.name}`);
        if (text === null) continue;
        const state = parseStatistics(
          text,
          this.spaceId,
          decodeURIComponent(entry.name.slice(0, -5)),
        );
        for (const metadata of state.books) {
          const previous = books.get(metadata.book_hash);
          if (!previous || (metadata.updated_at_ms ?? 0) >= (previous.updated_at_ms ?? 0)) {
            books.set(metadata.book_hash, bookRecord(metadata));
          }
        }
        mergePages(pages, state.pages);
      }
      this.#round = {
        books: [...books.values()].filter(
          (metadata) =>
            (!book || metadata.book_hash === book) &&
            this.#seenBooks.get(metadata.book_hash) !== JSON.stringify(metadata),
        ),
        pages: [...pages.values()].filter(
          (page) =>
            (!book || page.book_hash === book) &&
            this.#seenPages.get(eventKey(page)) !== JSON.stringify(page),
        ),
      };
    }

    const pageSize = Number.isFinite(limit) && limit > 0 ? Math.max(1, Math.floor(limit)) : 1000;
    const pages = this.#round.pages.splice(0, pageSize);
    const books = this.#round.books;
    this.#round.books = [];
    const result: SyncResult = {
      ...emptyResult(),
      statBooks: books,
      statPages: pages.map((page, index) => ({ ...page, updated_at_ms: since + index + 1 })),
    };
    if (pages.length > 0) {
      this.#pending = { watermark: since + pages.length, result, pages, books };
    } else {
      // Metadata-only results have no page cursor to acknowledge. Replaying
      // them on a later round is harmless and also retries failed DB writes.
      this.#round = null;
    }
    return result;
  }
}
