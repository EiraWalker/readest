/** Serialize device-owned snapshots across WebViews sharing this app origin. */
export const withS3DeviceLock = <T>(
  namespace: string,
  spaceId: string,
  deviceId: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks) return operation();
  return locks.request(
    `readest-private-s3:${JSON.stringify([namespace, spaceId, deviceId])}`,
    operation,
  );
};
