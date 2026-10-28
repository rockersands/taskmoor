import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import type * as Y from 'yjs';
import type { PmJson } from './convert';
import { schema } from './schema';

/**
 * The collaboration layer's view of a document (ADR-014, M1-017): one Yjs document per rich
 * text field, holding the ProseMirror tree in the XML fragment the editor binds to.
 */

/** The fragment Tiptap's Collaboration extension binds to by default. */
export const COLLAB_FRAGMENT = 'default';

/** The empty document: one empty paragraph. */
export const EMPTY_DOC: PmJson = { type: 'doc', content: [{ type: 'paragraph' }] };

/**
 * Makes the Yjs document hold `doc` (null for an empty one). The fragment is updated in place
 * with the smallest change, so people editing it keep their cursors; `origin` marks the
 * transaction for whoever listens to updates.
 */
export function writeDocToYDoc(ydoc: Y.Doc, doc: PmJson | null, origin?: unknown): void {
  const fragment = ydoc.getXmlFragment(COLLAB_FRAGMENT);
  ydoc.transact(() => {
    prosemirrorJSONToYXmlFragment(schema, doc ?? EMPTY_DOC, fragment);
  }, origin);
}

/**
 * The document a Yjs document holds, read through the shared schema: nodes the schema refuses
 * (a client sending something no editor makes) are left out.
 */
export function docFromYDoc(ydoc: Y.Doc): PmJson {
  const node = yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment(COLLAB_FRAGMENT), schema);
  return node.toJSON() as PmJson;
}
