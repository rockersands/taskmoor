// Canvas preview (ADR-114, for the user's review only; remove with glass-preview.css when the
// choice is made). Off unless the address asks for it: ?canvas=base|soft|vivid and ?art=on|off.
// The choice is kept in this browser, and a small switch appears at the bottom of the page.
(() => {
  const KEY = 'taskmoor.glassPreview';
  const root = document.documentElement;
  const read = () => {
    try {
      return JSON.parse(window.localStorage.getItem(KEY)) || null;
    } catch {
      return null;
    }
  };
  const params = new URLSearchParams(window.location.search);
  let state = read();
  if (params.has('canvas') || params.has('art')) {
    state = {
      canvas: params.get('canvas') || state?.canvas || 'base',
      art: (params.get('art') || (state?.art ? 'on' : 'off')) === 'on',
    };
  }
  if (!state) return;
  const apply = () => {
    if (state.canvas === 'base') root.removeAttribute('data-glass-canvas');
    else root.setAttribute('data-glass-canvas', state.canvas);
    if (state.art) root.setAttribute('data-glass-art', 'on');
    else root.removeAttribute('data-glass-art');
    try {
      window.localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // Not kept in this browser; the address still works.
    }
  };
  apply();
  const words = {
    title: 'Canvas',
    base: 'Base',
    soft: 'Soft',
    vivid: 'Vivid',
    art: 'Illustration',
  };
  const draw = () => {
    const bar = document.createElement('div');
    bar.className = 'glass-preview';
    const label = document.createElement('span');
    label.textContent = words.title;
    bar.append(label);
    const buttons = [];
    for (const id of ['base', 'soft', 'vivid']) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = words[id];
      b.addEventListener('click', () => {
        state.canvas = id;
        apply();
        sync();
      });
      buttons.push([b, () => state.canvas === id]);
      bar.append(b);
    }
    const art = document.createElement('button');
    art.type = 'button';
    art.textContent = words.art;
    art.addEventListener('click', () => {
      state.art = !state.art;
      apply();
      sync();
    });
    buttons.push([art, () => state.art]);
    bar.append(art);
    function sync() {
      for (const [b, on] of buttons) b.setAttribute('aria-pressed', String(on()));
    }
    sync();
    document.body.append(bar);
  };
  if (document.body) draw();
  else document.addEventListener('DOMContentLoaded', draw);
})();
