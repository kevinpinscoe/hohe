// Theme: System (follow the OS), Light or Dark, chosen per device (POE-76).
//
// The choice lives in localStorage under THEME_KEY. public/theme-boot.js applies it before the
// first paint, so the page never flashes the wrong theme; this module keeps it applied while the
// app runs: when the setting changes, when the OS theme changes under "System", and when another
// tab changes the setting. Keep the key, the values and THEME_COLOR in step with theme-boot.js
// (theme.test.ts checks this).
//
// "System" cannot see dark mode in LibreWolf with privacy.resistFingerprinting, which always
// reports prefers-color-scheme: light. The explicit "Dark" setting exists for that case.

export type ThemePref = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

export const THEME_KEY = 'hohe.theme';
export const THEME_PREFS: readonly ThemePref[] = ['system', 'light', 'dark'];

/** The browser chrome colour (theme-color) for each theme: the app's top colour in each. */
export const THEME_COLOR: Record<Theme, string> = { light: '#1f3a4d', dark: '#14191d' };

type Reader = Pick<Storage, 'getItem'>;
type Writer = Pick<Storage, 'setItem'>;

/** Any stored value that is not a known choice (missing, garbage) means "system". */
export function parsePref(v: unknown): ThemePref {
  return v === 'light' || v === 'dark' ? v : 'system';
}

export function resolveTheme(pref: ThemePref, osDark: boolean): Theme {
  if (pref === 'system') return osDark ? 'dark' : 'light';
  return pref;
}

function localStore(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // storage disabled: the getter itself can throw
  }
}

export function readPref(storage: Reader | null = localStore()): ThemePref {
  try {
    return parsePref(storage?.getItem(THEME_KEY));
  } catch {
    return 'system';
  }
}

/** Saves the choice; false when this browser refuses storage (the choice then lasts this page only). */
export function writePref(pref: ThemePref, storage: Writer | null = localStore()): boolean {
  try {
    if (!storage) return false;
    storage.setItem(THEME_KEY, pref);
    return true;
  } catch {
    return false;
  }
}

const darkQuery = () => (typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null);

export function osPrefersDark(): boolean {
  return darkQuery()?.matches ?? false;
}

/** Applies a choice to the document: data-theme for the CSS, plus the theme-color meta. */
export function applyTheme(pref: ThemePref, osDark: boolean = osPrefersDark(), doc: Document = document): Theme {
  const theme = resolveTheme(pref, osDark);
  const root = doc.documentElement;
  root.dataset.theme = theme;
  root.dataset.themePref = pref;
  doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
  return theme;
}

/**
 * Keeps the theme applied while the app runs. Re-applies when the OS theme changes (it matters
 * only under "System") and when another tab saves a different choice. Returns a stop function.
 */
export function watchTheme(): () => void {
  const reapply = () => applyTheme(readPref());
  const mq = darkQuery();
  mq?.addEventListener?.('change', reapply);
  const onStorage = (e: StorageEvent) => {
    if (e.key === THEME_KEY || e.key === null) reapply();
  };
  addEventListener('storage', onStorage);
  reapply();
  return () => {
    mq?.removeEventListener?.('change', reapply);
    removeEventListener('storage', onStorage);
  };
}
