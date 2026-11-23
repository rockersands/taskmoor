import {
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { ApiError } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { useLockText } from '../../locks/useLockText';
import { DangerAction } from '../../shell/DangerAction';
import { EmptyState } from '../../shell/EmptyState';
import { leaveMotion } from '../../shell/motion';
import { useMediaQuery } from '../../shell/useMediaQuery';
import { useMenuButton } from '../../shell/useMenuButton';
import { ITEM_STATE_LABELS, ITEM_STATES, type ItemState } from './checklistStates';
import type {
  Checklist,
  ChecklistItem,
  ChecklistProgress,
  TicketChecklists,
  TicketToolsClient,
} from './client';
import { ticketToolsClient } from './client';
import { ProgressBar } from './Progress';

export interface ChecklistsPanelProps {
  ticket: { id: number };
  client?: TicketToolsClient;
  /** Bumped when the ticket changed elsewhere: its checklists read again. */
  revision: number;
  /** Tells the page something changed, so history reads again. */
  onChanged?: () => void;
}

type Run = (
  call: () => Promise<TicketChecklists>,
  said?: string,
  after?: () => void,
) => Promise<boolean>;

/** What the server takes (`routes/checklists.ts`): a checklist's name, and an item's text. */
const NAME_MAX = 200;
const TEXT_MAX = 1000;

/** A list or an item that a move button moved, and which way. */
interface Moved {
  id: number;
  step: -1 | 1;
}

/** When a form closes, saved or left, the focus goes back to the control that opened it. */
function useFocusBack(open: boolean, opener: RefObject<HTMLElement | null>) {
  const was = useRef(open);
  useEffect(() => {
    if (was.current && !open) opener.current?.focus();
    was.current = open;
  }, [open, opener]);
}

/** How far a pointer moves before a press on an item's grip becomes a drag, in pixels. */
const DRAG_START = 6;

/**
 * The order an item dropped on another makes (TT-5): it goes before that item, or after it when
 * dropped on its lower half. Null when nothing would change.
 */
export function droppedOrder(
  ids: readonly number[],
  id: number,
  target: number,
  after: boolean,
): number[] | null {
  if (id === target || !ids.includes(id) || !ids.includes(target)) return null;
  const rest = ids.filter((other) => other !== id);
  const at = rest.indexOf(target) + (after ? 1 : 0);
  const next = [...rest.slice(0, at), id, ...rest.slice(at)];
  return next.every((other, i) => other === ids[i]) ? null : next;
}

/** Six dots, the grip an item is dragged by. */
function GripIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      {[4, 8, 12].map((y) =>
        [6, 10].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.3" fill="currentColor" />),
      )}
    </svg>
  );
}

/** Which position an item or a list moves to, and the order that makes. */
function moved(ids: readonly number[], id: number, step: -1 | 1): number[] | null {
  const at = ids.indexOf(id);
  const to = at + step;
  if (at < 0 || to < 0 || to >= ids.length) return null;
  const next = [...ids];
  next[at] = ids[to] as number;
  next[to] = id;
  return next;
}

function ProgressLine({ progress }: { progress: ChecklistProgress }) {
  const t = useT();
  if (progress.percent === null) return null;
  const numbers = t('ticketTools.checklists.progress', {
    done: progress.done,
    counted: progress.counted,
    percent: progress.percent,
  });
  return (
    <div className="tool-progress">
      <ProgressBar percent={progress.percent} label={numbers} />
      <p className="tool-progress-text">{numbers}</p>
    </div>
  );
}

/**
 * A ticket's checklists (CORE-033): named lists, separate from the description, of items that are
 * open, in progress, done or rejected. The box makes an item done or open; the list beside it sets
 * any state. Each list and the ticket overall show a percentage in which a rejected item is left
 * out. Order changes with buttons, so the keyboard does all a pointer does, and an item can also
 * be dragged by its grip with a mouse or a finger (TT-5). Every route answers the whole of the
 * ticket's checklists, and this panel shows what it answered.
 */
