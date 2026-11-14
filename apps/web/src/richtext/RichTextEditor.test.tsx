import { fromAdfJson, type PmJson } from '@taskmoor/richtext';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import type { MentionPerson } from './mentions';
import {
  linkTarget,
  RichTextEditor,
  type RichTextEditorProps,
  toolsThatFit,
} from './RichTextEditor';

const PEOPLE: MentionPerson[] = [
  { id: 7, name: 'Kalo Smith', canView: true },
  { id: 9, name: 'Mi Rivera', canView: false },
];

function renderEditor(props: Partial<RichTextEditorProps> = {}, locale: Locale = 'en') {
  const changes: (PmJson | null)[] = [];
  const view = render(
    <I18nProvider locale={locale}>
      <p id="label">Description</p>
      <RichTextEditor labelledBy="label" onChange={(doc) => changes.push(doc)} {...props} />
    </I18nProvider>,
  );
  const textbox = screen.getByRole('textbox', locale === 'en' ? { name: 'Description' } : {});
  return { ...view, textbox, changes };
}

const doc = (...content: PmJson[]): PmJson => ({ type: 'doc', content });
const p = (text: string): PmJson => ({ type: 'paragraph', content: [{ type: 'text', text }] });

function paste(target: HTMLElement, text: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
    clipboardData: { getData: (type: string) => string; types: string[] };
  };
  event.clipboardData = {
    getData: (type: string) => (type === 'text/plain' ? text : ''),
    types: ['text/plain'],
  };
  fireEvent(target, event);
}

