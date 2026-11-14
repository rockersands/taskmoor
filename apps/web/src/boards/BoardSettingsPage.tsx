import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { routeHref } from '../routing/router';
import { useSession } from '../session/SessionProvider';
import { PageHeader } from '../shell/PageHeader';
import type { NumberField } from '../sprints/client';
import {
  type SprintDraft,
  SprintSettingsSection,
  sprintDraftOf,
  sprintSettingsOf,
} from '../sprints/SprintSettingsSection';
import { trackSectionsChanged } from '../tracks/trackSections';
import {
  type Board,
  type BoardClient,
  type BoardPatch,
  type BoardReach,
  type BoardStatus,
  boardClient,
  CARD_FIELDS,
  type CardRules,
  MAX_CARD_FIELDS,
  type Swimlanes,
  sourceOf,
  sourceText,
} from './client';

export interface BoardSettingsPageProps {
  boardId: number;
  client?: BoardClient;
}

/** Items being edited keep a local key, so new ones (without a server id yet) stay apart. */
interface Keyed {
  key: string;
}
interface ColumnDraft extends Keyed {
  id?: string;
  name: string;
  statusIds: number[];
  min: string;
  max: string;
}
interface LaneDraft extends Keyed {
  id?: string;
  name: string;
  query: string;
}
interface FilterDraft extends Keyed {
  id?: string;
  name: string;
  query: string;
  description: string;
}
interface ColourDraft extends Keyed {
  id?: string;
  query: string;
  colour: string;
}

interface Draft {
  name: string;
  kind: 'scrum' | 'kanban';
  /** The team's id, or '' for none (M1-123). */
  teamId: string;
  query: string;
  subFilter: string;
  columns: ColumnDraft[];
  /** Which column closes tickets on a board managing its workflow; null the rightmost. */
  closingColumn: string | null;
  /** Where the tickets of removed columns go, by status id. */
  statusMapping: Record<string, number>;
  lanesMode: Swimlanes['mode'];
  lanes: LaneDraft[];
  unassigned: 'first' | 'last';
  otherName: string;
  filters: FilterDraft[];
  filterDisplay: 'buttons' | 'dropdown';
  colourBy: CardRules['colourBy'];
  colours: ColourDraft[];
  fields: string[];
  daysInColumn: boolean;
  sprint: SprintDraft;
}

let lastKey = 0;
const newKey = () => `k${++lastKey}`;

function draftOf(board: Board, timeZone: string): Draft {
  return {
    name: board.name,
    kind: board.kind,
    teamId: board.team ? String(board.team.id) : '',
    query: sourceText(board.source),
    subFilter: board.subFilter?.query ?? '',
    columns: board.columns.map((c) => ({
      key: newKey(),
      id: c.id,
      name: c.name,
      statusIds: [...c.statusIds],
      min: c.min === null ? '' : String(c.min),
      max: c.max === null ? '' : String(c.max),
    })),
    closingColumn: board.closingColumn ?? null,
    statusMapping: {},
    lanesMode: board.swimlanes.mode,
    lanes: board.swimlanes.lanes.map((l) => ({ key: newKey(), ...l })),
    unassigned: board.swimlanes.unassigned,
    otherName: board.swimlanes.otherName,
    filters: board.boardFilters.map((f) => ({ key: newKey(), ...f })),
    filterDisplay: board.boardFilterDisplay,
    colourBy: board.cardRules.colourBy,
    colours: board.cardRules.colours.map((c) => ({ key: newKey(), ...c })),
    fields: [...board.cardRules.fields],
    daysInColumn: board.cardRules.daysInColumn,
    sprint: sprintDraftOf(board.sprintSettings, timeZone),
  };
}

const limit = (text: string) => (text.trim() === '' ? null : Math.max(0, Math.floor(Number(text))));
const withoutKey = <T extends Keyed & { id?: string | undefined }>({
  key: _key,
  id,
  ...rest
}: T) => (id === undefined ? rest : { id, ...rest });

function patchOf(draft: Draft, version: number): BoardPatch {
  return {
    version,
    name: draft.name.trim(),
    kind: draft.kind,
    teamId: draft.teamId === '' ? null : Number(draft.teamId),
    source: sourceOf(draft.query),
    subFilter: draft.subFilter.trim() === '' ? null : { query: draft.subFilter.trim() },
    columns: draft.columns.map((c) => ({
      ...(c.id === undefined ? {} : { id: c.id }),
      name: c.name.trim(),
      statusIds: c.statusIds,
      min: limit(c.min),
      max: limit(c.max),
    })),
    closingColumn: draft.closingColumn,
    ...(Object.keys(draft.statusMapping).length > 0 ? { statusMapping: draft.statusMapping } : {}),
    swimlanes: {
      mode: draft.lanesMode,
      lanes: draft.lanes.map(withoutKey),
      unassigned: draft.unassigned,
      otherName: draft.otherName.trim(),
    },
    boardFilters: draft.filters.map(withoutKey),
    boardFilterDisplay: draft.filterDisplay,
    cardRules: {
      colourBy: draft.colourBy,
      colours: draft.colours.map(withoutKey),
      fields: draft.fields,
      daysInColumn: draft.daysInColumn,
    },
    // Sprint settings belong to Scrum boards; a board turning Kanban keeps its stored ones.
    ...(draft.kind === 'scrum' ? { sprintSettings: sprintSettingsOf(draft.sprint) } : {}),
  };
}