export function ChecklistsPanel({
  ticket,
  client = ticketToolsClient,
  revision,
  onChanged,
}: ChecklistsPanelProps) {
  const t = useT();
  const lockText = useLockText();
  const titleId = useId();
  const [data, setData] = useState<TicketChecklists | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [movedList, setMovedList] = useState<Moved | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const read = useRef(0);
  useFocusBack(adding, addButton);

  // biome-ignore lint/correctness/useExhaustiveDependencies: read again when the ticket changes
  useEffect(() => {
    const ask = ++read.current;
    client.checklists(ticket.id).then(
      (found) => {
        if (ask === read.current) setData(found);
      },
      () => {
        if (ask === read.current) setData((now) => now);
      },
    );
    return () => {
      read.current++;
    };
  }, [client, ticket.id, revision]);

  const refusal = (error: unknown) => {
    if (error instanceof ApiError) {
      if (error.status === 403) return t('ticketView.problem.forbidden');
      if (error.code === 'too_many') return t('ticketTools.checklists.tooMany');
      if (error.code === 'order_changed') return t('ticketTools.checklists.orderChanged');
      if (error.code === 'track_archived') return t('ticketTools.links.archived');
      if (error.status === 404) return t('ticketTools.checklists.gone');
    }
    return t('ticketView.problem.other');
  };

  const writes = useRef(0);
  const run: Run = async (call, words = '', after) => {
    const write = ++writes.current;
    setBusy(true);
    setProblem(null);
    try {
      const answer = await call();
      // Boxes can be ticked faster than the server answers: the last answer has them all.
      if (write === writes.current) setData(answer);
      setSaid(words);
      after?.();
      onChanged?.();
      return true;
    } catch (error) {
      setProblem(refusal(error));
      // What the list holds now may be what refused it (someone else changed it).
      client.checklists(ticket.id).then(setData, () => {});
      return false;
    } finally {
      if (write === writes.current) setBusy(false);
    }
  };

  if (!data) return null;
  const { checklists, canEdit } = data;
  if (checklists.length === 0 && !canEdit) return null;
  const lock = data.lock ? lockText(data.lock as Parameters<typeof lockText>[0]) : null;
  const order = checklists.map((list) => list.id);

  return (
    <section aria-labelledby={titleId} className="ticket-links ticket-tool ticket-checklists">
      <div className="ticket-tool-head">
        <h2 id={titleId} className="ticket-section-title">
          {t('ticketTools.checklists.title')}
        </h2>
        {canEdit && !adding && (
          <button
            ref={addButton}
            type="button"
            className="button-secondary ticket-action"
            onClick={() => setAdding(true)}
          >
            {t('ticketTools.checklists.add')}
          </button>
        )}
      </div>
      {lock && <p className="form-hint">{lock}</p>}
      {checklists.length > 1 && (
        <div className="checklist-overall">
          <p className="checklist-overall-title">{t('ticketTools.checklists.overall')}</p>
          <ProgressLine progress={data.progress} />
        </div>
      )}
      {checklists.length === 0 && !adding && (
        <EmptyState compact title={t('ticketTools.checklists.empty')} />
      )}
      {checklists.map((list) => (
        <ChecklistBlock
          key={list.id}
          list={list}
          ticketId={ticket.id}
          client={client}
          canEdit={canEdit}
          busy={busy}
          run={run}
          moveList={(step) => {
            const next = moved(order, list.id, step);
            if (next) {
              void run(
                () => client.orderChecklists(ticket.id, next),
                t('ticketTools.checklists.moved', { name: list.name }),
                // The keyboard stays with the list that moved, wherever it went.
                () => setMovedList({ id: list.id, step }),
              );
            }
          }}
          canMoveUp={order.indexOf(list.id) > 0}
          canMoveDown={order.indexOf(list.id) < order.length - 1}
          focusMove={movedList?.id === list.id ? movedList.step : null}
          onMoveFocused={() => setMovedList(null)}
          // The add button, or the name of the list being made while it stands in its place.
          onRemoved={() => (addButton.current ?? nameField.current)?.focus()}
        />
      ))}
      {adding && (
        <NameForm
          label={t('ticketTools.checklists.name')}
          submit={t('ticketTools.checklists.create')}
          maxLength={NAME_MAX}
          field={nameField}
          busy={busy}
          onCancel={() => setAdding(false)}
          onSave={async (name) => {
            const ok = await run(
              () => client.addChecklist(ticket.id, name),
              t('ticketTools.checklists.added', { name }),
            );
            if (ok) setAdding(false);
            return ok;
          }}
        />
      )}
      <p role="status" className="form-status">
        {said}
      </p>
      {problem && (
        <p role="alert" className="form-error">
          {problem}
        </p>
      )}
    </section>
  );
}

