import type { PmJson } from '@taskmoor/richtext';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Editor } from '@tiptap/core';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { messagesEn } from '../i18n/messages.en';
import { messagesEs } from '../i18n/messages.es';
import { setAccountTimeZone } from '../i18n/zone';
import { type EditorTools, EditorToolsProvider } from './EditorTools';
import { RichTextEditor, type RichTextEditorProps } from './RichTextEditor';
import { RichTextView } from './RichTextView';
import { matchingTools, SLASH_TOOLS } from './slashTools';

const TOOLS: EditorTools = {
  attachments: async () => [
    {
      name: 'screen.png',
      image: true,
      href: 'https://files.example.test/1',
      thumbnail: 'https://files.example.test/1/t',
    },
    { name: 'notes.pdf', image: false, href: 'https://files.example.test/2', thumbnail: null },
  ],
  tickets: async (typed) =>
    typed.includes('retry')
      ? [{ id: 40, key: 'SHOP-40', summary: 'Retry a failed payment', status: { name: 'New' } }]
      : [],
};

function renderEditor(
  props: Partial<RichTextEditorProps> = {},
  tools: EditorTools = TOOLS,
  locale: Locale = 'en',
) {
  const changes: (PmJson | null)[] = [];
  render(
    <I18nProvider locale={locale}>
      <EditorToolsProvider value={tools}>
        <p id="label">Description</p>
        <RichTextEditor
          labelledBy="label"
          onChange={(doc) => changes.push(doc)}
          mentions={async () => []}
          {...props}
        />
      </EditorToolsProvider>
    </I18nProvider>,
  );
  const textbox = screen.getByRole('textbox', locale === 'en' ? { name: 'Description' } : {});
  return { textbox, changes };
}

const menu = () => screen.findByRole('listbox', { name: 'Blocks to add' });
const blockTypes = (doc: PmJson | null | undefined) => doc?.content?.map((n) => n.type);

/** Opens the menu, narrows it, and takes the first entry. */
async function choose(textbox: HTMLElement, query: string) {
  const user = userEvent.setup();
  await user.click(textbox);
  await user.keyboard(`/${query}`);
  await menu();
  await user.keyboard('{Enter}');
  return user;
}

