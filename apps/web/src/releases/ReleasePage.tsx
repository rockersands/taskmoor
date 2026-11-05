import { useCallback, useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { routeHref } from '../routing/router';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
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
import { type CrossTrackClient, type CrossTrackRow, crossTrackClient } from './crossTrackClient';
import { dayText } from './crossTrackText';
import { ReleaseState } from './ReleaseState';
import { StageProgress } from './StageProgress';

export interface ReleasePageProps {
  releaseId: number;
  client?: ReleaseClient;
  /** Releases across tracks, to link this one to (PLN-007). */
  crossTrack?: CrossTrackClient;
  /** Today, the default day a release ships on. */
  now?: () => Date;
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
}: ReleasePageProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const [release, setRelease] = useState<Release | null>(null);
  const [overview, setOverview] = useState<ReleaseOverview | null>(null);
  const [notes, setNotes] = useState<ReleaseNotes | null>(null);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState('');

  const load = useCallback(() => {
    Promise.all([client.get(releaseId), client.overview(releaseId), client.notes(releaseId)]).then(
      ([r, o, n]) => {
        setRelease(r);
        setOverview(o);
        setNotes(n);
      },
      () => setFailed(true),
    );
  }, [client, releaseId]);
  useEffect(load, [load]);

  if (failed) {
    return (
      <section className="page release-page" aria-labelledby={`${id}-title`}>
        <PageHeader
          titleId={`${id}-title`}
          title={t('track.section.releases')}
          purpose={t('purpose.release')}
        />
        <p className="board-problem" role="alert">
          {t('release.notFound')}
        </p>
      </section>
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
    const done = await client.setDate(releaseId, date);
    setNotice(
      done.ok
        ? t('release.crossTrack.aligned', { date: dayText(intl, date) })
        : t('release.crossTrack.alignFailed'),
    );
    if (done.ok) load();
  };

  return (
    <section className="page release-page" aria-labelledby={`${id}-title`}>
      <PageHeader
        titleId={`${id}-title`}
        title={t('release.title', { track: track.name, name: release.name })}
        eyebrow={<ReleaseState release={release} />}
        purpose={t('purpose.release')}
        actions={
          <a
            className="button-quiet"
            href={routeHref(`#/tracks/${encodeURIComponent(track.key)}/releases`)}
          >
            {t('release.toReleases', { track: track.name })}
          </a>
        }
      />
      <dl className="release-facts">
        <div>
          <dt>{t('release.startDate')}</dt>
          <dd>{release.startDate ?? t('release.noDate')}</dd>
        </div>
        <div>
          <dt>{t('release.releaseDate')}</dt>
          <dd>{release.releaseDate ?? t('release.noDate')}</dd>
        </div>
        {release.shipped && notes.release.shippedOn && (
          <div>
            <dt>{t('release.shippedOn')}</dt>
            <dd>{notes.release.shippedOn}</dd>
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

      {canShip && (
        <Ship
          client={client}
          release={release}
          open={overview.open.count}
          today={now().toISOString().slice(0, 10)}
          onShipped={() => {
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
  const [chosen, setChosen] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const linked = release.crossTrack ?? null;

  useEffect(() => {
    if (!opened || rows !== null) return;
    client.list('upcoming').then(
      (page) =>
        setRows(page.releases.filter((r) => !r.tracks.some((x) => x.id === release.trackId))),
      () => setRows([]),
    );
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
          : t('crossTrack.linked.addFailed'),
      );
    }
  };
  const unlink = async () => {
    if (!linked) return;
    setProblem(null);
    const done = await client.unlink(linked.id, release.id);
    if (done.ok) onChanged(t('release.crossTrack.unlinked', { name: linked.name }));
    else setProblem(t('crossTrack.linked.removeFailed'));
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
        <button type="button" className="button-secondary" onClick={() => setOpened(true)}>
          {t('release.crossTrack.add')}
        </button>
      ) : (
        <form
          className="release-ship"
          onSubmit={(event) => {
            event.preventDefault();
            void link();
          }}
        >
          {rows === null && <p className="report-loading">{t('reports.loading')}</p>}
          {rows?.length === 0 && (
            <EmptyState compact title={t('release.crossTrack.noneToJoin')}>
              {t('empty.release.crossTrack')}{' '}
              <a href={routeHref('#/cross-track-releases')}>{t('crossTrack.title')}</a>
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
  onShipped,
}: {
  client: ReleaseClient;
  release: Release;
  open: number;
  today: string;
  onShipped: () => void;
}) {
  const t = useT();
  const id = useId();
  const [opened, setOpened] = useState(false);
  const [day, setDay] = useState(today);
  const [others, setOthers] = useState<Release[] | null>(null);
  const [moveTo, setMoveTo] = useState('stay');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!opened || others !== null) return;
    client.list(release.trackId).then(
      (l) => setOthers(l.releases.filter((r) => r.id !== release.id && !r.shipped && !r.archived)),
      () => setOthers([]),
    );
  }, [opened, others, client, release]);

  const ship = async () => {
    setBusy(true);
    setProblem(null);
    const outcome = await client.ship(release.id, {
      releaseDate: day,
      ...(open > 0 ? { moveOpenTo: moveTo === 'stay' ? null : Number(moveTo) } : {}),
    });
    setBusy(false);
    if (outcome.ok) {
      setOpened(false);
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
      <h2 id={`${id}-ship`}>{t('release.ship.title')}</h2>
      {!opened ? (
        <button type="button" className="button-primary" onClick={() => setOpened(true)}>
          {t('release.ship.open')}
        </button>
      ) : (
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
            <button type="button" className="button-secondary" onClick={() => setOpened(false)}>
              {t('release.ship.cancel')}
            </button>
          </div>
          {problem && (
            <p className="board-problem" role="alert">
              {problem}
            </p>
          )}
        </form>
      )}
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
      <div className="form-actions">
        <button type="button" className="button-secondary" onClick={copy}>
          {t('release.notes.copy')}
        </button>
        <a className="button-secondary" href={notesFileHref(releaseId)} download>
          {t('release.notes.download')}
        </a>
      </div>
    </section>
  );
}
