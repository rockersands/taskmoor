/**
 * For the user's review only: a switch between the two strengths of glass. Remove this file, its
 * call in main.tsx, `.glass-level-preview` in surfaces.css and the `deep` tokens once the choice
 * is made. Off unless the address asks for it with ?glass=clear or ?glass=deep; the choice then
 * stays in this browser.
 */
const KEY = 'taskmoor.glassLevel';

function stored(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function startGlassLevelPreview() {
  const asked = new URLSearchParams(window.location.search).get('glass');
  const level = asked === 'clear' || asked === 'deep' ? asked : stored();
  if (level !== 'clear' && level !== 'deep') return;
  const root = document.documentElement;
  const apply = (next: string) => {
    if (next === 'deep') root.dataset.glassLevel = 'deep';
    else delete root.dataset.glassLevel;
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      // Not kept in this browser; the address still works.
    }
    for (const button of bar.querySelectorAll('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.level === next));
    }
  };
  const bar = document.createElement('div');
  bar.className = 'glass-level-preview';
  const label = document.createElement('span');
  label.textContent = 'Glass';
  bar.append(label);
  for (const [id, name] of [
    ['clear', 'Clear'],
    ['deep', 'Deep'],
  ] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.level = id;
    button.textContent = name;
    button.addEventListener('click', () => apply(id));
    bar.append(button);
  }
  document.body.append(bar);
  apply(level);
}