function NameForm({
  label,
  submit,
  start = '',
  maxLength,
  field,
  busy,
  onSave,
  onCancel,
}: {
  label: string;
  submit: string;
  start?: string;
  /** What the server takes for this text. */
  maxLength: number;
  /** The field, for the panel to give it the focus. */
  field?: RefObject<HTMLInputElement | null>;
  busy: boolean;
  onSave: (value: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const t = useT();
  const id = useId();
  const [value, setValue] = useState(start);
  const own = useRef<HTMLInputElement>(null);
  const input = field ?? own;
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when the form appears
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim() !== '') void onSave(value.trim());
  };
  return (
    <form
      className="checklist-form"
      // Text that is what is already saved is no draft for the pop-up to ask about.
      data-no-draft={value.trim() === start || undefined}
      onSubmit={save}
    >
      <div className="checklist-form-field">
        <label htmlFor={id} className="form-label">
          {label}
        </label>
        <input
          ref={input}
          id={id}
          type="text"
          value={value}
          maxLength={maxLength}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              onCancel();
            }
          }}
        />
      </div>
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={busy || value.trim() === ''}>
          {submit}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('ticketView.cancel')}
        </button>
      </div>
    </form>
  );
}

/**
 * Up and down for a list or an item, each shown only where that move is possible. Once a move
 * is drawn, the focus goes back to the button pressed, or to the other one when the move reached
 * the first or the last place, so the keyboard stays with what moved.
 */
function MoveButtons({
  up,
  down,
  busy,
  focus,
  onFocused,
  onMove,
}: {
  /** The button's name, or null where it cannot go that way. */
  up: string | null;
  down: string | null;
  busy: boolean;
  focus: -1 | 1 | null;
  onFocused: () => void;
  onMove: (step: -1 | 1) => void;
}) {
  const t = useT();
  const upButton = useRef<HTMLButtonElement>(null);
  const downButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (focus === null) return;
    const [pressed, other] = focus === -1 ? [upButton, downButton] : [downButton, upButton];
    (pressed.current ?? other.current)?.focus();
    onFocused();
  }, [focus, onFocused]);
  return (
    <>
      {up !== null && (
        <button
          ref={upButton}
          type="button"
          className="button-secondary ticket-action"
          disabled={busy}
          aria-label={up}
          onClick={() => onMove(-1)}
        >
          {t('ticketTools.moveUp')}
        </button>
      )}
      {down !== null && (
        <button
          ref={downButton}
          type="button"
          className="button-secondary ticket-action"
          disabled={busy}
          aria-label={down}
          onClick={() => onMove(1)}
        >
          {t('ticketTools.moveDown')}
        </button>
      )}
    </>
  );
}

