import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { PmJson } from '@taskmoor/richtext';
import { COLLAB_FRAGMENT, docFromYDoc, fromMarkdown, writeDocToYDoc } from '@taskmoor/richtext';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { I18nProvider } from '../i18n/I18nProvider';
import {
  CollaborativeEditor,
  type CollabStatus,
  type Connect,
  collabUrl,
} from './CollaborativeEditor';

const text = (value: string): PmJson => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }],
});

/** A document kept in the test, opened as the server would open it. */
function localDocument(initial: PmJson | null, withAwareness = false) {
  const document = new Y.Doc();
  writeDocToYDoc(document, initial);
  const awareness = withAwareness ? new Awareness(document) : null;
  let report: (status: CollabStatus) => void = () => {};
  const names: string[] = [];
  const connect: Connect = (name, onStatus) => {
    names.push(name);
    report = onStatus;
    onStatus('live');
    return {
      document,
      provider: awareness ? ({ awareness } as unknown as HocuspocusProvider) : null,
      destroy: () => {},
    };
  };
  return { document, awareness, connect, names, report: (s: CollabStatus) => report(s) };
}

function renderField(connect: Connect, fallback: PmJson | null = null) {
  render(
    <I18nProvider locale="en">
      <h2 id="label">Description</h2>
      <CollaborativeEditor
        ticketId={41}
        field="description"
        labelledBy="label"
        fallback={fallback}
        user={{ id: 3, name: 'Kalo' }}
        connect={connect}
      />
    </I18nProvider>,
  );
}

