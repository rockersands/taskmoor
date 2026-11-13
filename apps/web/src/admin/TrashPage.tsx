import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { ApiError, api } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { useSession } from '../session/SessionProvider';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';

/** A ticket in the trash, as `GET /api/v1/trash` shows it (CORE-025 (3)). */
export interface TrashedTicket {
  id: number;
  key: string;
  summary: string;
  track: { id: number; key: string; name: string };
  trash: {
    deletedAt: string;
    deletedBy: { id: number; name: string } | null;
    purgeAfter: string;
    deletedWith: { id: number; key: string } | null;
  };
}

/** A track in the trash, as `GET /api/v1/trash/tracks` shows it (M1-101). */
export interface TrashedTrack {
  id: number;
  key: string;
  name: string;
  ticketCount: number;
  trash: {
    deletedAt: string;
    deletedBy: { id: number; name: string } | null;
    purgeAfter: string;
    purging: boolean;
  };
}

/** One page of a list and the cursor of the next. */
export interface TrashListPage<T> {
  items: T[];
  next: string | null;
}

/** The endpoints the page uses. Stories and some tests pass their own. */
export interface TrashClient {
  listTickets: (after?: string) => Promise<TrashListPage<TrashedTicket>>;
  /** Null when the caller may not see tracks in the trash (configuration administrators may). */
  listTracks: () => Promise<TrashedTrack[] | null>;
  restoreTicket: (id: number) => Promise<void>;
  restoreTrack: (id: number) => Promise<void>;
  loadRetention: () => Promise<number>;
  saveRetention: (days: number) => Promise<number>;
}

const forbidden = (e: unknown) => e instanceof ApiError && (e.status === 403 || e.status === 401);

export const trashClient: TrashClient = {
  listTickets: async (after) => {
    const page = await api<{ tickets: TrashedTicket[]; next: string | null }>(
      `/trash?limit=50${after ? `&after=${encodeURIComponent(after)}` : ''}`,
    );
    return { items: page.tickets, next: page.next };
  },
  listTracks: async () => {
    try {
      return (await api<{ tracks: TrashedTrack[] }>('/trash/tracks')).tracks;
    } catch (e) {
      if (forbidden(e)) return null;
      throw e;
    }
  },
  restoreTicket: async (id) => {
    await api(`/tickets/${id}/restore`, { method: 'POST' });
  },
  restoreTrack: async (id) => {
    await api(`/tracks/${id}/undelete`, { method: 'POST' });
  },
  loadRetention: async () =>
    (await api<{ retentionDays: number }>('/admin/trash-policy')).retentionDays,
  saveRetention: async (days) =>
    (
      await api<{ retentionDays: number }>('/admin/trash-policy', {
        method: 'PUT',
        body: { retentionDays: days },
      })
    ).retentionDays,
};

/** Why a restore was refused, by the backend's error code. */
const REFUSALS: Record<string, MessageId> = {
  parent_in_trash: 'admin.trash.parentInTrash',
  deleted_with_parent: 'admin.trash.deletedWithParent',
  track_archived: 'admin.trash.trackArchived',
  purging: 'admin.trash.purging',
};

type State =
  | { status: 'loading' }
  | {
      status: 'loaded';
      tickets: TrashedTicket[];
      next: string | null;
      tracks: TrashedTrack[] | null;
      retention: number | null;
    }
  | { status: 'failed' };

export interface TrashPageProps {
  /** Stories and tests pass their own endpoints; the page calls the backend otherwise. */
  client?: TrashClient;
}

/**
 * The trash (#/admin/trash, M1-101, CORE-025 (3)): deleted tickets the viewer may restore and,
 * for administrators, deleted tracks, each with when it goes for good; a restore puts it back
 * as it was. Site administrators also set how many days the trash keeps things. Lists of
 * cards, so phones never scroll sideways.
 */
