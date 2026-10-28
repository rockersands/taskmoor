import {
  type ClipboardEvent,
  type DragEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useIntl } from 'react-intl';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { AttachmentPreview, previewable } from './AttachmentPreview';
import { type Attachment, type AttachmentClient, attachmentClient } from './client';
import { formatSize } from './format';

export interface AttachmentPanelProps {
  /** The ticket, by id or key. */
  ticket: number | string;
  /** Stories and tests pass their own endpoints; the panel calls the backend otherwise. */
  client?: AttachmentClient;
}

type State =
  | { status: 'loading' }
  | { status: 'failed' }
  | {
      status: 'loaded';
      attachments: Attachment[];
      maxFileSize: number;
      canCreate: boolean;
      available: boolean;
    };

/** Images small enough to show from the file itself when there is no thumbnail. */
const INLINE_IMAGE_BYTES = 5 * 1024 * 1024;

function FileGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true" focusable="false">
      <path
        d="M6 2h8l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm7 1.5V8h4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * A ticket's attachments (M1-016, CORE-021): the files with their size, uploader and date, a
 * preview of images, PDF, video, text and ZIP contents, download one or all, and delete where
 * the viewer may. Files arrive by the file chooser, by dropping them on the panel or by pasting
 * them into it; each is checked against the size limit before it is sent. Built to sit in the
 * ticket view (M1-051); a list of cards, so phones never scroll sideways.
 */