describe('the rich text editor (M1-017)', () => {
  it('[NTF-006] [NFR-005] keeps the toolbar to one row on a phone, the rest behind More tools (PL-42)', async () => {
    setViewportWidth(375);
    const user = userEvent.setup();
    renderEditor({ initial: doc(p('Hello')) });
    const toolbar = screen.getByRole('toolbar', { name: 'Formatting' });
    const names = () =>
      within(toolbar)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label'));
    expect(names()).toEqual([
      'Bold',
      'Italic',
      'Strikethrough',
      'Code',
      'Link',
      'Heading 2',
      'More tools',
    ]);
    const more = within(toolbar).getByRole('button', { name: 'More tools' });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    await user.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(names()).toContain('Undo');
    expect(names().at(-1)).toBe('More tools');
    // Still one tab stop, and the arrows reach More.
    expect(
      within(toolbar)
        .getAllByRole('button')
        .filter((b) => b.tabIndex === 0),
    ).toHaveLength(1);
  });

  it('[NTF-006] counts More when fitting the tools to a phone row, so More never wraps alone', () => {
    // A 274 px bar of 44 px tools 2 px apart holds six buttons: five tools and More.
    expect(toolsThatFit(274, 44, 2)).toBe(5);
    // Room for seven: six tools and More.
    expect(toolsThatFit(330, 44, 2)).toBe(6);
    // A tablet's wider row: as many tools as fit, then More.
    expect(toolsThatFit(700, 44, 2)).toBe(14);
    // Very narrow: one tool and More, never none.
    expect(toolsThatFit(60, 44, 2)).toBe(1);
    // Not laid out (no measurement): the six first tools.
    expect(toolsThatFit(0, 0, 0)).toBe(6);
  });

  it('[NTF-006] is a named multi-line text box with a formatting toolbar of one tab stop', async () => {
    const user = userEvent.setup();
    const { textbox } = renderEditor({ initial: doc(p('Hello')) });
    expect(textbox).toHaveAttribute('aria-multiline', 'true');
    expect(textbox).toHaveAccessibleDescription(/Markdown shortcuts work/);
    const toolbar = screen.getByRole('toolbar', { name: 'Formatting' });
    const buttons = within(toolbar).getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Bold',
      'Italic',
      'Strikethrough',
      'Code',
      'Link',
      'Heading 2',
      'Heading 3',
      'Bulleted list',
      'Numbered list',
      'Checklist',
      'Quote',
      'Code block',
      'Divider',
      'Table',
      'Undo',
      'Redo',
    ]);
    expect(buttons.filter((b) => b.tabIndex === 0)).toHaveLength(1);
    // Keyboard only: arrows walk the toolbar, Enter applies.
    (buttons[0] as HTMLElement).focus();
    await user.keyboard('{ArrowRight}');
    expect(buttons[1]).toHaveFocus();
    await user.keyboard('{End}');
    expect(buttons[buttons.length - 1]).toHaveFocus();
    await user.keyboard('{Home}');
    expect(buttons[0]).toHaveFocus();
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'false');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('[NTF-006] turns Markdown shortcuts into headings and checklists as you type', async () => {
    const user = userEvent.setup();
    const { textbox, changes } = renderEditor();
    await user.click(textbox);
    await user.keyboard('## Plan');
    expect(await screen.findByRole('heading', { level: 2, name: 'Plan' })).toBeInTheDocument();
    await user.keyboard('{Enter}[[] buy milk');
    expect(within(textbox).getByRole('checkbox')).not.toBeChecked();
    const last = changes.at(-1);
    // The editor keeps an empty paragraph after a list, so there is always a line to type on.
    expect(last?.content?.map((n) => n.type).slice(0, 2)).toEqual(['heading', 'taskList']);
  });

  it('[NTF-006] turns pasted Markdown, a table say, into rich text', async () => {
    const { textbox, changes } = renderEditor();
    act(() => textbox.focus());
    act(() => paste(textbox, '| Browser | Result |\n| - | - |\n| Safari | fails |\n'));
    expect(await within(textbox).findByRole('table')).toBeInTheDocument();
    expect(within(textbox).getByRole('columnheader', { name: 'Browser' })).toBeInTheDocument();
    expect(within(textbox).getByRole('cell', { name: 'fails' })).toBeInTheDocument();
    expect(JSON.stringify(changes.at(-1))).toContain('tableHeader');
    // Table tools appear while the caret is in it.
    expect(screen.getByRole('button', { name: 'Add a row below' })).toBeInTheDocument();
  });

  it('[NTF-005] offers people after "@", walks them with the arrow keys and warns about those who cannot see the ticket', async () => {
    const user = userEvent.setup();
    const mentions = vi.fn(async (query: string) =>
      PEOPLE.filter((person) => person.name.toLowerCase().includes(query.toLowerCase())),
    );
    const { textbox, changes } = renderEditor({ mentions });
    await user.click(textbox);
    await user.keyboard('Ping @');
    const list = await screen.findByRole('listbox', { name: 'People to mention' });
    const options = within(list).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual([
      'Kalo Smith',
      'Mi RiveraCannot see this ticket',
    ]);
    expect(textbox).toHaveAttribute('aria-activedescendant', options[0]?.id);
    await user.keyboard('{ArrowDown}');
    expect(textbox).toHaveAttribute('aria-activedescendant', options[1]?.id);
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(textbox).not.toHaveAttribute('aria-activedescendant');
    expect(screen.getByRole('status')).toHaveTextContent(
      'Mi Rivera cannot see this ticket and will not be notified.',
    );
    const paragraph = changes.at(-1)?.content?.[0];
    expect(paragraph?.content?.find((n) => n.type === 'mention')?.attrs).toMatchObject({
      id: '9',
      label: 'Mi Rivera',
    });
    expect(mentions).toHaveBeenCalledWith('');
  });

  it('[NTF-006] adds a link from the keyboard, refusing unsafe addresses', async () => {
    const user = userEvent.setup();
    const { textbox, changes } = renderEditor({ initial: doc(p('docs')) });
    await user.click(textbox);
    await user.keyboard('{Control>}a{/Control}{Control>}k{/Control}');
    const address = await screen.findByLabelText('Link address');
    expect(address).toHaveFocus();
    await user.type(address, 'javascript:alert(1){Enter}');
    expect(screen.getByText('Enter a web, email or phone address.')).toBeVisible();
    await user.clear(address);
    await user.type(address, 'example.test/docs{Enter}');
    expect(screen.queryByLabelText('Link address')).toBeNull();
    expect(within(textbox).getByRole('link', { name: 'docs' })).toHaveAttribute(
      'href',
      'https://example.test/docs',
    );
    expect(JSON.stringify(changes.at(-1))).toContain('https://example.test/docs');
    expect(linkTarget('mailto:a@example.test')).toBe('mailto:a@example.test');
    expect(linkTarget('  ')).toBeNull();
  });

  it('[NTF-006] lets Escape leave the text, so Tab moves on', async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en">
        <p id="label">Description</p>
        <RichTextEditor labelledBy="label" />
        <button type="button">After</button>
      </I18nProvider>,
    );
    const textbox = screen.getByRole('textbox', { name: 'Description' });
    await user.click(textbox);
    await user.keyboard('{Escape}');
    expect(textbox).not.toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
  });

  it('[NTF-007] shows content kept from the other format as a placeholder, read-only when asked', () => {
    const imported = fromAdfJson({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Before' }] },
        { type: 'extension', attrs: { extensionKey: 'chart' } },
      ],
    });
    const { textbox } = renderEditor({ initial: imported, editable: false });
    expect(textbox).toHaveAttribute('aria-readonly', 'true');
    expect(screen.queryByRole('toolbar')).toBeNull();
    expect(
      within(textbox).getByText('Content this editor cannot show yet. It is kept as it is.'),
    ).toBeVisible();
  });

  it('[NTF-006] fits a small phone and reads every string from the catalogue', () => {
    setViewportWidth(360);
    const { container } = renderEditor({ initial: doc(p('Ünïcödé')) }, 'en-XA');
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(360);
    const texts = visibleTexts(container).filter(
      (text) => text !== 'Ünïcödé' && text !== 'Description',
    );
    expect(texts.length).toBeGreaterThan(10);
    expect(untranslated(texts)).toEqual([]);
  });
});
