import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StatPageRecord } from '@/libs/sync';
import type { FileEntry, FileSyncProvider } from '@/services/sync/file/provider';
import { NodeDatabaseService } from '@/services/database/nodeDatabaseService';
import { migrate } from '@/services/database/migrate';
import { getMigrations } from '@/services/database/migrations';
import { StatisticsDb } from '@/services/statistics/statisticsDb';
import { pullStats, pushStats } from '@/services/statistics/statsSync';
import { S3StatsClient } from '@/services/statistics/s3StatsClient';

class MemoryProvider implements FileSyncProvider {
  readonly rootPath = '/';
  readonly objects = new Map<string, string>();
  readonly modified = new Map<string, string>();
  #revision = 0;

  async readText(path: string): Promise<string | null> {
    return this.objects.get(path) ?? null;
  }
  async list(path: string): Promise<FileEntry[]> {
    return [...this.objects.keys()]
      .filter((key) => key.startsWith(`${path}/`))
      .map((key) => ({
        name: key.slice(path.length + 1),
        path: key,
        isDirectory: false,
        lastModified: this.modified.get(key),
      }));
  }
  async writeText(path: string, body: string): Promise<void> {
    this.objects.set(path, body);
    this.modified.set(path, new Date(++this.#revision).toISOString());
  }
  async readBinary(): Promise<ArrayBuffer | null> {
    return null;
  }
  async head(): Promise<null> {
    return null;
  }
  async writeBinary(): Promise<void> {}
  async ensureDir(): Promise<void> {}
  async deleteDir(): Promise<void> {}
}

async function db(): Promise<StatisticsDb> {
  const connection = await NodeDatabaseService.open(':memory:');
  await migrate(connection, getMigrations('statistics'));
  return StatisticsDb.from(connection);
}

describe('S3 statistics synchronization', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  it('merges multiple devices by book, page and start time, retaining the longest duration', async () => {
    const provider = new MemoryProvider();
    const first = new S3StatsClient(provider, 'personal', 'desktop-a');
    const second = new S3StatsClient(provider, 'personal', 'desktop-b');
    await first.pushChanges({
      statBooks: [{ book_hash: 'book', title: 'Book', authors: 'Author' }],
      statPages: [{ book_hash: 'book', page: 1, start_time: 100, duration: 5, total_pages: 20 }],
    });
    await second.pushChanges({
      statBooks: [{ book_hash: 'book', title: 'Book', authors: 'Author' }],
      statPages: [
        { book_hash: 'book', page: 1, start_time: 100, duration: 9, total_pages: 20 },
        { book_hash: 'book', page: 2, start_time: 200, duration: 4, total_pages: 20 },
      ],
    });
    const stats = await db();
    await pullStats(stats, new S3StatsClient(provider, 'personal', 'receiver'));
    expect(await stats.getBookByMd5('book')).toMatchObject({
      total_read_time: 13,
      total_read_pages: 2,
    });

    await pullStats(stats, new S3StatsClient(provider, 'personal', 'receiver'));
    expect(await stats.getBookByMd5('book')).toMatchObject({
      total_read_time: 13,
      total_read_pages: 2,
    });
  });

  it('does not resync unchanged statistics or grow totals when pulled events are pushed back', async () => {
    const provider = new MemoryProvider();
    await new S3StatsClient(provider, 'personal', 'desktop-a').pushChanges({
      statBooks: [{ book_hash: 'book', title: 'Book', authors: 'Author' }],
      statPages: [{ book_hash: 'book', page: 1, start_time: 100, duration: 5, total_pages: 20 }],
    });
    const stats = await db();
    const client = new S3StatsClient(provider, 'personal', 'receiver');
    await pullStats(stats, client);
    await pushStats(stats, client);
    const cursor = await stats.getCursor('pull');

    for (let i = 0; i < 3; i++) {
      await pullStats(stats, client);
      await pushStats(stats, client);
    }
    expect(await stats.getCursor('pull')).toBe(cursor);
    expect(await stats.getBookByMd5('book')).toMatchObject({
      total_read_time: 5,
      total_read_pages: 1,
    });
  });

  it('discovers a late offline device behind the saved cursor, including after restart', async () => {
    const provider = new MemoryProvider();
    const receiver = new S3StatsClient(provider, 'personal', 'receiver');
    const stats = await db();
    await stats.setCursor('pull', 1_800_000_000_000);
    await new S3StatsClient(provider, 'personal', 'first').pushChanges({
      statBooks: [{ book_hash: 'book', title: 'Book', authors: 'Author' }],
      statPages: [{ book_hash: 'book', page: 2, start_time: 500, duration: 5, total_pages: 20 }],
    });
    await pullStats(stats, receiver);
    await new S3StatsClient(provider, 'personal', 'late').pushChanges({
      statBooks: [{ book_hash: 'book', title: 'Book', authors: 'Author' }],
      statPages: [{ book_hash: 'book', page: 1, start_time: 100, duration: 7, total_pages: 20 }],
    });

    await pullStats(stats, receiver);
    expect(await stats.getBookByMd5('book')).toMatchObject({
      total_read_time: 12,
      total_read_pages: 2,
    });
    await pullStats(stats, new S3StatsClient(provider, 'personal', 'receiver'));
    expect(await stats.getBookByMd5('book')).toMatchObject({
      total_read_time: 12,
      total_read_pages: 2,
    });
  });

  it('delivers bounded pull pages and replays a page whose apply did not advance the cursor', async () => {
    const provider = new MemoryProvider();
    const pages: StatPageRecord[] = Array.from({ length: 1005 }, (_, index) => ({
      book_hash: 'book',
      page: index + 1,
      start_time: 100,
      duration: 1,
      total_pages: 2000,
    }));
    await new S3StatsClient(provider, 'personal', 'writer').pushChanges({
      statBooks: [{ book_hash: 'book', title: 'Book', authors: 'Author' }],
      statPages: pages,
    });
    const receiver = new S3StatsClient(provider, 'personal', 'receiver');

    const first = await receiver.pullChanges(0, 'stats', undefined, undefined, 1000);
    expect(first.statPages).toHaveLength(1000);
    expect(await receiver.pullChanges(0, 'stats', undefined, undefined, 1000)).toEqual(first);
    const second = await receiver.pullChanges(1000, 'stats', undefined, undefined, 1000);
    expect(second.statPages).toHaveLength(5);
    const last = await receiver.pullChanges(1005, 'stats', undefined, undefined, 1000);
    expect(last.statPages).toEqual([]);
    const delivered = [...(first.statPages ?? []), ...(second.statPages ?? [])];
    expect(new Set(delivered.map((page) => page.page)).size).toBe(1005);
  });

  it('keeps the push cursor on upload failure and retries the device state without losing an event', async () => {
    const provider = new MemoryProvider();
    const stats = await db();
    const book = await stats.upsertBook({ bookMd5: 'book', title: 'Book', authors: 'Author' });
    await stats.insertPageEvent(book, { page: 1, startTime: 100, duration: 5, totalPages: 20 });
    const writer = new S3StatsClient(provider, 'personal', 'writer');
    vi.spyOn(provider, 'writeText').mockRejectedValueOnce(new Error('offline'));

    await expect(pushStats(stats, writer)).rejects.toThrow('offline');
    expect(await stats.getCursor('push')).toBe(0);
    await pushStats(stats, writer);
    expect(await stats.getCursor('push')).toBe(100);
    const recipient = await db();
    await pullStats(recipient, new S3StatsClient(provider, 'personal', 'recipient'));
    expect(await recipient.getBookByMd5('book')).toMatchObject({
      total_read_time: 5,
      total_read_pages: 1,
    });
  });

  it('serializes concurrent pushes from one device and isolates different library spaces', async () => {
    const provider = new MemoryProvider();
    const writer = new S3StatsClient(provider, 'personal', 'writer');
    await Promise.all(
      [1, 2].map((page) =>
        writer.pushChanges({
          statPages: [{ book_hash: 'book', page, start_time: 100, duration: 5, total_pages: 20 }],
        }),
      ),
    );
    const own = await new S3StatsClient(provider, 'personal', 'recipient').pullChanges(0, 'stats');
    expect(own.statPages).toHaveLength(2);
    const other = await new S3StatsClient(provider, 'other-library', 'recipient').pullChanges(
      0,
      'stats',
    );
    expect(other.statPages).toEqual([]);
  });

  it('keeps the existing push chunk rule that never splits events sharing a start time', async () => {
    const stats = await db();
    const book = await stats.upsertBook({ bookMd5: 'book', title: 'Book', authors: 'Author' });
    for (let page = 1; page <= 502; page++) {
      await stats.insertPageEvent(book, {
        page,
        startTime: page <= 500 ? page : page - 1,
        duration: 1,
        totalPages: 1000,
      });
    }
    const provider = new MemoryProvider();
    const client = new S3StatsClient(provider, 'personal', 'writer');
    const push = vi.spyOn(client, 'pushChanges');

    await pushStats(stats, client);

    expect(push.mock.calls.map(([payload]) => payload.statPages?.length)).toEqual([501, 1]);
    expect(await stats.getCursor('push')).toBe(501);
    const recipient = await db();
    await pullStats(recipient, new S3StatsClient(provider, 'personal', 'recipient'));
    expect(await recipient.getBookByMd5('book')).toMatchObject({
      total_read_time: 502,
      total_read_pages: 502,
    });
  });

  it('applies metadata-only changes and later increases to an already delivered duration', async () => {
    const provider = new MemoryProvider();
    const writer = new S3StatsClient(provider, 'personal', 'writer');
    const reader = new S3StatsClient(provider, 'personal', 'reader');
    const stats = await db();
    await writer.pushChanges({
      statBooks: [{ book_hash: 'book', title: 'First title', authors: 'Author' }],
      statPages: [{ book_hash: 'book', page: 1, start_time: 100, duration: 5, total_pages: 20 }],
    });
    await pullStats(stats, reader);
    await pushStats(stats, reader);

    await writer.pushChanges({
      statBooks: [{ book_hash: 'book', title: 'Revised title', authors: 'Author' }],
    });
    await pullStats(stats, reader);
    expect(await stats.getBookByMd5('book')).toMatchObject({
      title: 'Revised title',
      total_read_time: 5,
    });

    await writer.pushChanges({
      statPages: [{ book_hash: 'book', page: 1, start_time: 100, duration: 9, total_pages: 20 }],
    });
    await pullStats(stats, reader);
    await pullStats(stats, reader);
    expect(await stats.getBookByMd5('book')).toMatchObject({
      title: 'Revised title',
      total_read_time: 9,
    });
  });

  it('does not overwrite a renamed book when another device uploads events for a different book', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
    const provider = new MemoryProvider();
    const first = new S3StatsClient(provider, 'personal', 'first');
    const offline = new S3StatsClient(provider, 'personal', 'offline');
    const original = { book_hash: 'book', title: 'Original', authors: 'Author' };
    await first.pushChanges({ statBooks: [original] });
    await offline.pushChanges({ statBooks: [original] });
    clock.mockReturnValue(2000);
    await first.pushChanges({ statBooks: [{ ...original, title: 'Renamed' }] });
    clock.mockReturnValue(3000);
    await offline.pushChanges({
      statBooks: [{ book_hash: 'other', title: 'Other book', authors: 'Author' }],
      statPages: [{ book_hash: 'other', page: 1, start_time: 100, duration: 5, total_pages: 20 }],
    });

    const stats = await db();
    await pullStats(stats, new S3StatsClient(provider, 'personal', 'reader'));
    expect(await stats.getBookByMd5('book')).toMatchObject({ title: 'Renamed' });
    expect(await stats.getBookByMd5('other')).toMatchObject({ total_read_time: 5 });
  });

  it('preserves stats extension fields and tombstones through device snapshots', async () => {
    const provider = new MemoryProvider();
    const deletedAt = '2026-10-17T04:00:00Z';
    const writer = new S3StatsClient(provider, 'personal', 'writer');
    await writer.pushChanges({
      statBooks: [{ book_hash: 'book', title: 'Book', authors: 'Author', deleted_at: deletedAt }],
      statPages: [
        {
          book_hash: 'book',
          page: 1,
          start_time: 100,
          duration: 5,
          total_pages: 20,
          ext: { source: 'tts', narration: { chapter: 2 } },
          deleted_at: deletedAt,
        },
      ],
    });

    const result = await new S3StatsClient(provider, 'personal', 'reader').pullChanges(0, 'stats');

    expect(result.statBooks?.[0]).toMatchObject({ deleted_at: deletedAt });
    expect(result.statPages?.[0]).toMatchObject({
      duration: 5,
      ext: { source: 'tts', narration: { chapter: 2 } },
      deleted_at: deletedAt,
    });
  });

  it('replaces an existing page record only when its incoming duration is strictly longer', async () => {
    const provider = new MemoryProvider();
    const writer = new S3StatsClient(provider, 'personal', 'writer');
    const first: StatPageRecord = {
      book_hash: 'book',
      page: 1,
      start_time: 100,
      duration: 9,
      total_pages: 20,
      ext: { source: 'first' },
      deleted_at: null,
    };
    await writer.pushChanges({ statPages: [first] });
    await writer.pushChanges({
      statPages: [
        {
          ...first,
          total_pages: 999,
          ext: { source: 'second' },
          deleted_at: '2026-10-17T04:00:00Z',
        },
      ],
    });

    const unchanged = await new S3StatsClient(provider, 'personal', 'reader').pullChanges(
      0,
      'stats',
    );
    expect(unchanged.statPages?.[0]).toMatchObject(first);

    await writer.pushChanges({
      statPages: [{ ...first, duration: 12, ext: { source: 'longer' } }],
    });
    const longer = await new S3StatsClient(provider, 'personal', 'reader').pullChanges(0, 'stats');
    expect(longer.statPages?.[0]).toMatchObject({ duration: 12, ext: { source: 'longer' } });
  });

  it('rejects an empty existing snapshot without overwriting it or advancing the push cursor', async () => {
    const provider = new MemoryProvider();
    const writer = new S3StatsClient(provider, 'personal', 'writer');
    await writer.pushChanges({
      statPages: [{ book_hash: 'book', page: 1, start_time: 100, duration: 5, total_pages: 20 }],
    });
    const path = [...provider.objects.keys()][0]!;
    provider.objects.set(path, '');
    const writes = vi.spyOn(provider, 'writeText');
    const stats = await db();
    const book = await stats.upsertBook({ bookMd5: 'book', title: 'Book', authors: 'Author' });
    await stats.insertPageEvent(book, { page: 2, startTime: 200, duration: 5, totalPages: 20 });

    await expect(pushStats(stats, writer)).rejects.toThrow();

    expect(writes).not.toHaveBeenCalled();
    expect(provider.objects.get(path)).toBe('');
    expect(await stats.getCursor('push')).toBe(0);
  });

  it('keeps both events when two windows with the same device identity push concurrently', async () => {
    const queues = new Map<string, Promise<unknown>>();
    vi.stubGlobal('navigator', {
      locks: {
        request: <T>(name: string, operation: () => Promise<T>): Promise<T> => {
          const previous = queues.get(name) ?? Promise.resolve();
          const next = previous.then(operation);
          queues.set(
            name,
            next.catch(() => {}),
          );
          return next;
        },
      },
    });
    const provider = new MemoryProvider();
    const firstWindow = new S3StatsClient(provider, 'personal', 'desktop');
    const secondWindow = new S3StatsClient(provider, 'personal', 'desktop');

    await Promise.all([
      firstWindow.pushChanges({
        statPages: [{ book_hash: 'book', page: 1, start_time: 100, duration: 5, total_pages: 20 }],
      }),
      secondWindow.pushChanges({
        statPages: [{ book_hash: 'book', page: 2, start_time: 200, duration: 7, total_pages: 20 }],
      }),
    ]);

    const stats = await db();
    await pullStats(stats, new S3StatsClient(provider, 'personal', 'reader'));
    expect(await stats.getBookByMd5('book')).toMatchObject({
      total_read_time: 12,
      total_read_pages: 2,
    });
  });
});
