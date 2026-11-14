import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { navigate, routeHref } from '../routing/router';
import { EmptyState } from '../shell/EmptyState';
import { ModalDialog } from '../shell/ModalDialog';
import { PageHeader } from '../shell/PageHeader';
import { COMPACT_QUERY, useMediaQuery } from '../shell/useMediaQuery';
import { CrossTrackState } from './CrossTrackState';
import { searchHref } from './client';
import {
  type CrossTrackClient,
  type CrossTrackRelease,
  type CrossTrackWarning,
  crossTrackClient,
  type LinkedRelease,
  UNREACHABLE,
} from './crossTrackClient';
import { dayText } from './crossTrackText';
import { MoveDateDialog } from './MoveDateDialog';
import { ReleaseState } from './ReleaseState';
import { StageProgress } from './StageProgress';
import { candidateMatches, useCandidates } from './useCandidates';

export interface CrossTrackReleasePageProps {
  id: number;
  client?: CrossTrackClient;
}

/**
 * One release across tracks (T-089c; PLN-007; ADR-122 stage 4), laid out as a release's page: its
 * state in the header, its end, one stage bar with numbers linking to searches, its warnings, its
 * linked releases (a table on a desktop, cards on a phone) and its first tickets. What the viewer
 * may not see is only counted, in words under the linked releases. Its owner and administrators
 * move the date, edit and delete it; a track's administrators link and unlink their own releases.
 * Each control shows only to someone it would work for, and a date that can no longer move offers
 * no move.
 */
