import { v4 as uuidv4 } from 'uuid';
import { clearSecureItem, getSecureItem, setSecureItem } from '@/utils/bridge';
import { FileSyncError } from '@/services/sync/file/provider';

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

const KEY_PREFIX = 'readest-private-s3:';

const isCredentials = (value: unknown): value is S3Credentials => {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['accessKeyId'] === 'string' &&
    record['accessKeyId'].length > 0 &&
    typeof record['secretAccessKey'] === 'string' &&
    record['secretAccessKey'].length > 0
  );
};

/** Each connection gets its own native key; no plaintext persistence fallback. */
export async function saveS3Credentials(credentials: S3Credentials): Promise<string> {
  const key = `${KEY_PREFIX}${uuidv4()}`;
  try {
    const result = await setSecureItem({ key, value: JSON.stringify(credentials) });
    if (!result.success) throw new Error('Secure storage unavailable');
    return key;
  } catch {
    throw new FileSyncError('Unable to save S3 credentials in secure storage', 'AUTH_FAILED');
  }
}

export async function clearS3Credentials(credentialRef: string): Promise<void> {
  if (!credentialRef.startsWith(KEY_PREFIX)) return;
  const result = await clearSecureItem({ key: credentialRef });
  if (!result.success) throw new Error('Unable to clear S3 credentials');
}

/** Draft keys take priority; saved connections restore only from native storage. */
export async function resolveS3Credentials<
  T extends Partial<S3Credentials> & { credentialRef?: string },
>(config: T): Promise<T & S3Credentials> {
  if (isCredentials(config)) return config;
  try {
    if (!config.credentialRef?.startsWith(KEY_PREFIX)) throw new Error('Missing credentials');
    const result = await getSecureItem({ key: config.credentialRef });
    if (result.error || !result.value) throw new Error('Missing credentials');
    const credentials: unknown = JSON.parse(result.value);
    if (!isCredentials(credentials)) throw new Error('Invalid credentials');
    return { ...config, ...credentials };
  } catch {
    throw new FileSyncError('S3 credentials are unavailable on this device', 'AUTH_FAILED');
  }
}
