import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { eventDispatcher } from '@/utils/event';
import type { TextSelection } from '@/utils/sel';
import type { BookData } from '@/store/bookDataStore';
import type { BookDoc, TOCItem } from '@/libs/document';
import { TOCProgress } from 'foliate-js/progress.js';
import * as CFI from 'foliate-js/epubcfi.js';
import { writeTextToClipboard } from '@/utils/clipboard';
import Annotator from '@/app/reader/components/annotator/Annotator';

const h = vi.hoisted(() => ({
  booksData: {} as Record<string, BookData>,
  views: {} as Record<string, unknown>,
  actions: null as null | Record<string, () => boolean>,
  config: { booknotes: [] as unknown[], viewSettings: {} },
  viewSettings: {
    // A non-empty toolbar so the popup actually renders (Annotator suppresses
    // it entirely when there is nothing to show).
    annotationToolbarItems: ['copyexplain'] as string[],
    noteExportConfig: {},
    copyToNotebook: false,
    rtl: false,
    vertical: false,
    enableAnnotationQuickActions: false,
    annotationQuickAction: '' as string,
    keepSelectionAfterLookup: false,
  },
  saveConfig: vi.fn(),
  nativeClipboardWrite: vi.fn<(text: string) => Promise<void>>(),
  updateBooknotes: vi.fn(),
  deselect: vi.fn(),
  restoreSelectionRange: vi.fn(() => true),
  isTextSelected: { current: true },
  // Swapped per test: the fixed-layout branch of `onLoad` used to wire PDF-only
  // listeners, so a regression there is only visible with this on.
  book: { format: 'EPUB', isFixedLayout: false },
  // `onLoad` and friends, captured from the `useFoliateEvents` call so a test can
  // fire a section load and drive the listeners it registers on the section doc.
  foliateHandlers: null as null | Record<string, (event: Event) => void>,
  // Annotator's own `setSelection`, captured from the `useTextSelector` call
  // so a test can republish the selection exactly as the hook does.
  setSelection: null as
    | null
    | ((update: (prev: TextSelection | null) => TextSelection | null) => void),
}));

const settings = {
  globalReadSettings: {
    highlightStyle: 'highlight',
    highlightStyles: { highlight: 'yellow', underline: 'green', squiggly: 'blue' },
  },
};

vi.mock('@/hooks/useShortcuts', () => ({
  default: (actions: Record<string, () => boolean>) => {
    h.actions = actions;
  },
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ envConfig: {}, appService: {} }),
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (value: string) => value,
}));

vi.mock('@/hooks/useResponsiveSize', () => ({
  useResponsiveSize: (value: number) => value,
}));

vi.mock('@/store/settingsStore', () => ({
  useSettingsStore: Object.assign(
    () => ({
      settings,
      setSettingsDialogBookKey: vi.fn(),
      setSettingsDialogOpen: vi.fn(),
      setActiveSettingsItemId: vi.fn(),
    }),
    { getState: () => ({ settings }) },
  ),
}));

vi.mock('@/store/themeStore', () => ({
  useThemeStore: () => ({ isDarkMode: false }),
}));

vi.mock('@/store/bookDataStore', () => {
  const state = {
    getConfig: () => h.config,
    setConfig: vi.fn(),
    saveConfig: h.saveConfig,
    getBookData: (key: string) => h.booksData[key],
    updateBooknotes: h.updateBooknotes,
  };
  return {
    useBookDataStore: (selector?: (value: typeof state) => unknown) =>
      selector ? selector(state) : state,
  };
});

vi.mock('@/store/readerStore', () => {
  const state = {
    getView: (key: string) => h.views[key],
    getViewsById: () => [],
    getViewSettings: () => h.viewSettings,
  };
  return {
    useReaderStore: (selector?: (value: typeof state) => unknown) =>
      selector ? selector(state) : state,
  };
});

