import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkCatalogueStyle,
  checkWebStrings,
  findCatalogueStyle,
  findHardCodedStrings,
  styleProblems,
  webComponents,
} from './i18n-check';

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

describe('the English catalogue’s house style (TR-34)', () => {
  it('[NFR-006] finds straight apostrophes and American spellings, line by line', () => {
    const source = `export const messagesEn = {
      'a': "This track's board",
      'b': 'This track’s board',
      'c': 'Customize',
      'd':
        'Your organization’s domains, colored',
      'e': "{key}'s workflow",
      'f': 'Bring work in from a Jira Data Center backup; resize it to any size',
      'g': 'Colour, organisation, customise, minimise, summarise',
    } as const;`;
    expect(findCatalogueStyle(source, 'messages.en.ts').map((f) => [f.line, f.text])).toEqual([
      [2, "'a': a straight apostrophe (')"],
      [4, "'c': the American spelling 'Customize'"],
      [6, "'d': the American spelling 'organization', the American spelling 'colored'"],
      [7, "'e': a straight apostrophe (')"],
    ]);
  });

  it('[NFR-006] reads placeholders and other products’ names as not ours to spell', () => {
    expect(styleProblems("{name}'s")).toEqual(["a straight apostrophe (')"]);
    expect(styleProblems('{color} at the Jira Data Center')).toEqual([]);
    expect(styleProblems('Center the text')).toEqual(["the American spelling 'Center'"]);
  });

  it('[NFR-006] the English catalogue uses curly apostrophes and British spellings throughout', () => {
    expect(checkCatalogueStyle(ROOT)).toEqual([]);
  });
});
