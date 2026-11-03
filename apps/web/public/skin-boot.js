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
  const root = document.documentElement;
  root.setAttribute('data-skin', skin);

  // The Dark Reader extension repaints every colour, which hides the skins and the glass
  // (ADR-114). Where it is at work, the app's own dark skin takes over, unless the person chose a
  // skin here, and the extension is told to leave the page alone. Mirrored in src/skins/skins.ts.
  const repainted = () =>
    root.hasAttribute('data-darkreader-mode') ||
    root.hasAttribute('data-darkreader-scheme') ||
    document.querySelector('meta[name="darkreader"], style.darkreader') !== null;
  const standDown = () => {
    if (!skins.includes(appearance)) {
      root.setAttribute('data-dark-extension', 'true');
      root.setAttribute('data-skin', 'dark');
    }
    const lock = document.createElement('meta');
    lock.setAttribute('name', 'darkreader-lock');
    document.head.append(lock);
  };
  if (repainted()) {
    standDown();
  } else if (typeof MutationObserver === 'function') {
    // It can start after this script; it does so within the first moments or not at all.
    const watch = new MutationObserver(() => {
      if (!repainted()) return;
      watch.disconnect();
      standDown();
    });
    watch.observe(root, { attributes: true, childList: true, subtree: true });
    window.setTimeout(() => watch.disconnect(), 5000);
  }
})();