vi.mock('@/store/readerProgressStore', () => ({
  getBookProgress: () => ({ page: 1 }),
  useBookProgress: () => ({ page: 1, sectionHref: 'chapter.xhtml' }),
}));

vi.mock('@/store/notebookStore', () => ({
  useNotebookStore: () => ({
    setNotebookVisible: vi.fn(),
    setNotebookActiveTab: vi.fn(),
    setNotebookNewAnnotation: vi.fn(),
    setNotebookNewHighlightIds: vi.fn(),
  }),
}));

vi.mock('@/store/sidebarStore', () => ({
  useSidebarStore: () => ({
    clearBooknotesNav: vi.fn(),
    isSideBarVisible: false,
    setSideBarVisible: vi.fn(),
    setSearchBarVisible: vi.fn(),
  }),
}));

vi.mock('@/store/customDictionaryStore', () => ({
  useCustomDictionaryStore: Object.assign(
    () => ({ loadCustomDictionaries: vi.fn().mockResolvedValue(undefined) }),
    { getState: () => ({ settings: { providerEnabled: {} } }) },
  ),
}));

vi.mock('@/store/deviceStore', () => ({
  useDeviceControlStore: () => ({ listenToNativeTouchEvents: vi.fn() }),
}));

vi.mock('@/hooks/useFileSelector', () => ({
  useFileSelector: () => ({ selectFiles: vi.fn() }),
}));

vi.mock('@/app/reader/hooks/useNotesSync', () => ({ useNotesSync: () => {} }));
vi.mock('@/app/reader/hooks/useBookOrbitNotesSync', () => ({ useBookOrbitNotesSync: () => {} }));
vi.mock('@/app/reader/hooks/useReadwiseSync', () => ({ useReadwiseSync: () => {} }));
vi.mock('@/app/reader/hooks/useHardcoverSync', () => ({ useHardcoverSync: () => {} }));
vi.mock('@/app/reader/hooks/usePageboundSync', () => ({ usePageboundSync: () => {} }));
vi.mock('@/app/reader/hooks/useNotionSync', () => ({ useNotionSync: () => {} }));
vi.mock('@/app/reader/hooks/useFoliateEvents', () => ({
  useFoliateEvents: (_view: unknown, handlers: Record<string, (event: Event) => void>) => {
    h.foliateHandlers = handlers;
  },
}));
vi.mock('@/app/reader/hooks/useRendererInputListeners', () => ({
  useRendererInputListeners: () => {},
}));

vi.mock('@/app/reader/hooks/useTextSelector', () => ({
  useTextSelector: (
    _bookKey: string,
    _contentInsets: unknown,
    setSelection: (update: (prev: TextSelection | null) => TextSelection | null) => void,
  ) => {
    h.setSelection = setSelection;
    return {
      isTextSelected: h.isTextSelected,
      isInstantAnnotating: { current: false },
      handleScroll: vi.fn(),
      handleTouchStart: vi.fn(),
      handleTouchMove: vi.fn(),
      handleTouchEnd: vi.fn(),
      handleMouseDown: vi.fn(),
      handlePointerDown: vi.fn(),
      handlePointerMove: vi.fn(),
      handleNativeTouchMove: vi.fn(),
      handlePointerCancel: vi.fn(),
      handlePointerUp: vi.fn(),
      handleDoubleClick: vi.fn(),
      handleSelectionchange: vi.fn(),
      handleShowPopup: vi.fn(),
      handleUpToPopup: vi.fn(),
      handleContextmenu: vi.fn(),
      dragSelectionTo: vi.fn(),
      // The real hook republishes the selection with the flag set; the test
      // drives that step itself so it can assert what the effect does with it.
      suppressNativeSelectionHandles: vi.fn(),
      restoreSelectionRange: h.restoreSelectionRange,
      noteAutoTurnPoint: { current: null },
      cancelAutoTurn: vi.fn(),
      onAutoTurn: vi.fn(),
    };
  },
}));

