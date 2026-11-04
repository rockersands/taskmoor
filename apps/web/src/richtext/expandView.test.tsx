import type { PmJson } from '@taskmoor/richtext';
import { docFromYDoc, writeDocToYDoc } from '@taskmoor/richtext';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Editor } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { CollaborativeEditor, type Connect } from './CollaborativeEditor';
import { RichTextEditor, type RichTextEditorProps } from './RichTextEditor';

const p = (text: string): PmJson => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const section = (title: string, ...content: PmJson[]): PmJson => ({
  type: 'expand',
  attrs: { title },
  content,
});
const doc = (...content: PmJson[]): PmJson => ({ type: 'doc', content });

const START = doc(p('Before'), section('Steps', p('Click save'), p('Reload')), p('After'));

function renderEditor(props: Partial<RichTextEditorProps> = {}, locale: Locale = 'en') {
  const changes: (PmJson | null)[] = [];
  render(
    <I18nProvider locale={locale}>
      <p id="label">Description</p>
      <RichTextEditor
        labelledBy="label"
        initial={START}
        onChange={(next) => changes.push(next)}
        {...props}
      />
    </I18nProvider>,
  );
  const textbox = screen.getByRole('textbox', { name: 'Description' });
  const editor = (textbox as HTMLElement & { editor: Editor }).editor;
  return { textbox, editor, changes };
}

/** Where a text first stands in the document, as a position for the caret. */
function positionOf(editor: Editor, text: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found === -1 && node.isText && node.text?.includes(text)) found = pos;
    return found === -1;
  });
  return found;
}

/** Where the section starts and ends. */
function sectionAt(editor: Editor): { from: number; to: number } {
  let at = { from: -1, to: -1 };
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'expand' && at.from === -1) at = { from: pos, to: pos + node.nodeSize };
    return at.from === -1;
  });
  return at;
}

