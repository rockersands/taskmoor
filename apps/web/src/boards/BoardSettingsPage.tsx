import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { useSession } from '../session/SessionProvider';
import type { NumberField } from '../sprints/client';
import {
  type SprintDraft,
  SprintSettingsSection,
  sprintDraftOf,
  sprintSettingsOf,
} from '../sprints/SprintSettingsSection';
import {
  type Board,
  type BoardClient,
  type BoardPatch,
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
  query: string;
  subFilter: string;
  columns: ColumnDraft[];
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
    source: sourceOf(draft.query),
    subFilter: draft.subFilter.trim() === '' ? null : { query: draft.subFilter.trim() },
    columns: draft.columns.map((c) => ({
      ...(c.id === undefined ? {} : { id: c.id }),
      name: c.name.trim(),
      statusIds: c.statusIds,
      min: limit(c.min),
      max: limit(c.max),
    })),
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

/** The list with item `at` moved one place up (-1) or down (1). */
function moved<T>(list: readonly T[], at: number, step: -1 | 1): T[] {
  const to = at + step;
  if (to < 0 || to >= list.length) return [...list];
  const out = [...list];
  [out[at], out[to]] = [out[to] as T, out[at] as T];
  return out;
}

const FIELD_LABELS: Record<(typeof CARD_FIELDS)[number], MessageId> = {
  assignee: 'boards.settings.field.assignee',
  priority: 'boards.settings.field.priority',
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
  const [statuses, setStatuses] = useState<BoardStatus[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<{ kind: 'saved' | 'failed' | 'conflict' } | null>(null);
  const [busy, setBusy] = useState(false);
  const noticeRef = useRef<HTMLParagraphElement | null>(null);

  useEffect(() => {
    client.settings(boardId).then(
      (read) => {
        setBoard(read.board);
        setStatuses(read.statuses);
        setDraft(draftOf(read.board, timeZone));
        setState('loaded');
      },
      () => setState('failed'),
    );
  }, [client, boardId, timeZone]);

  useEffect(() => {
    // Without the list the picker still shows the board's field by its id.
    client.numberFields().then(setNumberFields, () => setNumberFields([]));
  }, [client]);

  useEffect(() => {
    if (notice) noticeRef.current?.focus();
  }, [notice]);

  if (state === 'loading') return <p className="page-note">{t('boards.loading')}</p>;
  if (state === 'failed' || !board || !draft) {
    return (
      <p className="page-note" role="alert">
        {t('boards.failed')}
      </p>
    );
  }
  if (!board.mayConfigure) {
    return (
      <section className="board-settings">
        <h1 className="page-title">{t('boards.settings.title', { name: board.name })}</h1>
        <p className="page-note">{t('boards.settings.readOnly')}</p>
      </section>
    );
  }

  const set = (change: Partial<Draft>) => setDraft({ ...draft, ...change });
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

  async function save() {
    if (!draft || !board) return;
    setBusy(true);
    setProblems({});
    setNotice(null);
    try {
      const outcome = await client.update(boardId, patchOf(draft, board.version));
      if (outcome.ok) {
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
      <button type="button" disabled={at === 0} onClick={() => onMove(-1)}>
        {t('boards.settings.up', { item: label })}
      </button>
      <button type="button" disabled={at === length - 1} onClick={() => onMove(1)}>
        {t('boards.settings.down', { item: label })}
      </button>
      {onRemove && (
        <button type="button" onClick={onRemove}>
          {t('boards.settings.remove', { item: label })}
        </button>
      )}
    </div>
  );

  return (
    <section className="board-settings" aria-labelledby={`${id}-title`}>
      <h1 id={`${id}-title`} className="page-title">
        {t('boards.settings.title', { name: board.name })}
      </h1>
      <p>
        <a href={`#/boards/${boardId}`}>{t('boards.settings.back')}</a>
      </p>
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
        <fieldset className="board-settings-section">
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
            >
              <option value="kanban">{t('boards.kind.kanban')}</option>
              <option value="scrum">{t('boards.kind.scrum')}</option>
            </select>
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

        <fieldset className="board-settings-section">
          <legend>{t('boards.settings.columns')}</legend>
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
                    draft.columns.length > 1
                      ? () => set({ columns: draft.columns.filter((c) => c.key !== column.key) })
                      : null,
                  )}
                </li>
              );
            })}
          </ol>
          <button
            type="button"
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
          {problemText('columns', `${id}-columns`)}
          <table className="board-settings-statuses">
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
        </fieldset>

        <fieldset className="board-settings-section">
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

        <fieldset className="board-settings-section">
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

        <fieldset className="board-settings-section">
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