describe('the slash menu (NTF-013)', () => {
  it('[NTF-013] (1) opens on "/", narrows as you type, and the arrow keys and Enter work', async () => {
    const user = userEvent.setup();
    const { textbox, changes } = renderEditor();
    await user.click(textbox);
    await user.keyboard('/');
    const list = await menu();
    // Everything but the widths of columns, which only shows inside them.
    expect(within(list).getAllByRole('option').length).toBe(
      SLASH_TOOLS.filter((tool) => tool.id !== 'columnWidths').length,
    );
    await user.keyboard('hea');
    await waitFor(() =>
      expect(
        within(list)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6']),
    );
    const options = within(list).getAllByRole('option');
    expect(textbox).toHaveAttribute('aria-activedescendant', options[0]?.id);
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(textbox).toHaveAttribute('aria-activedescendant', options[2]?.id);
    await user.keyboard('{ArrowUp}{Enter}');
    expect(screen.queryByRole('listbox')).toBeNull();
    await user.keyboard('Plan');
    // What was typed after "/" went with it.
    expect(changes.at(-1)?.content?.[0]).toMatchObject({
      type: 'heading',
      attrs: { level: 2 },
      content: [{ text: 'Plan' }],
    });
  });

  it('[NTF-013] (2) Escape closes it and leaves what was typed in place', async () => {
    const user = userEvent.setup();
    const { textbox, changes } = renderEditor();
    await user.click(textbox);
    await user.keyboard('/hea');
    await menu();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('listbox')).toBeNull());
    expect(changes.at(-1)?.content?.[0]?.content?.[0]?.text).toBe('/hea');
  });

  it('[NTF-013] (3) opens nothing inside a word, or in a code block', async () => {
    const user = userEvent.setup();
    const { textbox } = renderEditor();
    await user.click(textbox);
    await user.keyboard('and/or');
    expect(screen.queryByRole('listbox')).toBeNull();
    await user.keyboard('{Enter}```{Enter}/x');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('[NTF-013] says when nothing matches, and Enter then types on', async () => {
    const user = userEvent.setup();
    const { textbox, changes } = renderEditor();
    await user.click(textbox);
    await user.keyboard('/zzz');
    expect(await screen.findByText('No block matches.')).toBeVisible();
    await user.keyboard('{Enter}after');
    expect(blockTypes(changes.at(-1))).toEqual(['paragraph', 'paragraph']);
  });

  it('[NTF-013] finds a block by its name in the reader’s language, without accents', () => {
    const label = (id: keyof typeof messagesEs) => messagesEs[id];
    const found = matchingTools(SLASH_TOOLS, 'titulo', (tool) => label(tool.label));
    expect(found.map((tool) => tool.id)).toEqual([]);
    const plegable = matchingTools(SLASH_TOOLS, 'PLEGABLE', (tool) => label(tool.label));
    expect(plegable.map((tool) => tool.id)).toEqual(['expand']);
    const parrafo = matchingTools(SLASH_TOOLS, 'parrafo', (tool) => label(tool.label));
    expect(parrafo.map((tool) => tool.id)).toEqual(['paragraph']);
  });

  it('[NTF-013] holds every block asked for, each named in both languages', () => {
    expect(SLASH_TOOLS.map((tool) => tool.id)).toEqual([
      'paragraph',
      'heading1',
      'heading2',
      'heading3',
      'heading4',
      'heading5',
      'heading6',
      'bulletList',
      'orderedList',
      'taskList',
      'blockquote',
      'codeBlock',
      'panel-info',
      'panel-note',
      'panel-warning',
      'panel-success',
      'panel-error',
      'expand',
      'columns-2',
      'columns-3',
      'columnWidths',
      'table',
      'rule',
      'link',
      'mention',
      'ticket',
      'attachment',
      'emoji',
      'date',
      'status',
    ]);
    for (const tool of SLASH_TOOLS) {
      expect(messagesEn[tool.label], tool.id).toBeTruthy();
      expect(messagesEs[tool.label], tool.id).toBeTruthy();
    }
  });

  it('[NTF-013] leaves out what needs a ticket when there is none around it', async () => {
    const user = userEvent.setup();
    const { textbox } = renderEditor({ mentions: undefined }, {});
    await user.click(textbox);
    await user.keyboard('/');
    const list = await menu();
    const names = within(list)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(names).not.toContain('Another ticket');
    expect(names).not.toContain('Image or file from this ticket');
    expect(names).not.toContain('Mention');
  });

  it('[NTF-013] inserts lists, a quote, a divider and a table at the caret', async () => {
    for (const [query, type] of [
      ['bullet', 'bulletList'],
      ['number', 'orderedList'],
      ['checklist', 'taskList'],
      ['quote', 'blockquote'],
      ['divider', 'horizontalRule'],
      ['table', 'table'],
    ] as const) {
      const { textbox, changes } = renderEditor();
      const user = await choose(textbox, query);
      // An empty list reads as an empty document until it holds something.
      await user.keyboard('x');
      await waitFor(() => expect(blockTypes(changes.at(-1))).toContain(type));
      document.body.innerHTML = '';
    }
  });

  it('[NTF-013] inserts each panel, and text goes inside it', async () => {
    for (const [query, panelType] of [
      ['information', 'info'],
      ['note', 'note'],
      ['warning', 'warning'],
      ['success', 'success'],
      ['error', 'error'],
    ] as const) {
      const { textbox, changes } = renderEditor();
      const user = await choose(textbox, query);
      await user.keyboard('careful');
      expect(changes.at(-1)?.content?.[0]).toMatchObject({
        type: 'panel',
        attrs: { panelType },
        content: [{ type: 'paragraph', content: [{ text: 'careful' }] }],
      });
      document.body.innerHTML = '';
    }
  });

  it('[NTF-014] inserts a collapsible section with its title in a field', async () => {
    const user = userEvent.setup();
    const { textbox, changes } = renderEditor();
    await choose(textbox, 'collaps');
    const title = await screen.findByRole('textbox', { name: 'Section title' });
    await waitFor(() => expect(title).toHaveFocus());
    await user.keyboard('More{Enter}');
    await waitFor(() => expect(textbox).toHaveFocus());
    await user.keyboard('inside');
    expect(changes.at(-1)?.content?.[0]).toMatchObject({
      type: 'expand',
      attrs: { title: 'More' },
      content: [{ type: 'paragraph', content: [{ text: 'inside' }] }],
    });
  });

  it('[NTF-014] keeps a section title to one line of text: a pasted tab becomes a space', async () => {
    const user = userEvent.setup();
    const { textbox, changes } = renderEditor();
    await choose(textbox, 'collaps');
    const title = await screen.findByRole('textbox', { name: 'Section title' });
    await waitFor(() => expect(title).toHaveFocus());
    await user.paste('Step\t1\u0007');
    await user.keyboard('!');
    expect(title).toHaveValue('Step 1 !');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(textbox).toHaveFocus());
    await user.keyboard('inside');
    expect(changes.at(-1)?.content?.[0]).toMatchObject({
      type: 'expand',
      attrs: { title: 'Step 1 !' },
    });
  });

  it('[NTF-014] puts the caret in the title of the section that went in, not of another untitled one', async () => {
    const user = userEvent.setup();
    const { textbox, changes } = renderEditor({
      initial: {
        type: 'doc',
        content: [
          { type: 'expand', attrs: { title: '' }, content: [{ type: 'paragraph' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'Later' }] },
        ],
      },
    });
    await user.click(textbox);
    // The caret at the end of "Later", below the untitled section (jsdom lays nothing out to
    // click on, so the editor puts it there).
    act(() => {
      (textbox as HTMLElement & { editor: Editor }).editor.commands.focus('end');
    });
    await user.keyboard(' /collaps');
    await menu();
    await user.keyboard('{Enter}');
    const titles = await screen.findAllByRole('textbox', { name: 'Section title' });
    expect(titles).toHaveLength(2);
    await waitFor(() => expect(titles[1]).toHaveFocus());
    await user.keyboard('New');
    const sections = changes.at(-1)?.content?.filter((n) => n.type === 'expand');
    expect(sections?.map((n) => n.attrs?.title)).toEqual(['', 'New']);
  });

  it('[NTF-014] inserts columns, and writing goes in the first', async () => {
    const user = userEvent.setup();
    const { textbox, changes } = renderEditor();
    await choose(textbox, 'three');
    await user.keyboard('left');
    const layout = changes.at(-1)?.content?.[0];
    expect(layout?.type).toBe('columnLayout');
    expect(layout?.content).toHaveLength(3);
    expect(layout?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe('left');
  });

  it('[NTF-013] asks a code block for its language, refusing what is not one', async () => {
    const user = userEvent.setup();
    const { textbox, changes } = renderEditor();
    await choose(textbox, 'code');
    const field = await screen.findByRole('combobox', { name: 'Code language (optional)' });
    expect(field).toHaveFocus();
    await user.keyboard('not a language{Enter}');
    expect(screen.getByText('A language is one word, such as sql.')).toBeVisible();
    await user.clear(field);
    await user.keyboard('sql{Enter}');
    expect(screen.queryByRole('combobox', { name: 'Code language (optional)' })).toBeNull();
    await waitFor(() => expect(textbox).toHaveFocus());
    await user.keyboard('SELECT 1');
    expect(changes.at(-1)?.content?.[0]).toMatchObject({
      type: 'codeBlock',
      attrs: { language: 'sql' },
      content: [{ text: 'SELECT 1' }],
    });
  });

  it('[NTF-013] asks a status label for its words and colour', async () => {
    const user = userEvent.setup();
    const { textbox, changes } = renderEditor();
    await choose(textbox, 'status');
    await user.keyboard('In review');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Colour' }), 'Blue');
    await user.click(screen.getByRole('button', { name: 'Insert' }));
    expect(changes.at(-1)?.content?.[0]?.content?.[0]).toMatchObject({
      type: 'status',
      attrs: { text: 'In review', color: 'blue' },
    });
  });

  it('[NTF-013] inserts a date as the day chosen, in UTC', async () => {
    const user = userEvent.setup();
    const { textbox, changes } = renderEditor();
    await choose(textbox, 'date');
    const field = await screen.findByLabelText('Date');
    await user.clear(field);
    await user.type(field, '2026-11-03');
    await user.click(screen.getByRole('button', { name: 'Insert' }));
    expect(changes.at(-1)?.content?.[0]?.content?.[0]).toMatchObject({
      type: 'date',
      attrs: { timestamp: String(Date.UTC(2026, 10, 3)) },
    });
  });

  it('[NTF-013] offers today as the reader’s own day, not the day in UTC', async () => {
    // 19:00 on 3 November in Mexico City is already 4 November in UTC.
    vi.stubEnv('TZ', 'America/Mexico_City');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-04T01:00:00Z'));
    try {
      const user = userEvent.setup();
      const { textbox, changes } = renderEditor();
      await choose(textbox, 'date');
      expect(await screen.findByLabelText('Date')).toHaveValue('2026-11-03');
      await user.keyboard('{Enter}');
      expect(changes.at(-1)?.content?.[0]?.content?.[0]).toMatchObject({
        type: 'date',
        attrs: { timestamp: String(Date.UTC(2026, 10, 3)) },
      });
    } finally {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it('[NTF-013] offers today on the zone saved on the account, not the device’s (T-280)', async () => {
    // 19:00 on 3 November on a device in Mexico City; the account says Tokyo, where it is
    // already 10:00 on 4 November.
    vi.stubEnv('TZ', 'America/Mexico_City');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-04T01:00:00Z'));
    setAccountTimeZone('Asia/Tokyo');
    try {
      const { textbox } = renderEditor();
      await choose(textbox, 'date');
      expect(await screen.findByLabelText('Date')).toHaveValue('2026-11-04');
    } finally {
      setAccountTimeZone(null);
      vi.useRealTimers();
      vi.unstubAllEnvs();
    }
  });

  it('[NTF-013] finds an emoji by name, by keyboard', async () => {
    const user = userEvent.setup();
    const { textbox, changes } = renderEditor();
    await choose(textbox, 'emoji');
    await screen.findByRole('combobox', { name: 'Emoji' });
    await user.keyboard('rock');
    await user.keyboard('{Enter}');
    expect(changes.at(-1)?.content?.[0]?.content?.[0]).toMatchObject({
      type: 'emoji',
      attrs: { shortName: ':rocket:', text: '🚀' },
    });
  });

  it('[NTF-013] offers the files of the ticket, and an image keeps being one', async () => {
    const user = userEvent.setup();
    const { textbox, changes } = renderEditor();
    await choose(textbox, 'image');
    await screen.findByRole('combobox', { name: 'Image or file from this ticket' });
    await user.keyboard('{ArrowDown}{ArrowUp}{Enter}');
    await waitFor(() =>
      expect(changes.at(-1)?.content?.[0]).toMatchObject({
        type: 'attachmentRef',
        attrs: { name: 'screen.png', image: true },
      }),
    );
  });

  it('[NTF-014] offers two files of one name as two choices, and the reference keeps the one picked (TT-4)', async () => {
    const user = userEvent.setup();
    const shot = (n: number, sha256: string, createdAt: string) => ({
      name: 'image.png',
      image: true,
      href: `https://files.example.test/${n}`,
      thumbnail: null,
      sha256,
      size: 2048 * n,
      createdAt,
      author: n === 1 ? 'Ana' : null,
    });
    const files = [
      shot(1, `${'a'.repeat(16)}${'0'.repeat(48)}`, '2026-11-01T10:00:00Z'),
      shot(2, `${'b'.repeat(16)}${'0'.repeat(48)}`, '2026-11-02T10:00:00Z'),
      { ...shot(3, 'c'.repeat(64), '2026-11-03T10:00:00Z'), name: 'notes.pdf', image: false },
    ];
    const { textbox, changes } = renderEditor({}, { attachments: async () => files });
    await choose(textbox, 'image');
    const list = await screen.findByRole('listbox', { name: 'Image or file from this ticket' });
    const names = within(list)
      .getAllByRole('option')
      .map((o) => o.textContent);
    // Each of the two says its size, when it came and who added it; a name alone stays alone.
    expect(names).toHaveLength(3);
    expect(names[0]).toMatch(/^image\.png \(2 KB, Nov 1, 2026, .+, by Ana\)$/);
    expect(names[1]).toMatch(/^image\.png \(4 KB, Nov 2, 2026, .+\)$/);
    expect(names[2]).toBe('notes.pdf');
    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() =>
      expect(changes.at(-1)?.content?.[0]).toMatchObject({
        type: 'attachmentRef',
        attrs: { name: 'image.png', image: true, digest: 'b'.repeat(16) },
      }),
    );
  });

  it('[NTF-014] tells two files of one name apart by their place when nothing else does (TT-4)', async () => {
    const shot = (n: number) => ({
      name: 'image.png',
      image: true,
      href: `https://files.example.test/${n}`,
      thumbnail: null,
    });
    const { textbox } = renderEditor({}, { attachments: async () => [shot(1), shot(2)] });
    await choose(textbox, 'image');
    const list = await screen.findByRole('listbox', { name: 'Image or file from this ticket' });
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['image.png (file 1)', 'image.png (file 2)']);
  });

  it('[NTF-013] offers common languages for a code block, narrowed as you type (TT-8)', async () => {
    const user = userEvent.setup();
    const { textbox, changes } = renderEditor();
    await choose(textbox, 'code');
    const field = await screen.findByRole('combobox', { name: 'Code language (optional)' });
    const list = screen.getByRole('listbox', { name: 'Common languages' });
    expect(within(list).getAllByRole('option').length).toBeGreaterThan(20);
    await user.keyboard('ty');
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['TypeScript']);
    await user.clear(field);
    await user.keyboard('sh');
    // Those that start with it come first; a word unlike the name shows beside it.
    const options = within(list).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Shell', 'Bash', 'C#csharp', 'PowerShell']);
    await user.keyboard('{ArrowDown}');
    expect(field).toHaveAttribute('aria-activedescendant', options[0]?.id);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowDown}{ArrowUp}{Enter}');
    await waitFor(() => expect(textbox).toHaveFocus());
    await user.keyboard('ls');
    expect(changes.at(-1)?.content?.[0]).toMatchObject({
      type: 'codeBlock',
      attrs: { language: 'shell' },
    });
  });

  it('[NTF-013] keeps the option the arrow keys reach in sight in a long list (TT-8)', async () => {
    // jsdom has no layout and no scrolling: what was asked to come into view is recorded.
    const scrolled = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: scrolled,
      configurable: true,
    });
    const last = () => scrolled.mock.contexts.at(-1) as HTMLElement | undefined;
    try {
      const user = userEvent.setup();
      const first = renderEditor();
      await choose(first.textbox, 'code');
      await screen.findByRole('combobox', { name: 'Code language (optional)' });
      const list = screen.getByRole('listbox', { name: 'Common languages' });
      const options = within(list).getAllByRole('option');
      // Up from what was typed goes to the last of about thirty, far below the few in sight.
      await user.keyboard('{ArrowUp}');
      expect(options.at(-1)).toHaveAttribute('aria-selected', 'true');
      expect(last()).toBe(options.at(-1));
      expect(scrolled).toHaveBeenLastCalledWith({ block: 'nearest' });
      await user.keyboard('{ArrowDown}{ArrowDown}');
      expect(last()).toBe(options[1]);

      document.body.innerHTML = '';
      const second = renderEditor();
      await choose(second.textbox, 'emoji');
      await screen.findByRole('combobox', { name: 'Emoji' });
      const emoji = within(screen.getByRole('listbox', { name: 'Emoji' })).getAllByRole('option');
      await user.keyboard('{ArrowUp}');
      expect(emoji.at(-1)).toHaveAttribute('aria-selected', 'true');
      expect(last()).toBe(emoji.at(-1));
    } finally {
      Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    }
  });

  it('[NTF-013] still takes any one word for a language, and a pointer can pick one (TT-8)', async () => {
    const user = userEvent.setup();
    const first = renderEditor();
    await choose(first.textbox, 'code');
    await screen.findByRole('combobox', { name: 'Code language (optional)' });
    await user.keyboard('elixir{Enter}');
    await waitFor(() => expect(first.textbox).toHaveFocus());
    await user.keyboard('x');
    expect(first.changes.at(-1)?.content?.[0]?.attrs?.language).toBe('elixir');
    document.body.innerHTML = '';
    const second = renderEditor();
    await choose(second.textbox, 'code');
    await screen.findByRole('combobox', { name: 'Code language (optional)' });
    await user.click(screen.getByRole('option', { name: 'Python' }));
    await waitFor(() => expect(second.textbox).toHaveFocus());
    await user.keyboard('x');
    expect(second.changes.at(-1)?.content?.[0]?.attrs?.language).toBe('python');
  });

  it('[NTF-014] sets the widths of the columns the caret is in, all at once (TT-2)', async () => {
    const user = userEvent.setup();
    const { textbox, changes } = renderEditor();
    await choose(textbox, 'two');
    await user.keyboard('left /width');
    const list = await menu();
    expect(
      within(list)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Column widths']);
    await user.keyboard('{Enter}');
    const widths = await screen.findByRole('combobox', { name: 'Widths of the 2 columns' });
    expect(widths).toHaveFocus();
    expect(
      within(widths)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Equal', '33.3%, 66.7%', '66.7%, 33.3%', '25%, 75%', '75%, 25%']);
    await user.selectOptions(widths, '25%, 75%');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(textbox).toHaveFocus());
    const layout = changes.at(-1)?.content?.[0];
    expect(layout?.content?.map((column) => column.attrs?.width)).toEqual([25, 75]);
    // The text typed before the menu stays, with the "/width" gone.
    expect(JSON.stringify(layout)).toContain('left ');
    expect(JSON.stringify(layout)).not.toContain('/width');
    const shown = textbox.querySelector<HTMLElement>('[data-columns]');
    expect(shown?.style.getPropertyValue('--rt-columns')).toBe('minmax(0, 25fr) minmax(0, 75fr)');
    // Equal again: the widths go, and so does the property.
    await user.keyboard(' /width{Enter}');
    const again = await screen.findByRole('combobox', { name: 'Widths of the 2 columns' });
    expect(again).toHaveDisplayValue('25%, 75%');
    await user.selectOptions(again, 'Equal');
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(changes.at(-1)?.content?.[0]?.content?.map((c) => c.attrs?.width)).toEqual([
        null,
        null,
      ]),
    );
    expect(shown?.style.getPropertyValue('--rt-columns')).toBe('');
  });

  it('[NTF-014] offers the widths of columns only inside columns (TT-2)', async () => {
    const user = userEvent.setup();
    const { textbox } = renderEditor();
    await user.click(textbox);
    await user.keyboard('/width');
    expect(await screen.findByText('No block matches.')).toBeVisible();
  });

  it('[NTF-013] links another ticket by what is typed, as its key only', async () => {
    const user = userEvent.setup();
    const { textbox, changes } = renderEditor();
    await choose(textbox, 'another');
    await screen.findByRole('combobox', { name: 'Another ticket' });
    await user.keyboard('retry');
    await screen.findByRole('option', { name: /SHOP-40/ });
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(changes.at(-1)?.content?.[0]?.content?.[0]).toMatchObject({
        type: 'ticketRef',
        attrs: { key: 'SHOP-40' },
      }),
    );
    expect(JSON.stringify(changes.at(-1))).not.toContain('Retry a failed payment');
  });

  it('[NTF-013] adds a link with its address as its text, when nothing is selected', async () => {
    const user = userEvent.setup();
    const { textbox, changes } = renderEditor();
    await choose(textbox, 'link');
    await user.keyboard('example.test/docs{Enter}');
    expect(changes.at(-1)?.content?.[0]?.content?.[0]).toMatchObject({
      text: 'https://example.test/docs',
      marks: [{ type: 'link', attrs: { href: 'https://example.test/docs' } }],
    });
  });

  it('[NTF-013] Escape in a form goes back to the text with nothing added', async () => {
    const user = userEvent.setup();
    const { textbox, changes } = renderEditor();
    await choose(textbox, 'status');
    await user.keyboard('Half written{Escape}');
    await waitFor(() => expect(textbox).toHaveFocus());
    expect(JSON.stringify(changes.at(-1) ?? null)).not.toContain('Half written');
    expect(JSON.stringify(changes.at(-1) ?? null)).not.toContain('status');
  });

  it('[NFR-006] reads in Spanish', async () => {
    const user = userEvent.setup();
    const { textbox } = renderEditor({}, TOOLS, 'es');
    await user.click(textbox);
    await user.keyboard('/plega');
    const list = await screen.findByRole('listbox', { name: 'Bloques para añadir' });
    await waitFor(() =>
      expect(
        within(list)
          .getAllByRole('option')
          .map((o) => o.textContent),
      ).toEqual(['Sección plegable']),
    );
  });
});