describe('a collapsible section while editing (NTF-014; ADR-120, TT-1)', () => {
  it('[NTF-014] hides and shows its text with a toggle, and the document does not change', async () => {
    const user = userEvent.setup();
    const { textbox, changes } = renderEditor();
    const toggle = screen.getByRole('button', { name: 'Text of the section “Steps”' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const body = document.getElementById(toggle.getAttribute('aria-controls') ?? '');
    expect(body).toHaveTextContent('Click save');
    expect(body).toBeVisible();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('title', 'Show the text');
    expect(body).not.toBeVisible();
    // The title stays, as a field, and the text is still in the document.
    expect(screen.getByRole('textbox', { name: 'Section title' })).toHaveValue('Steps');
    expect(textbox).toHaveTextContent('After');
    expect(changes).toEqual([]);
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(body).toBeVisible();
  });

  it('[NTF-014] moves the caret out of text it hides, and shows text the caret goes back into', async () => {
    const user = userEvent.setup();
    const { editor, changes } = renderEditor();
    act(() => {
      editor.commands.setTextSelection(positionOf(editor, 'Reload') + 2);
    });
    const toggle = screen.getByRole('button', { name: 'Text of the section “Steps”' });
    await user.click(toggle);
    // Just past the section, at the start of "After".
    const { from, to } = sectionAt(editor);
    expect(editor.state.selection.from).toBeGreaterThanOrEqual(to);
    expect(editor.state.selection.$from.parent.textContent).toBe('After');
    expect(changes).toEqual([]);
    // Anything that puts the caret back inside (here, a search's selection) shows it again.
    act(() => {
      editor.commands.setTextSelection(from + 3);
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('[NTF-014] Down and Escape in the title go past a hidden section; Enter shows it and goes in', async () => {
    const user = userEvent.setup();
    const { editor, changes } = renderEditor();
    const toggle = screen.getByRole('button', { name: 'Text of the section “Steps”' });
    const title = screen.getByRole('textbox', { name: 'Section title' });
    await user.click(toggle);
    await user.click(title);
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(editor.isFocused).toBe(true));
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard('x');
    expect(changes.at(-1)?.content?.[2]).toMatchObject(p('xAfter'));
    await user.click(title);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(editor.isFocused).toBe(true));
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(title);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'true'));
    await user.keyboard('y');
    expect(changes.at(-1)?.content?.[1]?.content?.[0]).toMatchObject(p('yClick save'));
  });

  it('[NTF-014] Down past a hidden section with nothing after it starts a paragraph there', async () => {
    const user = userEvent.setup();
    const { editor, changes } = renderEditor({ initial: doc(section('Last', p('Inside'))) });
    await user.click(screen.getByRole('button', { name: 'Text of the section “Last”' }));
    await user.click(screen.getByRole('textbox', { name: 'Section title' }));
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(editor.isFocused).toBe(true));
    await user.keyboard('Next');
    expect(changes.at(-1)?.content?.map((n) => n.type)).toEqual(['expand', 'paragraph']);
    expect(changes.at(-1)?.content?.[1]).toMatchObject(p('Next'));
    expect(screen.getByRole('button', { name: 'Text of the section “Last”' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('[NTF-014] Up in the title goes to the text before; with none, the title keeps the caret', async () => {
    const user = userEvent.setup();
    const first = renderEditor();
    await user.click(screen.getByRole('textbox', { name: 'Section title' }));
    await user.keyboard('{ArrowUp}');
    await waitFor(() => expect(first.editor.isFocused).toBe(true));
    await user.keyboard('!');
    expect(first.changes.at(-1)?.content?.[0]?.content?.[0]?.text).toMatch(/!/);
    document.body.innerHTML = '';
    renderEditor({ initial: doc(section('Alone', p('Text'))) });
    const title = screen.getByRole('textbox', { name: 'Section title' });
    await user.click(title);
    await user.keyboard('{ArrowUp}');
    expect(title).toHaveFocus();
  });

  it('[NTF-014] the toggle works by keyboard, and in a document someone may only read', async () => {
    const user = userEvent.setup();
    renderEditor({ editable: false });
    const title = screen.getByRole('textbox', { name: 'Section title' });
    expect(title).toBeDisabled();
    const toggle = screen.getByRole('button', { name: 'Text of the section “Steps”' });
    toggle.focus();
    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.keyboard(' ');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
  });

  it('[NTF-014] names a section without a title, and reads in Spanish', async () => {
    renderEditor({ initial: doc(section('', p('x')), section('Pasos', p('y'))) }, 'es');
    expect(screen.getByRole('button', { name: 'Texto de la sección «Más»' })).toBeVisible();
    const toggle = screen.getByRole('button', { name: 'Texto de la sección «Pasos»' });
    expect(toggle).toHaveAttribute('title', 'Ocultar el texto');
  });
});

/** A shared document, opened as the server would open it (`CollaborativeEditor.test.tsx`). */
function sharedDocument(initial: PmJson) {
  const document = new Y.Doc();
  writeDocToYDoc(document, initial);
  const connect: Connect = (_name, onStatus) => {
    onStatus('live');
    return { document, provider: null, destroy: () => {} };
  };
  return { document, connect };
}

describe('a collapsible section edited together (NTF-008, NTF-014; TT-1)', () => {
  it('[NTF-014] hiding is each person’s own: someone else’s change reaches the hidden text and says so', async () => {
    const user = userEvent.setup();
    const shared = sharedDocument(START);
    render(
      <I18nProvider locale="en">
        <h2 id="label">Description</h2>
        <CollaborativeEditor
          ticketId={41}
          field="description"
          labelledBy="label"
          fallback={null}
          user={{ id: 3, name: 'Kalo' }}
          connect={shared.connect}
        />
      </I18nProvider>,
    );
    const toggle = await screen.findByRole('button', { name: 'Text of the section “Steps”' });
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // Hiding writes nothing to the shared document.
    expect(docFromYDoc(shared.document)).toEqual(docFromYDoc(sharedDocument(START).document));
    expect(screen.getByText('Changed while hidden')).not.toBeVisible();
    // Someone else adds a step inside it.
    const edited = doc(
      p('Before'),
      section('Steps', p('Click save'), p('Wait a second'), p('Reload')),
      p('After'),
    );
    act(() => writeDocToYDoc(shared.document, edited));
    const note = screen.getByText('Changed while hidden');
    await waitFor(() => expect(note).toBeVisible());
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-describedby', note.id);
    // Their retitling reaches the field, and the toggle's name with it.
    act(() =>
      writeDocToYDoc(
        shared.document,
        doc(p('Before'), section('How to', p('Click save'), p('Wait a second'), p('Reload'))),
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Section title' })).toHaveValue('How to'),
    );
    expect(toggle).toHaveAccessibleName('Text of the section “How to”');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(screen.getByText('Wait a second')).toBeVisible();
    expect(note).not.toBeVisible();
    expect(toggle).not.toHaveAttribute('aria-describedby');
  });
});