// jsdom lays nothing out, so the real popup positioning bails on a zero rect
// and no popup ever renders. Feed it fixed anchor points instead.
vi.mock('@/utils/sel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/sel')>();
  return {
    ...actual,
    getPosition: () => ({ point: { x: 120, y: 200 }, dir: 'up' as const }),
    getPopupPosition: () => ({ point: { x: 120, y: 140 }, dir: 'up' as const }),
  };
});

vi.mock('@/services/transformService', () => ({
  transformContent: ({ content }: { content: string }) => Promise.resolve(content),
}));

vi.mock('@/app/reader/components/annotator/AnnotationRangeEditor', () => ({ default: () => null }));
vi.mock('@/app/reader/components/annotator/SelectionRangeEditor', () => ({ default: () => null }));
vi.mock('@/app/reader/components/annotator/ExportMarkdownDialog', () => ({ default: () => null }));
vi.mock('@/app/reader/components/annotator/ImportAnnotationsDialog', () => ({
  default: () => null,
}));
vi.mock('@/components/Popup', () => ({
  default: ({ children }: { children: React.ReactNode }) => (
    <div data-testid='selection-toolbar'>{children}</div>
  ),
}));
vi.mock('@/utils/clipboard', () => ({ writeTextToClipboard: vi.fn() }));
vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({ writeText: h.nativeClipboardWrite }));
// The dismiss button stands in for the popup's close / backdrop tap, so a test
// can drive the route back out of the lookup. Each surface reads its text the
// way the real one does on every render, so rendering one without a word fails
// the same way (#6419).
vi.mock('@/app/reader/components/annotator/DictionaryPopup', () => ({
  default: ({ word, onDismiss }: { word: string; onDismiss: () => void }) => (
    <div data-testid='dictionary-surface' data-word={word.trim()}>
      <button type='button' data-testid='dictionary-dismiss' onClick={onDismiss} />
    </div>
  ),
}));
vi.mock('@/app/reader/components/annotator/DictionarySheet', () => ({
  default: ({ word, onDismiss }: { word: string; onDismiss: () => void }) => (
    <div data-testid='dictionary-surface' data-word={word.trim()}>
      <button type='button' data-testid='dictionary-dismiss' onClick={onDismiss} />
    </div>
  ),
}));
vi.mock('@/app/reader/components/annotator/TranslatorPopup', () => ({
  default: ({ text }: { text: string }) => (
    <div data-testid='translator-surface' data-text={text.trim()} />
  ),
}));
vi.mock('@/app/reader/components/annotator/ProofreadPopup', () => ({
  default: () => <div data-testid='proofread-surface' />,
}));

