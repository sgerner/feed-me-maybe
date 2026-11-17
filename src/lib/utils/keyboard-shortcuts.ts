const SINGLE_KEY_SHORTCUTS_KEY = 'feed-me-maybe:single-key-shortcuts';
let sessionPreference: boolean | undefined;

export const SINGLE_KEY_SHORTCUTS_CHANGE_EVENT =
  'feed-me-maybe:single-key-shortcuts-change';

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
