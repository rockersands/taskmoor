import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkWebStrings, findHardCodedStrings, webComponents } from './i18n-check';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

describe('hard-coded string check (M1-116)', () => {
  it('[NFR-006] finds text between tags and in attributes people read', () => {
    const source = `
      export function Page({ t }) {
        return (
          <section aria-label="Settings" title={'Open'} data-kind="plain">
            <h1>Welcome back</h1>
            <p>{t('page.note')}</p>
            <input placeholder={\`Type here\`} alt={label} />
            <span>{count} · 42 %</span>
          </section>
        );
      }`;
    expect(findHardCodedStrings(source, 'Page.tsx').map((f) => [f.line, f.text])).toEqual([
      [4, 'aria-label="Settings"'],
      [4, 'title="Open"'],
      [5, 'Welcome back'],
      [7, 'placeholder="Type here"'],
    ]);
  });

  it('[NFR-006] leaves technical text and marked lines alone', () => {
    const source = `
      export const Help = () => (
        <div>
          <kbd>Ctrl K</kbd>
          <code>track = PAY</code>
          <pre><span>stage != closed</span></pre>
          {/* i18n-ignore: a product name */}
          <span>Taskmoor</span>
          <input
            // i18n-ignore: an example in the query language
            placeholder="due < now()"
          />
        </div>
      );`;
    expect(findHardCodedStrings(source, 'Help.tsx')).toEqual([]);
  });

  it('[NFR-006] checks components only, not tests, stories or fixtures', () => {
    const files = webComponents(ROOT);
    expect(files).toContain('apps/web/src/App.tsx');
    expect(files.some((f) => /\.(test|stories)\.tsx$|fixtures|\/test\//.test(f))).toBe(false);
  });

  it('[NFR-006] (1) the web app has no hard-coded strings', () => {
    expect(checkWebStrings(ROOT)).toEqual([]);
  });
});