export function CrossTrackReleasePage({
  id,
  client = crossTrackClient,
}: CrossTrackReleasePageProps) {
  const t = useT();
  const intl = useIntl();
  const domId = useId();
  const compact = useMediaQuery(COMPACT_QUERY);
  const [data, setData] = useState<CrossTrackRelease | null>(null);
  const [failed, setFailed] = useState<'missing' | 'other' | null>(null);
  const [moving, setMoving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [linking, setLinking] = useState(false);
  const [notice, setNotice] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const linkedHeading = useRef<HTMLHeadingElement>(null);

  const load = useCallback(() => {
    client.get(id).then(setData, (error) => {
      setFailed(error instanceof ApiError && error.status === 404 ? 'missing' : 'other');
    });
  }, [client, id]);
  useEffect(load, [load]);

  const back = (
    <a className="button-quiet" href={routeHref('#/cross-track-releases')}>
      {t('crossTrack.toList')}
    </a>
  );

  if (failed) {
    return (
      <section className="page cross-track-page" aria-labelledby={`${domId}-title`}>
        <PageHeader
          titleId={`${domId}-title`}
          title={t('crossTrack.title')}
          purpose={t('purpose.crossTrack')}
          actions={back}
        />
        <p className="board-problem" role="alert">
          {t(failed === 'missing' ? 'crossTrack.notFound' : 'crossTrack.failed')}
        </p>
      </section>
    );
  }
  if (!data) return <p className="report-loading">{t('reports.loading')}</p>;

  const mayManage = data.viewer.mayManage;
  const unlink = async (release: LinkedRelease) => {
    setProblem(null);
    const answer = await client.unlink(id, release.id);
    if (!answer.ok) {
      setProblem(
        answer.code === UNREACHABLE
          ? t('crossTrack.unreachable')
          : t('crossTrack.linked.removeFailed'),
      );
      return;
    }
    setNotice(t('crossTrack.linked.removed', { name: release.name }));
    // Its button is going away: focus waits at the heading of what is left, not on the page's body.
    linkedHeading.current?.focus();
    load();
  };
  const remove = async () => {
    if (!window.confirm(t('crossTrack.delete.confirm', { name: data.name }))) return;
    const answer = await client.remove(id);
    if (answer.ok) navigate('#/cross-track-releases');
    else {
      setProblem(
        answer.code === UNREACHABLE ? t('crossTrack.unreachable') : t('crossTrack.delete.failed'),
      );
    }
  };

  return (
    <section className="page cross-track-page" aria-labelledby={`${domId}-title`}>
      <PageHeader
        titleId={`${domId}-title`}
        title={data.name}
        eyebrow={<CrossTrackState state={data.state} />}
        purpose={t('purpose.crossTrack')}
        actions={
          <>
            {back}
            {mayManage && data.state !== 'shipped' && (
              <button type="button" className="button-primary" onClick={() => setMoving(true)}>
                {t('crossTrack.move.open')}
              </button>
            )}
          </>
        }
      />
      <dl className="release-facts">
        <div>
          <dt>{t('crossTrack.fact.end')}</dt>
          <dd>{data.date ? dayText(intl, data.date) : t('crossTrack.end.whenComplete')}</dd>
        </div>
        <div>
          <dt>{t('crossTrack.fact.owner')}</dt>
          <dd>{data.owner.name}</dd>
        </div>
      </dl>
      {data.description && <p className="release-description">{data.description}</p>}
      {data.state === 'ready' && <p className="board-hint">{t('crossTrack.readyNote')}</p>}
      <p className="board-hint" role="status">
        {notice}
      </p>
      {problem && (
        <p className="board-problem" role="alert">
          {problem}
        </p>
      )}

      <section className="glass-card release-section" aria-labelledby={`${domId}-progress`}>
        <h2 id={`${domId}-progress`}>{t('release.progress')}</h2>
        <StageProgress stages={data.stages} />
      </section>

      {data.warnings.length > 0 && (
        <section className="glass-card release-section" aria-labelledby={`${domId}-warnings`}>
          <h2 id={`${domId}-warnings`}>{t('release.warnings')}</h2>
          <ul className="release-warnings">
            {data.warnings.map((w) => (
              <li key={w.code}>
                <span className="release-warning-mark" aria-hidden="true">
                  !
                </span>
                <WarningText warning={w} />
                {'query' in w && <a href={searchHref(w.query)}>{t('release.warning.show')}</a>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="glass-card release-section" aria-labelledby={`${domId}-linked`}>
        <h2 id={`${domId}-linked`} ref={linkedHeading} tabIndex={-1}>
          {t('crossTrack.linked.title')}
        </h2>
        {data.members.length === 0 ? (
          <EmptyState compact title={t('crossTrack.linked.none')}>
            {t('empty.crossTrack.linked')}
          </EmptyState>
        ) : compact ? (
          <LinkedCards members={data.members} onRemove={(r) => void unlink(r)} />
        ) : (
          <LinkedTable members={data.members} onRemove={(r) => void unlink(r)} />
        )}
        {data.hidden.releases > 0 && (
          <p className="cross-track-hidden">
            {t('crossTrack.hidden', {
              releases: data.hidden.releases,
              open: data.hidden.open,
            })}
          </p>
        )}
        {data.hidden.releases === 0 && data.hidden.open > 0 && (
          <p className="cross-track-hidden">
            {t('crossTrack.hiddenOpen', { open: data.hidden.open })}
          </p>
        )}
        {(data.viewer.mayLink || mayManage) && (
          <div className="form-actions">
            {data.viewer.mayLink && (
              <button type="button" className="button-secondary" onClick={() => setLinking(true)}>
                {t('crossTrack.linked.add')}
              </button>
            )}
            {mayManage && (
              <>
                <button type="button" className="button-secondary" onClick={() => setEditing(true)}>
                  {t('crossTrack.edit.open')}
                </button>
                <button type="button" className="button-secondary" onClick={() => void remove()}>
                  {t('crossTrack.delete')}
                </button>
              </>
            )}
          </div>
        )}
      </section>

      <section className="glass-card release-section" aria-labelledby={`${domId}-tickets`}>
        <h2 id={`${domId}-tickets`}>{t('release.tickets')}</h2>
        {data.tickets.length === 0 ? (
          <EmptyState compact title={t('release.noTickets')}>
            {t('empty.crossTrack.tickets')}
          </EmptyState>
        ) : (
          <div className="release-table-wrap">
            <table className="data-table release-table">
              <thead>
                <tr>
                  <th scope="col">{t('release.column.key')}</th>
                  <th scope="col">{t('release.column.summary')}</th>
                  <th scope="col">{t('release.column.status')}</th>
                  <th scope="col">{t('release.column.assignee')}</th>
                </tr>
              </thead>
              <tbody>
                {data.tickets.map((k) => (
                  <tr key={k.id} data-stage={k.stage}>
                    <td>
                      <a href={routeHref(`#/tickets/${encodeURIComponent(k.key)}`)}>{k.key}</a>
                    </td>
                    <td>{k.summary}</td>
                    <td>{k.status}</td>
                    <td>{k.assignee ?? t('summary.unassigned')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data.truncated && (
          <p className="board-hint">
            <a href={searchHref(`crossTrackRelease = ${id}`)}>{t('release.allTickets')}</a>
          </p>
        )}
      </section>

      {moving && (
        <MoveDateDialog
          id={id}
          name={data.name}
          date={data.date}
          client={client}
          onMoved={load}
          onClose={() => setMoving(false)}
        />
      )}
      {editing && (
        <EditDialog
          data={data}
          client={client}
          onSaved={() => {
            setEditing(false);
            load();
          }}
          onStale={load}
          onClose={() => setEditing(false)}
        />
      )}
      {linking && (
        <LinkDialog
          id={id}
          linked={data.members}
          client={client}
          onLinked={() => {
            setLinking(false);
            load();
          }}
          onClose={() => setLinking(false)}
        />
      )}
    </section>
  );
}

function WarningText({ warning }: { warning: CrossTrackWarning }) {
  const t = useT();
  const count = warning.count;
  if (warning.code === 'overdue') return <span>{t('release.warning.overdue', { count })}</span>;
  if (warning.code === 'unassigned') {
    return <span>{t('release.warning.unassigned', { count })}</span>;
  }
  return <span>{t('crossTrack.warning.outOfStep', { count })}</span>;
}

/** A linked release's day, and "Out of step" in words, never colour alone. */
function LinkedDay({ release }: { release: LinkedRelease }) {
  const t = useT();
  const intl = useIntl();
  return (
    <>
      {release.releaseDate ? dayText(intl, release.releaseDate) : t('release.noDate')}
      {release.outOfStep && (
        <>
          {' '}
          <span className="badge badge-warning">{t('crossTrack.outOfStep')}</span>
        </>
      )}
    </>
  );
}

const closedShare = (release: LinkedRelease) => ({
  closed: release.progress.closed,
  count: release.progress.tickets,
});

function LinkedTable({
  members,
  onRemove,
}: {
  members: LinkedRelease[];
  onRemove: (release: LinkedRelease) => void;
}) {
  const t = useT();
  return (
    <div className="release-table-wrap">
      <table className="data-table release-table cross-track-table">
        <thead>
          <tr>
            <th scope="col">{t('crossTrack.linked.track')}</th>
            <th scope="col">{t('crossTrack.linked.release')}</th>
            <th scope="col">{t('crossTrack.linked.day')}</th>
            <th scope="col">{t('crossTrack.linked.state')}</th>
            <th scope="col">{t('crossTrack.linked.progress')}</th>
            <th scope="col">
              <span className="visually-hidden">{t('crossTrack.linked.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {members.map((r) => (
            <tr key={r.id}>
              <td>{r.track.name}</td>
              <td>
                <a href={routeHref(`#/releases/${r.id}`)}>{r.name}</a>
              </td>
              <td>
                <LinkedDay release={r} />
              </td>
              <td>
                <ReleaseState release={r} />
              </td>
              <td>{t('releases.progress', closedShare(r))}</td>
              <td>
                {r.mayRemove && (
                  <button type="button" className="button-quiet" onClick={() => onRemove(r)}>
                    {t('crossTrack.linked.remove', { name: r.name })}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LinkedCards({
  members,
  onRemove,
}: {
  members: LinkedRelease[];
  onRemove: (release: LinkedRelease) => void;
}) {
  const t = useT();
  return (
    <ul className="cross-track-cards" aria-label={t('crossTrack.linked.title')}>
      {members.map((r) => (
        <li key={r.id} className="cross-track-card">
          <h3>
            <a href={routeHref(`#/releases/${r.id}`)}>
              {t('crossTrack.linked.name', { track: r.track.name, name: r.name })}
            </a>
          </h3>
          <p>
            <LinkedDay release={r} />
          </p>
          <p>
            <ReleaseState release={r} />
          </p>
          <p className="board-meta">{t('releases.progress', closedShare(r))}</p>
          {r.mayRemove && (
            <button type="button" className="button-secondary" onClick={() => onRemove(r)}>
              {t('crossTrack.linked.remove', { name: r.name })}
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Its name, its description, and ending when its work completes, which moves nothing. When someone
 * changed it first the page reads itself again, so saving again sends the version it now holds; what
 * the person typed stays in the fields.
 */
function EditDialog({
  data,
  client,
  onSaved,
  onStale,
  onClose,
}: {
  data: CrossTrackRelease;
  client: CrossTrackClient;
  onSaved: () => void;
  onStale: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState(data.name);
  const [description, setDescription] = useState(data.description);
  const [work, setWork] = useState(data.endRule === 'work_complete');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setProblem(null);
    const answer = await client.update(data.id, {
      name: name.trim(),
      description,
      ...(work && data.endRule !== 'work_complete' ? { endRule: 'work_complete' as const } : {}),
      version: data.version,
    });
    setBusy(false);
    if (answer.ok) {
      onSaved();
      return;
    }
    if (answer.code === 'version_conflict') {
      setProblem(t('crossTrack.edit.stale'));
      onStale();
    } else {
      setProblem(
        answer.code === UNREACHABLE ? t('crossTrack.unreachable') : t('crossTrack.edit.failed'),
      );
    }
  };
  return (
    <ModalDialog
      onClose={onClose}
      labelledBy={`${id}-title`}
      closeLabel={t('crossTrack.new.close')}
      focusFirstField
      className="cross-track-dialog"
    >
      <form
        className="cross-track-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 id={`${id}-title`}>{t('crossTrack.edit.title', { name: data.name })}</h2>
        <label className="form-field" htmlFor={`${id}-name`}>
          <span className="form-label">{t('crossTrack.new.name')}</span>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={255}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="form-field" htmlFor={`${id}-description`}>
          <span className="form-label">{t('crossTrack.new.description')}</span>
          <textarea
            id={`${id}-description`}
            value={description}
            maxLength={4000}
            rows={3}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        {data.endRule === 'fixed_date' && (
          <label className="form-field-inline">
            <input
              type="checkbox"
              checked={work}
              onChange={(event) => setWork(event.target.checked)}
            />
            {t('crossTrack.edit.workComplete')}
          </label>
        )}
        {problem && (
          <p className="board-problem" role="alert">
            {problem}
          </p>
        )}
        <div className="form-actions cross-track-dialog-actions">
          <button type="submit" className="button-primary" disabled={busy || name.trim() === ''}>
            {t('crossTrack.edit.submit')}
          </button>
          <button type="button" className="button-secondary" onClick={onClose}>
            {t('crossTrack.move.cancel')}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}

/** Links one more release of a track the person administers; linking never moves a date. */
function LinkDialog({
  id,
  linked,
  client,
  onLinked,
  onClose,
}: {
  id: number;
  linked: LinkedRelease[];
  client: CrossTrackClient;
  onLinked: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const domId = useId();
  const known = useCandidates(client);
  const [chosen, setChosen] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const taken = new Set(linked.map((m) => m.track.id));
  const candidates = known.candidates?.filter((r) => !taken.has(r.track.id)) ?? null;
  const shown = candidates?.filter(
    (c) => candidateMatches(c, known.filter) || String(c.id) === chosen,
  );
  const link = async () => {
    setBusy(true);
    setProblem(null);
    const answer = await client.link(id, Number(chosen));
    setBusy(false);
    if (answer.ok) onLinked();
    else {
      setProblem(
        answer.code === 'track_taken' || answer.code === 'release_taken'
          ? t('crossTrack.new.taken')
          : answer.code === 'too_many_members'
            ? t('crossTrack.linked.tooMany')
            : answer.code === UNREACHABLE
              ? t('crossTrack.unreachable')
              : t('crossTrack.linked.addFailed'),
      );
    }
  };
  return (
    <ModalDialog
      onClose={onClose}
      labelledBy={`${domId}-title`}
      closeLabel={t('crossTrack.new.close')}
      className="cross-track-dialog"
    >
      <form
        className="cross-track-form"
        onSubmit={(event) => {
          event.preventDefault();
          void link();
        }}
      >
        <h2 id={`${domId}-title`}>{t('crossTrack.linked.add')}</h2>
        {known.failed && (
          <p className="board-problem" role="alert">
            {t('crossTrack.new.candidatesFailed')}
          </p>
        )}
        {candidates === null && !known.failed && (
          <p className="report-loading">{t('reports.loading')}</p>
        )}
        {candidates?.length === 0 && !known.failed && !known.stopsShort && (
          <EmptyState compact title={t('crossTrack.new.noneToLink')}>
            {t('empty.crossTrack.candidates')}
          </EmptyState>
        )}
        {known.stopsShort && (
          <>
            <label className="form-field" htmlFor={`${domId}-filter`}>
              <span className="form-label">{t('crossTrack.new.filter')}</span>
              <input
                id={`${domId}-filter`}
                type="search"
                value={known.filter}
                onChange={(event) => known.setFilter(event.target.value)}
              />
            </label>
            {known.truncated && <p className="board-hint">{t('crossTrack.new.truncated')}</p>}
            {shown?.length === 0 && <p className="board-hint">{t('crossTrack.new.noMatch')}</p>}
          </>
        )}
        {candidates !== null && candidates.length > 0 && (
          <label className="form-field" htmlFor={`${domId}-release`}>
            <span className="form-label">{t('crossTrack.linked.release')}</span>
            <select
              id={`${domId}-release`}
              value={chosen}
              required
              onChange={(event) => setChosen(event.target.value)}
            >
              <option value="">{t('crossTrack.linked.choose')}</option>
              {(shown ?? candidates).map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {t('crossTrack.linked.name', { track: c.track.name, name: c.name })}
                </option>
              ))}
            </select>
          </label>
        )}
        <p className="board-hint">{t('crossTrack.new.noMove')}</p>
        {problem && (
          <p className="board-problem" role="alert">
            {problem}
          </p>
        )}
        <div className="form-actions cross-track-dialog-actions">
          <button type="submit" className="button-primary" disabled={busy || chosen === ''}>
            {t('crossTrack.linked.addSubmit')}
          </button>
          <button type="button" className="button-secondary" onClick={onClose}>
            {t('crossTrack.move.cancel')}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
