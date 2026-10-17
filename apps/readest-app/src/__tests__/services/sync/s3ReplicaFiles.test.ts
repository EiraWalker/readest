import { describe, expect, it, vi } from 'vitest';
import type { AppService } from '@/types/system';

const remote = vi.hoisted(() => ({
  writeBinary: vi.fn(),
  readBinary: vi.fn(),
  deleteDir: vi.fn(),
}));
vi.mock('@/services/sync/privateS3Runtime', () => ({
  getPrivateS3Runtime: async () => ({ provider: remote, spaceId: 'space' }),
}));
import {
  downloadS3ReplicaFile,
  uploadS3ReplicaFile,
  deleteS3ReplicaBundle,
} from '@/services/sync/s3ReplicaFiles';

describe('S3 replica resource transfer', () => {
  it('uploads and closes a local resource, downloads its bytes, and deletes only its bundle', async () => {
    const bytes = new Uint8Array([7, 8, 9]).buffer;
    const close = vi.fn();
    const writeFile = vi.fn();
    const service = {
      openFile: async () => ({ arrayBuffer: async () => bytes, close }),
      writeFile,
      createDir: vi.fn(),
      resolveFilePath: async () => 'local/font.ttf',
    } as unknown as AppService;
    await uploadS3ReplicaFile(
      service,
      'font',
      'font-id',
      'font.ttf',
      'local.ttf',
      'Fonts',
      vi.fn(),
    );
    expect(remote.writeBinary).toHaveBeenCalledWith(
      '/Readest/sync/space/resources/font/font-id/font.ttf',
      bytes,
    );
    expect(close).toHaveBeenCalledOnce();
    remote.readBinary.mockResolvedValue(bytes);
    await downloadS3ReplicaFile(service, 'font', 'font-id', 'font.ttf', 'folder/font.ttf', 'Fonts');
    expect(writeFile).toHaveBeenCalledWith('folder/font.ttf', 'Fonts', bytes);
    await deleteS3ReplicaBundle('font', 'font-id');
    expect(remote.deleteDir).toHaveBeenCalledWith('/Readest/sync/space/resources/font/font-id');
  });
});
