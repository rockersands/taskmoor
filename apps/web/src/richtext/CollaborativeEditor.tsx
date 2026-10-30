import { HocuspocusProvider } from '@hocuspocus/provider';
import type { PmJson } from '@taskmoor/richtext';
import type { AnyExtension } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCaret from '@tiptap/extension-collaboration-caret';
import { useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { socketUrl } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MentionSource } from './mentions';
import { RichTextEditor } from './RichTextEditor';

/**
 * A rich text field edited by several people at once (M1-017; NTF-008; ADR-014): the editor
 * bound to the field's Yjs document on the server (`/api/v1/collab`, document
 * `ticket/<id>/<field>`). Changes merge character by character and are saved as people type;
 * others' cursors carry their names, and the field says who else is in it.
 *
 * Until the document arrives, and for people who may read but not edit the field (the server
 * refuses them), the field shows `fallback`, the text the ticket view gave, read-only.
 */
export type CollabStatus = 'connecting' | 'live' | 'offline' | 'refused';

export interface CollabSession {
  document: Y.Doc;
  /** Presence and cursors; absent for a document kept in this page only (stories). */
  provider: HocuspocusProvider | null;
  destroy: () => void;
}

/** Opens a field's document; `onStatus` hears how the connection goes. */
export type Connect = (name: string, onStatus: (status: CollabStatus) => void) => CollabSession;

/** The server's realtime endpoint, on the origin the app talks to. */
export function collabUrl(location: Pick<Location, 'protocol' | 'host'> = window.location): string {
  return socketUrl('/collab', location);
}

export const connectToServer: Connect = (name, onStatus) => {
  const document = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: collabUrl(),
    name,
    document,
    onSynced: ({ state }) => {
      if (state) onStatus('live');
    },
    onAuthenticationFailed: () => onStatus('refused'),
    onStatus: ({ status }) => {
      if (status === 'disconnected') onStatus('offline');
    },
  });
  return {
    document,
    provider,
    destroy: () => {
      provider.destroy();
      document.destroy();
    },
  };
};

/** A colour per person, from a fixed set that reads on both skins. */
const COLORS = ['#a1452a', '#2f5f8f', '#9b3550', '#2c6a44', '#6a55d4', '#7a5a00'];
export function colorOf(userId: number): string {
  return COLORS[Math.abs(userId) % COLORS.length] as string;
}

export interface CollaborativeEditorProps {
  ticketId: number;
  field: 'description' | 'environment';
  labelledBy: string;
  describedBy?: string;
  /** The text as the ticket view gave it: shown read-only until the document is live. */
  fallback: PmJson | null;
  /** Who is editing: their name labels their cursor for the others. */
  user: { id: number; name: string };
  mentions?: MentionSource;
  /** Stories and tests open documents their own way. */
  connect?: Connect;
}

export function CollaborativeEditor({
  ticketId,
  field,
  labelledBy,
  describedBy,
  fallback,
  user,
  mentions,
  connect = connectToServer,
}: CollaborativeEditorProps) {
  const t = useT();
  const [status, setStatus] = useState<CollabStatus>('connecting');
  const [session, setSession] = useState<CollabSession | null>(null);
  // Each opening gets its own editor: an editor stays bound to the document it started with.
  const [opening, setOpening] = useState(0);
  const [others, setOthers] = useState<string[]>([]);

  useEffect(() => {
    setStatus('connecting');
    const opened = connect(`ticket/${ticketId}/${field}`, (next) =>
      setStatus((now) => (now === 'refused' ? now : next)),
    );
    setSession(opened);
    setOpening((n) => n + 1);
    return () => {
      opened.destroy();
      setSession(null);
    };
  }, [connect, ticketId, field]);

  // Who else is in the document (NTF-008): everyone in its awareness but this page.
  useEffect(() => {
    const awareness = session?.provider?.awareness;
    if (!awareness) return;
    const read = () => {
      const names: string[] = [];
      for (const [clientId, state] of awareness.getStates()) {
        const name = (state as { user?: { name?: unknown } }).user?.name;
        if (clientId !== awareness.clientID && typeof name === 'string') names.push(name);
      }
      setOthers([...new Set(names)].sort());
    };
    read();
    awareness.on('change', read);
    return () => awareness.off('change', read);
  }, [session]);

  const extensions = useMemo<AnyExtension[] | null>(() => {
    if (!session) return null;
    return [
      Collaboration.configure({ document: session.document }),
      ...(session.provider
        ? [
            CollaborationCaret.configure({
              provider: session.provider,
              user: { name: user.name, color: colorOf(user.id) },
              render: (who: { name?: string; color?: string }) => {
                const caret = document.createElement('span');
                caret.className = 'rt-caret';
                caret.setAttribute('aria-hidden', 'true');
                caret.style.borderColor = who.color ?? 'currentColor';
                const label = document.createElement('span');
                label.className = 'rt-caret-label';
                label.style.backgroundColor = who.color ?? 'currentColor';
                label.textContent = who.name ?? '';
                caret.append(label);
                return caret;
              },
            }),
          ]
        : []),
    ];
  }, [session, user.id, user.name]);

  const note =
    status === 'live'
      ? others.length > 0
        ? t('richtext.collab.others', { names: others.join(', ') })
        : t('richtext.collab.live')
      : status === 'offline'
        ? t('richtext.collab.offline')
        : status === 'refused'
          ? t('richtext.collab.readOnly')
          : t('richtext.collab.connecting');

  const live = (status === 'live' || status === 'offline') && session && extensions;
  return (
    <div className="rt-collab" data-status={status}>
      {live ? (
        <RichTextEditor
          key={`${ticketId}/${field}/${opening}`}
          labelledBy={labelledBy}
          describedBy={describedBy}
          collaboration={extensions}
          mentions={mentions}
          status={
            <p role="status" className="rt-collab-status">
              {note}
            </p>
          }
        />
      ) : (
        <>
          <p role="status" className="rt-collab-status">
            {note}
          </p>
          {fallback ? (
            <RichTextEditor
              key="fallback"
              labelledBy={labelledBy}
              describedBy={describedBy}
              initial={fallback}
              editable={false}
            />
          ) : (
            <p className="page-note">{t('richtext.collab.empty')}</p>
          )}
        </>
      )}
    </div>
  );
}
