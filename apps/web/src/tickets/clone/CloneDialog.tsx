import { useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { ApiError } from '../../api/client';
import { useReason } from '../../bulk/BulkOperationPage';
import type { BulkItem, BulkOperation } from '../../bulk/client';
import { useT } from '../../i18n/I18nProvider';
import type { MessageId } from '../../i18n/messages.en';
import { navigate, routeHref } from '../../routing/router';
import { useLeaveMotion } from '../../shell/motion';
import { TrackSelect } from '../../shell/TrackSelect';
import { useCustomFieldNames } from '../customFieldNames';
import { type CustomFieldNames, customFieldOf, refusedFieldLabel } from '../refusedFields';
import { type CloneClient, type CloneTrack, cloneClient } from './client';

/** The ticket being cloned, as the ticket view knows it. */
export interface CloneSource {
  id: number;
  key: string;
  summary: string;
  track: { id: number; key: string; name: string };
  /** Its hierarchy level: 1 and above may have tickets below them, -1 is a subticket. */
  level: number;
}

export interface CloneDialogProps {
  ticket: CloneSource;
  onClose: () => void;
  client?: CloneClient;
  /** Opens the copy when everything was copied; the page goes to it by default. */
  onCloned?: (key: string) => void;
  /** How often to read progress while the clone runs (ms). */
  pollMs?: number;
}

const SUBTICKET = -1;
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
/** What a copy can be without besides fields, by the name the clone reports it under. */
const LEFT_LABELS: Record<string, MessageId> = {
  attachments: 'clone.attachments',
  links: 'clone.links',
};

const finished = (op: BulkOperation) => op.status === 'done' || op.status === 'cancelled';
const NOTHING_LEFT: string[] = [];

/**
 * Clone and deep clone (M1-124; CORE-023): copies the ticket into its own track or another,
 * with its subtickets, attachments and links unless unticked, and for a ticket that can have
 * tickets below it, everything below it too. The copies are made in the background; the dialog
 * follows them and opens the copy when all went through, or says what did not.
 */
export function CloneDialog({
  ticket,
  onClose,
  client = cloneClient,
  onCloned = (key) => navigate(`#/tickets/${encodeURIComponent(key)}`),
  pollMs = 1000,
}: CloneDialogProps) {
  const t = useT();
  const intl = useIntl();
  const reason = useReason();
  const titleId = useId();
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const boxRef = useLeaveMotion(box);
  const summaryInput = useRef<HTMLInputElement>(null);
  const subticket = ticket.level === SUBTICKET;
  const [tracks, setTracks] = useState<CloneTrack[] | null>(null);
  const [summary, setSummary] = useState(ticket.summary);
  const [track, setTrack] = useState(ticket.track.key);
  const [subtickets, setSubtickets] = useState(true);
  const [descendants, setDescendants] = useState(false);
  const [attachments, setAttachments] = useState(true);
  const [links, setLinks] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [op, setOp] = useState<BulkOperation | null>(null);
  const [first, setFirst] = useState<BulkItem | null>(null);
  const [lost, setLost] = useState(false);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    summaryInput.current?.focus();
    summaryInput.current?.select();
    return () => opener?.focus();
  }, []);

  useEffect(() => {
    let live = true;
    client.tracks().then(
      (list) => live && setTracks(list),
      () => live && setTracks([ticket.track]),
    );
    return () => {
      live = false;
    };
  }, [client, ticket.track]);

  // Progress, read again until the clone finishes; then the result for the ticket itself.
  const opened = useRef(onCloned);
  opened.current = onCloned;
  const opId = op?.id;
  useEffect(() => {
    if (opId === undefined) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const next = await client.progress(opId);
        if (!live) return;
        setOp(next);
        if (!finished(next)) {
          timer = setTimeout(() => void tick(), pollMs);
          return;
        }
        const item = await client.first(opId);
        if (!live) return;
        setFirst(item);
        const key = item?.result?.ticket.key;
        // Straight to the copy when nothing is missing; otherwise the dialog says what is.
        if (key && next.failed === 0 && next.skipped === 0 && item.result?.left.length === 0) {
          opened.current(key);
        }
      } catch {
        if (live) setLost(true);
      }
    };
    timer = setTimeout(() => void tick(), pollMs);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client, opId, pollMs]);

  const start = async () => {
    setProblem(null);
    setStarting(true);
    try {
      const started = await client.start(ticket.id, {
        ...(track !== ticket.track.key ? { track } : {}),
        ...(summary.trim() !== ticket.summary ? { summary: summary.trim() } : {}),
        subtickets,
        descendants,
        attachments,
        links,
      });
      setOp(started);
    } catch (error) {
      setProblem(startProblem(error));
    } finally {
      setStarting(false);
    }
  };

  const startProblem = (error: unknown): string => {
    if (!(error instanceof ApiError)) return t('clone.problem.other');
    const body = error.body as { fields?: Record<string, string>; max?: number } | null;
    if (error.status === 403) return t('clone.problem.forbidden');
    if (error.code === 'track_archived') return t('clone.problem.archived');
    if (error.code === 'too_many_tickets') {
      return t('clone.problem.tooMany', { max: intl.formatNumber(body?.max ?? 0) });
    }
    if (body?.fields?.summary) return t('clone.problem.summary');
    if (body?.fields?.track === 'subticket') return t('clone.problem.subticket');
    return t('clone.problem.other');
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab' || !box.current) return;
    const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const firstItem = items[0];
    const last = items.at(-1);
    if (!firstItem || !last) return;
    if (event.shiftKey && document.activeElement === firstItem) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      firstItem.focus();
    }
  };

  // The custom fields the copy was made without, by their names (T-352): the catalogue of the
  // track the copy went to first, then the original's for a field that does not apply there (the
  // copy left it out for that reason, so the target's catalogue does not list it). Neither is
  // read until the clone has left something out.
  const targetId = op === null ? null : (tracks?.find((tr) => tr.key === track) ?? ticket.track).id;
  const sourceId = op === null ? null : ticket.track.id;
  const nameInTarget = useCustomFieldNames(targetId, client.fieldNames);
  const nameInSource = useCustomFieldNames(sourceId, client.fieldNames);
  /** The names, for the result they were read for: until then the list waits, as a refusal does. */
  const [named, setNamed] = useState<{ keys: string[]; names: CustomFieldNames } | null>(null);
  const leftKeys = first?.result?.left ?? NOTHING_LEFT;
  useEffect(() => {
    if (leftKeys.length === 0) return;
    nameInTarget(leftKeys, (inTarget) => {
      const unnamed = leftKeys.filter((key) => {
        const field = customFieldOf(key);
        return field !== null && !inTarget.has(field);
      });
      if (unnamed.length === 0 || targetId === sourceId) {
        setNamed({ keys: leftKeys, names: inTarget });
        return;
      }
      nameInSource(unnamed, (inSource) =>
        setNamed({ keys: leftKeys, names: new Map([...inSource, ...inTarget]) }),
      );
    });
  }, [leftKeys, nameInTarget, nameInSource, targetId, sourceId]);
  const fieldNames = named?.keys === leftKeys ? named.names : null;

  const number = (n: number) => intl.formatNumber(n);
  const copyKey = first?.result?.ticket.key ?? null;
  // Each by its label, never the key the clone reports it under (T-292); one this client cannot
  // name is said as something more, and a custom field no catalogue names (a read refused or
  // failed, or a field since deleted) as 'a custom field'.
  const left = (fieldNames === null ? NOTHING_LEFT : leftKeys).map((key) => {
    const own = Object.hasOwn(LEFT_LABELS, key) ? LEFT_LABELS[key] : undefined;
    if (own) return t(own);
    return (
      refusedFieldLabel(t, key, fieldNames ?? undefined, 'clone.customField') ??
      t('clone.otherValue')
    );
  });

  return (
    <div className="ticket-dialog-backdrop">
      <div
        ref={boxRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="ticket-dialog clone-dialog"
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId} className="ticket-section-title">
          {t('clone.title', { key: ticket.key })}
        </h2>
        {op === null ? (
          <form
            className="clone-form"
            onSubmit={(event) => {
              event.preventDefault();
              void start();
            }}
          >
            <div className="form-field">
              <label htmlFor={`${id}-summary`}>{t('clone.summary')}</label>
              <input
                ref={summaryInput}
                id={`${id}-summary`}
                type="text"
                value={summary}
                maxLength={255}
                onChange={(event) => setSummary(event.target.value)}
              />
            </div>
            <div className="form-field">
              <label htmlFor={`${id}-track`}>{t('clone.track')}</label>
              <TrackSelect
                id={`${id}-track`}
                tracks={tracks ?? [ticket.track]}
                value={track}
                disabled={subticket || tracks === null}
                aria-describedby={subticket ? `${id}-track-hint` : undefined}
                label={(tr) => t('clone.trackOption', { key: tr.key, name: tr.name })}
                onChange={setTrack}
              />
              {subticket && (
                <p id={`${id}-track-hint`} className="form-hint">
                  {t('clone.subticketHint')}
                </p>
              )}
            </div>
            <fieldset className="clone-options">
              <legend>{t('clone.with')}</legend>
              {!subticket && (
                <div className="form-field form-field-inline">
                  <input
                    id={`${id}-subtickets`}
                    type="checkbox"
                    checked={subtickets}
                    onChange={(event) => setSubtickets(event.target.checked)}
                  />
                  <label htmlFor={`${id}-subtickets`}>{t('clone.subtickets')}</label>
                </div>
              )}
              {ticket.level > 0 && (
                <div className="form-field form-field-inline">
                  <input
                    id={`${id}-descendants`}
                    type="checkbox"
                    checked={descendants}
                    onChange={(event) => setDescendants(event.target.checked)}
                  />
                  <label htmlFor={`${id}-descendants`}>{t('clone.descendants')}</label>
                </div>
              )}
              <div className="form-field form-field-inline">
                <input
                  id={`${id}-attachments`}
                  type="checkbox"
                  checked={attachments}
                  onChange={(event) => setAttachments(event.target.checked)}
                />
                <label htmlFor={`${id}-attachments`}>{t('clone.attachments')}</label>
              </div>
              <div className="form-field form-field-inline">
                <input
                  id={`${id}-links`}
                  type="checkbox"
                  checked={links}
                  onChange={(event) => setLinks(event.target.checked)}
                />
                <label htmlFor={`${id}-links`}>{t('clone.links')}</label>
              </div>
            </fieldset>
            <p className="form-hint">{t('clone.copiesHint')}</p>
            {problem && (
              <p role="alert" className="form-error">
                {problem}
              </p>
            )}
            <div className="form-actions">
              <button
                type="submit"
                className="button-primary"
                disabled={starting || summary.trim() === ''}
              >
                {t('clone.submit')}
              </button>
              <button type="button" className="button-secondary" onClick={onClose}>
                {t('ticketView.cancel')}
              </button>
            </div>
          </form>
        ) : (
          <div className="clone-progress">
            <p role="status" className="clone-status">
              {finished(op)
                ? t('clone.finished', { done: number(op.succeeded), total: number(op.total) })
                : t('clone.running')}
            </p>
            <label htmlFor={`${id}-progress`} className="form-hint">
              {t('clone.progress', {
                done: number(op.total - op.pending),
                total: number(op.total),
              })}
            </label>
            <progress id={`${id}-progress`} max={op.total} value={op.total - op.pending} />
            {first && first.outcome !== 'done' && (
              <p role="alert" className="form-error">
                {t('clone.notCopied', { reason: reason(first.error) })}
              </p>
            )}
            {left.length > 0 && (
              <p className="form-hint">{t('clone.left', { fields: left.join(', ') })}</p>
            )}
            {lost && (
              <p role="alert" className="form-error">
                {t('clone.problem.progress')}
              </p>
            )}
            <div className="form-actions">
              {copyKey && (
                <a
                  className="button-primary"
                  href={routeHref(`#/tickets/${encodeURIComponent(copyKey)}`)}
                  onClick={onClose}
                >
                  {t('clone.open', { key: copyKey })}
                </a>
              )}
              {(finished(op) || lost) && (
                <a className="button-secondary" href={routeHref(`#/bulk/${op.id}`)}>
                  {t('clone.details')}
                </a>
              )}
              <button type="button" className="button-secondary" onClick={onClose}>
                {t('ticketView.close')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
