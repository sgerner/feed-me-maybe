import { browser } from '$app/environment';

class ThemeStore {
  current = $state(
    browser ? (localStorage.getItem('theme') || 'cerberus') : 'cerberus'
  );

  set(newTheme: string) {
    this.current = newTheme;
    if (browser) {
      localStorage.setItem('theme', newTheme);
      document.documentElement.setAttribute('data-theme', newTheme);
    }
  }
}

export const themeStore = new ThemeStore();
