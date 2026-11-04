import {
  createContext,
  type DragEvent,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { useT } from '../i18n/I18nProvider';

/** What a ticket's attachments panel offers a drop anywhere on its ticket (T-162). */
export interface AttachTarget {
  /** Whether the person may attach files here now. */
  ready: boolean;
  /** Why not, when not: shown on the drop target in place of the invitation. */
  refusal: string | null;
  /** The largest file allowed, in words. */
  limit: string | null;
  /** Takes the dropped files: checks each against the limit and sends it, as a chosen file. */
  attach(files: File[]): void;
}

type Register = (target: AttachTarget | null) => void;

const FileDropContext = createContext<Register | null>(null);
export const FileDropProvider = FileDropContext.Provider;

/**
 * For the attachments panel: whether a drop area around it takes the drops (the whole ticket),
 * and the way to tell it what a drop does. Without one, the panel takes drops on itself.
 */
export function useFileDropArea(): Register | null {
  return useContext(FileDropContext);
}

/**
 * Whether a drag carries files from outside the page. Text, a link or a ticket dragged within the
 * page carries none, and the ticket leaves those to whatever is under them.
 */
const carriesFiles = (event: DragEvent) => {
  const transfer = event.dataTransfer;
  if (!transfer) return false;
  // While over the page only the kinds are known; at the drop, the files themselves.
  if (transfer.types && Array.from(transfer.types).includes('Files')) return true;
  return (transfer.files?.length ?? 0) > 0;
};

/** An arrow into a tray: what a drop does. */
function DropIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="32"
      height="32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 3v11m-4.5-4.5L12 14l4.5-4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}

/**
 * Files dropped anywhere on a ticket go to its attachments (T-162; CORE-021; ADR-114, sections 7
 * and 12). While files are over the ticket, it says so: an outline round the whole ticket and a
 * card in its middle naming the ticket and the size limit, or why nothing can be attached here.
 * A file let go anywhere on the ticket is taken there, so it never opens in the browser in place
 * of the page. A drag of text or of something on the page is left alone. The attachments panel
 * registers what a drop does; the Attach files button and pasting stay the keyboard's way.
 */
export function useTicketFileDrop(ticketKey: string | null) {
  const t = useT();
  const target = useRef<AttachTarget | null>(null);
  const [over, setOver] = useState<AttachTarget | null>(null);
  /** Enter and leave come in pairs for every element crossed: over the ticket while above 0. */
  const depth = useRef(0);
  const register = useCallback<Register>((next) => {
    target.current = next;
    // The panel's state changed while files are over the ticket: the card follows.
    setOver((current) => (current ? next : current));
  }, []);

  const leave = useCallback(() => {
    depth.current = 0;
    setOver(null);
  }, []);

  // A drag that ends elsewhere, or leaves the window, leaves no target behind.
  useEffect(() => {
    if (!over) return;
    window.addEventListener('dragend', leave);
    window.addEventListener('drop', leave);
    return () => {
      window.removeEventListener('dragend', leave);
      window.removeEventListener('drop', leave);
    };
  }, [over, leave]);

  const areaProps = {
    onDragEnter: (event: DragEvent) => {
      if (!carriesFiles(event) || !target.current) return;
      depth.current += 1;
      setOver(target.current);
    },
    onDragOver: (event: DragEvent) => {
      const here = target.current;
      if (!carriesFiles(event) || !here) return;
      // Taken here in any case, so a file let go on the ticket never replaces the page.
      event.preventDefault();
      event.dataTransfer.dropEffect = here.ready ? 'copy' : 'none';
      setOver((current) => current ?? here);
    },
    onDragLeave: (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(null);
    },
    onDrop: (event: DragEvent) => {
      const here = target.current;
      if (!carriesFiles(event) || !here) return;
      event.preventDefault();
      leave();
      if (here.ready) here.attach(Array.from(event.dataTransfer.files));
    },
  };

  const words =
    over && ticketKey
      ? over.ready
        ? t('attachments.dropTarget', { key: ticketKey })
        : (over.refusal ?? t('attachments.forbidden'))
      : '';

  const overlay = (
    <>
      <div className="visually-hidden" aria-live="polite">
        {over && ticketKey
          ? over.ready
            ? t('attachments.dropOver', { key: ticketKey })
            : words
          : ''}
      </div>
      {over && ticketKey && (
        <div className="file-drop-overlay" data-ready={over.ready || undefined} aria-hidden="true">
          <div className="file-drop-card">
            <DropIcon />
            <p className="file-drop-title">{words}</p>
            {over.ready && over.limit && (
              <p className="file-drop-limit">{t('attachments.dropLimit', { limit: over.limit })}</p>
            )}
          </div>
        </div>
      )}
    </>
  );

  return { register, areaProps, overlay, over: over !== null };
}
