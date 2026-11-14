import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { ApiError } from '../api/client';
import { dayText, shippedDay } from '../i18n/days';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { routeHref } from '../routing/router';
import { EmptyState } from '../shell/EmptyState';
import { NotFoundPage } from '../shell/NotFoundPage';
import { PageHeader } from '../shell/PageHeader';
import { localDay } from '../timeline/client';
import { type TrackClient, trackClient } from '../tracks/client';
import { TrackLayout } from '../tracks/TrackLayout';
import {
  notesFileHref,
  type Release,
  type ReleaseClient,
  type ReleaseNotes,
  type ReleaseOverview,
  releaseClient,
  searchHref,
  type Warning,
} from './client';
import {
  type CrossTrackClient,
  type CrossTrackRow,
  crossTrackClient,
  UNREACHABLE,
} from './crossTrackClient';
import { ReleaseState } from './ReleaseState';
import { StageProgress } from './StageProgress';

export interface ReleasePageProps {
  releaseId: number;
  client?: ReleaseClient;
  /** Releases across tracks, to link this one to (PLN-007). */
  crossTrack?: CrossTrackClient;
  /** Today, the default day a release ships on. */
  now?: () => Date;
  /** The track's sections, for its tab bar. */
  tracks?: TrackClient;
}

const WARNINGS: Record<Warning['code'], MessageId> = {
  overdue: 'release.warning.overdue',
  open_after_ship: 'release.warning.openAfterShip',
  unassigned: 'release.warning.unassigned',
  open_found: 'release.warning.openFound',
  no_approvers: 'release.warning.noApprovers',
  approvals_waiting: 'release.warning.approvalsWaiting',
  approval_declined: 'release.warning.approvalDeclined',
  cross_track_out_of_step: 'release.warning.outOfStep',
};
const DECISIONS: Record<'approved' | 'declined' | 'none', MessageId> = {
  approved: 'release.approval.approved',
  declined: 'release.approval.declined',
  none: 'release.approval.waiting',
};

/**
 * A release's page (M1-050; CORE-016): its state and dates, its tickets by stage (each number
 * linking to the search that finds them), its warnings, its approvers (who approve or decline
 * here), shipping (with somewhere for the open tickets to go), its tickets in rank order, and
 * release notes generated from its closed tickets, to copy as Markdown or download. A release in a
 * release across tracks (PLN-007) says so in its facts, says in words when it is out of step, and
 * its track's administrators get Align, which is this release's own change.
 */
