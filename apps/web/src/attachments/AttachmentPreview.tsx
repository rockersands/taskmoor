import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import type { Attachment, AttachmentClient, ZipListing } from './client';
import { formatSize } from './format';
import { useMediaUrl } from './media';

export interface AttachmentPreviewProps {
  attachment: Attachment;
  client: AttachmentClient;
  onClose: () => void;
}

type Loaded =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'text'; text: string; truncated: boolean }
  | { status: 'zip'; listing: ZipListing }
  | { status: 'ready' };

/** Whether the panel offers a preview of this file. */
export function previewable(a: Attachment): boolean {
  return a.scan === 'clean' && a.kind !== 'other';
}

/**
 * The preview of one attachment, in a modal dialog (CORE-021): images, PDF and video from the
 * file itself, the start of a text file, a ZIP file's entries with a download for each.
 * Escape and the close button close it; focus stays inside while it is open and returns to
 * where it was.
 */
export function AttachmentPreview({ attachment: a, client, onClose }: AttachmentPreviewProps) {
  const t = useT();
  const intl = useIntl();
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [loaded, setLoaded] = useState<Loaded>(
    a.kind === 'text' || a.kind === 'zip' ? { status: 'loading' } : { status: 'ready' },
  );

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    let live = true;
    if (a.kind === 'text') {
      client.text(a).then(
        (r) => live && setLoaded({ status: 'text', ...r }),
        () => live && setLoaded({ status: 'failed' }),
      );
    } else if (a.kind === 'zip') {
      client.entries(a).then(
        (listing) => live && setLoaded({ status: 'zip', listing }),
        () => live && setLoaded({ status: 'failed' }),
      );
    }
    return () => {
      live = false;
    };
  }, [a, client]);

  // Escape closes even once focus has left the dialog: Safari does not focus a link it follows,
  // such as a ZIP entry's download (M1-132). Inside, onKeyDown below handles it first.
  useEffect(() => {
    const onDocumentKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onDocumentKey);
    return () => document.removeEventListener('keydown', onDocumentKey);
  }, [onClose]);

  // Escape closes; Tab cycles within the dialog.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !dialog.current) return;
    const focusable = [
      ...dialog.current.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), video, iframe, [tabindex]:not([tabindex="-1"])',
      ),
    ];
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const inline = useMediaUrl(client.urls.content(a, true));
  const media = a.kind === 'image' || a.kind === 'pdf' || a.kind === 'video';
  let body: React.ReactNode;
  // A file fetched with the access token (M1-107) shows once it has arrived.
  if (loaded.status === 'loading' || (media && inline === null)) {
    body = (
      <p role="status" className="page-note">
        {t('attachments.previewLoading')}
      </p>
    );
  } else if (loaded.status === 'failed') {
    body = (
      <p role="alert" className="form-error">
        {t('attachments.previewFailed')}
      </p>
    );
  } else if (a.kind === 'image') {
    body = <img className="attachment-preview-image" src={inline ?? undefined} alt={a.name} />;
  } else if (a.kind === 'pdf') {
    body = <iframe className="attachment-preview-frame" src={inline ?? undefined} title={a.name} />;
  } else if (a.kind === 'video') {
    body = (
      // biome-ignore lint/a11y/useMediaCaption: attachments come without caption tracks
      <video
        className="attachment-preview-video"
        src={inline ?? undefined}
        controls
        aria-label={a.name}
      />
    );
  } else if (loaded.status === 'text') {
    body = (
      <>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a long text scrolls by keyboard */}
        <pre className="attachment-preview-text" tabIndex={0}>
          {loaded.text}
        </pre>
        {loaded.truncated && <p className="page-note">{t('attachments.textTruncated')}</p>}
      </>
    );
  } else if (loaded.status === 'zip') {
    const { listing } = loaded;
    body = (
      <>
        <h3 className="attachment-zip-title">{t('attachments.zipContents')}</h3>
        <p className="page-note">
          {t('attachments.zipSummary', {
            total: listing.total,
            truncated: String(listing.truncated),
            shown: listing.entries.length,
          })}
        </p>
        <ul className="attachment-zip-list">
          {listing.entries.map((entry) => (
            <li key={entry.index} className="attachment-zip-entry">
              {entry.directory || entry.encrypted ? (
                <span className="attachment-zip-path">{entry.path}</span>
              ) : (
                <a
                  className="attachment-zip-path"
                  href={client.urls.entry(a, entry.index)}
                  download
                  aria-label={t('attachments.downloadEntry', { path: entry.path })}
                >
                  {entry.path}
                </a>
              )}
              <span className="attachment-meta">
                {entry.directory
                  ? t('attachments.zipFolder')
                  : entry.encrypted
                    ? t('attachments.zipEncrypted')
                    : formatSize(t, intl, entry.size)}
                {entry.unsafe && (
                  <span className="attachment-warning"> {t('attachments.zipUnsafe')}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </>
    );
  }

  return (
    <div className="attachment-preview-backdrop">
      <div
        ref={dialog}
        className="attachment-preview"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <div className="attachment-preview-header">
          <h2 id={titleId} className="attachment-preview-title">
            {a.name}
          </h2>
          <a className="button-secondary attachment-action" href={client.urls.content(a)} download>
            {t('attachments.download', { name: a.name })}
          </a>
          <button
            ref={close}
            type="button"
            className="button-secondary attachment-action"
            onClick={onClose}
          >
            {t('attachments.close')}
          </button>
        </div>
        <div className="attachment-preview-body">{body}</div>
      </div>
    </div>
  );
}