function ChecklistBlock({
  list,
  ticketId,
  client,
  canEdit,
  busy,
  run,
  moveList,
  canMoveUp,
  canMoveDown,
  focusMove,
  onMoveFocused,
  onRemoved,
}: {
  list: Checklist;
  ticketId: number;
  client: TicketToolsClient;
  canEdit: boolean;
  busy: boolean;
  run: Run;
  moveList: (step: -1 | 1) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** The list just moved this way: its move button takes the focus again. */
  focusMove: -1 | 1 | null;
  onMoveFocused: () => void;
  onRemoved: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const addId = useId();
  const [renaming, setRenaming] = useState(false);
  const [text, setText] = useState('');
  const [movedItem, setMovedItem] = useState<Moved | null>(null);
  /** The item being dragged, and where it would land (TT-5). */
  const [dragging, setDragging] = useState<number | null>(null);
  const [landing, setLanding] = useState<{ id: number; after: boolean } | null>(null);
  const items = useRef<HTMLUListElement>(null);
  const addInput = useRef<HTMLInputElement>(null);
  const renameButton = useRef<HTMLButtonElement>(null);
  useFocusBack(renaming, renameButton);
  const order = list.items.map((item) => item.id);
  const moveItem = (item: ChecklistItem, step: -1 | 1) => {
    const next = moved(order, item.id, step);
    if (next) {
      void run(
        () => client.orderItems(ticketId, list.id, next),
        t('ticketTools.checklists.itemMoved', { text: item.text }),
        // The keyboard stays with the item that moved, wherever it went.
        () => setMovedItem({ id: item.id, step }),
      );
    }
  };
  /** The item of this list under the pointer, and whether on its lower half. */
  const itemAt = (x: number, y: number): { id: number; after: boolean } | null => {
    const row = document.elementFromPoint?.(x, y)?.closest<HTMLElement>('[data-item]');
    if (!row || !items.current?.contains(row)) return null;
    const box = row.getBoundingClientRect();
    return { id: Number(row.dataset.item), after: y > box.top + box.height / 2 };
  };
  /**
   * A drag by an item's grip, with pointer events so a mouse and a finger work alike: past a few
   * pixels it is a drag, the item it is over shows where it would land, and letting go there
   * moves it. Escape or a cancelled touch leaves the order as it was.
   */
  const beginDrag = (event: ReactPointerEvent<HTMLElement>, item: ChecklistItem) => {
    if (busy || (event.pointerType === 'mouse' && event.button !== 0)) return;
    // No text is selected on the way.
    event.preventDefault();
    const start = { x: event.clientX, y: event.clientY };
    const pointerId = event.pointerId;
    const from = [...order];
    let moving = false;
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      if (!moving) {
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_START) return;
        moving = true;
        setDragging(item.id);
      }
      e.preventDefault();
      const over = itemAt(e.clientX, e.clientY);
      setLanding(over && droppedOrder(from, item.id, over.id, over.after) ? over : null);
    };
    const stop = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      setDragging(null);
      setLanding(null);
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      stop();
      if (!moving) return;
      const over = itemAt(e.clientX, e.clientY);
      const next = over && droppedOrder(from, item.id, over.id, over.after);
      if (next) {
        void run(
          () => client.orderItems(ticketId, list.id, next),
          t('ticketTools.checklists.itemMoved', { text: item.text }),
        );
      }
    };
    const onCancel = (e: PointerEvent) => {
      if (e.pointerId === pointerId) stop();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      stop();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
  };
  const addItem = async (event: FormEvent) => {
    event.preventDefault();
    const words = text.trim();
    if (words === '') return;
    const ok = await run(
      () => client.addItem(ticketId, list.id, words),
      t('ticketTools.checklists.itemAdded', { text: words }),
    );
    if (ok) setText('');
    addInput.current?.focus();
  };

  return (
    <section className="checklist" aria-labelledby={renaming ? undefined : titleId}>
      <div className="checklist-head">
        {renaming ? (
          <NameForm
            label={t('ticketTools.checklists.name')}
            submit={t('ticketView.save')}
            start={list.name}
            maxLength={NAME_MAX}
            busy={busy}
            onCancel={() => setRenaming(false)}
            onSave={async (name) => {
              const ok = await run(() => client.renameChecklist(ticketId, list.id, name));
              if (ok) setRenaming(false);
              return ok;
            }}
          />
        ) : (
          <h3 id={titleId} className="checklist-title">
            {list.name}
          </h3>
        )}
        {canEdit && !renaming && (
          <span className="checklist-actions">
            <button
              ref={renameButton}
              type="button"
              className="button-secondary ticket-action"
              aria-label={t('ticketTools.checklists.rename', { name: list.name })}
              onClick={() => setRenaming(true)}
            >
              {t('ticketView.edit')}
            </button>
            <MoveButtons
              up={canMoveUp ? t('ticketTools.checklists.moveListUp', { name: list.name }) : null}
              down={
                canMoveDown ? t('ticketTools.checklists.moveListDown', { name: list.name }) : null
              }
              busy={busy}
              focus={focusMove}
              onFocused={onMoveFocused}
              onMove={moveList}
            />
            {list.items.length > 0 ? (
              // Its items and their states go with it, and history keeps only its name: asked
              // first (D13, T-267). An empty one loses only a name, so it goes at once.
              <DangerAction
                label={t('ticketTools.remove')}
                name={t('ticketTools.checklists.remove', { name: list.name })}
                outcome={t('ticketTools.checklists.removeOutcome', {
                  name: list.name,
                  count: list.items.length,
                  done: list.items.filter((item) => item.state === 'done').length,
                })}
                confirmLabel={t('ticketTools.checklists.remove', { name: list.name })}
                busy={busy}
                onConfirm={async () => {
                  const ok = await run(
                    () => client.removeChecklist(ticketId, list.id),
                    t('ticketTools.checklists.removed', { name: list.name }),
                    onRemoved,
                  );
                  // Refused: the reason shows above, and the question stays open.
                  if (!ok) throw new Error('refused');
                }}
              />
            ) : (
              <button
                type="button"
                className="button-secondary ticket-action"
                disabled={busy}
                aria-label={t('ticketTools.checklists.remove', { name: list.name })}
                onClick={() =>
                  void run(
                    () => client.removeChecklist(ticketId, list.id),
                    t('ticketTools.checklists.removed', { name: list.name }),
                    onRemoved,
                  )
                }
              >
                {t('ticketTools.remove')}
              </button>
            )}
          </span>
        )}
      </div>
      <ProgressLine progress={list.progress} />
      {list.items.length > 0 && (
        <ul ref={items} className="checklist-items" data-dragging={dragging !== null || undefined}>
          {list.items.map((item, at) => (
            <ChecklistRow
              key={item.id}
              item={item}
              canEdit={canEdit}
              busy={busy}
              dragged={dragging === item.id}
              landing={landing?.id === item.id ? (landing.after ? 'after' : 'before') : null}
              onGrip={list.items.length > 1 ? (event) => beginDrag(event, item) : null}
              canMoveUp={at > 0}
              canMoveDown={at < list.items.length - 1}
              focusMove={movedItem?.id === item.id ? movedItem.step : null}
              onMoveFocused={() => setMovedItem(null)}
              onState={(state) =>
                run(() => client.updateItem(ticketId, list.id, item.id, { state }))
              }
              onText={(words) =>
                run(() => client.updateItem(ticketId, list.id, item.id, { text: words }))
              }
              onMove={(step) => moveItem(item, step)}
              onRemove={() =>
                void run(
                  () => client.removeItem(ticketId, list.id, item.id),
                  t('ticketTools.checklists.itemRemoved', { text: item.text }),
                  () => addInput.current?.focus(),
                )
              }
              focusWhenGone={addInput}
            />
          ))}
        </ul>
      )}
      {canEdit && (
        <form className="checklist-form" onSubmit={(event) => void addItem(event)}>
          <div className="checklist-form-field">
            <label htmlFor={addId} className="form-label">
              {t('ticketTools.checklists.addItem', { name: list.name })}
            </label>
            <input
              ref={addInput}
              id={addId}
              type="text"
              value={text}
              maxLength={TEXT_MAX}
              onChange={(event) => setText(event.target.value)}
            />
          </div>
          <div className="form-actions">
            {/* The same primary Add as a new subticket's (PL-44). */}
            <button type="submit" className="button-primary" disabled={busy || text.trim() === ''}>
              {t('ticketTools.subtickets.add')}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

/** Where an item's controls go under its name (ticket-tools.css): its other actions, in a menu. */
const CHECKLIST_COMPACT = '(max-width: 40rem)';

/**
 * An item's actions on a phone (PL-44): Edit, the moves and Remove behind one More button, so an
 * item takes two rows, its name and then its grip, its state and More. The same actions, in the
 * same words, as the buttons beside it on a wider screen; after a move the focus is on More again.
 */
function ItemActions({
  text,
  opener,
  busy,
  canMoveUp,
  canMoveDown,
  focusMove,
  onMoveFocused,
  onEdit,
  onMove,
  onRemove,
}: {
  text: string;
  /** Takes the More button too, for the focus to come back to it when the edit form closes. */
  opener: RefObject<HTMLButtonElement | null>;
  busy: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  focusMove: -1 | 1 | null;
  onMoveFocused: () => void;
  onEdit: () => void;
  onMove: (step: -1 | 1) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const { open, openMenu, close, container, button, menu, buttonId, menuId, ...keys } =
    useMenuButton();
  useEffect(() => {
    if (focusMove === null) return;
    button.current?.focus();
    onMoveFocused();
  }, [focusMove, onMoveFocused, button]);
  const actions = [
    { key: 'edit', label: t('ticketView.edit'), run: onEdit },
    ...(canMoveUp ? [{ key: 'up', label: t('ticketTools.moveUp'), run: () => onMove(-1) }] : []),
    ...(canMoveDown
      ? [{ key: 'down', label: t('ticketTools.moveDown'), run: () => onMove(1) }]
      : []),
    { key: 'remove', label: t('ticketTools.remove'), run: onRemove },
  ];
  return (
    <div className="user-menu checklist-item-menu" ref={container}>
      <button
        ref={(node) => {
          button.current = node;
          opener.current = node;
        }}
        id={buttonId}
        type="button"
        className="button-secondary ticket-action"
        aria-label={t('ticketTools.checklists.moreOf', { text })}
        aria-haspopup="menu"
        aria-expanded={open}
        {...(open ? { 'aria-controls': menuId } : {})}
        onClick={() => (open ? close(false) : openMenu(true))}
        onKeyDown={keys.onButtonKeyDown}
      >
        {t('ticketTools.checklists.more')}
      </button>
      {open && (
        <div ref={leaveMotion} className="user-menu-popup">
          <div
            ref={menu}
            id={menuId}
            role="menu"
            aria-labelledby={buttonId}
            className="user-menu-list"
            onKeyDown={keys.onMenuKeyDown}
          >
            {actions.map((action) => (
              <button
                key={action.key}
                role="menuitem"
                tabIndex={-1}
                type="button"
                className="user-menu-item"
                aria-disabled={busy || undefined}
                onClick={() => {
                  if (busy) return;
                  // The focus waits on More: Edit and the moves put it where it belongs, a removal
                  // on the Add-item field, and a refused one leaves it here, beside the reason.
                  close(true);
                  action.run();
                }}
              >
                {action.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ChecklistRow({
  item,
  canEdit,
  busy,
  dragged,
  landing,
  onGrip,
  canMoveUp,
  canMoveDown,
  focusMove,
  onMoveFocused,
  onState,
  onText,
  onMove,
  onRemove,
  focusWhenGone,
}: {
  item: ChecklistItem;
  canEdit: boolean;
  busy: boolean;
  /** This item is being dragged (TT-5). */
  dragged: boolean;
  /** A dragged item would land just before or after this one. */
  landing: 'before' | 'after' | null;
  /** Starts a drag by the grip; null when there is nowhere to drag to. */
  onGrip: ((event: ReactPointerEvent<HTMLElement>) => void) | null;
  canMoveUp: boolean;
  canMoveDown: boolean;
  /** The item just moved this way: its move button takes the focus again. */
  focusMove: -1 | 1 | null;
  onMoveFocused: () => void;
  onState: (state: ItemState) => Promise<boolean>;
  onText: (text: string) => Promise<boolean>;
  onMove: (step: -1 | 1) => void;
  onRemove: () => void;
  /** Where the focus goes when the item goes while one of its controls has it: Add an item. */
  focusWhenGone: RefObject<HTMLElement | null>;
}) {
  const t = useT();
  const boxId = useId();
  const compact = useMediaQuery(CHECKLIST_COMPACT);
  // An item that goes while it holds the focus, found gone when its removal was refused or
  // removed by someone else meanwhile, hands the focus on rather than dropping it on the page. A
  // layout effect's cleanup runs while the row is still on the page, so it can still tell.
  const row = useRef<HTMLLIElement>(null);
  useLayoutEffect(() => {
    const node = row.current;
    return () => {
      if (node?.contains(document.activeElement)) focusWhenGone.current?.focus();
    };
  }, [focusWhenGone]);
  const [editing, setEditing] = useState(false);
  // Edit, or on a phone the menu that holds it: where the focus goes back once the form closes.
  const editButton = useRef<HTMLButtonElement>(null);
  useFocusBack(editing, editButton);
  // What was just chosen, shown at once while the server answers. It goes when the list shows
  // it, or with the next list after its own answer: ticking another box meanwhile sets that
  // answer aside for a later one. A refusal puts it back; an older choice never clears a newer.
  const [chosen, setChosen] = useState<ItemState | null>(null);
  const asked = useRef(0);
  const answered = useRef(false);
  const state = chosen ?? item.state;
  const choose = (next: ItemState) => {
    const mine = ++asked.current;
    answered.current = false;
    setChosen(next);
    void onState(next).then((ok) => {
      if (mine !== asked.current) return;
      if (ok) answered.current = true;
      else setChosen(null);
    });
  };
  useEffect(() => {
    if (chosen === null) return;
    if (item.state === chosen || answered.current) {
      answered.current = false;
      setChosen(null);
    }
  }, [item, chosen]);
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Something is under way: neither ticked nor empty, for sight and for screen readers. The
    // edit form stands in the box's place, so the box drawn again when it closes is set too.
    if (!editing && box.current) box.current.indeterminate = state === 'in_progress';
  }, [state, editing]);

  if (editing) {
    return (
      <li ref={row} className="checklist-item">
        <NameForm
          label={t('ticketTools.checklists.itemText')}
          submit={t('ticketView.save')}
          start={item.text}
          maxLength={TEXT_MAX}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSave={async (words) => {
            const ok = await onText(words);
            if (ok) setEditing(false);
            return ok;
          }}
        />
      </li>
    );
  }
  return (
    <li
      ref={row}
      className="checklist-item"
      data-state={state}
      data-item={item.id}
      data-dragged={dragged || undefined}
      data-landing={landing ?? undefined}
    >
      <input
        ref={box}
        id={boxId}
        type="checkbox"
        checked={state === 'done'}
        disabled={!canEdit}
        onChange={(event) => choose(event.target.checked ? 'done' : 'open')}
      />
      <label htmlFor={boxId} className="checklist-item-text">
        {item.text}
      </label>
      {canEdit ? (
        <span className="checklist-item-controls">
          {onGrip && (
            // For a pointer only: Move up and Move down are the same moves by keyboard.
            <span
              className="checklist-grip"
              aria-hidden="true"
              title={t('ticketTools.checklists.drag')}
              onPointerDown={onGrip}
            >
              <GripIcon />
            </span>
          )}
          <select
            value={state}
            aria-label={t('ticketTools.checklists.stateOf', { text: item.text })}
            onChange={(event) => choose(event.target.value as ItemState)}
          >
            {ITEM_STATES.map((state) => (
              <option key={state} value={state}>
                {t(ITEM_STATE_LABELS[state])}
              </option>
            ))}
          </select>
          {compact ? (
            <ItemActions
              text={item.text}
              opener={editButton}
              busy={busy}
              canMoveUp={canMoveUp}
              canMoveDown={canMoveDown}
              focusMove={focusMove}
              onMoveFocused={onMoveFocused}
              onEdit={() => setEditing(true)}
              onMove={onMove}
              onRemove={onRemove}
            />
          ) : (
            <>
              <button
                ref={editButton}
                type="button"
                className="button-secondary ticket-action"
                aria-label={t('ticketTools.checklists.edit', { text: item.text })}
                onClick={() => setEditing(true)}
              >
                {t('ticketView.edit')}
              </button>
              <MoveButtons
                up={canMoveUp ? t('ticketTools.checklists.moveUp', { text: item.text }) : null}
                down={
                  canMoveDown ? t('ticketTools.checklists.moveDown', { text: item.text }) : null
                }
                busy={busy}
                focus={focusMove}
                onFocused={onMoveFocused}
                onMove={onMove}
              />
              <button
                type="button"
                className="button-secondary ticket-action"
                disabled={busy}
                aria-label={t('ticketTools.checklists.removeItem', { text: item.text })}
                onClick={onRemove}
              >
                {t('ticketTools.remove')}
              </button>
            </>
          )}
        </span>
      ) : (
        <span className="checklist-item-state">{t(ITEM_STATE_LABELS[state])}</span>
      )}
    </li>
  );
}