export function ReleasePage({
  releaseId,
  client = releaseClient,
  crossTrack = crossTrackClient,
  now = () => new Date(),
  tracks = trackClient,
}: ReleasePageProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const [release, setRelease] = useState<Release | null>(null);
  const [overview, setOverview] = useState<ReleaseOverview | null>(null);
  const [notes, setNotes] = useState<ReleaseNotes | null>(null);
  const [failed, setFailed] = useState<'missing' | 'failed' | null>(null);
  const [notice, setNotice] = useState('');
  const [shipping, setShipping] = useState(false);
  const shipButton = useRef<HTMLButtonElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  /** Where focus goes once the shipping step closes: back to Ship, or to the page's name. */
  const focusAfterShipping = useRef<'ship' | 'title' | null>(null);
  useEffect(() => {
    if (shipping) return;
    const next = focusAfterShipping.current;
    focusAfterShipping.current = null;
    if (next === 'ship') shipButton.current?.focus();
    if (next === 'title') title.current?.focus();
  }, [shipping]);

  const load = useCallback(() => {
    // The release first: once it is not there, nothing else is asked for (PL-50).
    client.get(releaseId).then(
      (r) => {
        setRelease(r);
        // The notes name the track: a failure after them keeps its tab bar.
        const read = client.notes(releaseId).then((n) => {
          setNotes(n);
          return n;
        });
        return Promise.all([client.overview(releaseId), read]).then(
          ([o]) => setOverview(o),
          () => setFailed('failed'),
        );
      },
      (error: unknown) =>
        setFailed(
          error instanceof ApiError && (error.status === 404 || error.status === 403)
            ? 'missing'
            : 'failed',
        ),
    );
  }, [client, releaseId]);
  useEffect(load, [load]);

  if (failed === 'missing') {
    return <NotFoundPage title={t('notFound.release')}>{t('release.notFound')}</NotFoundPage>;
  }
  if (failed) {
    // The page keeps its header, and its track's tab bar when the track is known (UI-T22).
    const known = notes?.release.track ?? null;
    const failure = (
      <section className="page release-page" aria-labelledby={`${id}-title`}>
        <PageHeader
          titleId={`${id}-title`}
          title={release?.name ?? t('release.title')}
          eyebrow={known?.name}
          purpose={t('purpose.release')}
          about={t('release.about')}
        />
        <p className="board-problem" role="alert">
          {t('release.failed')}
        </p>
      </section>
    );
    return known ? (
      <TrackLayout trackKey={known.key} section="releases" client={tracks}>
        {failure}
      </TrackLayout>
    ) : (
      failure
    );
  }
  if (!release || !overview || !notes) {
    return <p className="report-loading">{t('reports.loading')}</p>;
  }

  const track = notes.release.track;
  const canShip = overview.viewer.mayManage && !release.shipped && !release.archived;
  const mayDecide = overview.viewer.approver !== null && !release.shipped;
  const linked = release.crossTrack ?? null;
  const align = async (date: string) => {
    const done = await client.setDate(releaseId, date).catch(() => null);
    setNotice(
      done?.ok
        ? t('release.crossTrack.aligned', { date: dayText(intl, date) })
        : t('release.crossTrack.alignFailed'),
    );
    if (done?.ok) load();
  };

  return (
    <TrackLayout trackKey={track.key} section="releases" client={tracks}>
      <section className="page release-page" aria-labelledby={`${id}-title`}>
        <PageHeader
          titleId={`${id}-title`}
          titleRef={title}
          // Titled by the release, its track named above as on the track's other pages (D26); the
          // track's tab bar leads back to its releases (T-215, D7).
          title={release.name}
          eyebrow={
            <>
              {track.name} <ReleaseState release={release} />
            </>
          }
          purpose={t('purpose.release')}
          about={t('release.about')}
          actions={
            // A normal primary action; the step it opens carries the weight (D27).
            canShip && !shipping ? (
              <button
                ref={shipButton}
                type="button"
                className="button-primary"
                data-tutorial="release-ship"
                onClick={() => setShipping(true)}
              >
                {t('release.ship.open')}
              </button>
            ) : undefined
          }
        />
        <dl className="release-facts">
          <div>
            <dt>{t('release.startDate')}</dt>
            <dd>{release.startDate ? dayText(intl, release.startDate) : t('release.noDate')}</dd>
          </div>
          <div>
            <dt>{t('release.releaseDate')}</dt>
            <dd>
              {release.releaseDate ? dayText(intl, release.releaseDate) : t('release.noDate')}
            </dd>
          </div>
          {release.shipped && release.shippedAt && (
            <div>
              <dt>{t('release.shippedOn')}</dt>
              <dd>{dayText(intl, shippedDay(release.releaseDate, release.shippedAt))}</dd>
            </div>
          )}
          {linked && (
            <div>
              <dt>{t('release.crossTrack.fact')}</dt>
              <dd>
                <a href={routeHref(`#/cross-track-releases/${linked.id}`)}>{linked.name}</a>
                {' · '}
                {linked.date ? dayText(intl, linked.date) : t('crossTrack.end.whenComplete')}
              </dd>
            </div>
          )}
        </dl>
        {release.description && <p className="release-description">{release.description}</p>}
        <p className="board-hint" role="status">
          {notice}
        </p>

        <section className="glass-card release-section" aria-labelledby={`${id}-progress`}>
          <h2 id={`${id}-progress`}>{t('release.progress')}</h2>
          <StageProgress stages={overview.stages} />
        </section>

        {overview.warnings.length > 0 && (
          <section className="glass-card release-section" aria-labelledby={`${id}-warnings`}>
            <h2 id={`${id}-warnings`}>{t('release.warnings')}</h2>
            <ul className="release-warnings">
              {overview.warnings.map((w) => (
                <li key={w.code}>
                  <span className="release-warning-mark" aria-hidden="true">
                    !
                  </span>
                  <span>
                    {t(WARNINGS[w.code], {
                      count: w.count,
                      name: linked?.name ?? '',
                      date: linked?.date ? dayText(intl, linked.date) : '',
                    })}
                  </span>
                  {w.query && <a href={searchHref(w.query)}>{t('release.warning.show')}</a>}
                  {w.code === 'cross_track_out_of_step' &&
                    linked?.date &&
                    overview.viewer.mayManage && (
                      <button
                        type="button"
                        className="button-secondary"
                        onClick={() => void align(linked.date as string)}
                      >
                        {t('release.crossTrack.align', { date: dayText(intl, linked.date) })}
                      </button>
                    )}
                </li>
              ))}
            </ul>
          </section>
        )}

        {(release.requireApprovals || overview.approvers.length > 0) && (
          <section className="glass-card release-section" aria-labelledby={`${id}-approvals`}>
            <h2 id={`${id}-approvals`}>{t('release.approvals')}</h2>
            {overview.approvers.length === 0 ? (
              <EmptyState compact title={t('release.approval.nobody')} />
            ) : (
              <ul className="release-approvers">
                {overview.approvers.map((a) => (
                  <li key={a.user.id}>
                    <span className="release-approver">{a.user.name}</span>
                    <span
                      className={`badge release-decision${
                        a.decision === 'approved'
                          ? ' badge-success'
                          : a.decision === 'declined'
                            ? ' badge-danger'
                            : ''
                      }`}
                      data-decision={a.decision ?? 'none'}
                    >
                      {t(DECISIONS[a.decision ?? 'none'])}
                    </span>
                    {a.comment && <span className="board-meta">{a.comment}</span>}
                  </li>
                ))}
              </ul>
            )}
            {mayDecide && (
              <Decision
                client={client}
                releaseId={releaseId}
                onDone={(message) => {
                  setNotice(message);
                  load();
                }}
              />
            )}
          </section>
        )}

        {overview.viewer.mayManage && (
          <CrossTrackLink
            release={release}
            client={crossTrack}
            onChanged={(message) => {
              setNotice(message);
              load();
            }}
          />
        )}

        {canShip && shipping && (
          <Ship
            client={client}
            release={release}
            open={overview.open.count}
            today={localDay(now())}
            onCancel={() => {
              focusAfterShipping.current = 'ship';
              setShipping(false);
            }}
            onShipped={() => {
              // Ship is gone once shipped: the page's name, with the notice under it, takes focus.
              focusAfterShipping.current = 'title';
              setShipping(false);
              setNotice(t('release.ship.done', { name: release.name }));
              load();
            }}
          />
        )}

        <section className="glass-card release-section" aria-labelledby={`${id}-tickets`}>
          <h2 id={`${id}-tickets`}>{t('release.tickets')}</h2>
          {overview.tickets.length === 0 ? (
            <EmptyState compact title={t('release.noTickets')}>
              {t('empty.release.tickets')}
            </EmptyState>
          ) : (
            <div className="release-table-wrap">
              <table className="data-table release-table">
                <thead>
                  <tr>
                    <th scope="col">{t('release.column.key')}</th>
                    <th scope="col">{t('release.column.summary')}</th>
                    <th scope="col">{t('release.column.type')}</th>
                    <th scope="col">{t('release.column.status')}</th>
                    <th scope="col">{t('release.column.assignee')}</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.tickets.map((k) => (
                    <tr key={k.id} data-stage={k.stage}>
                      <td>
                        <a href={routeHref(`#/tickets/${encodeURIComponent(k.key)}`)}>{k.key}</a>
                      </td>
                      <td>{k.summary}</td>
                      <td>{k.type}</td>
                      <td>{k.status}</td>
                      <td>{k.assignee ?? t('summary.unassigned')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {overview.truncated && (
            <p className="board-hint">
              <a href={searchHref(`targetRelease = ${releaseId}`)}>{t('release.allTickets')}</a>
            </p>
          )}
        </section>

        <NotesView notes={notes} releaseId={releaseId} onCopied={setNotice} />
      </section>
    </TrackLayout>
  );
}

/**
 * For the track's administrators: adding this release to a release across tracks, or taking it out
 * (PLN-007). Neither changes its date: on another day it reads as out of step until someone moves it.
 */
function CrossTrackLink({
  release,
  client,
  onChanged,
}: {
  release: Release;
  client: CrossTrackClient;
  onChanged: (message: string) => void;
}) {
  const t = useT();
  const id = useId();
  const [opened, setOpened] = useState(false);
  const [rows, setRows] = useState<CrossTrackRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [chosen, setChosen] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const linked = release.crossTrack ?? null;

  useEffect(() => {
    if (!opened || rows !== null) return;
    let live = true;
    allUpcoming(client).then(
      (all) => {
        if (live) setRows(all.filter((r) => !r.tracks.some((x) => x.id === release.trackId)));
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [opened, rows, client, release.trackId]);

  const link = async () => {
    setProblem(null);
    const done = await client.link(Number(chosen), release.id);
    if (done.ok) {
      setOpened(false);
      setRows(null);
      setChosen('');
      onChanged(t('release.crossTrack.linked', { name: done.value.name }));
    } else {
      setProblem(
        done.code === 'release_taken' || done.code === 'track_taken'
          ? t('crossTrack.new.taken')
          : done.code === UNREACHABLE
            ? t('crossTrack.unreachable')
            : t('crossTrack.linked.addFailed'),
      );
    }
  };
  const unlink = async () => {
    if (!linked) return;
    setProblem(null);
    const done = await client.unlink(linked.id, release.id);
    if (done.ok) onChanged(t('release.crossTrack.unlinked', { name: linked.name }));
    else {
      setProblem(
        done.code === UNREACHABLE
          ? t('crossTrack.unreachable')
          : t('crossTrack.linked.removeFailed'),
      );
    }
  };

  if (!linked && (release.shipped || release.archived)) return null;
  return (
    <section className="glass-card release-section" aria-labelledby={`${id}-cross`}>
      <h2 id={`${id}-cross`}>{t('release.crossTrack.fact')}</h2>
      {linked ? (
        <button type="button" className="button-secondary" onClick={() => void unlink()}>
          {t('release.crossTrack.remove', { name: linked.name })}
        </button>
      ) : !opened ? (
        <>
          <button type="button" className="button-secondary" onClick={() => setOpened(true)}>
            {t('release.crossTrack.add')}
          </button>
          <p className="board-hint">
            <a className="release-cross-track-all" href={routeHref('#/cross-track-releases')}>
              {t('crossTrack.title')}
            </a>
          </p>
        </>
      ) : (
        <form
          className="release-ship"
          onSubmit={(event) => {
            event.preventDefault();
            void link();
          }}
        >
          {failed && (
            <p className="board-problem" role="alert">
              {t('release.crossTrack.listFailed')}
            </p>
          )}
          {rows === null && !failed && <p className="report-loading">{t('reports.loading')}</p>}
          {rows?.length === 0 && (
            <EmptyState compact title={t('release.crossTrack.noneToJoin')}>
              {t('empty.release.crossTrack')}{' '}
              <a className="release-cross-track-all" href={routeHref('#/cross-track-releases')}>
                {t('crossTrack.title')}
              </a>
            </EmptyState>
          )}
          {rows !== null && rows.length > 0 && (
            <label className="form-field" htmlFor={`${id}-pick`}>
              <span className="form-label">{t('release.crossTrack.pick')}</span>
              <select
                id={`${id}-pick`}
                value={chosen}
                required
                onChange={(event) => setChosen(event.target.value)}
              >
                <option value="">{t('crossTrack.linked.choose')}</option>
                {rows.map((r) => (
                  <option key={r.id} value={String(r.id)}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="board-hint">{t('crossTrack.new.noMove')}</p>
          <div className="form-actions">
            <button type="submit" className="button-primary" disabled={chosen === ''}>
              {t('crossTrack.linked.addSubmit')}
            </button>
            <button type="button" className="button-secondary" onClick={() => setOpened(false)}>
              {t('crossTrack.move.cancel')}
            </button>
          </div>
        </form>
      )}
      {problem && (
        <p className="board-problem" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}

/** Every upcoming release across tracks the person sees, whatever number of pages that takes. */
async function allUpcoming(client: CrossTrackClient): Promise<CrossTrackRow[]> {
  const rows: CrossTrackRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.list('upcoming', cursor);
    rows.push(...page.releases);
    cursor = page.next ?? undefined;
  } while (cursor);
  return rows;
}

/** An approver's decision, with an optional comment (CORE-016 (2)). */
function Decision({
  client,
  releaseId,
  onDone,
}: {
  client: ReleaseClient;
  releaseId: number;
  onDone: (message: string) => void;
}) {
  const t = useT();
  const id = useId();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const decide = async (decision: 'approved' | 'declined') => {
    setBusy(true);
    setProblem(null);
    const outcome = await client.decide(releaseId, decision, comment);
    setBusy(false);
    if (!outcome.ok) {
      setProblem(t('release.approval.failed'));
      return;
    }
    setComment('');
    onDone(
      t(
        decision === 'approved' ? 'release.approval.doneApproved' : 'release.approval.doneDeclined',
      ),
    );
  };
  return (
    <div className="release-decide">
      <label htmlFor={`${id}-comment`} className="form-label">
        {t('release.approval.comment')}
      </label>
      <input
        id={`${id}-comment`}
        type="text"
        value={comment}
        maxLength={2000}
        onChange={(event) => setComment(event.target.value)}
      />
      <div className="form-actions">
        <button
          type="button"
          className="button-primary"
          disabled={busy}
          onClick={() => void decide('approved')}
        >
          {t('release.approval.approve')}
        </button>
        <button
          type="button"
          className="button-secondary"
          disabled={busy}
          onClick={() => void decide('declined')}
        >
          {t('release.approval.decline')}
        </button>
      </div>
      {problem && (
        <p className="board-problem" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

/**
 * Shipping (CORE-016 (1)): on a day (today by default); with open tickets, they move to another
 * upcoming release or stay where they are, as the person chooses.
 */
function Ship({
  client,
  release,
  open,
  today,
  onCancel,
  onShipped,
}: {
  client: ReleaseClient;
  release: Release;
  open: number;
  today: string;
  onCancel: () => void;
  onShipped: () => void;
}) {
  const t = useT();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [day, setDay] = useState(today);
  const [others, setOthers] = useState<Release[] | null>(null);
  const [moveTo, setMoveTo] = useState('stay');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // The step opens away from the button that opened it: focus goes to it, so it is read at once.
  useEffect(() => heading.current?.focus(), []);

  useEffect(() => {
    if (others !== null) return;
    client.list(release.trackId).then(
      (l) => setOthers(l.releases.filter((r) => r.id !== release.id && !r.shipped && !r.archived)),
      () => setOthers([]),
    );
  }, [others, client, release]);

  const ship = async () => {
    setBusy(true);
    setProblem(null);
    const outcome = await client.ship(release.id, {
      releaseDate: day,
      ...(open > 0 ? { moveOpenTo: moveTo === 'stay' ? null : Number(moveTo) } : {}),
    });
    setBusy(false);
    if (outcome.ok) {
      onShipped();
      return;
    }
    setProblem(
      outcome.code === 'approvals_pending'
        ? t('release.ship.approvalsPending')
        : outcome.code === 'open_tickets'
          ? t('release.ship.openTickets', { count: outcome.openTickets ?? open })
          : t('release.ship.failed'),
    );
  };

  return (
    <section
      className="glass-card release-section"
      data-tutorial="release-ship"
      aria-labelledby={`${id}-ship`}
    >
      <h2 id={`${id}-ship`} ref={heading} tabIndex={-1}>
        {t('release.ship.title', { name: release.name })}
      </h2>
      <p>{t('release.ship.weight')}</p>
      <form
        className="release-ship"
        onSubmit={(event) => {
          event.preventDefault();
          void ship();
        }}
      >
        <label className="form-field">
          <span className="form-label">{t('release.ship.day')}</span>
          <input
            type="date"
            value={day}
            required
            onChange={(event) => setDay(event.target.value)}
          />
        </label>
        {open > 0 && (
          <fieldset className="release-ship-open">
            <legend>{t('release.ship.openLegend', { count: open })}</legend>
            <label className="form-field-inline">
              <input
                type="radio"
                name={`${id}-open`}
                value="stay"
                checked={moveTo === 'stay'}
                onChange={() => setMoveTo('stay')}
              />
              {t('release.ship.stay')}
            </label>
            {others?.map((r) => (
              <label key={r.id} className="form-field-inline">
                <input
                  type="radio"
                  name={`${id}-open`}
                  value={String(r.id)}
                  checked={moveTo === String(r.id)}
                  onChange={() => setMoveTo(String(r.id))}
                />
                {t('release.ship.moveTo', { name: r.name })}
              </label>
            ))}
          </fieldset>
        )}
        <div className="form-actions">
          <button type="submit" className="button-primary" disabled={busy || day === ''}>
            {t('release.ship.submit', { name: release.name })}
          </button>
          <button type="button" className="button-secondary" onClick={onCancel}>
            {t('release.ship.cancel')}
          </button>
        </div>
        {problem && (
          <p className="board-problem" role="alert">
            {problem}
          </p>
        )}
      </form>
    </section>
  );
}

/** The generated notes, to read here, copy as Markdown or download as a file. */
function NotesView({
  notes,
  releaseId,
  onCopied,
}: {
  notes: ReleaseNotes;
  releaseId: number;
  onCopied: (message: string) => void;
}) {
  const t = useT();
  const id = useId();
  const copy = () => {
    navigator.clipboard?.writeText(notes.markdown).then(
      () => onCopied(t('release.notes.copied')),
      () => onCopied(t('release.notes.copyFailed')),
    );
  };
  return (
    <section className="glass-card release-section" aria-labelledby={`${id}-notes`}>
      <h2 id={`${id}-notes`}>{t('release.notes.title')}</h2>
      {notes.sections.length === 0 ? (
        <EmptyState compact title={t('release.notes.empty')} />
      ) : (
        <div className="release-notes">
          {notes.sections.map((s, i) => (
            <section key={s.type} aria-labelledby={`${id}-notes-${i}`}>
              <h3 id={`${id}-notes-${i}`}>{s.type}</h3>
              <ul>
                {s.tickets.map((k) => (
                  <li key={k.id}>
                    <a href={routeHref(`#/tickets/${encodeURIComponent(k.key)}`)}>{k.key}</a>{' '}
                    {k.summary}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
      {notes.leftOut.length > 0 && (
        <p className="board-hint">
          {t('release.notes.leftOut', {
            list: notes.leftOut.map((l) => `${l.reason} (${l.count})`).join(', '),
          })}
        </p>
      )}
      {notes.truncated && <p className="board-hint">{t('release.notes.truncated')}</p>}
      {/* Notes with nothing in them are nothing to copy or keep (D27). */}
      {notes.sections.length > 0 && (
        <div className="form-actions">
          <button type="button" className="button-secondary" onClick={copy}>
            {t('release.notes.copy')}
          </button>
          <a className="button-secondary" href={notesFileHref(releaseId)} download>
            {t('release.notes.download')}
          </a>
        </div>
      )}
    </section>
  );
}