describe('the collaborative editor (M1-017)', () => {
  it('[NTF-008] edits the shared document of the field, so changes reach everyone in it', async () => {
    const user = userEvent.setup();
    const shared = localDocument(text('Shared text'));
    renderField(shared.connect);
    expect(shared.names).toEqual(['ticket/41/description']);
    const textbox = await screen.findByRole('textbox', { name: 'Description' });
    expect(textbox).toHaveTextContent('Shared text');
    expect(screen.getByText('Changes are saved as you type.')).toHaveAttribute('role', 'status');
    await user.click(textbox);
    await user.keyboard('Edited: ');
    const written = JSON.stringify(docFromYDoc(shared.document));
    expect(written).toContain('Edited: ');
    expect(written).toContain('Shared text');
    // Undo and Redo walk Yjs's history of this person's own edits (PL-44).
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(textbox).not.toHaveTextContent('Edited:'));
    expect(textbox).toHaveTextContent('Shared text');
    await user.click(screen.getByRole('button', { name: 'Redo' }));
    await waitFor(() => expect(textbox).toHaveTextContent('Edited: Shared text'));
    // Someone else's change shows in the field.
    act(() => writeDocToYDoc(shared.document, text('Rewritten elsewhere')));
    await waitFor(() => expect(textbox).toHaveTextContent('Rewritten elsewhere'));
  });

  it('[NTF-008] undo takes back the person’s own edit and leaves someone else’s alone (PL-44)', async () => {
    const user = userEvent.setup();
    const shared = localDocument(text('Shared text'));
    renderField(shared.connect);
    const textbox = await screen.findByRole('textbox', { name: 'Description' });
    await user.click(textbox);
    await user.keyboard('Mine: ');
    await waitFor(() => expect(textbox).toHaveTextContent('Mine: Shared text'));
    // Someone else adds a paragraph of their own, as the server would pass it on.
    act(() =>
      shared.document.transact(() => {
        const paragraph = new Y.XmlElement('paragraph');
        paragraph.insert(0, [new Y.XmlText('Added elsewhere')]);
        const fragment = shared.document.getXmlFragment(COLLAB_FRAGMENT);
        fragment.insert(fragment.length, [paragraph]);
      }, 'someone else'),
    );
    await waitFor(() => expect(textbox).toHaveTextContent('Added elsewhere'));
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(textbox).not.toHaveTextContent('Mine:'));
    expect(textbox).toHaveTextContent('Shared text');
    expect(textbox).toHaveTextContent('Added elsewhere');
    const written = JSON.stringify(docFromYDoc(shared.document));
    expect(written).not.toContain('Mine: ');
    expect(written).toContain('Added elsewhere');
    // Undo again has nothing of this person's left to take back: the other edit stays.
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(JSON.stringify(docFromYDoc(shared.document))).toContain('Added elsewhere');
  });

  it('[NTF-008] says who else is editing', async () => {
    const shared = localDocument(text('Together'), true);
    renderField(shared.connect);
    await screen.findByRole('textbox', { name: 'Description' });
    const other = new Awareness(new Y.Doc());
    other.setLocalStateField('user', { name: 'Ana', color: '#2f5f8f' });
    act(() => {
      if (!shared.awareness) throw new Error('no awareness');
      applyAwarenessUpdate(
        shared.awareness,
        encodeAwarenessUpdate(other, [other.clientID]),
        'test',
      );
    });
    expect(await screen.findByText('Also editing: Ana')).toBeVisible();
    act(() => shared.report('offline'));
    expect(
      await screen.findByText(
        'Connection lost. What you type now is kept and sent when the connection is back.',
      ),
    ).toBeVisible();
  });

  it('[NTF-008] [CORE-022] opening a description that ends in a code block changes nothing in it', async () => {
    // MOB-50's description in the page review's demo (T-250): a heading, bold text, a link, a
    // list and a code block last. The editor used to add an empty paragraph after the code
    // block as it opened, which the server saved as an edit by the person who only looked.
    const description = fromMarkdown(
      '## What this is\n\nPeople **sign in once** and stay signed in without a connection. ' +
        'See [the notes](https://example.com/notes).\n\n- First point of the list\n' +
        '- Second point, a little longer than the first so it wraps on a phone\n\n' +
        '```\nconst retries = 3;\n```',
    );
    const shared = localDocument(description, true);
    const asStored = docFromYDoc(shared.document);
    const changes: unknown[] = [];
    shared.document.on('update', (_update: Uint8Array, origin: unknown) => changes.push(origin));
    renderField(shared.connect);
    const textbox = await screen.findByRole('textbox', { name: 'Description' });
    await waitFor(() => expect(textbox).toHaveTextContent('const retries = 3;'));
    // What the editor does once it has the document happens in later tasks: let them run.
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(changes).toEqual([]);
    expect(docFromYDoc(shared.document)).toEqual(asStored);
    // A change from someone else is no edit here either.
    act(() =>
      writeDocToYDoc(
        shared.document,
        fromMarkdown('Rewritten elsewhere\n\n```\nconst retries = 5;\n```'),
        'someone else',
      ),
    );
    await waitFor(() => expect(textbox).toHaveTextContent('const retries = 5;'));
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(changes).toEqual(['someone else']);

    // The person's own edit still leaves a line to type on below the code block.
    const user = userEvent.setup();
    await user.click(textbox);
    await user.keyboard('x');
    await waitFor(() => expect(changes.length).toBeGreaterThan(1));
    const content = docFromYDoc(shared.document).content ?? [];
    expect(JSON.stringify(content)).toContain('x');
    expect(content.at(-1)?.type).toBe('paragraph');
  });

  it('[NTF-008] does not count the person’s own other pages as someone else editing', async () => {
    const shared = localDocument(text('Together'), true);
    renderField(shared.connect);
    await screen.findByRole('textbox', { name: 'Description' });
    const join = (userId: number, name: string) => {
      const other = new Awareness(new Y.Doc());
      other.setLocalStateField('user', { id: userId, name, color: '#2f5f8f' });
      act(() => {
        if (!shared.awareness) throw new Error('no awareness');
        applyAwarenessUpdate(
          shared.awareness,
          encodeAwarenessUpdate(other, [other.clientID]),
          'test',
        );
      });
    };
    // The same person (id 3, as renderField signs in) in another tab, or the page just reloaded.
    join(3, 'Kalo');
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(screen.getByText('Changes are saved as you type.')).toBeVisible();
    expect(screen.queryByText(/Also editing/)).toBeNull();
    // Someone else is named.
    join(8, 'Ana');
    expect(await screen.findByText('Also editing: Ana')).toBeVisible();
  });

  it('[IAM-011] shows people who may not edit the text read-only', async () => {
    const connect: Connect = (_name, onStatus) => {
      onStatus('refused');
      return { document: new Y.Doc(), provider: null, destroy: () => {} };
    };
    renderField(connect, text('As the ticket says'));
    expect(await screen.findByText('You can read this text but not edit it.')).toBeVisible();
    const textbox = screen.getByRole('textbox', { name: 'Description' });
    expect(textbox).toHaveAttribute('aria-readonly', 'true');
    expect(textbox).toHaveTextContent('As the ticket says');
    expect(screen.queryByRole('toolbar')).toBeNull();
  });

  it('connects to the realtime endpoint on the page’s own origin', () => {
    expect(collabUrl({ protocol: 'https:', host: 'app.example.test' })).toBe(
      'wss://app.example.test/api/v1/collab',
    );
    expect(collabUrl({ protocol: 'http:', host: 'localhost:4173' })).toBe(
      'ws://localhost:4173/api/v1/collab',
    );
  });
});
