import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { SystemSettings } from '@/types/settings';
import type { FileSystem } from '@/types/system';

const h = vi.hoisted(() => ({
  persist: vi.fn<(settings: SystemSettings) => Promise<void>>(),
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({
    envConfig: { getAppService: async () => ({ saveSettings: h.persist }) },
  }),
}));
vi.mock('@/hooks/useTranslation', () => ({
  useTranslation:
    () =>
    (key: string, options: Record<string, string> = {}) =>
      key.replace(/\{\{(\w+)\}\}/g, (token, name: string) => options[name] ?? token),
}));
vi.mock('@/i18n/i18n', () => ({ default: { changeLanguage: vi.fn() } }));
vi.mock('@/utils/time', () => ({ initDayjs: vi.fn() }));
vi.mock('@/utils/settingsSync', () => ({ broadcastGlobalSettings: vi.fn() }));

import ExplanationPromptEditor from '@/components/settings/ExplanationPromptEditor';
import { useSettingsStore } from '@/store/settingsStore';
import { loadSettings, saveSettings } from '@/services/settingsService';
import { broadcastGlobalSettings } from '@/utils/settingsSync';
import { SETTINGS_FILENAME } from '@/services/constants';
import {
  buildExplanationPrompt,
  DEFAULT_EXPLANATION_PROMPT_TEMPLATE,
} from '@/app/reader/utils/explanationPrompt';

const files = new Map<string, string>();
const fs = {
  readFile: async (path: string) => {
    if (!files.has(path)) throw new Error('ENOENT');
    return files.get(path)!;
  },
  writeFile: async (path: string, _base: unknown, content: string) => {
    files.set(path, content);
  },
  getPrefix: async () => 'Books',
} as unknown as FileSystem;
const context = { fs, isMobile: false, isEink: false, isAppDataSandbox: false };
const template = () =>
  useSettingsStore.getState().settings.globalReadSettings.explanationPromptTemplate;
const textbox = () => screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Prompt Template' });

beforeEach(async () => {
  vi.clearAllMocks();
  files.clear();
  localStorage.clear();
  useSettingsStore.getState().setSettings(await loadSettings(context));
  h.persist.mockImplementation((settings) => saveSettings(fs, settings));
});
afterEach(cleanup);

describe('global explanation template settings → persisted prompt', () => {
  test('loads the default for old settings and explains the global scope and placeholders', () => {
    render(<ExplanationPromptEditor onBack={() => {}} />);
    expect(textbox().value).toBe(DEFAULT_EXPLANATION_PROMPT_TEMPLATE);
    expect(screen.getByText('One prompt template for all books on this device.')).toBeTruthy();
    expect(screen.getByText(/The complete selected text\./)).toBeTruthy();
    expect(screen.getByText(/Available title, author, chapter, location and link\./)).toBeTruthy();
  });

  test('saves through the real global store and settings persistence, then survives a reload', async () => {
    const onBack = vi.fn();
    const draft = '  Discuss {{selection}}\nSOURCE {{source}}\n  ';
    const ui = render(<ExplanationPromptEditor onBack={onBack} />);
    fireEvent.change(textbox(), { target: { value: draft } });
    expect(template()).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onBack).toHaveBeenCalledOnce());
    expect(template()).toBe(draft);
    expect(
      JSON.parse(files.get(SETTINGS_FILENAME)!).globalReadSettings.explanationPromptTemplate,
    ).toBe(draft);
    expect(broadcastGlobalSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        globalReadSettings: expect.objectContaining({ explanationPromptTemplate: draft }),
      }),
    );
    ui.unmount();
    useSettingsStore.getState().setSettings(await loadSettings(context));
    render(<ExplanationPromptEditor onBack={() => {}} />);
    expect(textbox().value).toBe(draft);
    for (const title of ['Book A', 'Book B']) {
      const text = buildExplanationPrompt(
        { text: 'passage', title, locations: [] },
        null,
        template(),
      );
      expect(text).toBe(`  Discuss passage\nSOURCE 资料：《${title}》\n  `);
    }
  });

  test.each([
    '',
    ' \n\t ',
    'Missing the selected text',
    '{{Selection}} {{source}}',
  ])('rejects invalid template %j without changing the active prompt', async (draft) => {
    render(<ExplanationPromptEditor onBack={() => {}} />);
    fireEvent.change(textbox(), { target: { value: draft } });
    expect(screen.getByRole('button', { name: 'Save' })).toHaveProperty('disabled', true);
    expect(textbox().getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(textbox().getAttribute('aria-describedby')!)?.textContent).toBe(
      'Include {{selection}} in the template.',
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(h.persist).not.toHaveBeenCalled();
    expect(template()).toBeUndefined();
  });

  test('leaving without saving discards the draft', () => {
    const onBack = vi.fn();
    const ui = render(<ExplanationPromptEditor onBack={onBack} />);
    fireEvent.change(textbox(), { target: { value: 'Draft {{selection}}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Behavior' }));
    expect(onBack).toHaveBeenCalledOnce();
    ui.unmount();
    render(<ExplanationPromptEditor onBack={() => {}} />);
    expect(textbox().value).toBe(DEFAULT_EXPLANATION_PROMPT_TEMPLATE);
    expect(h.persist).not.toHaveBeenCalled();
  });

  test('reset only changes the draft until it is saved', async () => {
    const settings = useSettingsStore.getState().settings;
    useSettingsStore.getState().setSettings({
      ...settings,
      globalReadSettings: {
        ...settings.globalReadSettings,
        explanationPromptTemplate: 'Old {{selection}}',
      },
    });
    const onBack = vi.fn();
    render(<ExplanationPromptEditor onBack={onBack} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset to Default' }));
    expect(textbox().value).toBe(DEFAULT_EXPLANATION_PROMPT_TEMPLATE);
    expect(template()).toBe('Old {{selection}}');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onBack).toHaveBeenCalledOnce());
    expect(template()).toBe(DEFAULT_EXPLANATION_PROMPT_TEMPLATE);
  });

  test('does not activate a pending or failed save, retains the draft and permits retry', async () => {
    const pending = Promise.withResolvers<void>();
    h.persist.mockReturnValueOnce(pending.promise);
    const onBack = vi.fn();
    render(<ExplanationPromptEditor onBack={onBack} />);
    fireEvent.change(textbox(), { target: { value: 'Retry {{selection}}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(h.persist).toHaveBeenCalledOnce());
    expect(template()).toBeUndefined();
    expect(textbox()).toHaveProperty('disabled', true);
    await act(async () => pending.reject(new Error('disk full')));
    expect(screen.getByRole('alert').textContent).toBe(
      'Could not save the prompt template. Please try again.',
    );
    expect(textbox().value).toBe('Retry {{selection}}');
    expect(template()).toBeUndefined();
    expect(broadcastGlobalSettings).not.toHaveBeenCalled();
    expect(onBack).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onBack).toHaveBeenCalledOnce());
    expect(template()).toBe('Retry {{selection}}');
  });
});
