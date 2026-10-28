import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { PmJson } from '@taskmoor/richtext';
import { docFromYDoc, writeDocToYDoc } from '@taskmoor/richtext';
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
    // Someone else's change shows in the field.
    act(() => writeDocToYDoc(shared.document, text('Rewritten elsewhere')));
    await waitFor(() => expect(textbox).toHaveTextContent('Rewritten elsewhere'));
    // Yjs keeps the history: there is no separate undo button.
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull();
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
