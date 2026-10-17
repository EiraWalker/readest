import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createS3Provider, type S3FetchFn } from '@/services/sync/providers/s3/S3Provider';
import { getSecureItem } from '@/utils/bridge';
import { tauriDownload, tauriUpload } from '@/utils/transfer';

vi.mock('@/utils/bridge', () => ({ getSecureItem: vi.fn() }));
vi.mock('@/services/environment', () => ({ isTauriAppPlatform: () => true }));
vi.mock('@/utils/transfer', () => ({ tauriDownload: vi.fn(), tauriUpload: vi.fn() }));

const connection = {
  endpoint: 'https://s3.example.com',
  bucket: 'readest',
  credentialRef: 'readest-private-s3:test-connection',
  accessKeyId: '',
  secretAccessKey: '',
};

beforeEach(() => vi.clearAllMocks());

describe('S3 native credentials', () => {
  test('restores signing keys from the native store after a restart', async () => {
    vi.mocked(getSecureItem).mockResolvedValue({
      value: JSON.stringify({ accessKeyId: 'DEVICE_ACCESS', secretAccessKey: 'DEVICE_SECRET' }),
    });
    const fetchFn = vi.fn<S3FetchFn>(async () => new Response('book'));
    const provider = createS3Provider(connection, fetchFn);

    expect(await provider.readText('/Readest/library.json')).toBe('book');
    expect(getSecureItem).toHaveBeenCalledWith({ key: connection.credentialRef });
    const init = fetchFn.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get('authorization')).toContain('Credential=DEVICE_ACCESS/');
  });

  test('missing native credentials stops before making a storage request', async () => {
    vi.mocked(getSecureItem).mockResolvedValue({});
    const fetchFn = vi.fn<S3FetchFn>(async () => new Response('book'));
    const provider = createS3Provider(connection, fetchFn);

    await expect(provider.readText('/Readest/library.json')).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  test.each([
    'upload',
    'download',
  ] as const)('%s failures do not expose presigned credentials in logs', async (direction) => {
    const error = new Error(
      'error sending request for url (https://s3.example.com/object?X-Amz-Credential=SYNTHETIC_ACCESS&X-Amz-Signature=SYNTHETIC_SIGNATURE)',
    );
    vi.mocked(tauriUpload).mockRejectedValue(error);
    vi.mocked(tauriDownload).mockRejectedValue(error);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const provider = createS3Provider({
        ...connection,
        accessKeyId: 'SYNTHETIC_ACCESS',
        secretAccessKey: 'SYNTHETIC_SECRET',
      });
      const operation = direction === 'upload' ? provider.uploadStream : provider.downloadStream;
      expect(await operation?.('/Readest/books/book.epub', 'book.epub')).toBe(false);
      const logged = warn.mock.calls.flat().map(String).join(' ');
      expect(logged).not.toContain('SYNTHETIC_ACCESS');
      expect(logged).not.toContain('SYNTHETIC_SIGNATURE');
    } finally {
      warn.mockRestore();
    }
  });
});