const createFixture = async () => {
  const documents = [
    '<h1 id="one">第一章</h1><p id="intro">第一段</p><h2 id="nested">嵌套小节</h2><pre id="code">  first line\n    second line\n</pre>',
    '<h1 id="two">第二章</h1><p id="end">最后一段</p>',
  ].map((html) => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const doc = frame.contentDocument!;
    doc.body.innerHTML = html;
    return doc;
  });
  const toc: TOCItem[] = [
    {
      id: 0,
      label: '第一章',
      href: 'one.xhtml#one',
      index: 0,
      subitems: [{ id: 1, label: '嵌套小节', href: 'one.xhtml#nested', index: 0 }],
    },
    { id: 2, label: '第二章', href: 'two.xhtml#two', index: 1 },
  ];
  const tocProgress = new TOCProgress();
  await tocProgress.init({
    toc,
    ids: ['one.xhtml', 'two.xhtml'],
    splitHref: (href: string) => href.split('#'),
    getFragment: (doc: Document, id: string) => doc.getElementById(id),
  });
  const bookDoc: BookDoc = {
    metadata: { title: '解析的书名', author: '原作者', language: 'zh' },
    rendition: { layout: 'reflowable' },
    dir: 'ltr',
    toc,
    sections: documents.map((doc, index) => ({
      id: ['one.xhtml', 'two.xhtml'][index]!,
      size: 100,
      linear: 'yes',
      cfi: CFI.fake.fromIndex(index),
      createDocument: vi.fn(async () => doc),
    })),
    splitTOCHref: (href) => href.split('#'),
    getCover: async () => null,
  };
  const data: BookData = {
    id: 'book',
    file: new File([''], 'source.epub'),
    bookDoc,
    isFixedLayout: false,
    config: { updatedAt: 1 },
    book: {
      hash: 'book',
      title: '书库显示名',
      author: '书库作者',
      format: 'EPUB',
      createdAt: 1,
      updatedAt: 1,
    },
  };
  const cfiRanges = new Map<string, { index: number; range: Range }>();
  const view = Object.assign(document.createElement('div'), {
    book: bookDoc,
    isFixedLayout: false,
    deselect: h.deselect,
    renderer: Object.assign(document.createElement('div'), {
      getContents: () => documents.map((doc, index) => ({ doc, index })),
    }),
    getCFI: vi.fn((index: number, range: Range) => {
      const cfi = CFI.joinIndir(CFI.fake.fromIndex(index), CFI.fromRange(range));
      cfiRanges.set(cfi, { index, range: range.cloneRange() });
      return cfi;
    }),
    resolveCFI: (cfi: string) => {
      const resolved = cfiRanges.get(cfi);
      if (!resolved) throw new Error('Unknown CFI');
      return { index: resolved.index, anchor: () => resolved.range.cloneRange() };
    },
    getProgressOf: (index: number, range: Range) => ({
      tocItem: tocProgress.getProgress(index, range),
    }),
  });
  h.booksData['book-1'] = data;
  h.views['book-1'] = view;
  const rangeAt = (index: number, id: string) => {
    const range = documents[index]!.createRange();
    range.selectNodeContents(documents[index]!.getElementById(id)!);
    return range;
  };
  return { data, view, documents, rangeAt };
};

let fixture: Awaited<ReturnType<typeof createFixture>>;
let toast: ReturnType<typeof vi.fn<(event: CustomEvent<{ message: string }>) => void>>;

beforeEach(async () => {
  vi.clearAllMocks();
  h.booksData = {};
  h.views = {};
  h.config.booknotes = [];
  h.viewSettings.annotationToolbarItems = ['copyexplain'];
  h.viewSettings.copyToNotebook = true;
  h.viewSettings.noteExportConfig = {};
  h.isTextSelected.current = true;
  vi.mocked(writeTextToClipboard).mockResolvedValue(true);
  fixture = await createFixture();
  toast = vi.fn();
  eventDispatcher.on('toast', toast);
  const cell = document.createElement('div');
  cell.id = 'gridcell-book-1';
  document.body.append(cell);
  render(<Annotator bookKey='book-1' contentInsets={{ top: 0, right: 0, bottom: 0, left: 0 }} />);
});

