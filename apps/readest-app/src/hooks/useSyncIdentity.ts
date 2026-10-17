import { useAuth } from '@/context/AuthContext';
import { useSettingsStore } from '@/store/settingsStore';
import { getPrivateS3Identity, isPrivateS3Mode } from '@/services/sync/privateS3';

/** Sync identity is independent of the official authentication session. */
export const useSyncIdentity = (): string | null => {
  const { user } = useAuth();
  const settings = useSettingsStore((state) => state.settings);
  return isPrivateS3Mode() ? getPrivateS3Identity(settings) : (user?.id ?? null);
};