export function AttachmentPanel({ ticket, client: given }: AttachmentPanelProps) {
  const t = useT();
  const intl = useIntl();
  const client = useMemo(() => given ?? attachmentClient(ticket), [given, ticket]);
  const titleId = useId();
  const hintId = useId();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [uploading, setUploading] = useState(0);
  const [message, setMessage] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [confirming, setConfirming] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState<Attachment | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const list = await client.list();
      setState({ status: 'loaded', ...list });
    } catch {
      setState({ status: 'failed' });
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const size = (bytes: number) => formatSize(t, intl, bytes);
  const loaded = state.status === 'loaded' ? state : null;

  const upload = async (files: File[]) => {
    if (!loaded || files.length === 0) return;
    const problems: string[] = [];
    const accepted = files.filter((file) => {
      if (file.size <= loaded.maxFileSize) return true;
      problems.push(
        t('attachments.tooLarge', { name: file.name, limit: size(loaded.maxFileSize) }),
      );
      return false;
    });
    setErrors(problems);
    setMessage('');
    if (accepted.length === 0) return;
    setUploading(accepted.length);
    const done: string[] = [];
    for (const file of accepted) {
      try {
        const added = await client.upload(file);
        done.push(added.name);
        setState((s) =>
          s.status === 'loaded' ? { ...s, attachments: [...s.attachments, added] } : s,
        );
      } catch (e) {
        const code = e instanceof ApiError ? e.code : undefined;
        problems.push(
          code === 'file_too_large'
            ? t('attachments.tooLarge', { name: file.name, limit: size(loaded.maxFileSize) })
            : code === 'forbidden'
              ? t('attachments.forbidden')
              : t('attachments.uploadFailed', { name: file.name }),
        );
        setErrors([...problems]);
      } finally {
        setUploading((n) => Math.max(0, n - 1));
      }
    }
    setMessage(done.map((name) => t('attachments.uploaded', { name })).join(' '));
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    if (!loaded?.canCreate) return;
    void upload([...event.dataTransfer.files]);
  };

  const onPaste = (event: ClipboardEvent<HTMLElement>) => {
    if (!loaded?.canCreate) return;
    const files = [...event.clipboardData.files];
    if (files.length === 0) return;
    event.preventDefault();
    // Pasted screenshots arrive as "image.png"; give them a name of their own.
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    void upload(
      files.map((file, i) =>
        /^image\.\w+$/.test(file.name)
          ? new File(
              [file],
              `${t('attachments.pastedName', { time: `${stamp}${i ? `-${i + 1}` : ''}` })}${file.name.slice(5)}`,
              { type: file.type },
            )
          : file,
      ),
    );
  };

  const remove = async (a: Attachment) => {
    setConfirming(null);
    setErrors([]);
    try {
      await client.remove(a);
      setState((s) =>
        s.status === 'loaded'
          ? { ...s, attachments: s.attachments.filter((x) => x.id !== a.id) }
          : s,
      );
      setMessage(t('attachments.deleted', { name: a.name }));
    } catch {
      setErrors([t('attachments.deleteFailed', { name: a.name })]);
    }
  };

  const when = (iso: string) => intl.formatDate(iso, { dateStyle: 'medium', timeStyle: 'short' });

  const picture = (a: Attachment) => {
    if (a.scan === 'clean' && a.thumbnail) {
      return <img className="attachment-thumb" src={client.urls.thumbnail(a)} alt="" />;
    }
    if (a.scan === 'clean' && a.kind === 'image' && a.size <= INLINE_IMAGE_BYTES) {
      return <img className="attachment-thumb" src={client.urls.content(a, true)} alt="" />;
    }
    return (
      <span className="attachment-thumb attachment-glyph">
        <FileGlyph />
      </span>
    );
  };

  const scanNote = (a: Attachment) =>
    a.scan === 'pending'
      ? t('attachments.scanPending')
      : a.scan === 'infected'
        ? t('attachments.scanInfected')
        : a.scan === 'failed'
          ? t('attachments.scanFailed')
          : null;

  return (
    <section
      aria-labelledby={titleId}
      className="attachment-panel"
      data-dragging={dragging || undefined}
      onDragOver={(event) => {
        if (!loaded?.canCreate) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      onPaste={onPaste}
    >
      <div className="attachment-header">
        <h2 id={titleId} className="attachment-title">
          {t('attachments.title')}
        </h2>
        {loaded && (
          <span className="attachment-count">
            {t('attachments.count', { count: loaded.attachments.length })}
          </span>
        )}
        {loaded?.attachments.some((a) => a.scan === 'clean') && (
          <a className="button-secondary attachment-action" href={client.urls.archive()} download>
            {t('attachments.downloadAll')}
          </a>
        )}
      </div>

      {state.status === 'loading' && (
        <p role="status" className="page-note">
          {t('attachments.loading')}
        </p>
      )}
      {state.status === 'failed' && (
        <p role="alert" className="form-error">
          {t('attachments.failed')}
        </p>
      )}

      {loaded && (
        <>
          {loaded.canCreate ? (
            <div className="attachment-drop">
              <p id={hintId} className="attachment-hint">
                {t('attachments.dropHint', { limit: size(loaded.maxFileSize) })}
              </p>
              <label className="button-primary attachment-choose">
                {t('attachments.attach')}
                <input
                  ref={input}
                  aria-describedby={hintId}
                  className="visually-hidden"
                  type="file"
                  multiple
                  disabled={uploading > 0}
                  onChange={(event) => {
                    const files = [...(event.target.files ?? [])];
                    event.target.value = '';
                    void upload(files);
                  }}
                />
              </label>
            </div>
          ) : !loaded.available ? (
            <p className="page-note">{t('attachments.unavailable')}</p>
          ) : (
            <p className="page-note">{t('attachments.dropHintReadOnly')}</p>
          )}

          <p role="status" className="form-status">
            {uploading > 0 ? t('attachments.uploading', { count: uploading }) : message}
          </p>
          {errors.length > 0 && (
            <div role="alert" className="form-error">
              {errors.map((e) => (
                <p key={e}>{e}</p>
              ))}
            </div>
          )}

          {loaded.attachments.length === 0 ? (
            <p className="page-note">{t('attachments.empty')}</p>
          ) : (
            <ul className="attachment-list">
              {loaded.attachments.map((a) => {
                const note = scanNote(a);
                return (
                  <li key={a.id} className="attachment-item">
                    {picture(a)}
                    <div className="attachment-main">
                      {a.scan === 'clean' ? (
                        <a
                          className="attachment-name"
                          href={client.urls.content(a)}
                          download
                          aria-label={t('attachments.download', { name: a.name })}
                        >
                          {a.name}
                        </a>
                      ) : (
                        <span className="attachment-name">{a.name}</span>
                      )}
                      <p className="attachment-meta">
                        {a.author
                          ? t('attachments.meta', {
                              size: size(a.size),
                              author: a.author.name,
                              date: when(a.createdAt),
                            })
                          : t('attachments.metaNoAuthor', {
                              size: size(a.size),
                              date: when(a.createdAt),
                            })}
                      </p>
                      {note && <p className="attachment-warning">{note}</p>}
                    </div>
                    <div className="attachment-actions">
                      {confirming === a.id ? (
                        <>
                          <span className="attachment-confirm">
                            {t('attachments.confirmDelete', { name: a.name })}
                          </span>
                          <button
                            type="button"
                            className="button-danger attachment-action"
                            onClick={() => void remove(a)}
                          >
                            {t('attachments.confirmYes')}
                          </button>
                          <button
                            type="button"
                            className="button-secondary attachment-action"
                            onClick={() => setConfirming(null)}
                          >
                            {t('attachments.confirmNo')}
                          </button>
                        </>
                      ) : (
                        <>
                          {previewable(a) && (
                            <button
                              type="button"
                              className="button-secondary attachment-action"
                              aria-label={t('attachments.previewOf', { name: a.name })}
                              onClick={() => setPreviewing(a)}
                            >
                              {t('attachments.preview')}
                            </button>
                          )}
                          {a.canDelete && (
                            <button
                              type="button"
                              className="button-secondary attachment-action"
                              aria-label={t('attachments.deleteOf', { name: a.name })}
                              onClick={() => setConfirming(a.id)}
                            >
                              {t('attachments.delete')}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      {previewing && (
        <AttachmentPreview
          attachment={previewing}
          client={client}
          onClose={() => setPreviewing(null)}
        />
      )}
    </section>
  );
}
