// Theme setting (POE-76): storage, resolution, the pre-paint boot script, and WCAG AA contrast
// of both palettes, measured from styles.css itself.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { render } from 'preact-render-to-string';
import { h } from 'preact';
import { parsePref, readPref, resolveTheme, THEME_COLOR, THEME_KEY, THEME_PREFS, writePref, type ThemePref } from './theme';
import { AppearanceSetting } from './settings';

const BOOT = readFileSync(new URL('../public/theme-boot.js', import.meta.url), 'utf8');
const CSS = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

function memoryStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
}
const broken = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

describe('theme resolution', () => {
  const cases: [ThemePref, boolean, string][] = [
    ['system', false, 'light'],
    ['system', true, 'dark'],
    ['light', false, 'light'],
    ['light', true, 'light'],
    ['dark', false, 'dark'],
    ['dark', true, 'dark'],
  ];
  it.each(cases)('%s with the OS reporting dark=%s resolves to %s', (pref, osDark, want) => {
    expect(resolveTheme(pref, osDark)).toBe(want);
  });

  it('treats a missing or unknown stored value as system', () => {
    for (const v of [null, undefined, '', 'Dark', 'auto', 1]) expect(parsePref(v)).toBe('system');
    expect(parsePref('light')).toBe('light');
    expect(parsePref('dark')).toBe('dark');
  });
});

describe('theme storage', () => {
  it('round-trips each choice under the shared key', () => {
    for (const p of THEME_PREFS) {
      const s = memoryStorage();
      expect(writePref(p, s)).toBe(true);
      expect(s.m.get(THEME_KEY)).toBe(p);
      expect(readPref(s)).toBe(p);
    }
  });

  it('falls back to system, and reports the save as failed, when storage throws or is absent', () => {
    expect(readPref(broken)).toBe('system');
    expect(writePref('dark', broken)).toBe(false);
    expect(readPref(null)).toBe('system');
    expect(writePref('dark', null)).toBe(false);
  });
});

/** Runs public/theme-boot.js against stubbed browser globals; returns what it set. */
function boot(stored: string | null, osDark: boolean, opts: { storageThrows?: boolean } = {}) {
  const attrs: Record<string, string> = {};
  let color = '#000000';
  const meta = { setAttribute: (_: string, v: string) => (color = v) };
  const document = {
    documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) },
    querySelector: (sel: string) => (sel === 'meta[name="theme-color"]' ? meta : null),
  };
  const localStorage = opts.storageThrows ? broken : memoryStorage(stored === null ? {} : { [THEME_KEY]: stored });
  const window = { matchMedia: (q: string) => ({ matches: q === '(prefers-color-scheme: dark)' && osDark }) };
  new Function('document', 'localStorage', 'window', BOOT)(document, localStorage, window);
  return { theme: attrs['data-theme'], pref: attrs['data-theme-pref'], color };
}

describe('theme-boot.js (before first paint)', () => {
  it('uses the same key and colours as theme.ts', () => {
    expect(BOOT).toContain(`'${THEME_KEY}'`);
    expect(BOOT).toContain(`light: '${THEME_COLOR.light}'`);
    expect(BOOT).toContain(`dark: '${THEME_COLOR.dark}'`);
  });

  it('agrees with resolveTheme for every choice and OS theme', () => {
    for (const p of THEME_PREFS) {
      for (const osDark of [false, true]) {
        const got = boot(p, osDark);
        const want = resolveTheme(p, osDark);
        expect(got).toEqual({ theme: want, pref: p, color: THEME_COLOR[want] });
      }
    }
  });

  it('follows the system when nothing is saved, the value is unknown, or storage throws', () => {
    expect(boot(null, true).theme).toBe('dark');
    expect(boot('sepia', false).theme).toBe('light');
    expect(boot('dark', true, { storageThrows: true })).toMatchObject({ theme: 'dark', pref: 'system' });
  });
});

// ── contrast ──────────────────────────────────────────────────────────────────────────────

function tokens(selector: string): Record<string, string> {
  const start = CSS.indexOf(`${selector} {`);
  expect(start, `${selector} block in styles.css`).toBeGreaterThanOrEqual(0);
  const body = CSS.slice(start, CSS.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1], m[2]]));
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Every token used as text, on every surface it appears on, plus the inverted pairs (text on an
// accent or letter-coloured fill, and the toast's paper-on-ink).
const TEXT = ['ink', 'muted', 'accent', 'amber', 'a', 'b', 'c', 'none', 'done'];
const SURFACES = ['paper', 'page', 'warn-bg', 'sugg-bg'];
const INVERTED: [string, string][] = [
  ['accent-ink', 'accent'],
  ['accent-ink', 'done'],
  ['accent-ink', 'a'],
  ['accent-ink', 'b'],
  ['accent-ink', 'c'],
  ['paper', 'ink'],
];

describe.each([
  ['light', ':root'],
  ['dark', ":root[data-theme='dark']"],
])('%s theme contrast (WCAG 2.2 AA, 4.5:1)', (_name, selector) => {
  const light = tokens(':root');
  const t = { ...light, ...tokens(selector) };
  const pairs: [string, string][] = [...TEXT.flatMap((f) => SURFACES.map((s): [string, string] => [f, s])), ...INVERTED];

  it('defines every token it overrides', () => {
    for (const k of Object.keys(tokens(selector))) expect(light[k], k).toBeDefined();
  });

  it.each(pairs)('--%s on --%s', (fg, bg) => {
    expect(contrast(t[fg]!, t[bg]!)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('Appearance setting', () => {
  it('renders the three choices with the saved one checked', () => {
    const html = render(h(AppearanceSetting, { initial: 'dark' }));
    for (const label of ['System', 'Light', 'Dark']) expect(html).toContain(label);
    expect(html).toMatch(/value="dark"[^>]*checked/);
    expect(html).not.toMatch(/value="system"[^>]*checked/);
    expect(html).toContain('Always dark on this device');
  });

  it('explains the LibreWolf limit under System', () => {
    expect(render(h(AppearanceSetting, { initial: 'system' }))).toContain('LibreWolf');
  });
});
