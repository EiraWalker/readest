import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPrivateS3Identity, isPrivateS3Mode } from '@/services/sync/privateS3';
import type { SystemSettings } from '@/types/settings';

const settings = (endpoint = 'https://s3.cn-north-1.qiniucs.com/', bucket = 'reader') =>
  ({ s3: { enabled: true, endpoint, bucket } }) as SystemSettings;

afterEach(() => vi.unstubAllEnvs());

describe('private S3 sync identity', () => {
  it('joins the same space on a fresh device without an official account', () => {
    vi.stubEnv('NEXT_PUBLIC_PRIVATE_S3', 'true');
    expect(isPrivateS3Mode()).toBe(true);
    expect(getPrivateS3Identity(settings())).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(getPrivateS3Identity(settings())).toBe(
      getPrivateS3Identity(settings('https://s3.cn-north-1.qiniucs.com')),
    );
    expect(getPrivateS3Identity(settings())).not.toBe(
      getPrivateS3Identity(settings(undefined, 'another-reader')),
    );
  });

  it('does not enable sync for an unconfigured or insecure connection', () => {
    vi.stubEnv('NEXT_PUBLIC_PRIVATE_S3', 'true');
    expect(getPrivateS3Identity(settings('http://example.com'))).toBeNull();
    expect(getPrivateS3Identity(settings(undefined, ''))).toBeNull();
    expect(
      getPrivateS3Identity({ s3: { ...settings().s3, enabled: false } } as SystemSettings),
    ).toBeNull();
  });

  it('keeps the normal application outside the private space', () => {
    vi.stubEnv('NEXT_PUBLIC_PRIVATE_S3', 'false');
    expect(getPrivateS3Identity(settings())).toBeNull();
  });
});
