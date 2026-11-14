import { type FormEvent, useId, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { EmptyState } from '../shell/EmptyState';
import { ModalDialog } from '../shell/ModalDialog';
import type { MoveProblem } from './grid/tree';

/**
 * Why a row cannot move under a target, said before the server is asked (`moveProblem` in
 * `grid/tree.ts`). A wrong level names the level its parent must have, where the page knows it.
 */
export const MOVE_PROBLEM: Readonly<Record<MoveProblem, MessageId>> = {
  group_row: 'grid.move.no.groupRow',
  group_target: 'grid.move.no.group',
  placed_by_link: 'grid.move.no.link',
  own_rows: 'grid.move.no.own',
  same_parent: 'grid.move.no.same',
  wrong_level: 'grid.move.no.level',
  other_track: 'grid.move.no.track',
  required: 'grid.move.no.required',
};

/** What the ticket route said of a parent it refused (`fields.parent`), in the same words. */
const PARENT_REFUSED: Readonly<Record<string, MessageId>> = {
  wrong_level: 'grid.move.no.level',
  other_track: 'grid.move.no.track',
  required: 'grid.move.no.required',
  self: 'grid.move.no.own',
  not_found: 'grid.move.refused.parentGone',
};

/** A refusal of `PATCH /tickets/:id { parent, version }` in words; `stale` for a 409 of the version. */
export interface MoveRefusal {
  id: MessageId;
  stale?: boolean;
}

/**
 * The words of a move the ticket route refused: every check is its own (the hierarchy, the
 * placement rules, `edit_tickets`, the per-status locks, the version), and nothing moved.
 */
export function moveRefusal(error: unknown): MoveRefusal {
  if (!(error instanceof ApiError)) return { id: 'grid.move.refused.other' };
  const body = error.body as {
    error?: string;
    fields?: Record<string, string>;
    locks?: unknown[];
  } | null;
  if (error.status === 400) {
    const parent = body?.fields?.parent;
    return { id: (parent && PARENT_REFUSED[parent]) || 'grid.move.refused.invalid' };
  }
  if (error.status === 403) {
    return {
      id:
        body?.locks && body.locks.length > 0
          ? 'grid.move.refused.locked'
          : 'grid.move.refused.forbidden',
    };
  }
  if (error.status === 404) return { id: 'grid.move.refused.gone' };
  if (error.status === 409 && body?.error === 'version_conflict') {
    return { id: 'grid.move.refused.stale', stale: true };
  }
  if (error.status === 409 && body?.error === 'track_archived') {
    return { id: 'grid.move.refused.archived' };
  }
  return { id: 'grid.move.refused.other' };
}

/** A row offered as the new parent, with why it cannot be one (null: it can). */
export interface MoveCandidate {
  row: number;
  key: string;
  summary: string | null;
  /** Its hierarchy level's name, as the administrators named it. */
  level: string;
  problem: string | null;
}

/** The ticket's parent now: its key, one the viewer may not see, or none. */
export type MoveParent = { key: string } | 'hidden' | null;

export interface MoveUnderDialogProps {
  /** The key of the ticket moved. */
  moving: string;
  from: MoveParent;
  /** Rows below it in the grid, which move with it. */
  below: number;
  /**
   * The new parent already chosen: a row dropped on, or `none` for Remove from parent. Left out,
   * the dialog offers the grid's rows to choose from.
   */
  target?: { row: number; key: string } | 'none';
  /** The rows offered for the text typed, at most a page of them, and how many more matched. */
  candidates?: (text: string) => { list: MoveCandidate[]; more: number };
  /** Why the chosen move cannot be made, known before the server is asked. */
  blocked?: string | null;
  /** Sends the move; resolves null once moved, or the refusal in words. */
  onMove: (row: number | -1) => Promise<string | null>;
  onClose: () => void;
  /** Where focus goes once the dialog closes. */
  restoreFocus?: (opener: HTMLElement | null) => void;
}

/**
 * Moving a row of a plan's Grid under another parent (T-089a; PLN-010 acceptance 2; ADR-122 stage
 * 10): one row with everything below it, confirmed each time. The question names the ticket, its
 * parent before and after, and how many rows go with it; **Move** sends the ticket's own change
 * (`PATCH /tickets/:id { parent, version }`), which keeps every check the ticket route makes. A
 * refusal says why, in its words, and nothing moves. Opened from a row's menu it first offers the
 * grid's ticket rows, each that cannot be the parent saying why; opened by a drop or by Remove from
 * parent, it only asks.
 */
export function MoveUnderDialog({
  moving,
  from,
  below,
  target,
  candidates,
  blocked = null,
  onMove,
  onClose,
  restoreFocus,
}: MoveUnderDialogProps) {
  const t = useT();
  const id = useId();
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<{ row: number; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const removing = target === 'none';
  const chosen = target === undefined ? picked : target;
  const offered = target === undefined && candidates ? candidates(text) : null;

  const fromText =
    from === null ? null : from === 'hidden' ? t('grid.move.hiddenParent') : from.key;
  const change =
    chosen === null
      ? null
      : chosen === 'none'
        ? fromText === null
          ? null
          : t('grid.move.change.remove', { from: fromText })
        : fromText === null
          ? t('grid.move.change.fromNone', { to: chosen.key })
          : t('grid.move.change', { from: fromText, to: chosen.key });

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (chosen === null) {
      setProblem(t('grid.move.choose'));
      return;
    }
    if (blocked || busy) return;
    setBusy(true);
    setProblem(null);
    const why = await onMove(chosen === 'none' ? -1 : chosen.row).catch(() =>
      t('grid.move.refused.other'),
    );
    setBusy(false);
    if (why) setProblem(why);
  };

  return (
    <ModalDialog
      onClose={onClose}
      labelledBy={`${id}-title`}
      closeLabel={t('grid.move.cancel')}
      focusFirstField
      className="plan-grid-move-dialog"
      {...(restoreFocus ? { restoreFocus } : {})}
    >
      <form onSubmit={send}>
        <h2 id={`${id}-title`}>
          {removing
            ? t('grid.move.removeTitle', { key: moving })
            : t('grid.move.title', { key: moving })}
        </h2>
        {offered && (
          <>
            <label className="form-field" htmlFor={`${id}-find`}>
              <span className="form-label">{t('grid.move.find')}</span>
              <input
                id={`${id}-find`}
                type="search"
                value={text}
                autoComplete="off"
                onChange={(event) => setText(event.target.value)}
              />
            </label>
            {offered.list.length === 0 ? (
              <EmptyState compact title={t('grid.move.none')}>
                {text.trim() === '' ? t('grid.move.noneBody') : t('grid.move.noneFound')}
              </EmptyState>
            ) : (
              <fieldset className="plan-grid-move-targets">
                <legend>{t('grid.move.targets')}</legend>
                <ul className="plan-grid-move-list">
                  {offered.list.map((c) => (
                    <li
                      key={c.row}
                      className="plan-grid-move-item"
                      data-refused={c.problem ? 'true' : undefined}
                    >
                      <input
                        id={`${id}-t${c.row}`}
                        type="radio"
                        name={`${id}-target`}
                        checked={picked?.row === c.row}
                        disabled={c.problem !== null}
                        aria-describedby={c.problem ? `${id}-w${c.row}` : undefined}
                        onChange={() => {
                          setPicked({ row: c.row, key: c.key });
                          setProblem(null);
                        }}
                      />
                      <label htmlFor={`${id}-t${c.row}`}>
                        <span className="plan-grid-move-key">{c.key}</span>
                        {c.summary && (
                          <>
                            {' '}
                            <span className="plan-grid-move-summary">{c.summary}</span>
                          </>
                        )}
                        {c.level && (
                          <>
                            {' '}
                            <span className="plan-grid-move-level">{c.level}</span>
                          </>
                        )}
                      </label>
                      {c.problem && (
                        <span id={`${id}-w${c.row}`} className="plan-grid-move-why">
                          {c.problem}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
                {offered.more > 0 && (
                  <p className="board-hint">{t('grid.move.more', { count: offered.more })}</p>
                )}
              </fieldset>
            )}
          </>
        )}
        {chosen !== null && (
          <div className="plan-grid-move-ask">
            <p className="plan-grid-move-question">
              {chosen === 'none'
                ? t('grid.move.removeAsk', { key: moving })
                : t('grid.move.ask', { key: moving, to: chosen.key })}
            </p>
            {change && <p>{change}</p>}
            {below > 0 && <p>{t('grid.move.with', { count: below })}</p>}
          </div>
        )}
        {blocked && <p className="board-problem">{blocked}</p>}
        {problem && (
          <p className="board-problem" role="alert">
            {problem}
          </p>
        )}
        <div className="form-actions">
          <button
            type="submit"
            className="button-primary"
            disabled={busy}
            aria-disabled={chosen === null || blocked !== null || undefined}
          >
            {removing ? t('grid.move.removeConfirm') : t('grid.move.confirm')}
          </button>
          <button type="button" className="button-secondary" onClick={onClose}>
            {t('grid.move.cancel')}
          </button>
        </div>
      </form>
    </ModalDialog>
  );
}
