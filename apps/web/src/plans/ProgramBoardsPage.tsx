import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useAdminAccess } from '../admin/access';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { DangerAction } from '../shell/DangerAction';
import { EmptyState } from '../shell/EmptyState';
import { ModalDialog } from '../shell/ModalDialog';
import { localDay } from '../timeline/client';
import { boardHref, type PlanView } from './address';
import {
  type BoardInput,
  type BoardSaved,
  type ProgramBoardClient,
  type ProgramBoardList,
  type ProgramBoardSummary,
  programBoardClient,
} from './programBoardClient';

export interface ProgramBoardsPageProps {
  planId: number;
  /** The plan's view in the address (its filters), carried to each board. */
  view?: PlanView;
  client?: ProgramBoardClient;
  /** Today, the first day a new board offers. */
  now?: () => Date;
}

/** How many periods a board shows at most. */
const MAX_PERIODS = 12;

/**
 * A plan's program boards (T-089d; PLN-008; ADR-122 stage 5): active ones first, each with its
 * Team field and periods. The plan's editors make, change, archive and delete them; a plan holds
 * any number. A board places cards by a Team field, so without one the page says to ask a site
 * administrator for it; to someone who may add fields, it says where, with a link (S3-PL-8).
 */
export function ProgramBoardsPage({
  planId,
  view,
  client = programBoardClient,
  now = () => new Date(),
}: ProgramBoardsPageProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const [list, setList] = useState<ProgramBoardList | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<ProgramBoardSummary | 'new' | null>(null);
  const [status, setStatus] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // A site or configuration administrator adds fields (the setup pages); they are not sent to ask.
  const access = useAdminAccess();
  const addsFields = access === 'site' || access === 'setup';

  const load = useCallback(
    () =>
      client.list(planId).then(
        (l) => {
          setList(l);
          setFailed(false);
        },
        () => setFailed(true),
      ),
    [client, planId],
  );
  useEffect(() => {
    void load();
  }, [load]);

  if (failed && !list) {
    return (
      <p className="board-problem" role="alert">
        {t('programBoards.failed')}
      </p>
    );
  }
  if (!list) return <p className="report-loading">{t('reports.loading')}</p>;

  const dayText = (day: string) =>
    intl.formatDate(new Date(`${day}T00:00:00Z`), {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  const noField = list.teamFields.length === 0;

  const archive = async (board: ProgramBoardSummary) => {
    setBusy(board.id);
    setProblem(null);
    const saved = await client.update(planId, board.id, {
      archived: !board.archived,
      version: board.version,
    });
    setBusy(null);
    if (!saved.ok) {
      setProblem(
        saved.error === 'version_conflict'
          ? t('programBoards.conflict')
          : t('programBoards.saveFailed'),
      );
      void load();
      return;
    }
    setStatus(
      t(board.archived ? 'programBoards.restored' : 'programBoards.archived', { name: board.name }),
    );
    void load();
  };

  // Delete asks first (D13). A refusal leaves the question open to try again or cancel; a deletion
  // takes the board's row, and its buttons, away, so the list's heading keeps the focus.
  const remove = async (board: ProgramBoardSummary) => {
    setBusy(board.id);
    setProblem(null);
    try {
      await client.remove(planId, board.id);
    } catch (error) {
      setProblem(t('programBoards.saveFailed'));
      throw error;
    } finally {
      setBusy(null);
    }
    heading.current?.focus();
    setStatus(t('programBoards.deleted', { name: board.name }));
    await load();
  };

  return (
    <section className="program-boards" aria-labelledby={`${id}-title`}>
      <div className="program-board-head">
        <h2 id={`${id}-title`} ref={heading} tabIndex={-1}>
          {t('programBoards.title')}
        </h2>
        {list.editable && !noField && (
          <button type="button" className="button-primary" onClick={() => setEditing('new')}>
            {t('programBoards.new')}
          </button>
        )}
      </div>
      <p className="board-hint">{t('programBoards.about')}</p>
      {noField && !addsFields && <p className="plan-notices">{t('programBoards.noField')}</p>}
      {noField && addsFields && (
        <p className="plan-notices">
          {t('programBoards.noFieldAdmin')}{' '}
          <a href={routeHref('#/admin/fields')}>{t('programBoards.openFields')}</a>
        </p>
      )}
      <p className="board-hint" role="status">
        {status}
      </p>
      {problem && (
        <p className="board-problem" role="alert">
          {problem}
        </p>
      )}
      {list.boards.length === 0 ? (
        <EmptyState compact title={t('programBoards.none')} />
      ) : (
        <ul className="program-board-list">
          {list.boards.map((board) => (
            <li key={board.id} className="glass-card program-board-row">
              <h3>
                <a href={routeHref(boardHref(planId, board.id, view))}>{board.name}</a>
                {board.archived && (
                  <span className="program-board-state"> · {t('programBoards.isArchived')}</span>
                )}
              </h3>
              <p className="board-hint">
                {board.teamField
                  ? t('programBoard.facts', {
                      field: board.teamField.name,
                      count: board.periods,
                      from: dayText(board.from),
                    })
                  : t('programBoard.noField')}
              </p>
              {list.editable && (
                <div className="form-actions">
                  <button
                    type="button"
                    className="button-secondary"
                    aria-label={t('programBoards.editNamed', { name: board.name })}
                    onClick={() => setEditing(board)}
                  >
                    {t('programBoards.edit')}
                  </button>
                  <button
                    type="button"
                    className="button-secondary"
                    disabled={busy === board.id}
                    aria-label={t(
                      board.archived ? 'programBoards.restoreNamed' : 'programBoards.archiveNamed',
                      { name: board.name },
                    )}
                    onClick={() => void archive(board)}
                  >
                    {t(board.archived ? 'programBoards.restore' : 'programBoards.archive')}
                  </button>
                  <DangerAction
                    label={t('programBoards.delete')}
                    name={t('programBoards.deleteNamed', { name: board.name })}
                    outcome={t('programBoards.deleteOutcome', { name: board.name })}
                    confirmLabel={t('programBoards.deleteNamed', { name: board.name })}
                    busy={busy === board.id}
                    onConfirm={() => remove(board)}
                  />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <BoardDialog
          board={editing === 'new' ? null : editing}
          teamFields={list.teamFields}
          today={localDay(now())}
          onSave={(input) =>
            editing === 'new'
              ? client.create(planId, input)
              : client.update(planId, editing.id, { ...input, version: editing.version })
          }
          onSaved={(board) => {
            setEditing(null);
            setStatus(t('programBoards.saved', { name: board.name }));
            void load();
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}

export interface BoardDialogProps {
  /** The board changed, or null for a new one. */
  board: ProgramBoardSummary | null;
  teamFields: { id: number; name: string }[];
  /** The day a new board starts from. */
  today: string;
  onSave: (input: BoardInput) => Promise<BoardSaved>;
  onSaved: (board: ProgramBoardSummary) => void;
  onClose: () => void;
}

/** A program board's name, Team field, first day and number of periods. */
export function BoardDialog({
  board,
  teamFields,
  today,
  onSave,
  onSaved,
  onClose,
}: BoardDialogProps) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState(board?.name ?? '');
  const [field, setField] = useState(board?.teamField?.id ?? teamFields[0]?.id ?? 0);
  const [from, setFrom] = useState(board?.from ?? today);
  const [periods, setPeriods] = useState(board?.periods ?? 6);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim()) {
      setProblem(t('programBoards.nameRequired'));
      return;
    }
    setBusy(true);
    setProblem(null);
    const saved = await onSave({
      name: name.trim(),
      ...(field ? { teamFieldId: field } : {}),
      from,
      periods,
    }).catch(() => null);
    setBusy(false);
    if (saved?.ok) {
      onSaved(saved.board);
      return;
    }
    setProblem(
      saved?.error === 'version_conflict'
        ? t('programBoards.conflict')
        : saved && 'teamFieldId' in saved.fields
          ? t('programBoards.fieldGone')
          : t('programBoards.saveFailed'),
    );
  };

  return (
    <ModalDialog
      onClose={onClose}
      labelledBy={`${id}-title`}
      closeLabel={t('programBoard.cancel')}
      focusFirstField
      className="program-board-dialog"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <h2 id={`${id}-title`}>
          {board ? t('programBoards.editTitle', { name: board.name }) : t('programBoards.new')}
        </h2>
        <label className="form-field" htmlFor={`${id}-name`}>
          <span className="form-label">{t('programBoards.name')}</span>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={255}
            required
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label className="form-field" htmlFor={`${id}-field`}>
          <span className="form-label">{t('programBoards.field')}</span>
          <select
            id={`${id}-field`}
            value={field}
            onChange={(event) => setField(Number(event.target.value))}
          >
            {teamFields.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <label className="form-field" htmlFor={`${id}-from`}>
          <span className="form-label">{t('programBoards.from')}</span>
          <input
            id={`${id}-from`}
            type="date"
            required
            value={from}
            onChange={(event) => setFrom(event.target.value)}
          />
        </label>
        <label className="form-field" htmlFor={`${id}-periods`}>
          <span className="form-label">{t('programBoards.periods')}</span>
          <select
            id={`${id}-periods`}
            value={periods}
            onChange={(event) => setPeriods(Number(event.target.value))}
          >
            {Array.from({ length: MAX_PERIODS }, (_, i) => i + 1).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <p className="board-hint">{t('programBoards.dialogHint')}</p>
        {problem && (
          <p className="board-problem" role="alert">
            {problem}
          </p>
        )}
        <div className="form-actions">
          <button type="submit" className="button-primary" disabled={busy}>
            {t('programBoards.save')}
          </button>
          <button type="button" className="button-secondary" onClick={onClose}>
            {t('programBoard.cancel')}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
