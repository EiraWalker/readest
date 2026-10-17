import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadestVoiceProvider } from '@/services/tts/providers/readest';
import { getTranslators } from '@/services/translators/providers';
import { deeplProvider } from '@/services/translators/providers/deepl';
import { isInboxDrainEnabled } from '@/services/send/devicePrefs';
import { fetchWithAuth } from '@/utils/fetch';

vi.mock('@/utils/fetch', () => ({ fetchWithAuth: vi.fn() }));

beforeEach(() => vi.stubEnv('NEXT_PUBLIC_PRIVATE_S3', 'true'));
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('private S3 official services removal', () => {
  it('excludes the official translation proxy and blocks a stale direct invocation', async () => {
    expect(getTranslators().map((translator) => translator.name)).not.toContain('deepl');
    const fetch = vi.spyOn(globalThis, 'fetch');
    await expect(deeplProvider.translate(['Hello'], 'en', 'zh', 'stale-token')).rejects.toThrow(
      'unavailable',
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('disables the official inbox drainer regardless of old local preferences', () => {
    localStorage.setItem('readest-send-drain-enabled', 'true');
    expect(isInboxDrainEnabled()).toBe(false);
  });

  it('cannot fetch official voice lists, warmup, or speech from stale references', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const provider = new ReadestVoiceProvider();
    expect(await provider.init()).toBe(false);
    expect(await provider.getAllVoices()).toEqual([]);
    provider.warmup();
    const request = { text: 'Hello', lang: 'en-US', voice: 'kokoro:af_heart', pitch: 1 };
    const signal = new AbortController().signal;
    provider.prefetch([request], 'download', signal);
    await expect(provider.synthesize(request, signal)).rejects.toThrow('unavailable');
    expect(fetch).not.toHaveBeenCalled();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});