/** A column being removed while it holds cards. */
interface Removing {
  key: string;
  count: number;
}

/** Asks where a removed column's tickets go (the user's decision, ADR-116). */
function RemoveColumn({
  column,
  count,
  others,
  onDone,
  onCancel,
}: {
  column: ColumnDraft;
  count: number;
  others: ColumnDraft[];
  onDone: (statusId: number) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const id = useId();
  const [target, setTarget] = useState(String(others[0]?.statusIds[0] ?? ''));
  return (
    <fieldset className="board-settings-remove">
      <legend>{t('boards.settings.remove.ask', { column: column.name, count })}</legend>
      <label htmlFor={`${id}-to`} className="form-label">
        {t('boards.settings.remove.to')}
      </label>
      <select id={`${id}-to`} value={target} onChange={(e) => setTarget(e.target.value)}>
        {others.map((c) => (
          <option key={c.key} value={c.statusIds[0]}>
            {c.name}
          </option>
        ))}
      </select>
      <div className="form-actions">
        <button
          type="button"
          className="button-primary"
          disabled={target === ''}
          onClick={() => onDone(Number(target))}
        >
          {t('boards.settings.remove.confirm')}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('boards.choose.cancel')}
        </button>
      </div>
    </fieldset>
  );
}

/** Says at once when no card can reach a column, what fixing it does, and who can. */
function ColumnReachNote({
  name,
  problem,
  reach,
  fixing,
  onFix,
}: {
  name: string;
  problem: 'no_status' | 'no_path';
  reach: BoardReach;
  fixing: boolean;
  onFix: () => void;
}) {
  const t = useT();
  const shared = reach.otherTracks.length > 0;
  return (
    <aside className="board-settings-reach">
      <p>
        {t(
          problem === 'no_status'
            ? 'boards.settings.reach.noStatus'
            : 'boards.settings.reach.noPath',
          {
            column: name,
          },
        )}
      </p>
      {reach.mayFix && reach.singleWorkflow ? (
        <>
          {shared && (
            <p className="form-hint">
              {t('boards.settings.reach.shared', {
                workflow: reach.workflow?.name ?? '',
                tracks: reach.otherTracks.join(', '),
              })}
            </p>
          )}
          <button type="button" className="button-secondary" disabled={fixing} onClick={onFix}>
            {t('boards.settings.reach.fix', { column: name })}
          </button>
        </>
      ) : (
        <p className="form-hint">{t('boards.settings.reach.whoCan')}</p>
      )}
    </aside>
  );
}

/** The list with item `at` moved one place up (-1) or down (1). */
function moved<T>(list: readonly T[], at: number, step: -1 | 1): T[] {
  const to = at + step;
  if (to < 0 || to >= list.length) return [...list];
  const out = [...list];
  [out[at], out[to]] = [out[to] as T, out[at] as T];
  return out;
}

/** Why a board cannot manage its track's workflow (M1-126), as the server says it. */
const MANAGE_PROBLEMS: Record<string, MessageId> = {
  shared_mode_track: 'boards.settings.managed.sharedMode',
  per_type_workflows: 'boards.settings.managed.perType',
  shared_workflow: 'boards.settings.managed.sharedWorkflow',
  another_board_manages: 'boards.settings.managed.another',
  one_status_per_column: 'boards.settings.managed.oneStatus',
  migration_running: 'boards.settings.managed.migration',
};

const FIELD_LABELS: Record<(typeof CARD_FIELDS)[number], MessageId> = {
  assignee: 'boards.settings.field.assignee',
  priority: 'boards.settings.field.priority',
  points: 'boards.settings.field.points',
  dueDate: 'boards.settings.field.dueDate',
  startDate: 'boards.settings.field.startDate',
  labels: 'boards.settings.field.labels',
  targetReleases: 'boards.settings.field.targetReleases',
  areas: 'boards.settings.field.areas',
  requester: 'boards.settings.field.requester',
  parent: 'boards.settings.field.parent',
  track: 'boards.settings.field.track',
  voteCount: 'boards.settings.field.voteCount',
  followerCount: 'boards.settings.field.followerCount',
  timeTracking: 'boards.settings.field.timeTracking',
  createdAt: 'boards.settings.field.createdAt',
  updatedAt: 'boards.settings.field.updatedAt',
};

