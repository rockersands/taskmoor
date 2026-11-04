import { createContext, useContext } from 'react';
import type { PickedTicket } from '../tickets/tools/client';

/** A file of the ticket, as a document's attachment reference finds it by name. */
export interface EditorAttachment {
  name: string;
  image: boolean;
  /** Where the browser opens it; the server checks the reader's rights on the way. */
  href: string;
  thumbnail: string | null;
  /**
   * What tells it from another file of the same name (TT-4): its SHA-256, a reference holding
   * its first digits; its size, when it came and who added it, for the picker to show.
   */
  sha256?: string;
  size?: number;
  createdAt?: string;
  author?: string | null;
}

/**
 * The file an attachment reference shows (ADR-120): of the files with its name, the one whose
 * SHA-256 starts with the reference's digest, else the first listed (the oldest), else none.
 */
export function attachmentFor(
  files: readonly EditorAttachment[],
  name: string,
  digest: string | null,
): EditorAttachment | undefined {
  const named = files.filter((file) => file.name === name);
  return (digest ? named.find((file) => file.sha256?.startsWith(digest)) : undefined) ?? named[0];
}

/**
 * What the page around an editor offers its blocks (NTF-013, NTF-014). Without a ticket around it,
 * such as in the create form, the menu leaves out what needs one.
 */
export interface EditorTools {
  /** The ticket's files; `fresh` reads them again rather than the page's last answer. */
  attachments?: (fresh?: boolean) => Promise<EditorAttachment[]>;
  /** Tickets for what was typed, through search: only what the person may see. */
  tickets?: (typed: string) => Promise<PickedTicket[]>;
}

const EditorToolsContext = createContext<EditorTools>({});
export const EditorToolsProvider = EditorToolsContext.Provider;
export const useEditorTools = () => useContext(EditorToolsContext);

/**
 * Shows an attachment reference: its name as a link to the file when the ticket has one of that
 * name, with a small picture for an image. The document holds only the name and, for one of two
 * files of a name, the first digits of its SHA-256, so a name the ticket does not have, or a
 * reader without the file, shows as its text.
 */
export function showAttachment(
  element: HTMLElement,
  name: string,
  image: boolean,
  tools: EditorTools,
  digest: string | null = null,
): void {
  element.textContent = name;
  element.classList.add('rt-attachment');
  void tools
    .attachments?.()
    .then((files) => {
      const file = attachmentFor(files, name, digest);
      if (!file || !element.isConnected) return;
      const link = element.ownerDocument.createElement('a');
      link.href = file.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer nofollow';
      if (image && file.thumbnail) {
        const picture = element.ownerDocument.createElement('img');
        picture.src = file.thumbnail;
        picture.alt = name;
        picture.loading = 'lazy';
        link.append(picture);
      } else {
        link.textContent = name;
      }
      element.replaceChildren(link);
    })
    .catch(() => {});
}
