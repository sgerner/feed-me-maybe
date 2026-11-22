const SINGLE_KEY_SHORTCUTS_KEY = 'feed-me-maybe:single-key-shortcuts';
let sessionPreference: boolean | undefined;

export const SINGLE_KEY_SHORTCUTS_CHANGE_EVENT =
  'feed-me-maybe:single-key-shortcuts-change';
export const G_CHORD_TIMEOUT_MS = 1000;

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable="true"], [contenteditable=""], [contenteditable="plaintext-only"], [role="textbox"]';
const MODAL_SELECTOR = 'dialog[open], [role="dialog"], [aria-modal="true"]';
const OPEN_MODAL_DOCUMENT_SELECTOR = 'dialog[open], [aria-modal="true"]';
const MENU_SELECTOR = '[data-article-overflow], [data-reader-more]';
const OPEN_MENU_DOCUMENT_SELECTOR =
  '[data-article-overflow][open], [data-reader-more][open]';
const MODIFIER_ONLY_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta']);

type ElementLike = {
  tagName?: unknown;
  open?: unknown;
  isContentEditable?: unknown;
  contentEditable?: unknown;
  getAttribute?: (name: string) => string | null;
  closest?: (selector: string) => unknown;
};

export type DocumentLike = {
  activeElement?: unknown;
  querySelector?: (selector: string) => unknown;
};

export type ShortcutKeyEvent = {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
  target?: EventTarget | null | unknown;
  preventDefault: () => void;
};

export function getSingleKeyShortcutsEnabled(): boolean {
  if (sessionPreference !== undefined) return sessionPreference;
  try {
    return localStorage.getItem(SINGLE_KEY_SHORTCUTS_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function setSingleKeyShortcutsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(SINGLE_KEY_SHORTCUTS_KEY, String(enabled));
    sessionPreference = undefined;
  } catch {
    sessionPreference = enabled;
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SINGLE_KEY_SHORTCUTS_CHANGE_EVENT));
  }
}

export function hasShortcutModifiers(
  event: Pick<
    ShortcutKeyEvent,
    'altKey' | 'ctrlKey' | 'metaKey' | 'isComposing'
  >,
): boolean {
  return Boolean(
    event.altKey || event.ctrlKey || event.metaKey || event.isComposing,
  );
}

function asElementLike(value: unknown): ElementLike | null {
  return value && typeof value === 'object' ? (value as ElementLike) : null;
}

function isContentEditableValue(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.toLowerCase();
  return (
    normalized === '' ||
    normalized === 'true' ||
    normalized === 'plaintext-only'
  );
}

export function isEditableTarget(target: unknown): boolean {
  const node = asElementLike(target);
  if (!node) return false;

  if (
    typeof node.tagName === 'string' &&
    EDITABLE_TAGS.has(node.tagName.toUpperCase())
  ) {
    return true;
  }

  if (node.isContentEditable === true) return true;
  if (isContentEditableValue(node.contentEditable)) return true;

  if (typeof node.getAttribute === 'function') {
    const contentEditableAttr = node.getAttribute('contenteditable');
    if (
      contentEditableAttr !== null &&
      isContentEditableValue(contentEditableAttr)
    ) {
      return true;
    }
    if (node.getAttribute('role') === 'textbox') {
      return true;
    }
  }

  if (
    typeof node.closest === 'function' &&
    Boolean(node.closest(EDITABLE_SELECTOR))
  ) {
    return true;
  }

  return false;
}

function isModalElement(target: unknown): boolean {
  const node = asElementLike(target);
  if (!node) return false;

  if (
    typeof node.tagName === 'string' &&
    node.tagName.toUpperCase() === 'DIALOG' &&
    (node.open === true ||
      (typeof node.getAttribute === 'function' &&
        node.getAttribute('open') !== null))
  ) {
    return true;
  }

  if (typeof node.getAttribute === 'function') {
    if (node.getAttribute('role') === 'dialog') return true;
    if (node.getAttribute('aria-modal') === 'true') return true;
  }

  if (
    typeof node.closest === 'function' &&
    Boolean(node.closest(MODAL_SELECTOR))
  ) {
    return true;
  }

  return false;
}

