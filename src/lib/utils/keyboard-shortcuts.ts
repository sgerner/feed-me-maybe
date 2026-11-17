const SINGLE_KEY_SHORTCUTS_KEY = 'feed-me-maybe:single-key-shortcuts';

export const SINGLE_KEY_SHORTCUTS_CHANGE_EVENT =
  'feed-me-maybe:single-key-shortcuts-change';

export function getSingleKeyShortcutsEnabled(): boolean {
  try {
    return localStorage.getItem(SINGLE_KEY_SHORTCUTS_KEY) !== 'false';
  } catch {
    return true;
  }
}

export function setSingleKeyShortcutsEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(SINGLE_KEY_SHORTCUTS_KEY, String(enabled));
  } catch {
    // Keep the preference for this page session when storage is unavailable.
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SINGLE_KEY_SHORTCUTS_CHANGE_EVENT));
  }
}