describe('the menu inside another form (NTF-013)', () => {
  it('[NTF-013] Enter in a block form puts the block in and does not send the form around it', async () => {
    const user = userEvent.setup();
    const sent: number[] = [];
    const changes: (PmJson | null)[] = [];
    render(
      <I18nProvider locale="en">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            sent.push(1);
          }}
        >
          <p id="in-form">Comment</p>
          <RichTextEditor labelledBy="in-form" onChange={(doc) => changes.push(doc)} />
        </form>
      </I18nProvider>,
    );
    const textbox = screen.getByRole('textbox', { name: 'Comment' });
    await choose(textbox, 'status');
    await user.keyboard('Ready{Enter}');
    expect(sent).toEqual([]);
    expect(changes.at(-1)?.content?.[0]?.content?.[0]).toMatchObject({
      type: 'status',
      attrs: { text: 'Ready' },
    });
  });
});

describe('the new blocks in read mode (NTF-014)', () => {
  const view = (doc: PmJson, tools: EditorTools = TOOLS) =>
    render(
      <I18nProvider locale="en">
        <EditorToolsProvider value={tools}>
          <RichTextView doc={doc} />
        </EditorToolsProvider>
      </I18nProvider>,
    );
  const doc = (...content: PmJson[]): PmJson => ({ type: 'doc', content });
  const p = (text: string): PmJson => ({ type: 'paragraph', content: [{ type: 'text', text }] });

  it('[NTF-014] shows a collapsible section as a disclosure, with a word when it has no title', async () => {
    const { container } = view(
      doc(
        { type: 'expand', attrs: { title: 'Steps' }, content: [p('Inside')] },
        { type: 'expand', attrs: { title: '' }, content: [p('Other')] },
      ),
    );
    const parts = container.querySelectorAll('details');
    expect(parts).toHaveLength(2);
    expect(parts[0]?.open).toBe(false);
    expect(parts[0]?.querySelector('summary')).toHaveTextContent('Steps');
    expect(parts[1]?.querySelector('summary')).toHaveTextContent('More');
    expect(parts[0]).toHaveTextContent('Inside');
  });

  it('[NTF-014] shows a title as text, never as markup', () => {
    const { container } = view(
      doc({ type: 'expand', attrs: { title: '<img src=x onerror=alert(1)>' }, content: [p('x')] }),
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('summary')).toHaveTextContent('<img src=x onerror=alert(1)>');
  });

  it('[NTF-014] shows columns side by side as one block each', () => {
    const { container } = view(
      doc({
        type: 'columnLayout',
        content: [
          { type: 'column', content: [p('Left')] },
          { type: 'column', content: [p('Right')] },
        ],
      }),
    );
    expect(container.querySelectorAll('[data-columns] > [data-column]')).toHaveLength(2);
  });

  it('[NTF-014] links a ticket in this app, in the same tab', () => {
    view(doc({ type: 'paragraph', content: [{ type: 'ticketRef', attrs: { key: 'PAY-42' } }] }));
    const link = screen.getByRole('link', { name: 'PAY-42' });
    expect(link.getAttribute('href')).toContain('tickets/PAY-42');
    expect(link).not.toHaveAttribute('target');
  });

  it('[NTF-014] gives a reference that is not a key no address', () => {
    const { container } = view(
      doc({
        type: 'paragraph',
        content: [{ type: 'ticketRef', attrs: { key: 'javascript:alert(1)' } }],
      }),
    );
    expect(container.querySelector('a')?.hasAttribute('href')).toBe(false);
  });

  it('[NTF-014] finds a file by its name among the ticket’s, with a picture for an image', async () => {
    view(
      doc(
        { type: 'attachmentRef', attrs: { name: 'screen.png', image: true } },
        { type: 'attachmentRef', attrs: { name: 'notes.pdf', image: false } },
      ),
    );
    expect(await screen.findByRole('img', { name: 'screen.png' })).toHaveAttribute(
      'src',
      'https://files.example.test/1/t',
    );
    expect(await screen.findByRole('link', { name: 'notes.pdf' })).toHaveAttribute(
      'href',
      'https://files.example.test/2',
    );
  });

  it('[NTF-014] shows the file of a name whose SHA-256 the reference names, else the first (TT-4)', async () => {
    const file = (n: number, sha256?: string) => ({
      name: 'report.pdf',
      image: false,
      href: `https://files.example.test/${n}`,
      thumbnail: null,
      ...(sha256 ? { sha256 } : {}),
    });
    const tools: EditorTools = {
      attachments: async () => [
        file(1, 'a'.repeat(64)),
        file(2, `${'b'.repeat(16)}${'0'.repeat(48)}`),
      ],
    };
    view(
      doc(
        { type: 'attachmentRef', attrs: { name: 'report.pdf', digest: 'b'.repeat(16) } },
        { type: 'attachmentRef', attrs: { name: 'report.pdf' } },
        // A digest no file has: the first of the name.
        { type: 'attachmentRef', attrs: { name: 'report.pdf', digest: 'c'.repeat(16) } },
      ),
      tools,
    );
    await waitFor(() =>
      expect(screen.getAllByRole('link', { name: 'report.pdf' })).toHaveLength(3),
    );
    expect(
      screen.getAllByRole('link', { name: 'report.pdf' }).map((a) => a.getAttribute('href')),
    ).toEqual([
      'https://files.example.test/2',
      'https://files.example.test/1',
      'https://files.example.test/1',
    ]);
  });

  it('[NTF-014] lays columns out by their widths when every one has a width (TT-2)', () => {
    const layout = (...widths: (number | null)[]) =>
      doc({
        type: 'columnLayout',
        content: widths.map((width) => ({ type: 'column', attrs: { width }, content: [p('x')] })),
      });
    const { container, unmount } = view(layout(30, 70));
    expect(
      container
        .querySelector<HTMLElement>('[data-columns]')
        ?.style.getPropertyValue('--rt-columns'),
    ).toBe('minmax(0, 30fr) minmax(0, 70fr)');
    unmount();
    const equal = view(layout(30, null));
    expect(equal.container.querySelector('[data-columns]')?.getAttribute('style')).toBeNull();
  });

  it('[NTF-014] shows a file the ticket does not have as its name, with no link', async () => {
    view(doc({ type: 'attachmentRef', attrs: { name: 'gone.png', image: true } }));
    expect(await screen.findByText('gone.png')).toBeVisible();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('[NTF-006] shows a date in the reader’s language', () => {
    const { container } = view(
      doc({
        type: 'paragraph',
        content: [{ type: 'date', attrs: { timestamp: String(Date.UTC(2026, 10, 3)) } }],
      }),
    );
    const time = container.querySelector('time');
    expect(time).toHaveTextContent('Nov 3, 2026');
    expect(time).toHaveAttribute('datetime', '2026-11-03');
  });
});
