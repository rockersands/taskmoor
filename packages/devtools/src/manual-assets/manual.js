// The offline manual's only script, inlined into every page (pnpm run docs). It opens the
// navigation on small screens, focuses search on "/", and runs the search page from the index
// embedded in search.html. It makes no network requests; the page's CSP forbids them anyway.
(() => {
  const root = document.documentElement;
  root.classList.add('js');

  const toggle = document.querySelector('.menu-toggle');
  toggle?.addEventListener('click', () => {
    const open = root.dataset.nav !== 'open';
    root.dataset.nav = open ? 'open' : 'closed';
    toggle.setAttribute('aria-expanded', String(open));
  });

  const box = document.getElementById('q');
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    const typing =
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      (target instanceof HTMLElement && target.isContentEditable);
    if (event.key === '/' && !typing && box) {
      event.preventDefault();
      box.focus();
    }
  });

  const data = document.getElementById('search-index');
  const list = document.getElementById('results');
  const status = document.getElementById('search-status');
  if (!data || !list || !status || !(box instanceof HTMLInputElement)) return;

  const entries = JSON.parse(data.textContent || '[]').map((entry) => ({
    ...entry,
    lowTitle: entry.title.toLowerCase(),
    lowHeading: entry.heading.toLowerCase(),
    lowText: entry.text.toLowerCase(),
  }));

  const termsOf = (query) =>
    query
      .toLowerCase()
      .split(/[^\p{L}\p{N}_.:/-]+/u)
      .filter((term) => term.length > 0);

  const count = (text, term) => {
    let found = 0;
    for (let at = text.indexOf(term); at !== -1 && found < 10; at = text.indexOf(term, at + 1)) {
      found += 1;
    }
    return found;
  };

  /** Every term must appear; headings and titles weigh more than body text. */
  const search = (terms) => {
    const scored = [];
    for (const entry of entries) {
      let score = 0;
      let all = true;
      for (const term of terms) {
        const inHeading = entry.lowHeading.includes(term);
        const inTitle = entry.lowTitle.includes(term);
        const inText = count(entry.lowText, term);
        if (!inHeading && !inTitle && inText === 0) {
          all = false;
          break;
        }
        score += (inHeading ? 12 : 0) + (inTitle ? 6 : 0) + inText;
      }
      if (all) scored.push({ entry, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, 50);
  };

  /** A short excerpt around the first match, with every term marked. */
  const snippet = (entry, terms) => {
    const first = Math.min(
      ...terms.map((term) => entry.lowText.indexOf(term)).filter((at) => at !== -1),
    );
    const start = Number.isFinite(first) ? Math.max(0, first - 70) : 0;
    const text = entry.text.slice(start, start + 220);
    const low = text.toLowerCase();
    const p = document.createElement('p');
    if (start > 0) p.append('… ');
    let at = 0;
    while (at < text.length) {
      let next = -1;
      let length = 0;
      for (const term of terms) {
        const found = low.indexOf(term, at);
        if (found !== -1 && (next === -1 || found < next)) {
          next = found;
          length = term.length;
        }
      }
      if (next === -1) {
        p.append(text.slice(at));
        break;
      }
      p.append(text.slice(at, next));
      const mark = document.createElement('mark');
      mark.textContent = text.slice(next, next + length);
      p.append(mark);
      at = next + length;
    }
    if (start + 220 < entry.text.length) p.append(' …');
    return p;
  };

  const show = (query) => {
    const terms = termsOf(query);
    list.replaceChildren();
    if (terms.length === 0) {
      status.textContent = status.dataset.empty || '';
      return;
    }
    const hits = search(terms);
    const template =
      hits.length === 0
        ? status.dataset.none
        : hits.length === 1
          ? status.dataset.one
          : status.dataset.some;
    status.textContent = (template || '')
      .replace('{count}', String(hits.length))
      .replace('{query}', query.trim());
    for (const { entry } of hits) {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = entry.anchor ? `${entry.page}#${entry.anchor}` : entry.page;
      link.textContent = entry.heading ? `${entry.title} › ${entry.heading}` : entry.title;
      item.append(link, snippet(entry, terms));
      list.append(item);
    }
  };

  const initial = new URLSearchParams(window.location.search).get('q') || '';
  box.value = initial;
  show(initial);
  box.addEventListener('input', () => {
    show(box.value);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('q', box.value);
      window.history.replaceState(null, '', url);
    } catch {
      // Browsers refuse history changes on some file:// pages; the results still update.
    }
  });
  box.closest('form')?.addEventListener('submit', (event) => event.preventDefault());
  box.focus();
})();
