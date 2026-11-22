import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  canTriggerSingleKeyShortcut,
  createGChordTracker,
  G_CHORD_TIMEOUT_MS,
  getSingleKeyShortcutsEnabled,
  hasShortcutModifiers,
  isEditableTarget,
  isModalTargetOrOpen,
  setSingleKeyShortcutsEnabled,
  SINGLE_KEY_SHORTCUTS_CHANGE_EVENT,
  type DocumentLike,
  type ShortcutKeyEvent,
} from './keyboard-shortcuts';

function createKeyEvent(
  key: string,
  overrides: Omit<Partial<ShortcutKeyEvent>, 'preventDefault'> = {},
) {
  const preventDefault = vi.fn(() => {
    event.defaultPrevented = true;
  });
  const event = {
    key,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    isComposing: false,
    repeat: false,
    defaultPrevented: false,
    target: { tagName: 'DIV' } as unknown,
    ...overrides,
    preventDefault,
  };
  return event;
}

describe('keyboard-shortcuts utilities', () => {
  let storageMap: Map<string, string>;
  let dispatchEventMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    storageMap = new Map<string, string>();
    dispatchEventMock = vi.fn();

    vi.stubGlobal('localStorage', {
      getItem: vi.fn((key: string) => storageMap.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        storageMap.set(key, value);
      }),
    });
    vi.stubGlobal('window', {
      dispatchEvent: dispatchEventMock,
    });
    vi.stubGlobal('document', {
      activeElement: { tagName: 'BODY' },
      querySelector: vi.fn(() => null),
    });

    setSingleKeyShortcutsEnabled(true);
    dispatchEventMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('single-key opt-out state', () => {
    it('defaults to enabled, persists opt-out in localStorage, and dispatches change events', () => {
      expect(getSingleKeyShortcutsEnabled()).toBe(true);

      setSingleKeyShortcutsEnabled(false);
      expect(getSingleKeyShortcutsEnabled()).toBe(false);
      expect(dispatchEventMock).toHaveBeenCalledTimes(1);
      const dispatched = dispatchEventMock.mock.calls[0]?.[0] as CustomEvent;
      expect(dispatched.type).toBe(SINGLE_KEY_SHORTCUTS_CHANGE_EVENT);

      expect(canTriggerSingleKeyShortcut(createKeyEvent('j'))).toBe(false);

      setSingleKeyShortcutsEnabled(true);
      expect(getSingleKeyShortcutsEnabled()).toBe(true);
      expect(canTriggerSingleKeyShortcut(createKeyEvent('j'))).toBe(true);
    });

    it('falls back to in-memory session preference when localStorage throws', () => {
      vi.stubGlobal('localStorage', {
        getItem: () => {
          throw new Error('Storage blocked');
        },
        setItem: () => {
          throw new Error('Storage blocked');
        },
      });

      setSingleKeyShortcutsEnabled(false);
      expect(getSingleKeyShortcutsEnabled()).toBe(false);
      expect(canTriggerSingleKeyShortcut(createKeyEvent('?'))).toBe(false);

      setSingleKeyShortcutsEnabled(true);
      expect(getSingleKeyShortcutsEnabled()).toBe(true);
    });
  });

  describe('editable and modal target guards', () => {
    it('blocks input, textarea, select, contenteditable, and textbox roles', () => {
      expect(isEditableTarget({ tagName: 'INPUT' })).toBe(true);
      expect(isEditableTarget({ tagName: 'textarea' })).toBe(true);
      expect(isEditableTarget({ tagName: 'SELECT' })).toBe(true);
      expect(
        isEditableTarget({ tagName: 'DIV', isContentEditable: true }),
      ).toBe(true);
      expect(
        isEditableTarget({
          tagName: 'DIV',
          getAttribute: (attr: string) =>
            attr === 'contenteditable' ? '' : null,
        }),
      ).toBe(true);
      expect(
        isEditableTarget({
          tagName: 'DIV',
          getAttribute: (attr: string) => (attr === 'role' ? 'textbox' : null),
        }),
      ).toBe(true);
      expect(
        isEditableTarget({
          tagName: 'SPAN',
          closest: (selector: string) =>
            selector.includes('input') ? { tagName: 'INPUT' } : null,
        }),
      ).toBe(true);
      expect(isEditableTarget({ tagName: 'A' })).toBe(false);
    });

    it('blocks shortcuts when activeElement is editable even if event.target is body', () => {
      const doc: DocumentLike = {
        activeElement: { tagName: 'INPUT' },
        querySelector: () => null,
      };
      const event = createKeyEvent('/', { target: { tagName: 'BODY' } });
      expect(canTriggerSingleKeyShortcut(event, { doc })).toBe(false);
    });

    it('blocks shortcuts when a modal or open dialog holds focus or is open in the document', () => {
      const modalTarget = {
        tagName: 'BUTTON',
        closest: (selector: string) =>
          selector.includes('[aria-modal="true"]') ? { tagName: 'DIV' } : null,
      };
      expect(
        isModalTargetOrOpen(modalTarget, { querySelector: () => null }),
      ).toBe(true);

      const docWithOpenModal: DocumentLike = {
        activeElement: { tagName: 'BODY' },
        querySelector: (selector: string) =>
          selector.includes('dialog[open]') ? { tagName: 'DIALOG' } : null,
      };
      expect(
        canTriggerSingleKeyShortcut(createKeyEvent('u'), {
          doc: docWithOpenModal,
        }),
      ).toBe(false);
    });

    it('blocks shortcuts from or while an article action menu is open', () => {
      const menuButton = {
        tagName: 'BUTTON',
        closest: (selector: string) =>
          selector.includes('[data-reader-more]')
            ? { tagName: 'DETAILS' }
            : null,
      };
      expect(
        canTriggerSingleKeyShortcut(
          createKeyEvent('v', { target: menuButton }),
        ),
      ).toBe(false);

      const docWithOpenMenu: DocumentLike = {
        activeElement: { tagName: 'BODY' },
        querySelector: (selector: string) =>
          selector.includes('[data-article-overflow][open]')
            ? { tagName: 'DETAILS', open: true }
            : null,
      };
      expect(
        canTriggerSingleKeyShortcut(createKeyEvent('x'), {
          doc: docWithOpenMenu,
        }),
      ).toBe(false);
    });
  });

  describe('modifier, repeat, and defaultPrevented guards', () => {
    it('rejects ctrl, alt, meta, and IME composition while allowing shift for shifted symbols', () => {
      expect(hasShortcutModifiers(createKeyEvent('r', { ctrlKey: true }))).toBe(
        true,
      );
      expect(hasShortcutModifiers(createKeyEvent('r', { metaKey: true }))).toBe(
        true,
      );
      expect(hasShortcutModifiers(createKeyEvent('r', { altKey: true }))).toBe(
        true,
      );
      expect(
        hasShortcutModifiers(createKeyEvent('r', { isComposing: true })),
      ).toBe(true);

      expect(
        canTriggerSingleKeyShortcut(createKeyEvent('R', { shiftKey: true })),
      ).toBe(true);
      expect(
        canTriggerSingleKeyShortcut(createKeyEvent('?', { shiftKey: true })),
      ).toBe(true);
      expect(
        canTriggerSingleKeyShortcut(createKeyEvent('+', { shiftKey: true })),
      ).toBe(true);
    });

    it('blocks repeated or defaultPrevented events unless allowRepeat is enabled', () => {
      expect(
        canTriggerSingleKeyShortcut(createKeyEvent('v', { repeat: true })),
      ).toBe(false);
      expect(
        canTriggerSingleKeyShortcut(createKeyEvent('j', { repeat: true }), {
          allowRepeat: true,
        }),
      ).toBe(true);
      expect(
        canTriggerSingleKeyShortcut(
          createKeyEvent('s', { defaultPrevented: true }),
        ),
      ).toBe(false);
    });
  });

  describe('g chord tracker', () => {
    const routes = {
      a: '/',
      u: '/inbox',
      b: '/saved',
      d: '/digest',
      f: '/feeds',
      s: '/settings',
    };

    it('matches valid g chords within 1000ms and calls preventDefault on completion', () => {
      const tracker = createGChordTracker(routes);

      const first = createKeyEvent('g');
      expect(tracker.handleKeydown(first)).toBeNull();
      expect(first.preventDefault).not.toHaveBeenCalled();
      expect(tracker.isPending()).toBe(true);

      vi.advanceTimersByTime(G_CHORD_TIMEOUT_MS - 1);
      const second = createKeyEvent('s');
      expect(tracker.handleKeydown(second)).toBe('/settings');
      expect(second.preventDefault).toHaveBeenCalledOnce();
      expect(second.defaultPrevented).toBe(true);
      expect(tracker.isPending()).toBe(false);
    });

    it('expires pending g chords after 1000ms without preventing downstream single-key handlers', () => {
      const tracker = createGChordTracker(routes);

      tracker.handleKeydown(createKeyEvent('g'));
      expect(tracker.isPending()).toBe(true);

      vi.advanceTimersByTime(G_CHORD_TIMEOUT_MS);
      expect(tracker.isPending()).toBe(false);

      const lateSave = createKeyEvent('s');
      expect(tracker.handleKeydown(lateSave)).toBeNull();
      expect(lateSave.preventDefault).not.toHaveBeenCalled();
    });

    it('resets on unmatched keys, shifted G, opt-out disablement, or editable targets', () => {
      const tracker = createGChordTracker(routes);

      // Uppercase G does not start a chord
      tracker.handleKeydown(createKeyEvent('G', { shiftKey: true }));
      expect(tracker.isPending()).toBe(false);

      // Unmatched follow-up key resets without calling preventDefault
      tracker.handleKeydown(createKeyEvent('g'));
      const unmatched = createKeyEvent('z');
      expect(tracker.handleKeydown(unmatched)).toBeNull();
      expect(unmatched.preventDefault).not.toHaveBeenCalled();
      expect(tracker.isPending()).toBe(false);

      // Opt-out blocks starting and completing chords
      tracker.handleKeydown(createKeyEvent('g'));
      setSingleKeyShortcutsEnabled(false);
      const blockedByPref = createKeyEvent('u');
      expect(tracker.handleKeydown(blockedByPref)).toBeNull();
      expect(blockedByPref.preventDefault).not.toHaveBeenCalled();
      expect(tracker.isPending()).toBe(false);

      // Editable target blocks chord start and completion
      setSingleKeyShortcutsEnabled(true);
      expect(
        tracker.handleKeydown(
          createKeyEvent('g', { target: { tagName: 'INPUT' } }),
        ),
      ).toBeNull();
      expect(tracker.isPending()).toBe(false);
    });
  });
});