/** What a board's settings sit under: its track's name, or the board's own outside any track. */
const placeOf = (board: Board) =>
  board.location.type === 'track' && board.location.track.key
    ? (board.location.track.name ?? board.location.track.key)
    : board.name;

/**
 * A board's settings (M1-043; AGL-002 to AGL-006, AGL-014), for its board admins and the
 * administrators of its track: name, kind, query and sub-filter; columns with their minimum
 * and maximum and the status each takes (one column at most, or none: unmapped); swimlanes;
 * board filters and how they show; card colours, fields and days in column; on a Scrum board
 * its sprint settings (M1-044, M1-045). Everything saves at once with the version it was read
 * at; the server checks every query and setting, and its refusals show next to their fields.
 */
export function BoardSettingsPage({ boardId, client = boardClient }: BoardSettingsPageProps) {
  const t = useT();
  const id = useId();
  const { session } = useSession();
  // A new cycle runs on the person's time zone, or the server's default.
  const timeZone = (session.status === 'signed-in' && session.user.timeZone) || 'UTC';
  const [board, setBoard] = useState<Board | null>(null);
  const [numberFields, setNumberFields] = useState<NumberField[]>([]);
  const [teams, setTeams] = useState<{ id: number; name: string }[]>([]);
  const [statuses, setStatuses] = useState<BoardStatus[]>([]);
  const [reach, setReach] = useState<BoardReach | null>(null);
  const [removing, setRemoving] = useState<Removing | null>(null);
  const [fixing, setFixing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ kind: 'saved' | 'failed' | 'conflict' } | null>(null);
  const [busy, setBusy] = useState(false);
  const [manageProblem, setManageProblem] = useState<string | null>(null);
  const noticeRef = useRef<HTMLParagraphElement | null>(null);

  /** Once the person has changed something, a late answer (their time zone, say) leaves it be. */
  const edited = useRef(false);
  useEffect(() => {
    client.settings(boardId).then(
      (read) => {
        setBoard(read.board);
        setStatuses(read.statuses);
        setReach(read.reach ?? null);
        if (!edited.current) setDraft(draftOf(read.board, timeZone));
        setState('loaded');
      },
      () => setState('failed'),
    );
  }, [client, boardId, timeZone]);

  useEffect(() => {
    // Without the list the picker still shows the board's field by its id.
    client.numberFields().then(setNumberFields, () => setNumberFields([]));
    // Likewise the board's own team stays choosable without the list.
    client.teams().then(setTeams, () => setTeams([]));
  }, [client]);

  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);

  if (state === 'loading') return <p className="report-loading">{t('boards.loading')}</p>;
  if (state === 'failed' || !board || !draft) {
    return (
      <section className="page board-settings" aria-labelledby={`${id}-title`}>
        <PageHeader
          titleId={`${id}-title`}
          title={t('boards.settings.link')}
          purpose={t('purpose.boardSettings')}
        />
        <p className="page-note" role="alert">
          {t('boards.failed')}
        </p>
      </section>
    );
  }
  if (!board.mayConfigure) {
    return (
      <section className="page board-settings" aria-labelledby={`${id}-title`}>
        <PageHeader
          titleId={`${id}-title`}
          title={t('boards.settings.link')}
          eyebrow={placeOf(board)}
          purpose={t('purpose.boardSettings')}
          about={t('boards.settings.about')}
        />
        <p className="page-note">{t('boards.settings.readOnly')}</p>
      </section>
    );
  }

  const set = (change: Partial<Draft>) => {
    edited.current = true;
    setDraft({ ...draft, ...change });
  };
  const problem = (path: string) => problems[path];
  const invalid = (path: string, inputId: string) =>
    problem(path)
      ? { 'aria-invalid': true as const, 'aria-describedby': `${inputId}-problem` }
      : {};
  const problemText = (path: string, inputId: string): ReactNode =>
    problem(path) ? (
      <p id={`${inputId}-problem`} className="form-error">
        {problem(path) === 'invalid_query'
          ? t('boards.settings.invalidQuery')
          : problem(path) === 'sprint_running'
            ? t('boards.settings.sprintRunning')
            : t('boards.settings.invalidValue')}
      </p>
    ) : null;

  // A board on a saved search reports a saved search it cannot use on its query (M1-063).
  const sourcePath = problem('source.savedSearchId') ? 'source.savedSearchId' : 'source.query';
  const columnOfStatus = (statusId: number) =>
    draft.columns.find((c) => c.statusIds.includes(statusId))?.key ?? '';
  const mapStatus = (statusId: number, columnKey: string) =>
    set({
      columns: draft.columns.map((c) => ({
        ...c,
        statusIds:
          c.key === columnKey
            ? [...c.statusIds.filter((s) => s !== statusId), statusId]
            : c.statusIds.filter((s) => s !== statusId),
      })),
    });
  // Statuses mapped on the board but no longer among its workflows' still show.
  const known = new Set(statuses.map((s) => s.id));
  const extra = draft.columns
    .flatMap((c) => c.statusIds)
    .filter((s) => !known.has(s))
    .map((s) => ({ id: s, name: String(s), stage: '', columnId: null }));

  /** A column holding cards asks where they go; only a board managing its workflow moves them. */
  async function removeColumn(column: ColumnDraft) {
    const drop = () =>
      set({ columns: (draft as Draft).columns.filter((c) => c.key !== column.key) });
    if (!board?.managesWorkflow || !column.id) {
      drop();
      return;
    }
    try {
      const data = await client.data(boardId, []);
      const count = data.columns.find((c) => c.id === column.id)?.count ?? 0;
      if (count === 0) drop();
      else setRemoving({ key: column.key, count });
    } catch {
      setRemoving({ key: column.key, count: 0 });
    }
  }

  async function fixColumn(columnId: string) {
    setFixing(columnId);
    try {
      await client.addColumnPath(boardId, columnId);
      const read = await client.settings(boardId);
      setBoard(read.board);
      setStatuses(read.statuses);
      setReach(read.reach ?? null);
      setDraft(draftOf(read.board, timeZone));
      setNotice({ kind: 'saved' });
    } catch {
      setNotice({ kind: 'failed' });
    } finally {
      setFixing(null);
    }
  }

  async function manage(managed: boolean) {
    if (!board || !client.manageWorkflow) return;
    setBusy(true);
    setManageProblem(null);
    setNotice(null);
    try {
      const outcome = await client.manageWorkflow(boardId, managed);
      if (outcome.ok) {
        setBoard(outcome.board);
        setDraft(draftOf(outcome.board, timeZone));
        setNotice({ kind: 'saved' });
      } else {
        setManageProblem(outcome.problem);
      }
    } catch {
      setManageProblem('failed');
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!draft || !board) return;
    setBusy(true);
    setProblems({});
    setNotice(null);
    try {
      const outcome = await client.update(boardId, patchOf(draft, board.version));
      if (outcome.ok) {
        // The Backlog tab comes or goes at once, without a reload (ADR-116).
        if (outcome.board.kind !== board.kind && outcome.board.location.type === 'track') {
          trackSectionsChanged(outcome.board.location.track.key ?? '');
        }
        setBoard(outcome.board);
        setDraft(draftOf(outcome.board, timeZone));
        setNotice({ kind: 'saved' });
      } else if (outcome.conflict) {
        setNotice({ kind: 'conflict' });
      } else {
        setProblems(outcome.fields);
        setNotice({ kind: 'failed' });
      }
    } catch {
      setNotice({ kind: 'failed' });
    } finally {
      setBusy(false);
    }
  }

  const rowButtons = (
    label: string,
    at: number,
    length: number,
    onMove: (step: -1 | 1) => void,
    onRemove: (() => void) | null,
  ) => (
    <div className="board-settings-row-actions">
      <button
        type="button"
        className="button-secondary"
        disabled={at === 0}
        onClick={() => onMove(-1)}
      >
        {t('boards.settings.up', { item: label })}
      </button>
      <button
        type="button"
        className="button-secondary"
        disabled={at === length - 1}
        onClick={() => onMove(1)}
      >
        {t('boards.settings.down', { item: label })}
      </button>
      {onRemove && (
        <button type="button" className="button-secondary" onClick={onRemove}>
          {t('boards.settings.remove', { item: label })}
        </button>
      )}
    </div>
  );

  return (
    <section className="page board-settings" aria-labelledby={`${id}-title`}>
      <PageHeader
        titleId={`${id}-title`}
        // 'Board settings' under the track's name, like the track's other pages (D26); inside a
        // track the Board tab leads back, so no pill repeats it (D7).
        title={t('boards.settings.link')}
        eyebrow={placeOf(board)}
        purpose={t('purpose.boardSettings')}
        about={t('boards.settings.about')}
        actions={
          board.location.type === 'track' && board.location.track.key ? undefined : (
            <a className="button-quiet" href={routeHref(`#/boards/${boardId}`)}>
              {t('boards.settings.back')}
            </a>
          )
        }
      />
      {notice && (
        <p
          ref={noticeRef}
          tabIndex={-1}
          className={notice.kind === 'saved' ? 'page-note' : 'board-problem'}
          role={notice.kind === 'saved' ? 'status' : 'alert'}
        >
          {t(
            notice.kind === 'saved'
              ? 'boards.settings.saved'
              : notice.kind === 'conflict'
                ? 'boards.settings.conflict'
                : 'boards.settings.failed',
          )}
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset className="glass-card board-settings-section">
          <legend>{t('boards.settings.general')}</legend>
          <div className="form-field">
            <label htmlFor={`${id}-name`} className="form-label">
              {t('boards.create.name')}
            </label>
            <input
              id={`${id}-name`}
              type="text"
              required
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
            />
          </div>
          <div className="form-field">
            <label htmlFor={`${id}-kind`} className="form-label">
              {t('boards.create.kind')}
            </label>
            <select
              id={`${id}-kind`}
              value={draft.kind}
              onChange={(e) => set({ kind: e.target.value === 'scrum' ? 'scrum' : 'kanban' })}
              {...invalid('kind', `${id}-kind`)}
            >
              <option value="kanban">{t('boards.kind.kanban')}</option>
              <option value="scrum">{t('boards.kind.scrum')}</option>
            </select>
            {problemText('kind', `${id}-kind`)}
          </div>
          <div className="form-field">
            <label htmlFor={`${id}-team`} className="form-label">
              {t('boards.settings.team')}
            </label>
            <select
              id={`${id}-team`}
              value={draft.teamId}
              aria-describedby={`${id}-team-hint`}
              onChange={(e) => set({ teamId: e.target.value })}
              {...invalid('teamId', `${id}-team`)}
            >
              <option value="">{t('boards.settings.noTeam')}</option>
              {(board.team && !teams.some((x) => x.id === board.team?.id)
                ? [...teams, board.team]
                : teams
              ).map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
            <p id={`${id}-team-hint`} className="form-hint">
              {t('boards.settings.teamHint')}
            </p>
            {problemText('teamId', `${id}-team`)}
          </div>
          <div className="form-field">
            <label htmlFor={`${id}-query`} className="form-label">
              {t('boards.create.query')}
            </label>
            <input
              id={`${id}-query`}
              type="text"
              required
              value={draft.query}
              onChange={(e) => set({ query: e.target.value })}
              {...invalid(sourcePath, `${id}-query`)}
            />
            {problemText(sourcePath, `${id}-query`)}
          </div>
          <div className="form-field">
            <label htmlFor={`${id}-sub`} className="form-label">
              {t('boards.settings.subFilter')}
            </label>
            <input
              id={`${id}-sub`}
              type="text"
              value={draft.subFilter}
              aria-describedby={`${id}-sub-hint`}
              onChange={(e) => set({ subFilter: e.target.value })}
              {...invalid('subFilter.query', `${id}-sub`)}
            />
            <p id={`${id}-sub-hint`} className="form-hint">
              {t('boards.settings.subFilterHint')}
            </p>
            {problemText('subFilter.query', `${id}-sub`)}
          </div>
        </fieldset>

        <fieldset className="glass-card board-settings-section">
          <legend>{t('boards.settings.columns')}</legend>
          {board.location.type === 'track' && client.manageWorkflow && (
            <div className="board-settings-workflow">
              <div className="form-field form-field-inline">
                <input
                  id={`${id}-managed`}
                  type="checkbox"
                  checked={board.managesWorkflow === true}
                  disabled={busy}
                  aria-describedby={`${id}-managed-hint`}
                  onChange={(e) => void manage(e.target.checked)}
                />
                <label htmlFor={`${id}-managed`}>{t('boards.settings.managed')}</label>
              </div>
              <p id={`${id}-managed-hint`} className="form-hint">
                {t(
                  board.managesWorkflow
                    ? 'boards.settings.managedOnHint'
                    : 'boards.settings.managedHint',
                )}
              </p>
              {manageProblem && (
                <p role="alert" className="form-error">
                  {t(MANAGE_PROBLEMS[manageProblem] ?? 'boards.settings.managedFailed')}
                </p>
              )}
            </div>
          )}
          <ol className="board-settings-list">
            {draft.columns.map((column, at) => {
              const label = column.name || t('boards.settings.columnN', { n: at + 1 });
              const update = (change: Partial<ColumnDraft>) =>
                set({
                  columns: draft.columns.map((c) =>
                    c.key === column.key ? { ...c, ...change } : c,
                  ),
                });
              return (
                <li key={column.key} className="board-settings-item">
                  <div className="form-field">
                    <label htmlFor={`${id}-${column.key}-name`} className="form-label">
                      {t('boards.settings.columnName', { n: at + 1 })}
                    </label>
                    <input
                      id={`${id}-${column.key}-name`}
                      type="text"
                      required
                      value={column.name}
                      onChange={(e) => update({ name: e.target.value })}
                    />
                  </div>
                  <div className="board-settings-limits">
                    <div className="form-field">
                      <label htmlFor={`${id}-${column.key}-min`} className="form-label">
                        {t('boards.settings.min', { column: label })}
                      </label>
                      <input
                        id={`${id}-${column.key}-min`}
                        type="number"
                        min={0}
                        inputMode="numeric"
                        value={column.min}
                        onChange={(e) => update({ min: e.target.value })}
                      />
                    </div>
                    <div className="form-field">
                      <label htmlFor={`${id}-${column.key}-max`} className="form-label">
                        {t('boards.settings.max', { column: label })}
                      </label>
                      <input
                        id={`${id}-${column.key}-max`}
                        type="number"
                        min={0}
                        inputMode="numeric"
                        value={column.max}
                        onChange={(e) => update({ max: e.target.value })}
                      />
                    </div>
                  </div>
                  {rowButtons(
                    label,
                    at,
                    draft.columns.length,
                    (step) => set({ columns: moved(draft.columns, at, step) }),
                    draft.columns.length > 1 ? () => void removeColumn(column) : null,
                  )}
                  {removing?.key === column.key && (
                    <RemoveColumn
                      column={column}
                      count={removing.count}
                      others={draft.columns.filter(
                        (c) => c.key !== column.key && c.statusIds.length === 1,
                      )}
                      onDone={(target) => {
                        const from = column.statusIds[0];
                        set({
                          columns: draft.columns.filter((c) => c.key !== column.key),
                          statusMapping:
                            from === undefined
                              ? draft.statusMapping
                              : { ...draft.statusMapping, [from]: target },
                        });
                        setRemoving(null);
                      }}
                      onCancel={() => setRemoving(null)}
                    />
                  )}
                  {column.id && reach?.columns[column.id] && reach.columns[column.id] !== 'ok' && (
                    <ColumnReachNote
                      name={label}
                      problem={reach.columns[column.id] as 'no_status' | 'no_path'}
                      reach={reach}
                      fixing={fixing === column.id}
                      onFix={() => void fixColumn(column.id as string)}
                    />
                  )}
                </li>
              );
            })}
          </ol>
          <button
            type="button"
            className="button-secondary"
            onClick={() =>
              set({
                columns: [
                  ...draft.columns,
                  { key: newKey(), name: '', statusIds: [], min: '', max: '' },
                ],
              })
            }
          >
            {t('boards.settings.addColumn')}
          </button>
          {board.managesWorkflow && (
            <div className="form-field">
              <label htmlFor={`${id}-closing`} className="form-label">
                {t('boards.settings.closing')}
              </label>
              <select
                id={`${id}-closing`}
                aria-describedby={`${id}-closing-hint`}
                value={draft.closingColumn ?? ''}
                onChange={(e) => set({ closingColumn: e.target.value || null })}
              >
                <option value="">
                  {t('boards.settings.closing.rightmost', {
                    column: draft.columns.at(-1)?.name ?? '',
                  })}
                </option>
                {draft.columns.map((c) =>
                  c.id ? (
                    <option key={c.key} value={c.id}>
                      {c.name}
                    </option>
                  ) : null,
                )}
                <option value="none">{t('boards.settings.closing.none')}</option>
              </select>
              <p id={`${id}-closing-hint`} className="form-hint">
                {t('boards.settings.closing.hint')}
              </p>
            </div>
          )}
          {problem('columns') && MANAGE_PROBLEMS[problem('columns') as string] ? (
            <p role="alert" className="form-error">
              {t(MANAGE_PROBLEMS[problem('columns') as string] as MessageId)}
            </p>
          ) : (
            problemText('columns', `${id}-columns`)
          )}
          {!board.managesWorkflow && (
            <table className="data-table board-settings-statuses">
              <caption>{t('boards.settings.statuses')}</caption>
              <thead>
                <tr>
                  <th scope="col">{t('boards.settings.status')}</th>
                  <th scope="col">{t('boards.settings.column')}</th>
                </tr>
              </thead>
              <tbody>
                {[...statuses, ...extra].map((status) => (
                  <tr key={status.id}>
                    <th scope="row">{status.name}</th>
                    <td>
                      <select
                        aria-label={t('boards.settings.columnOf', { status: status.name })}
                        value={columnOfStatus(status.id)}
                        onChange={(e) => mapStatus(status.id, e.target.value)}
                      >
                        <option value="">{t('boards.settings.unmapped')}</option>
                        {draft.columns.map((c, at) => (
                          <option key={c.key} value={c.key}>
                            {c.name || t('boards.settings.columnN', { n: at + 1 })}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </fieldset>

        <fieldset className="glass-card board-settings-section">
          <legend>{t('boards.settings.swimlanes')}</legend>
          <div className="form-field">
            <label htmlFor={`${id}-mode`} className="form-label">
              {t('boards.settings.laneMode')}
            </label>
            <select
              id={`${id}-mode`}
              value={draft.lanesMode}
              onChange={(e) => set({ lanesMode: e.target.value as Swimlanes['mode'] })}
            >
              <option value="none">{t('boards.settings.laneMode.none')}</option>
              <option value="queries">{t('boards.settings.laneMode.queries')}</option>
              <option value="assignees">{t('boards.settings.laneMode.assignees')}</option>
              <option value="parents">{t('boards.settings.laneMode.parents')}</option>
            </select>
          </div>
          {draft.lanesMode === 'assignees' && (
            <div className="form-field">
              <label htmlFor={`${id}-unassigned`} className="form-label">
                {t('boards.settings.unassigned')}
              </label>
              <select
                id={`${id}-unassigned`}
                value={draft.unassigned}
                onChange={(e) => set({ unassigned: e.target.value === 'first' ? 'first' : 'last' })}
              >
                <option value="first">{t('boards.settings.unassigned.first')}</option>
                <option value="last">{t('boards.settings.unassigned.last')}</option>
              </select>
            </div>
          )}
          {draft.lanesMode === 'queries' && (
            <>
              <ol className="board-settings-list">
                {draft.lanes.map((lane, at) => {
                  const label = lane.name || t('boards.settings.laneN', { n: at + 1 });
                  const update = (change: Partial<LaneDraft>) =>
                    set({
                      lanes: draft.lanes.map((l) => (l.key === lane.key ? { ...l, ...change } : l)),
                    });
                  const queryId = `${id}-${lane.key}-query`;
                  return (
                    <li key={lane.key} className="board-settings-item">
                      <div className="form-field">
                        <label htmlFor={`${id}-${lane.key}-name`} className="form-label">
                          {t('boards.settings.laneName', { n: at + 1 })}
                        </label>
                        <input
                          id={`${id}-${lane.key}-name`}
                          type="text"
                          required
                          value={lane.name}
                          onChange={(e) => update({ name: e.target.value })}
                        />
                      </div>
                      <div className="form-field">
                        <label htmlFor={queryId} className="form-label">
                          {t('boards.settings.laneQuery', { lane: label })}
                        </label>
                        <input
                          id={queryId}
                          type="text"
                          required
                          value={lane.query}
                          onChange={(e) => update({ query: e.target.value })}
                          {...invalid(`swimlanes.lanes.${at}.query`, queryId)}
                        />
                        {problemText(`swimlanes.lanes.${at}.query`, queryId)}
                      </div>
                      {rowButtons(
                        label,
                        at,
                        draft.lanes.length,
                        (step) => set({ lanes: moved(draft.lanes, at, step) }),
                        () => set({ lanes: draft.lanes.filter((l) => l.key !== lane.key) }),
                      )}
                    </li>
                  );
                })}
              </ol>
              <button
                type="button"
                className="button-secondary"
                onClick={() =>
                  set({ lanes: [...draft.lanes, { key: newKey(), name: '', query: '' }] })
                }
              >
                {t('boards.settings.addLane')}
              </button>
              <div className="form-field">
                <label htmlFor={`${id}-other`} className="form-label">
                  {t('boards.settings.otherName')}
                </label>
                <input
                  id={`${id}-other`}
                  type="text"
                  required
                  value={draft.otherName}
                  onChange={(e) => set({ otherName: e.target.value })}
                />
              </div>
            </>
          )}
        </fieldset>

        <fieldset className="glass-card board-settings-section">
          <legend>{t('boards.filters')}</legend>
          <ol className="board-settings-list">
            {draft.filters.map((filter, at) => {
              const label = filter.name || t('boards.settings.filterN', { n: at + 1 });
              const update = (change: Partial<FilterDraft>) =>
                set({
                  filters: draft.filters.map((f) =>
                    f.key === filter.key ? { ...f, ...change } : f,
                  ),
                });
              const queryId = `${id}-${filter.key}-query`;
              return (
                <li key={filter.key} className="board-settings-item">
                  <div className="form-field">
                    <label htmlFor={`${id}-${filter.key}-name`} className="form-label">
                      {t('boards.settings.filterName', { n: at + 1 })}
                    </label>
                    <input
                      id={`${id}-${filter.key}-name`}
                      type="text"
                      required
                      value={filter.name}
                      onChange={(e) => update({ name: e.target.value })}
                    />
                  </div>
                  <div className="form-field">
                    <label htmlFor={queryId} className="form-label">
                      {t('boards.settings.filterQuery', { filter: label })}
                    </label>
                    <input
                      id={queryId}
                      type="text"
                      required
                      value={filter.query}
                      onChange={(e) => update({ query: e.target.value })}
                      {...invalid(`boardFilters.${at}.query`, queryId)}
                    />
                    {problemText(`boardFilters.${at}.query`, queryId)}
                  </div>
                  <div className="form-field">
                    <label htmlFor={`${id}-${filter.key}-description`} className="form-label">
                      {t('boards.settings.filterDescription', { filter: label })}
                    </label>
                    <input
                      id={`${id}-${filter.key}-description`}
                      type="text"
                      value={filter.description}
                      onChange={(e) => update({ description: e.target.value })}
                    />
                  </div>
                  {rowButtons(
                    label,
                    at,
                    draft.filters.length,
                    (step) => set({ filters: moved(draft.filters, at, step) }),
                    () => set({ filters: draft.filters.filter((f) => f.key !== filter.key) }),
                  )}
                </li>
              );
            })}
          </ol>
          <button
            type="button"
            className="button-secondary"
            onClick={() =>
              set({
                filters: [
                  ...draft.filters,
                  { key: newKey(), name: '', query: '', description: '' },
                ],
              })
            }
          >
            {t('boards.settings.addFilter')}
          </button>
          <div className="form-field">
            <label htmlFor={`${id}-display`} className="form-label">
              {t('boards.settings.filterDisplay')}
            </label>
            <select
              id={`${id}-display`}
              value={draft.filterDisplay}
              onChange={(e) =>
                set({ filterDisplay: e.target.value === 'dropdown' ? 'dropdown' : 'buttons' })
              }
            >
              <option value="buttons">{t('boards.settings.filterDisplay.buttons')}</option>
              <option value="dropdown">{t('boards.settings.filterDisplay.dropdown')}</option>
            </select>
          </div>
        </fieldset>

        <fieldset className="glass-card board-settings-section">
          <legend>{t('boards.settings.cards')}</legend>
          <div className="form-field">
            <label htmlFor={`${id}-colour`} className="form-label">
              {t('boards.settings.colourBy')}
            </label>
            <select
              id={`${id}-colour`}
              value={draft.colourBy}
              onChange={(e) => set({ colourBy: e.target.value as CardRules['colourBy'] })}
            >
              <option value="none">{t('boards.settings.colourBy.none')}</option>
              <option value="type">{t('boards.settings.colourBy.type')}</option>
              <option value="priority">{t('boards.settings.colourBy.priority')}</option>
              <option value="assignee">{t('boards.settings.colourBy.assignee')}</option>
              <option value="queries">{t('boards.settings.colourBy.queries')}</option>
            </select>
          </div>
          {draft.colourBy === 'queries' && (
            <>
              <ol className="board-settings-list">
                {draft.colours.map((rule, at) => {
                  const label = t('boards.settings.ruleN', { n: at + 1 });
                  const update = (change: Partial<ColourDraft>) =>
                    set({
                      colours: draft.colours.map((r) =>
                        r.key === rule.key ? { ...r, ...change } : r,
                      ),
                    });
                  const queryId = `${id}-${rule.key}-query`;
                  return (
                    <li key={rule.key} className="board-settings-item">
                      <div className="form-field">
                        <label htmlFor={queryId} className="form-label">
                          {t('boards.settings.ruleQuery', { rule: label })}
                        </label>
                        <input
                          id={queryId}
                          type="text"
                          required
                          value={rule.query}
                          onChange={(e) => update({ query: e.target.value })}
                          {...invalid(`cardRules.colours.${at}.query`, queryId)}
                        />
                        {problemText(`cardRules.colours.${at}.query`, queryId)}
                      </div>
                      <div className="form-field">
                        <label htmlFor={`${id}-${rule.key}-colour`} className="form-label">
                          {t('boards.settings.ruleColour', { rule: label })}
                        </label>
                        <input
                          id={`${id}-${rule.key}-colour`}
                          type="color"
                          value={rule.colour}
                          onChange={(e) => update({ colour: e.target.value })}
                        />
                      </div>
                      {rowButtons(
                        label,
                        at,
                        draft.colours.length,
                        (step) => set({ colours: moved(draft.colours, at, step) }),
                        () => set({ colours: draft.colours.filter((r) => r.key !== rule.key) }),
                      )}
                    </li>
                  );
                })}
              </ol>
              <button
                type="button"
                className="button-secondary"
                onClick={() =>
                  set({
                    colours: [...draft.colours, { key: newKey(), query: '', colour: '#2f6fdb' }],
                  })
                }
              >
                {t('boards.settings.addRule')}
              </button>
            </>
          )}
          <fieldset className="board-settings-fields">
            <legend>{t('boards.settings.fields', { max: MAX_CARD_FIELDS })}</legend>
            {CARD_FIELDS.map((field) => {
              const on = draft.fields.includes(field);
              return (
                <label key={field} className="board-settings-check">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!on && draft.fields.length >= MAX_CARD_FIELDS}
                    onChange={() =>
                      set({
                        fields: on
                          ? draft.fields.filter((f) => f !== field)
                          : [...draft.fields, field],
                      })
                    }
                  />
                  {t(FIELD_LABELS[field])}
                </label>
              );
            })}
          </fieldset>
          <label className="board-settings-check">
            <input
              type="checkbox"
              checked={draft.daysInColumn}
              onChange={(e) => set({ daysInColumn: e.target.checked })}
            />
            {t('boards.settings.daysInColumn')}
          </label>
        </fieldset>

        {draft.kind === 'scrum' && (
          <SprintSettingsSection
            value={draft.sprint}
            onChange={(change) => set({ sprint: { ...draft.sprint, ...change } })}
            numberFields={numberFields}
            problems={problems}
          />
        )}

        <div className="form-actions">
          <button type="submit" className="button-primary" disabled={busy}>
            {t('boards.settings.save')}
          </button>
        </div>
      </form>
    </section>
  );
}
