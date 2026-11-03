import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { ApiError } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import { useLockText } from '../../locks/useLockText';
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
 * out. Order changes with buttons, so the keyboard does all a pointer does. Every route answers
 * the whole of the ticket's checklists, and this panel shows what it answered.
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
  const addButton = useRef<HTMLButtonElement>(null);
  const read = useRef(0);

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
        <p className="ticket-tool-empty">{t('ticketTools.checklists.empty')}</p>
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
              );
            }
          }}
          canMoveUp={order.indexOf(list.id) > 0}
          canMoveDown={order.indexOf(list.id) < order.length - 1}
          onRemoved={() => addButton.current?.focus()}
        />
      ))}
      {adding && (
        <NameForm
          label={t('ticketTools.checklists.name')}
          submit={t('ticketTools.checklists.create')}
          busy={busy}
          onCancel={() => {
            setAdding(false);
            window.setTimeout(() => addButton.current?.focus(), 0);
          }}
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
  busy,
  onSave,
  onCancel,
}: {
  label: string;
  submit: string;
  start?: string;
  busy: boolean;
  onSave: (value: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const t = useT();
  const id = useId();
  const [value, setValue] = useState(start);
  const input = useRef<HTMLInputElement>(null);
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
          maxLength={1000}
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
  onRemoved: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const addId = useId();
  const [renaming, setRenaming] = useState(false);
  const [text, setText] = useState('');
  const addInput = useRef<HTMLInputElement>(null);
  const order = list.items.map((item) => item.id);
  const moveItem = (item: ChecklistItem, step: -1 | 1, button: HTMLElement) => {
    const next = moved(order, item.id, step);
    if (next) {
      void run(
        () => client.orderItems(ticketId, list.id, next),
        t('ticketTools.checklists.itemMoved', { text: item.text }),
        // The button stays where the keyboard is, with its item.
        () => window.setTimeout(() => button.focus(), 0),
      );
    }
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
              type="button"
              className="button-secondary ticket-action"
              aria-label={t('ticketTools.checklists.rename', { name: list.name })}
              onClick={() => setRenaming(true)}
            >
              {t('ticketView.edit')}
            </button>
            {canMoveUp && (
              <button
                type="button"
                className="button-secondary ticket-action"
                disabled={busy}
                aria-label={t('ticketTools.checklists.moveListUp', { name: list.name })}
                onClick={() => moveList(-1)}
              >
                {t('ticketTools.moveUp')}
              </button>
            )}
            {canMoveDown && (
              <button
                type="button"
                className="button-secondary ticket-action"
                disabled={busy}
                aria-label={t('ticketTools.checklists.moveListDown', { name: list.name })}
                onClick={() => moveList(1)}
              >
                {t('ticketTools.moveDown')}
              </button>
            )}
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
          </span>
        )}
      </div>
      <ProgressLine progress={list.progress} />
      {list.items.length > 0 && (
        <ul className="checklist-items">
          {list.items.map((item, at) => (
            <ChecklistRow
              key={item.id}
              item={item}
              canEdit={canEdit}
              busy={busy}
              canMoveUp={at > 0}
              canMoveDown={at < list.items.length - 1}
              onState={(state) =>
                run(() => client.updateItem(ticketId, list.id, item.id, { state }))
              }
              onText={(words) =>
                run(() => client.updateItem(ticketId, list.id, item.id, { text: words }))
              }
              onMove={(step, button) => moveItem(item, step, button)}
              onRemove={() =>
                void run(
                  () => client.removeItem(ticketId, list.id, item.id),
                  t('ticketTools.checklists.itemRemoved', { text: item.text }),
                  () => addInput.current?.focus(),
                )
              }
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
              maxLength={1000}
              onChange={(event) => setText(event.target.value)}
            />
          </div>
          <div className="form-actions">
            <button
              type="submit"
              className="button-secondary"
              disabled={busy || text.trim() === ''}
            >
              {t('ticketTools.subtickets.add')}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function ChecklistRow({
  item,
  canEdit,
  busy,
  canMoveUp,
  canMoveDown,
  onState,
  onText,
  onMove,
  onRemove,
}: {
  item: ChecklistItem;
  canEdit: boolean;
  busy: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onState: (state: ItemState) => Promise<boolean>;
  onText: (text: string) => Promise<boolean>;
  onMove: (step: -1 | 1, button: HTMLElement) => void;
  onRemove: () => void;
}) {
  const t = useT();
  const boxId = useId();
  const [editing, setEditing] = useState(false);
  // What was just chosen, shown at once while the server answers; a refusal puts it back.
  const [chosen, setChosen] = useState<ItemState | null>(null);
  const state = chosen ?? item.state;
  const choose = (next: ItemState) => {
    setChosen(next);
    void onState(next).finally(() => setChosen(null));
  };
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // Something is under way: neither ticked nor empty, for sight and for screen readers.
    if (box.current) box.current.indeterminate = state === 'in_progress';
  }, [state]);

  if (editing) {
    return (
      <li className="checklist-item">
        <NameForm
          label={t('ticketTools.checklists.itemText')}
          submit={t('ticketView.save')}
          start={item.text}
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
    <li className="checklist-item" data-state={state}>
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
          <button
            type="button"
            className="button-secondary ticket-action"
            aria-label={t('ticketTools.checklists.edit', { text: item.text })}
            onClick={() => setEditing(true)}
          >
            {t('ticketView.edit')}
          </button>
          {canMoveUp && (
            <button
              type="button"
              className="button-secondary ticket-action"
              disabled={busy}
              aria-label={t('ticketTools.checklists.moveUp', { text: item.text })}
              onClick={(event) => onMove(-1, event.currentTarget)}
            >
              {t('ticketTools.moveUp')}
            </button>
          )}
          {canMoveDown && (
            <button
              type="button"
              className="button-secondary ticket-action"
              disabled={busy}
              aria-label={t('ticketTools.checklists.moveDown', { text: item.text })}
              onClick={(event) => onMove(1, event.currentTarget)}
            >
              {t('ticketTools.moveDown')}
            </button>
          )}
          <button
            type="button"
            className="button-secondary ticket-action"
            disabled={busy}
            aria-label={t('ticketTools.checklists.removeItem', { text: item.text })}
            onClick={onRemove}
          >
            {t('ticketTools.remove')}
          </button>
        </span>
      ) : (
        <span className="checklist-item-state">{t(ITEM_STATE_LABELS[state])}</span>
      )}
    </li>
  );
}
