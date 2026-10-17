import { useSettingsStore } from '@/store/settingsStore';
import type { SystemSettings } from '@/types/settings';
import { createS3Provider } from './providers/s3/S3Provider';
import { getPrivateS3Identity, isPrivateS3Mode } from './privateS3';
import { S3ReplicaClient } from './s3ReplicaClient';
import { S3StatsClient } from '@/services/statistics/s3StatsClient';

let cached: {
  key: string;
  runtime: {
    provider: ReturnType<typeof createS3Provider>;
    spaceId: string;
    deviceId: string;
    replicaClient: S3ReplicaClient;
    statsClient: S3StatsClient;
  };
} | null = null;

export const getPrivateS3Runtime = async (
  settings: SystemSettings = useSettingsStore.getState().settings,
) => {
  const spaceId = getPrivateS3Identity(settings);
  const deviceId = settings?.replicaDeviceId;
  if (!spaceId || !deviceId) throw new Error('Private S3 sync is not configured');
  const key = JSON.stringify([spaceId, deviceId, settings.s3.region, settings.s3.credentialRef]);
  if (cached?.key === key) return cached.runtime;
  const provider = createS3Provider(settings.s3);
  const runtime = {
    provider,
    spaceId,
    deviceId,
    replicaClient: new S3ReplicaClient({ provider, spaceId, deviceId }),
    statsClient: new S3StatsClient(provider, spaceId, deviceId),
  };
  cached = { key, runtime };
  return runtime;
};

export const getPrivateS3StatsClient = async () =>
  isPrivateS3Mode() ? (await getPrivateS3Runtime()).statsClient : null;
