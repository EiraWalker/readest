import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Book } from '@/types/book';
import { DEFAULT_SYSTEM_SETTINGS } from '@/services/constants';
import { useSettingsStore } from '@/store/settingsStore';
import BookItem from '@/app/library/components/BookItem';

const h = vi.hoisted(() => ({
  auth: vi.fn<() => { user: { id: string } | null }>(),
  login: vi.fn(),
  router: { push: vi.fn() },
}));
vi.mock('next/navigation', () => ({ useRouter: () => h.router }));
vi.mock('@/context/EnvContext', () => ({ useEnv: () => ({ appService: null }) }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => h.auth() }));
vi.mock('@/hooks/useTranslation', () => ({ useTranslation: () => (text: string) => text }));
vi.mock('@/hooks/useResponsiveSize', () => ({ useResponsiveSize: (size: number) => size }));
vi.mock('@/hooks/useMedianPageDurationSecs', () => ({
  useMedianPageDurationSecs: () => undefined,
}));
vi.mock('@/components/BookCover', () => ({ default: () => null }));
vi.mock('@/utils/nav', () => ({ navigateToLogin: h.login }));

const book: Book = {
  hash: 'remote-book',
  title: 'Remote book',
  author: 'Author',
  format: 'EPUB',
  createdAt: 1,
  updatedAt: 1,
  uploadedAt: 1,
};
const download = vi.fn();
const upload = vi.fn();
const props = {
  mode: 'list' as const,
  coverFit: 'crop' as const,
  isSelectMode: false,
  bookSelected: false,
  transferProgress: null,
  handleBookUpload: upload,
  handleBookDownload: download,
  showBookDetailsModal: vi.fn(),
  showTimeRemaining: false,
};

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_PRIVATE_S3', 'false');
  h.auth.mockReturnValue({ user: null });
  useSettingsStore.setState((state) => ({
    settings: { ...state.settings, ...DEFAULT_SYSTEM_SETTINGS },
  }));
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  'Download Book',
  'Upload Book',
])('%s uses the private space without official sign in', (label) => {
  vi.stubEnv('NEXT_PUBLIC_PRIVATE_S3', 'true');
  useSettingsStore.setState({
    settings: {
      ...useSettingsStore.getState().settings,
      s3: {
        ...DEFAULT_SYSTEM_SETTINGS.s3,
        enabled: true,
        endpoint: 'https://s3.example.com',
        region: 'cn-north-1',
        bucket: 'private-test',
      },
    },
  });
  const target = label === 'Download Book' ? book : { ...book, uploadedAt: undefined };
  render(<BookItem {...props} book={target} />);
  fireEvent.click(screen.getByRole('button', { name: label }));

  if (label === 'Download Book') {
    expect(download).toHaveBeenCalledWith(target, { queued: true });
  } else {
    expect(upload).toHaveBeenCalledWith(target);
  }
  expect(h.login).not.toHaveBeenCalled();
});

it('preserves the official sign-in requirement in standard mode', () => {
  render(<BookItem {...props} book={book} />);
  fireEvent.click(screen.getByRole('button', { name: 'Download Book' }));
  expect(h.login).toHaveBeenCalledWith(h.router);
  expect(download).not.toHaveBeenCalled();
});

it('opens sync management when the private connection is not configured', () => {
  vi.stubEnv('NEXT_PUBLIC_PRIVATE_S3', 'true');
  h.auth.mockReturnValue({ user: { id: 'official-user' } });
  render(<BookItem {...props} book={book} />);
  fireEvent.click(screen.getByRole('button', { name: 'Download Book' }));
  expect(h.router.push).toHaveBeenCalledWith('/user?section=sync');
  expect(h.login).not.toHaveBeenCalled();
  expect(download).not.toHaveBeenCalled();
});

it('keeps standard signed-in download behavior', () => {
  h.auth.mockReturnValue({ user: { id: 'official-user' } });
  render(<BookItem {...props} book={book} />);
  fireEvent.click(screen.getByRole('button', { name: 'Download Book' }));
  expect(download).toHaveBeenCalledWith(book, { queued: true });
  expect(h.login).not.toHaveBeenCalled();
});