export function TrashPage({ client = trashClient }: TrashPageProps) {
  const t = useT();
  const intl = useIntl();
  const { session } = useSession();
  const siteAdmin = session.status === 'signed-in' && session.user.isSiteAdmin;
  const titleId = useId();
  const ticketsId = useId();
  const tracksId = useId();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const [tickets, tracks, retention] = await Promise.all([
        client.listTickets(),
        client.listTracks(),
        siteAdmin ? client.loadRetention().catch(() => null) : Promise.resolve(null),
      ]);
      setState({
        status: 'loaded',
        tickets: tickets.items,
        next: tickets.next,
        tracks,
        retention,
      });
    } catch {
      setState({ status: 'failed' });
    }
  }, [client, siteAdmin]);

  useEffect(() => {
    void load();
  }, [load]);

  const when = (iso: string) => intl.formatDate(iso, { dateStyle: 'medium', timeStyle: 'short' });
  const day = (iso: string) => intl.formatDate(iso, { dateStyle: 'medium' });

  const refusal = (e: unknown) => {
    const id = e instanceof ApiError && e.code ? REFUSALS[e.code] : undefined;
    return t(id ?? 'admin.trash.restoreFailed');
  };

  const restoreTicket = async (ticket: TrashedTicket) => {
    setBusy(`ticket-${ticket.id}`);
    setError(null);
    setMessage('');
    try {
      await client.restoreTicket(ticket.id);
      // Its subtickets come back with it.
      setState((s) =>
        s.status === 'loaded'
          ? {
              ...s,
              tickets: s.tickets.filter(
                (k) => k.id !== ticket.id && k.trash.deletedWith?.id !== ticket.id,
              ),
            }
          : s,
      );
      setMessage(t('admin.trash.ticketRestored', { key: ticket.key }));
    } catch (e) {
      setError(refusal(e));
    } finally {
      setBusy(null);
    }
  };

  const restoreTrack = async (track: TrashedTrack) => {
    setBusy(`track-${track.id}`);
    setError(null);
    setMessage('');
    try {
      await client.restoreTrack(track.id);
      setState((s) =>
        s.status === 'loaded' && s.tracks
          ? { ...s, tracks: s.tracks.filter((k) => k.id !== track.id) }
          : s,
      );
      setMessage(t('admin.trash.trackRestored', { key: track.key }));
    } catch (e) {
      setError(refusal(e));
    } finally {
      setBusy(null);
    }
  };

  const more = async () => {
    if (state.status !== 'loaded' || !state.next) return;
    setBusy('more');
    try {
      const page = await client.listTickets(state.next);
      setState((s) =>
        s.status === 'loaded'
          ? { ...s, tickets: [...s.tickets, ...page.items], next: page.next }
          : s,
      );
    } catch {
      setError(t('admin.trash.failed'));
    } finally {
      setBusy(null);
    }
  };

  const by = (who: { name: string } | null) =>
    who ? t('admin.trash.deletedBy', { name: who.name }) : t('admin.trash.deletedBySystem');

  return (
    <section aria-labelledby={titleId} className="page trash-page">
      <PageHeader
        titleId={titleId}
        title={t('admin.trash.title')}
        purpose={
          state.status !== 'loaded'
            ? t('purpose.trash')
            : state.retention === null
              ? t('admin.trash.intro')
              : t('admin.trash.introDays', { days: state.retention })
        }
        about={t('admin.trash.about')}
      />
      {state.status === 'loading' && (
        <p role="status" className="page-note">
          {t('admin.trash.loading')}
        </p>
      )}
      {state.status === 'failed' && (
        <p role="alert" className="form-error">
          {t('admin.trash.failed')}
        </p>
      )}
      {state.status === 'loaded' && (
        <>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <p role="status" className="form-status">
            {message}
          </p>
          <div className="trash-sections">
            <section aria-labelledby={ticketsId} className="glass-card facts">
              <h2 id={ticketsId} className="facts-title">
                {t('admin.trash.tickets')}
              </h2>
              {state.tickets.length === 0 ? (
                <EmptyState compact title={t('admin.trash.noTickets')}>
                  {t('empty.trash.tickets')}
                </EmptyState>
              ) : (
                <ul className="trash-list">
                  {state.tickets.map((ticket) => (
                    <li key={ticket.id} className="trash-item">
                      <div className="trash-main">
                        <p className="trash-name">
                          {t('admin.trash.ticketName', {
                            key: ticket.key,
                            summary: ticket.summary,
                          })}
                        </p>
                        <p className="trash-meta">
                          <span>
                            {t('admin.trash.deletedAt', { at: when(ticket.trash.deletedAt) })}{' '}
                            {by(ticket.trash.deletedBy)}
                          </span>
                          <span>
                            {t('admin.trash.purgeAfter', { day: day(ticket.trash.purgeAfter) })}
                          </span>
                        </p>
                      </div>
                      {ticket.trash.deletedWith ? (
                        <p className="trash-meta">
                          {t('admin.trash.comesBackWith', { key: ticket.trash.deletedWith.key })}
                        </p>
                      ) : (
                        <button
                          type="button"
                          className="button-secondary"
                          aria-label={t('admin.trash.restoreTicket', { key: ticket.key })}
                          disabled={busy !== null}
                          onClick={() => void restoreTicket(ticket)}
                        >
                          {t('admin.trash.restore')}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {state.next && (
                <div className="form-actions">
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={busy !== null}
                    onClick={() => void more()}
                  >
                    {t('admin.trash.more')}
                  </button>
                </div>
              )}
            </section>
            {state.tracks && (
              <section aria-labelledby={tracksId} className="glass-card facts">
                <h2 id={tracksId} className="facts-title">
                  {t('admin.trash.tracks')}
                </h2>
                {state.tracks.length === 0 ? (
                  <EmptyState compact title={t('admin.trash.noTracks')}>
                    {t('empty.trash.tracks')}
                  </EmptyState>
                ) : (
                  <ul className="trash-list">
                    {state.tracks.map((track) => (
                      <li key={track.id} className="trash-item">
                        <div className="trash-main">
                          <p className="trash-name">
                            {t('admin.trash.trackName', {
                              key: track.key,
                              name: track.name,
                              count: track.ticketCount,
                            })}
                          </p>
                          <p className="trash-meta">
                            <span>
                              {t('admin.trash.deletedAt', { at: when(track.trash.deletedAt) })}{' '}
                              {by(track.trash.deletedBy)}
                            </span>
                            <span>
                              {track.trash.purging
                                ? t('admin.trash.beingPurged')
                                : t('admin.trash.purgeAfter', { day: day(track.trash.purgeAfter) })}
                            </span>
                          </p>
                        </div>
                        {!track.trash.purging && (
                          <button
                            type="button"
                            className="button-secondary"
                            aria-label={t('admin.trash.restoreTrack', { key: track.key })}
                            disabled={busy !== null}
                            onClick={() => void restoreTrack(track)}
                          >
                            {t('admin.trash.restore')}
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}
          </div>
          {siteAdmin && state.retention !== null && (
            <RetentionForm
              days={state.retention}
              save={client.saveRetention}
              onSaved={(days) =>
                setState((s) => (s.status === 'loaded' ? { ...s, retention: days } : s))
              }
            />
          )}
        </>
      )}
    </section>
  );
}

/** How many days the trash keeps things (site administrators, 1 to 365). */
function RetentionForm({
  days,
  save,
  onSaved,
}: {
  days: number;
  save: (days: number) => Promise<number>;
  onSaved: (days: number) => void;
}) {
  const t = useT();
  const id = useId();
  const [value, setValue] = useState(String(days));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1 || n > 365) {
      setError(t('admin.trash.retentionInvalid'));
      return;
    }
    setBusy(true);
    setError(null);
    setSaved('');
    try {
      const stored = await save(n);
      setValue(String(stored));
      onSaved(stored);
      setSaved(t('admin.trash.retentionSaved'));
    } catch {
      setError(t('admin.trash.retentionFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="form glass-card account-section trash-retention"
      onSubmit={submit}
      aria-labelledby={`${id}-title`}
      noValidate
    >
      <h2 id={`${id}-title`} className="facts-title">
        {t('admin.trash.retention')}
      </h2>
      <div className="form-field">
        <label htmlFor={`${id}-days`}>{t('admin.trash.retentionDays')}</label>
        <input
          id={`${id}-days`}
          type="number"
          inputMode="numeric"
          min={1}
          max={365}
          value={value}
          aria-describedby={`${id}-hint`}
          aria-invalid={error !== null}
          onChange={(event) => setValue(event.target.value)}
        />
        <p id={`${id}-hint`} className="form-hint">
          {t('admin.trash.retentionHint')}
        </p>
      </div>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={busy}>
          {t('admin.trash.retentionSave')}
        </button>
      </div>
      <p role="status" className="form-status">
        {saved}
      </p>
    </form>
  );
}
