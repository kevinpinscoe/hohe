// HOHE theme boot (POE-76). Loaded as a classic, blocking script in <head>, before the
// stylesheet, so the saved theme is on <html> before the first paint and the page never
// flashes the wrong theme. It is a separate file, not an inline script, because the server's
// Content-Security-Policy is script-src 'self'.
//
// Keep THEME_KEY, the values and the colours in step with src/theme.ts (theme.test.ts checks).
(function () {
  var THEME_KEY = 'hohe.theme';
  var COLOR = { light: '#1f3a4d', dark: '#14191d' };
  var pref = 'system';
  try {
    var v = localStorage.getItem(THEME_KEY);
    if (v === 'light' || v === 'dark') pref = v;
  } catch (e) {
    /* storage disabled: follow the system */
  }
  var osDark = false;
  try {
    osDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch (e) {
    /* no matchMedia: light */
  }
  var theme = pref === 'system' ? (osDark ? 'dark' : 'light') : pref;
  var root = document.documentElement;
  root.setAttribute('data-theme', theme);
  root.setAttribute('data-theme-pref', pref);
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', COLOR[theme]);
})();
