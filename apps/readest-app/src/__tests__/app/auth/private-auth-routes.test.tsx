import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const h = vi.hoisted(() => ({
  callback: vi.fn(),
  authUI: vi.fn(() => null),
  onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams('payment=stripe&session_id=stale'),
}));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ login: vi.fn(), user: null }) }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (key: string) => key }));
vi.mock('@/hooks/useTheme', () => ({ useTheme: vi.fn() }));
vi.mock('@/store/themeStore', () => ({ useThemeStore: () => ({ isDarkMode: false }) }));
vi.mock('@/helpers/auth', () => ({ handleAuthCallback: h.callback }));
vi.mock('@supabase/auth-ui-react', () => ({ Auth: h.authUI }));
vi.mock('@/utils/supabase', () => ({
  supabase: { auth: { onAuthStateChange: h.onAuthStateChange } },
}));
vi.mock('@/app/user/components/PrivateSyncPage', () => ({
  PrivateSyncPage: () => <div data-testid='private-sync'>Private sync settings</div>,
}));

import AuthCallback from '@/app/auth/callback/page';
import ResetPasswordPage from '@/app/auth/recovery/page';
import UpdateEmailPage from '@/app/auth/update/page';
import AuthErrorPage from '@/app/auth/error/page';
import SubscriptionSuccessPage from '@/app/user/subscription/success/page';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_PRIVATE_S3', 'true');
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test('a private subscription callback opens local sync without contacting official billing', async () => {
  const fetch = vi.fn(async () => Response.json({ error: 'stale callback' }));
  vi.stubGlobal('fetch', fetch);
  render(<SubscriptionSuccessPage />);
  await Promise.resolve();
  expect(screen.getByTestId('private-sync')).toBeTruthy();
  expect(fetch).not.toHaveBeenCalled();
});

test.each([
  ['callback', AuthCallback],
  ['recovery', ResetPasswordPage],
  ['update', UpdateEmailPage],
  ['error', AuthErrorPage],
] as const)('private /auth/%s opens local sync without mounting official authentication', (_route, Page) => {
  render(<Page />);
  expect(screen.getByTestId('private-sync')).toBeTruthy();
  expect(h.callback).not.toHaveBeenCalled();
  expect(h.authUI).not.toHaveBeenCalled();
  expect(h.onAuthStateChange).not.toHaveBeenCalled();
});
