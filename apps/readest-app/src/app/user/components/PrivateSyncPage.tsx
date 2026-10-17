'use client';

import { useAppRouter } from '@/hooks/useAppRouter';
import { useTranslation } from '@/hooks/useTranslation';
import { useTheme } from '@/hooks/useTheme';
import { SyncCategoriesSection } from './SyncCategoriesSection';
import { SyncPassphraseSection } from './SyncPassphraseSection';
import ProfileHeader from './Header';

export function PrivateSyncPage() {
  const router = useAppRouter();
  const _ = useTranslation();
  useTheme({ systemUIVisible: false });
  return (
    <main className='bg-base-100 text-base-content min-h-screen'>
      <ProfileHeader onGoBack={() => router.back()} />
      <div className='mx-auto flex max-w-2xl flex-col gap-4 px-4 pb-8 pt-16 sm:px-8'>
        <h1 className='text-xl font-semibold'>{_('Manage Sync')}</h1>
        <SyncCategoriesSection />
        <SyncPassphraseSection />
      </div>
    </main>
  );
}
