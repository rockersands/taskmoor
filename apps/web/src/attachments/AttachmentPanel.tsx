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
import { type Lock, useLockText } from '../locks/useLockText';
import { DangerAction } from '../shell/DangerAction';
import { EmptyState } from '../shell/EmptyState';
import { AttachmentPreview, previewable } from './AttachmentPreview';
import { type Attachment, type AttachmentClient, attachmentClient } from './client';
import { type AttachResult, useFileDropArea } from './FileDrop';
import { formatSize } from './format';
import { MediaImage } from './media';

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
      locked?: Lock | null;
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
 * ticket view (M1-051); a list of cards, so phones never scroll sideways. In the ticket view a
 * drop anywhere on the ticket arrives here (T-162, `FileDrop.tsx`): the panel tells the ticket
 * what a drop does, and comes into view to show the files arriving. A file uploaded from the
 * ticket's text editor comes through the same way (T-120), so it is checked and listed here too.
 */
export function AttachmentPanel({ ticket, client: given }: AttachmentPanelProps) {
  const t = useT();
  const intl = useIntl();
  const lockText = useLockText();
  const client = useMemo(() => given ?? attachmentClient(ticket), [given, ticket]);
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const hintId = useId();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [uploading, setUploading] = useState(0);
  const [message, setMessage] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [previewing, setPreviewing] = useState<Attachment | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLElement>(null);
  /** The ticket around the panel takes the drops, when there is one (T-162). */
  const area = useFileDropArea();

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

  /**
   * Checks the files against the limit and sends each; what was added, and what went wrong. A
   * `quiet` upload (from the ticket's editor, T-120) only lists what arrived: its sender says how
   * it went.
   */
  const upload = async (files: File[], quiet = false): Promise<AttachResult> => {
    if (!loaded) return { added: [], problems: [t('attachments.loading')] };
    if (files.length === 0) return { added: [], problems: [] };
    const problems: string[] = [];
    const accepted = files.filter((file) => {
      if (file.size <= loaded.maxFileSize) return true;
      problems.push(
        t('attachments.tooLarge', { name: file.name, limit: size(loaded.maxFileSize) }),
      );
      return false;
    });
    if (!quiet) {
      setErrors(problems);
      setMessage('');
    }
    if (accepted.length === 0) return { added: [], problems };
    if (!quiet) setUploading(accepted.length);
    const done: Attachment[] = [];
    for (const file of accepted) {
      try {
        const added = await client.upload(file);
        done.push(added);
        setState((s) =>
          s.status === 'loaded' ? { ...s, attachments: [...s.attachments, added] } : s,
        );
      } catch (e) {
        const code = e instanceof ApiError ? e.code : undefined;
        // ASVS 12.1.3: the quota the upload would pass, with what is used and left.
        const quota =
          e instanceof ApiError && code === 'storage_quota_exceeded'
            ? (e.body as { quota?: string; limit?: number; used?: number; available?: number })
            : null;
        problems.push(
          quota
            ? t(
                quota.quota === 'workspace'
                  ? 'attachments.workspaceQuota'
                  : 'attachments.personQuota',
                {
                  name: file.name,
                  limit: size(quota.limit ?? 0),
                  used: size(quota.used ?? 0),
                  available: size(quota.available ?? 0),
                },
              )
            : code === 'file_too_large'
              ? t('attachments.tooLarge', { name: file.name, limit: size(loaded.maxFileSize) })
              : code === 'forbidden'
                ? t('attachments.forbidden')
                : t('attachments.uploadFailed', { name: file.name }),
        );
        if (!quiet) setErrors([...problems]);
      } finally {
        if (!quiet) setUploading((n) => Math.max(0, n - 1));
      }
    }
    if (!quiet) {
      setMessage(done.map((a) => t('attachments.uploaded', { name: a.name })).join(' '));
    }
    return { added: done, problems };
  };

  // What a drop anywhere on the ticket does: these files, sent as chosen ones, in view.
  const latest = useRef(upload);
  latest.current = upload;
  const refusal =
    state.status === 'loading'
      ? t('attachments.loading')
      : state.status === 'failed'
        ? t('attachments.failed')
        : state.canCreate
          ? null
          : state.locked
            ? lockText(state.locked, 'attach')
            : !state.available
              ? t('attachments.unavailable')
              : t('attachments.forbidden');
  const limit = loaded ? size(loaded.maxFileSize) : null;
  useEffect(() => {
    if (!area) return;
    area({
      ready: refusal === null,
      refusal,
      limit,
      attach: (files, options) => {
        const quiet = options?.quiet ?? false;
        if (!quiet) panel.current?.scrollIntoView?.({ block: 'nearest' });
        return latest.current(files, quiet);
      },
    });
  }, [area, refusal, limit]);
  useEffect(() => (area ? () => area(null) : undefined), [area]);

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

  // Asked first (D13); a refusal keeps the question open, the reason above the list.
  const remove = async (a: Attachment) => {
    setErrors([]);
    try {
      await client.remove(a);
    } catch (error) {
      setErrors([t('attachments.deleteFailed', { name: a.name })]);
      throw error;
    }
    setState((s) =>
      s.status === 'loaded' ? { ...s, attachments: s.attachments.filter((x) => x.id !== a.id) } : s,
    );
    setMessage(t('attachments.deleted', { name: a.name }));
    // The file is gone: the list's heading takes the focus.
    heading.current?.focus();
  };

  const when = (iso: string) => intl.formatDate(iso, { dateStyle: 'medium', timeStyle: 'short' });

  const picture = (a: Attachment) => {
    if (a.scan === 'clean' && a.thumbnail) {
      return <MediaImage className="attachment-thumb" src={client.urls.thumbnail(a)} alt="" />;
    }
    if (a.scan === 'clean' && a.kind === 'image' && a.size <= INLINE_IMAGE_BYTES) {
      return <MediaImage className="attachment-thumb" src={client.urls.content(a, true)} alt="" />;
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
      ref={panel}
      aria-labelledby={titleId}
      className="attachment-panel"
      data-dragging={dragging || undefined}
      // Inside a ticket, the whole ticket takes the drops; on its own, the panel does.
      {...(area
        ? {}
        : {
            onDragOver: (event: DragEvent<HTMLElement>) => {
              if (!loaded?.canCreate) return;
              event.preventDefault();
              setDragging(true);
            },
            onDragLeave: () => setDragging(false),
            onDrop,
          })}
      onPaste={onPaste}
    >
      <div className="attachment-header">
        <h2 id={titleId} ref={heading} tabIndex={-1} className="attachment-title">
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
            <div className="attachment-drop" data-tutorial="ticket-attach">
              <p id={hintId} className="attachment-hint">
                {t(area ? 'attachments.dropHintTicket' : 'attachments.dropHint', {
                  limit: size(loaded.maxFileSize),
                })}
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
          ) : loaded.locked ? (
            // The person's own reason first: the status keeps them out whatever the server has.
            <p className="page-note">{lockText(loaded.locked, 'attach')}</p>
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
            <EmptyState compact title={t('attachments.empty')} />
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
                        <DangerAction
                          label={t('attachments.delete')}
                          name={t('attachments.deleteOf', { name: a.name })}
                          outcome={t('attachments.confirmDelete', { name: a.name })}
                          confirmLabel={t('attachments.deleteOf', { name: a.name })}
                          onConfirm={() => remove(a)}
                        />
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