export function isModalTargetOrOpen(
  target: unknown,
  doc: DocumentLike | null | undefined = typeof document !== 'undefined'
    ? document
    : null,
): boolean {
  if (isModalElement(target)) return true;
  if (!doc) return false;
  if (isModalElement(doc.activeElement)) return true;
  if (
    typeof doc.querySelector === 'function' &&
    Boolean(doc.querySelector(OPEN_MODAL_DOCUMENT_SELECTOR))
  ) {
    return true;
  }
  return false;
}

function isMenuTargetOrOpen(
  target: unknown,
  doc: DocumentLike | null | undefined,
): boolean {
  const node = asElementLike(target);
  if (
    node &&
    typeof node.closest === 'function' &&
    node.closest(MENU_SELECTOR)
  ) {
    return true;
  }
  if (!doc) return false;

  const activeElement = asElementLike(doc.activeElement);
  if (
    activeElement &&
    typeof activeElement.closest === 'function' &&
    activeElement.closest(MENU_SELECTOR)
  ) {
    return true;
  }

  return Boolean(
    typeof doc.querySelector === 'function' &&
    doc.querySelector(OPEN_MENU_DOCUMENT_SELECTOR),
  );
}

export function canTriggerSingleKeyShortcut(
  event: Pick<
    ShortcutKeyEvent,
    | 'defaultPrevented'
    | 'repeat'
    | 'altKey'
    | 'ctrlKey'
    | 'metaKey'
    | 'isComposing'
    | 'target'
  >,
  options: {
    allowRepeat?: boolean;
    enabled?: boolean;
    doc?: DocumentLike | null;
  } = {},
): boolean {
  if (event.defaultPrevented) return false;
  if (!options.allowRepeat && event.repeat) return false;
  if (hasShortcutModifiers(event)) return false;

  const enabled = options.enabled ?? getSingleKeyShortcutsEnabled();
  if (!enabled) return false;

  const doc =
    options.doc !== undefined
      ? options.doc
      : typeof document !== 'undefined'
        ? document
        : null;

  if (isEditableTarget(event.target)) return false;
  if (doc?.activeElement && isEditableTarget(doc.activeElement)) return false;
  if (isModalTargetOrOpen(event.target, doc)) return false;
  if (isMenuTargetOrOpen(event.target, doc)) return false;

  return true;
}

export interface GChordTracker<T = string> {
  handleKeydown(event: ShortcutKeyEvent): T | null;
  reset(): void;
  isPending(): boolean;
}

export function createGChordTracker<T = string>(
  chords: Record<string, T>,
  options: {
    timeoutMs?: number;
    now?: () => number;
    doc?: DocumentLike | null;
  } = {},
): GChordTracker<T> {
  const timeoutMs = options.timeoutMs ?? G_CHORD_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  let pendingAt: number | null = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  function reset(): void {
    pendingAt = null;
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  }

  function isPending(): boolean {
    if (pendingAt === null) return false;
    if (now() - pendingAt >= timeoutMs) {
      reset();
      return false;
    }
    return true;
  }

  function handleKeydown(event: ShortcutKeyEvent): T | null {
    if (MODIFIER_ONLY_KEYS.has(event.key)) {
      return null;
    }

    if (!canTriggerSingleKeyShortcut(event, { doc: options.doc })) {
      reset();
      return null;
    }

    if (isPending()) {
      reset();
      if (!event.shiftKey && Object.hasOwn(chords, event.key)) {
        event.preventDefault();
        return chords[event.key];
      }
      return null;
    }

    if (event.key === 'g' && !event.shiftKey) {
      pendingAt = now();
      timeoutId = setTimeout(() => {
        pendingAt = null;
        timeoutId = null;
      }, timeoutMs);
    }

    return null;
  }

  return {
    handleKeydown,
    reset,
    isPending,
  };
}
