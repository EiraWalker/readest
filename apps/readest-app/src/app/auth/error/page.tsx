'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useTheme } from '@/hooks/useTheme';
import { isPrivateS3Mode } from '@/services/sync/privateS3';
import { PrivateSyncPage } from '@/app/user/components/PrivateSyncPage';

export default function AuthErrorPage() {
  return isPrivateS3Mode() ? <PrivateSyncPage /> : <OfficialAuthErrorPage />;
}

function OfficialAuthErrorPage() {
  const router = useRouter();
  useTheme({ systemUIVisible: false });

  useEffect(() => {
    const timer = setTimeout(() => {
      router.push('/auth');
    }, 3000);

    return () => clearTimeout(timer);
  }, [router]);

  return (
    <div className='bg-base-200/50 text-base-content hero h-screen items-center justify-center'>
      <div className='hero-content text-neutral-content text-center'>
        <div className='max-w-md'>
          <p className='mb-5'>You will be redirected to the login page shortly...</p>
          <button className='btn btn-primary rounded-xl' onClick={() => router.push('/auth')}>
            Go to Login
          </button>
        </div>
      </div>
    </div>
  );
}
