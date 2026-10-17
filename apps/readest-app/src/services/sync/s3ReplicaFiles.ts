import type { AppService, BaseDir } from '@/types/system';
import type { ProgressHandler } from '@/utils/transfer';
import type { ClosableFile } from '@/utils/file';
import { getPrivateS3Runtime } from './privateS3Runtime';
import { getDirPath } from '@/utils/path';

const segment = (value: string) => {
  if (!value || value === '.' || value === '..' || /[\\/\x00]/.test(value)) {
    throw new Error('Invalid replica resource path');
  }
  return value;
};
const bundlePath = (spaceId: string, kind: string, id: string) =>
  `/Readest/sync/${spaceId}/resources/${segment(kind)}/${segment(id)}`;

export const uploadS3ReplicaFile = async (
  service: AppService,
  kind: string,
  id: string,
  filename: string,
  localPath: string,
  base: BaseDir,
  progress: ProgressHandler,
): Promise<void> => {
  const { provider, spaceId } = await getPrivateS3Runtime();
  const remotePath = `${bundlePath(spaceId, kind, id)}/${segment(filename)}`;
  if (provider.uploadStream) {
    if (
      !(await provider.uploadStream(remotePath, await service.resolveFilePath(localPath, base)))
    ) {
      throw new Error('S3 resource upload failed');
    }
    return;
  }
  const file = await service.openFile(localPath, base);
  try {
    const body = await file.arrayBuffer();
    await provider.writeBinary(remotePath, body);
    progress({ progress: body.byteLength, transferSpeed: 0, total: body.byteLength });
  } finally {
    await (file as ClosableFile).close?.();
  }
};

export const downloadS3ReplicaFile = async (
  service: AppService,
  kind: string,
  id: string,
  filename: string,
  localPath: string,
  base: BaseDir,
  progress?: ProgressHandler,
): Promise<void> => {
  const { provider, spaceId } = await getPrivateS3Runtime();
  const remotePath = `${bundlePath(spaceId, kind, id)}/${segment(filename)}`;
  const directory = getDirPath(localPath);
  if (directory) await service.createDir(directory, base, true);
  if (provider.downloadStream) {
    if (
      !(await provider.downloadStream(
        remotePath,
        await service.resolveFilePath(localPath, base),
        progress,
      ))
    ) {
      throw new Error('S3 resource download failed');
    }
    return;
  }
  const body = await provider.readBinary(remotePath);
  if (!body) throw new Error('S3 resource was not found');
  await service.writeFile(localPath, base, body);
  progress?.({ progress: body.byteLength, transferSpeed: 0, total: body.byteLength });
};

export const deleteS3ReplicaBundle = async (kind: string, id: string): Promise<void> => {
  const { provider, spaceId } = await getPrivateS3Runtime();
  await provider.deleteDir(bundlePath(spaceId, kind, id));
};
