// Paints the person's skin before the app loads (M1-122, ADR-036), so a dark-skin person never
// sees a light flash. A file, not inline code, so a strict Content-Security-Policy can stay on.
// Mirrors resolveSkin in src/skins/skins.ts; a test keeps the skin lists equal.
(() => {
  const skins = ['light', 'dark'];
  let appearance = 'system';
  try {
    appearance = window.localStorage.getItem('taskmoor.appearance') || 'system';
  } catch {
    appearance = 'system';
  }
  const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
  const skin = skins.includes(appearance) ? appearance : dark ? 'dark' : 'light';
  document.documentElement.setAttribute('data-skin', skin);
})();
