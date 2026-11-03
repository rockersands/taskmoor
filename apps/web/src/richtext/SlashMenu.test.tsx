import type { PmJson } from '@taskmoor/richtext';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { messagesEn } from '../i18n/messages.en';
import { messagesEs } from '../i18n/messages.es';
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
    expect(within(list).getAllByRole('option').length).toBe(SLASH_TOOLS.length);
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
    expect(textbox).toHaveFocus();
    await user.keyboard('inside');
    expect(changes.at(-1)?.content?.[0]).toMatchObject({
      type: 'expand',
      attrs: { title: 'More' },
      content: [{ type: 'paragraph', content: [{ text: 'inside' }] }],
    });
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
    const field = await screen.findByRole('textbox', { name: 'Code language (optional)' });
    expect(field).toHaveFocus();
    await user.keyboard('not a language{Enter}');
    expect(screen.getByText('A language is one word, such as sql.')).toBeVisible();
    await user.clear(field);
    await user.keyboard('sql{Enter}');
    expect(screen.queryByRole('textbox', { name: 'Code language (optional)' })).toBeNull();
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