afterEach(() => {
  eventDispatcher.off('toast', toast);
  cleanup();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const select = async (overrides: Partial<TextSelection> = {}) => {
  const range = fixture.rangeAt(0, 'code');
  const selection: TextSelection = {
    key: 'book-1',
    range,
    index: 0,
    page: 999,
    text: range.toString(),
    ...overrides,
  };
  await act(async () => h.setSelection?.(() => selection));
  return selection;
};
const copy = () => fireEvent.click(screen.getByRole('button', { name: 'Copy Explanation Prompt' }));
const copiedText = () => vi.mocked(writeTextToClipboard).mock.calls.at(-1)![0];
const hasToast = (message: string) =>
  toast.mock.calls.some(([event]) => event.detail.message === message);

describe('selection toolbar → explanation prompt clipboard', () => {
  test('resolves a selection starting at the element boundary before a nested heading', async () => {
    const range = fixture.rangeAt(0, 'code');
    range.setStart(fixture.documents[0]!.body, 2);
    await select({ range });
    copy();
    await waitFor(() => expect(writeTextToClipboard).toHaveBeenCalled());
    expect(copiedText()).toContain('章节：嵌套小节');
    expect(copiedText()).not.toContain('第一章 →');
  });

  test('excludes the next heading when the range ends at its first text offset', async () => {
    const range = fixture.rangeAt(0, 'intro');
    range.setEnd(fixture.documents[0]!.getElementById('nested')!.firstChild!, 0);
    await select({ range });
    copy();
    await waitFor(() => expect(writeTextToClipboard).toHaveBeenCalled());
    expect(copiedText()).toContain('章节：第一章');
    expect(copiedText()).not.toContain('→ 嵌套小节');
  });
  test('uses a preceding loaded heading when the TOC has no entry at the selected anchor', async () => {
    fixture.view.getProgressOf = () => ({ tocItem: undefined });
    await select();
    copy();
    await waitFor(() => expect(writeTextToClipboard).toHaveBeenCalled());
    expect(copiedText()).toContain('章节：嵌套小节');
  });

  test('does not include the next chapter when the selection ends immediately before its heading', async () => {
    const range = fixture.rangeAt(0, 'intro');
    range.setEnd(fixture.documents[0]!.body, 2);
    await select({ range });
    copy();
    await waitFor(() => expect(writeTextToClipboard).toHaveBeenCalled());
    expect(copiedText()).toContain('章节：第一章');
    expect(copiedText()).not.toContain('→ 嵌套小节');
  });

  test('marks the starting chapter when the ending segment has no identifiable chapter', async () => {
    const progressOf = fixture.view.getProgressOf;
    fixture.view.getProgressOf = (index, range) =>
      index === 0 ? progressOf(index, range) : { tocItem: undefined };
    fixture.documents[1]!.querySelector('h1')!.remove();
    await select({
      segments: [
        { index: 0, range: fixture.rangeAt(0, 'code'), text: 'start' },
        { index: 1, range: fixture.rangeAt(1, 'end'), text: 'end' },
      ],
    });
    copy();
    await waitFor(() => expect(writeTextToClipboard).toHaveBeenCalled());
    expect(copiedText()).toContain('起始章节：嵌套小节');
  });

  test('maps popup text to a loaded source CFI without attributing the popup document heading', async () => {
    const source = fixture.rangeAt(0, 'code');
    const cfi = fixture.view.getCFI(0, source);
    const popup = document.createElement('div');
    popup.innerHTML = '<h1>不是源章节</h1><p>脚注原文</p>';
    document.body.append(popup);
    const range = document.createRange();
    range.selectNodeContents(popup.querySelector('p')!);
    await select({ popup: true, range, text: range.toString(), cfi, index: -1 });
    copy();
    await waitFor(() => expect(writeTextToClipboard).toHaveBeenCalled());
    expect(copiedText()).toContain('章节：嵌套小节');
    expect(copiedText()).toContain('脚注原文');
    expect(copiedText()).not.toContain('不是源章节');
  });

  test('copies without a link when CFI generation fails', async () => {
    fixture.view.getCFI.mockImplementation(() => {
      throw new Error('unavailable');
    });
    await select();
    copy();
    await waitFor(() => expect(hasToast('Explanation prompt copied')).toBe(true));
    expect(copiedText()).toContain('first line\n    second line');
    expect(copiedText()).not.toMatch(/结构定位|返回原文：/);
  });

  test('copies detached text even when no loaded chapter or structural anchor survives', async () => {
    const paragraph = fixture.documents[0]!.createElement('p');
    paragraph.textContent = 'detached text';
    const range = fixture.documents[0]!.createRange();
    range.selectNodeContents(paragraph);
    fixture.view.getCFI.mockImplementation(() => {
      throw new Error('detached');
    });
    fixture.view.getProgressOf = () => ({ tocItem: undefined });
    const text = range.toString();
    await select({ range, text });
    copy();
    await waitFor(() => expect(hasToast('Explanation prompt copied')).toBe(true));
    expect(copiedText()).toContain(text);
    expect(copiedText()).not.toMatch(/章节：|结构定位/);
  });

  test('keeps known document page indices when another segment has no valid location', async () => {
    fixture.data.isFixedLayout = true;
    await select({
      segments: [
        { index: 0, range: fixture.rangeAt(0, 'code'), text: 'known' },
        { index: -1, range: fixture.rangeAt(1, 'end'), text: 'unknown' },
      ],
    });
    copy();
    await waitFor(() => expect(writeTextToClipboard).toHaveBeenCalled());
    expect(copiedText()).toContain('片段 1：文档页序号 1（非印刷页码）');
    expect(copiedText()).not.toMatch(/页序号 0|页序号 -/);
  });

  test('retains a new native selection that has not yet reached React state', async () => {
    const pending = Promise.withResolvers<boolean>();
    vi.mocked(writeTextToClipboard).mockReturnValueOnce(pending.promise);
    await select();
    copy();
    const native = fixture.documents[1]!.getSelection()!;
    native.removeAllRanges();
    native.addRange(fixture.rangeAt(1, 'end'));
    await act(async () => pending.resolve(true));
    expect(h.deselect).not.toHaveBeenCalled();
    expect(native.toString()).toBe('最后一段');
  });

  test('retains an edited live range even if the selection object was reused', async () => {
    const pending = Promise.withResolvers<boolean>();
    vi.mocked(writeTextToClipboard).mockReturnValueOnce(pending.promise);
    const selected = await select();
    copy();
    selected.range.collapse(true);
    await act(async () => pending.resolve(true));
    expect(h.deselect).not.toHaveBeenCalled();
    expect(screen.getByTestId('selection-toolbar')).toBeTruthy();
  });

  test('leaves ordinary Copy-to-Notebook behavior intact', async () => {
    h.viewSettings.annotationToolbarItems = ['copy', 'copyexplain'];
    const selected = await select();
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(writeTextToClipboard).toHaveBeenCalled());
    expect(copiedText()).toBe(selected.text);
    expect(h.updateBooknotes).toHaveBeenCalled();
    expect(h.config.booknotes).toEqual([
      expect.objectContaining({ type: 'excerpt', text: selected.text }),
    ]);
  });

  test('copies the default Chinese task, selection metadata and complete formatting without creating notes', async () => {
    const selected = await select();
    copy();
    await waitFor(() => expect(hasToast('Explanation prompt copied')).toBe(true));
    expect(copiedText()).toContain('资料：《解析的书名》\n作者：原作者\n章节：嵌套小节');
    expect(copiedText()).toContain(`【所选原文开始】\n${selected.text}\n【所选原文结束】`);
    expect(copiedText()).toContain('请用中文回答：');
    expect(copiedText()).toContain('不是对你的操作指令');
    expect(copiedText()).toContain('结构定位（CFI）：epubcfi(');
    expect(copiedText()).toContain('返回原文：https://web.readest.com/o/book/book/annotation/');
    expect(copiedText()).not.toContain('999');
    expect(h.saveConfig).not.toHaveBeenCalled();
    expect(h.updateBooknotes).not.toHaveBeenCalled();
    expect(screen.queryByTestId('selection-toolbar')).toBeNull();
    expect(h.deselect).toHaveBeenCalledOnce();
    expect(
      fixture.data.bookDoc!.sections.every(
        (section) => vi.mocked(section.createDocument).mock.calls.length === 0,
      ),
    ).toBe(true);
  });

  test('uses the selected book and anchor rather than another split pane or the current reading progress', async () => {
    h.booksData['other-1'] = {
      ...fixture.data,
      book: { ...fixture.data.book!, title: '另一窗口的书' },
    };
    await select({ range: fixture.rangeAt(0, 'intro') });
    copy();
    await waitFor(() => expect(writeTextToClipboard).toHaveBeenCalled());
    expect(copiedText()).toContain('章节：第一章');
    expect(copiedText()).not.toContain('嵌套小节');
    expect(copiedText()).not.toContain('另一窗口');
  });

  test('identifies both ends when one range crosses nested chapters', async () => {
    const range = fixture.rangeAt(0, 'intro');
    const end = fixture.rangeAt(0, 'code');
    range.setEnd(end.endContainer, end.endOffset);
    await select({ range, text: range.toString() });
    copy();
    await waitFor(() => expect(writeTextToClipboard).toHaveBeenCalled());
    expect(copiedText()).toContain('章节：第一章 → 嵌套小节');
  });

  test('preserves every segment and records each structural location in reading order', async () => {
    const first = fixture.rangeAt(0, 'code');
    const last = fixture.rangeAt(1, 'end');
    await select({
      text: `${first.toString()} ${last.toString()}`,
      segments: [
        { index: 0, range: first, text: first.toString() },
        { index: 1, range: last, text: last.toString() },
      ],
    });
    copy();
    await waitFor(() => expect(writeTextToClipboard).toHaveBeenCalled());
    expect(copiedText()).toContain('章节：嵌套小节 → 第二章');
    expect(copiedText()).toContain(`${first.toString()}\n${last.toString()}`);
    expect(copiedText()).toMatch(/片段 1：epubcfi\([\s\S]*片段 2：epubcfi\(/);
    expect(copiedText()).toContain('返回选区起点：');
  });

  test('labels fixed layout positions as one-based document page indices, not printed pages', async () => {
    fixture.data.isFixedLayout = true;
    fixture.view.isFixedLayout = true;
    fixture.data.book!.format = 'PDF';
    const first = fixture.rangeAt(0, 'code');
    const last = fixture.rangeAt(1, 'end');
    await select({
      segments: [
        { index: 0, range: first, text: 'page one' },
        { index: 1, range: last, text: 'page two' },
      ],
    });
    copy();
    await waitFor(() => expect(writeTextToClipboard).toHaveBeenCalled());
    expect(copiedText()).toContain('文档页序号：1–2（非印刷页码）');
    expect(copiedText()).toContain('page one\npage two');
    expect(copiedText()).not.toContain('999');
  });

  test.each([
    'library',
    'file',
    'missing',
  ])('uses the %s metadata fallback without fabricating fields', async (fallback) => {
    fixture.data.bookDoc!.metadata.title = '';
    fixture.data.bookDoc!.metadata.author = '';
    fixture.data.book!.author = '';
    if (fallback !== 'library') fixture.data.book!.title = '';
    if (fallback === 'missing') fixture.data.file = null;
    await select({ popup: true, cfi: undefined, index: -1 });
    copy();
    await waitFor(() => expect(writeTextToClipboard).toHaveBeenCalled());
    if (fallback === 'library') expect(copiedText()).toContain('资料：《书库显示名》');
    if (fallback === 'file') expect(copiedText()).toContain('文档名（文件名）：source.epub');
    if (fallback === 'missing') expect(copiedText()).not.toMatch(/资料：|文档名/);
    expect(copiedText()).not.toMatch(/章节：|作者：|结构定位|返回原文：|undefined|null/);
  });

  test('honors the app link preference', async () => {
    h.viewSettings.noteExportConfig = { linkType: 'app' };
    await select();
    copy();
    await waitFor(() => expect(writeTextToClipboard).toHaveBeenCalled());
    expect(copiedText()).toContain('返回原文：readest://book/book/annotation/');
  });

  test('does not truncate a long selection or trim its indentation', async () => {
    const text = `  ${'长原文\n    code\n'.repeat(3000)}  `;
    await select({ text });
    copy();
    await waitFor(() => expect(writeTextToClipboard).toHaveBeenCalled());
    expect(copiedText()).toContain(`【所选原文开始】\n${text}\n【所选原文结束】`);
  });

  test('waits for the clipboard before reporting success or clearing selection', async () => {
    const pending = Promise.withResolvers<boolean>();
    vi.mocked(writeTextToClipboard).mockReturnValue(pending.promise);
    await select();
    copy();
    expect(hasToast('Explanation prompt copied')).toBe(false);
    expect(h.deselect).not.toHaveBeenCalled();
    expect(screen.getByTestId('selection-toolbar')).toBeTruthy();
    await act(async () => pending.resolve(true));
    expect(hasToast('Explanation prompt copied')).toBe(true);
    expect(screen.queryByTestId('selection-toolbar')).toBeNull();
  });

  test.each([
    'false',
    'exception',
  ])('retains the selection and allows retry on clipboard %s', async (failure) => {
    if (failure === 'false') vi.mocked(writeTextToClipboard).mockResolvedValueOnce(false);
    else vi.mocked(writeTextToClipboard).mockRejectedValueOnce(new Error('denied'));
    await select();
    copy();
    await waitFor(() =>
      expect(hasToast('Could not copy explanation prompt. Please try again.')).toBe(true),
    );
    expect(hasToast('Explanation prompt copied')).toBe(false);
    expect(h.deselect).not.toHaveBeenCalled();
    copy();
    await waitFor(() => expect(hasToast('Explanation prompt copied')).toBe(true));
  });

  test('retains the selection when the native clipboard fails even if the WebView reports success', async () => {
    const actual = await vi.importActual<typeof import('@/utils/clipboard')>('@/utils/clipboard');
    vi.mocked(writeTextToClipboard).mockImplementation(actual.writeTextToClipboard);
    vi.stubEnv('NEXT_PUBLIC_APP_PLATFORM', 'tauri');
    h.nativeClipboardWrite.mockRejectedValueOnce(new Error('Clipboard is held by another party'));
    h.nativeClipboardWrite.mockResolvedValue(undefined);
    const webWrite = vi.fn().mockResolvedValue(undefined);
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: webWrite },
    });
    try {
      await select();
      copy();
      await waitFor(() =>
        expect(hasToast('Could not copy explanation prompt. Please try again.')).toBe(true),
      );
      expect(hasToast('Explanation prompt copied')).toBe(false);
      expect(h.deselect).not.toHaveBeenCalled();
      expect(screen.getByTestId('selection-toolbar')).toBeTruthy();
      expect(h.updateBooknotes).not.toHaveBeenCalled();
      expect(webWrite).not.toHaveBeenCalled();
      copy();
      await waitFor(() => expect(hasToast('Explanation prompt copied')).toBe(true));
      expect(h.nativeClipboardWrite).toHaveBeenLastCalledWith(copiedText());
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'clipboard', descriptor);
      else Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  test.each([
    true,
    false,
  ])('does not clear a newer selection when an older copy completes (%s)', async (success) => {
    const pending = Promise.withResolvers<boolean>();
    vi.mocked(writeTextToClipboard).mockReturnValueOnce(pending.promise);
    await select({ text: 'old text' });
    copy();
    await select({ text: 'new text', range: fixture.rangeAt(1, 'end'), index: 1 });
    await act(async () => pending.resolve(success));
    expect(copiedText()).toContain('old text');
    expect(copiedText()).not.toContain('new text');
    expect(h.deselect).not.toHaveBeenCalled();
    expect(screen.getByTestId('selection-toolbar')).toBeTruthy();
  });

  test('does not copy whitespace or claim success for an empty selection', async () => {
    await select({ text: ' \n\t ' });
    const button = screen.queryByRole('button', { name: 'Copy Explanation Prompt' });
    if (button) fireEvent.click(button);
    expect(writeTextToClipboard).not.toHaveBeenCalled();
    expect(hasToast('Explanation prompt copied')).toBe(false);
  });
});
