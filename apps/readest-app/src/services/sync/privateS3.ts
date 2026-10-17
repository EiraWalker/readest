import type { SystemSettings } from '@/types/settings';
import { v5 as uuidv5 } from 'uuid';

export const isPrivateS3Mode = (): boolean => process.env['NEXT_PUBLIC_PRIVATE_S3'] === 'true';

/** The same endpoint and bucket identify one space without an account or bootstrap race. */
export const getPrivateS3Identity = (settings?: SystemSettings): string | null => {
  const config = settings?.s3;
  if (!isPrivateS3Mode() || !config?.enabled || !config.bucket.trim()) return null;
  try {
    const endpoint = new URL(config.endpoint);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) return null;
    endpoint.hash = '';
    endpoint.search = '';
    return uuidv5(
      `${endpoint.href.replace(/\/+$/, '')}/${encodeURIComponent(config.bucket.trim())}`,
      uuidv5.URL,
    );
  } catch {
    return null;
  }
};
