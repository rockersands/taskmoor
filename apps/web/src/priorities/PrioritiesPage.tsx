import {
  type FormEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { useIntl } from 'react-intl';
import { useAdminAccess } from '../admin/access';
import { CardHead, NewButton, useNewForm } from '../admin/NewButton';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { DangerAction } from '../shell/DangerAction';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import { PriorityGlyph } from '../shell/TicketIcons';
import {
  type CloseReason,
  type NamedValue,
  type PrioritiesClient,
  type Priority,
  type PrioritySet,
  prioritiesClient,
} from './client';
import { type Feedback, useFeedback } from './feedback';
import { PrioritySetsSection } from './PrioritySetsSection';

export interface PrioritiesPageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: PrioritiesClient;
}

/**
 * Priorities, priority sets and close reasons (CORE-014; ADR-114 section 1, T-320), for site and
 * configuration administrators. The site's priorities and close reasons are ordered lists: add,
 * change, move up and down, and delete, where a value in use first asks which one takes its place
 * (CORE-014 (3)). Priority sets choose which priorities a track offers and what new tickets get
 * (CORE-014 (2)). A priority's stored icon and colour change nothing drawn, so the page offers
 * neither: its icon follows its place in the list.
 */
export function PrioritiesPage({ client = prioritiesClient }: PrioritiesPageProps) {
  const t = useT();
  const expired = useSessionExpiry();
  const titleId = useId();
  const access = useAdminAccess();
  // Everyone signed in reads these lists; only site and configuration administrators change them.
  const notAdmin = access !== null && access !== 'site' && access !== 'setup';
  const [state, setState] = useState<
    | { status: 'loading' }
    | {
        status: 'loaded';
        priorities: Priority[];
        sets: PrioritySet[];
        reasons: CloseReason[];
      }
    | { status: 'failed' }
    | { status: 'forbidden' }
  >({ status: 'loading' });

  const load = useCallback(async () => {
    try {
      const [priorities, sets, reasons] = await Promise.all([
        client.priorities(),
        client.prioritySets(),
        client.closeReasons(),
      ]);
      setState({ status: 'loaded', priorities, sets, reasons });
    } catch (error) {
      if (expired(error)) return;
      if (error instanceof ApiError && error.status === 403) setState({ status: 'forbidden' });
      else setState({ status: 'failed' });
    }
  }, [client, expired]);
  useEffect(() => {
    if (!notAdmin) void load();
  }, [load, notAdmin]);

  const shown = notAdmin ? { status: 'forbidden' as const } : state;
  return (
    <section aria-labelledby={titleId} className="page admin-page people-page">
      <PageHeader
        titleId={titleId}
        title={t('admin.priorities.title')}
        {...(shown.status === 'forbidden'
          ? {}
          : { purpose: t('admin.priorities.purpose'), about: t('admin.priorities.about') })}
      />
      {shown.status === 'forbidden' && (
        <p className="page-note">{t('admin.priorities.forbidden')}</p>
      )}
      {shown.status === 'loading' && <p className="page-note">{t('admin.priorities.loading')}</p>}
      {shown.status === 'failed' && (
        <p role="alert" className="form-error">
          {t('admin.priorities.failed')}
        </p>
      )}
      {shown.status === 'loaded' && (
        <>
          <PrioritiesSection client={client} priorities={shown.priorities} reload={load} />
          <PrioritySetsSection
            client={client}
            priorities={shown.priorities}
            sets={shown.sets}
            reload={load}
          />
          <CloseReasonsSection client={client} reasons={shown.reasons} reload={load} />
        </>
      )}
    </section>
  );
}

/** A value of an ordered list: a priority or a close reason. */
interface ListValue {
  id: number;
  name: string;
  description: string;
}

/** What an ordered list's section says, in the person's language. */
interface ValueWords {
  heading: string;
  newLabel: string;
  add: string;
  note: string;
  emptyTitle: string;
  empty: string;
  moveUp: (name: string) => string;
  moveDown: (name: string) => string;
  changeOf: (name: string) => string;
  deleteOf: (name: string) => string;
  confirmDelete: (name: string) => string;
  /** Why it was not deleted, from the server's answer, and what the choice below does. */
  inUse: (name: string, refusal: InUse) => string;
  noOther: string;
  deletedInto: (name: string, into: string) => string;
}

/** Why a delete needs a replacement: tickets have the value, or workflows set it. */
type InUse = { tickets: number } | { workflows: string[] };

/** The calls a section makes for its list. */
interface ValueCalls {
  create: (body: NamedValue) => Promise<void>;
  update: (id: number, change: NamedValue) => Promise<void>;
  order: (ids: number[]) => Promise<void>;
  remove: (id: number, replacementId?: number) => Promise<void>;
}

function PrioritiesSection({
  client,
  priorities,
  reload,
}: {
  client: PrioritiesClient;
  priorities: Priority[];
  reload: () => Promise<void>;
}) {
  const t = useT();
  const words: ValueWords = {
    heading: t('admin.priorities.priorities'),
    newLabel: t('admin.priorities.new'),
    add: t('admin.priorities.add'),
    note: t('admin.priorities.note'),
    emptyTitle: t('admin.priorities.emptyTitle'),
    empty: t('admin.priorities.empty'),
    moveUp: (name) => t('admin.priorities.moveUp', { name }),
    moveDown: (name) => t('admin.priorities.moveDown', { name }),
    changeOf: (name) => t('admin.priorities.changeOf', { name }),
    deleteOf: (name) => t('admin.priorities.deleteOf', { name }),
    confirmDelete: (name) => t('admin.priorities.confirmDelete', { name }),
    inUse: (name, refusal) =>
      t('admin.priorities.inUse', { name, count: 'tickets' in refusal ? refusal.tickets : 0 }),
    noOther: t('admin.priorities.noOther'),
    deletedInto: (name, into) => t('admin.priorities.deletedInto', { name, into }),
  };
  return (
    <OrderedValues
      values={priorities}
      glyph={(value) => <PriorityGlyph level={(value as Priority).level} />}
      words={words}
      calls={{
        create: client.createPriority,
        update: client.updatePriority,
        order: client.orderPriorities,
        remove: client.deletePriority,
      }}
      reload={reload}
    />
  );
}

function CloseReasonsSection({
  client,
  reasons,
  reload,
}: {
  client: PrioritiesClient;
  reasons: CloseReason[];
  reload: () => Promise<void>;
}) {
  const t = useT();
  const intl = useIntl();
  const words: ValueWords = {
    heading: t('admin.priorities.reasons'),
    newLabel: t('admin.priorities.newReason'),
    add: t('admin.priorities.addReason'),
    note: t('admin.priorities.reasonsNote'),
    emptyTitle: t('admin.priorities.reasonsEmptyTitle'),
    empty: t('admin.priorities.reasonsEmpty'),
    moveUp: (name) => t('admin.priorities.reasonMoveUp', { name }),
    moveDown: (name) => t('admin.priorities.reasonMoveDown', { name }),
    changeOf: (name) => t('admin.priorities.reasonChangeOf', { name }),
    deleteOf: (name) => t('admin.priorities.reasonDeleteOf', { name }),
    confirmDelete: (name) => t('admin.priorities.reasonConfirmDelete', { name }),
    inUse: (name, refusal) =>
      'tickets' in refusal
        ? t('admin.priorities.reasonInUse', { name, count: refusal.tickets })
        : t('admin.priorities.reasonUsedBy', {
            name,
            count: refusal.workflows.length,
            workflows: intl.formatList(refusal.workflows, { type: 'conjunction' }),
          }),
    noOther: t('admin.priorities.reasonNoOther'),
    deletedInto: (name, into) => t('admin.priorities.reasonDeletedInto', { name, into }),
  };
  return (
    <OrderedValues
      values={reasons}
      words={words}
      calls={{
        create: client.createCloseReason,
        update: client.updateCloseReason,
        order: client.orderCloseReasons,
        remove: client.deleteCloseReason,
      }}
      reload={reload}
    />
  );
}

/**
 * One of the site's ordered lists on a card: New, then each value with Up, Down, Change and
 * Delete. Up and Down are the keyboard's way to reorder (ADR-114 section 7); the order goes to the
 * server whole, as `PUT .../order` takes it.
 */
function OrderedValues({
  values,
  glyph,
  words,
  calls,
  reload,
}: {
  values: ListValue[];
  glyph?: (value: ListValue) => ReactNode;
  words: ValueWords;
  calls: ValueCalls;
  reload: () => Promise<void>;
}) {
  const t = useT();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const creating = useNewForm();
  const feedback = useFeedback(reload);

  /** Answers whether the value moved. */
  const move = async (index: number, by: -1 | 1): Promise<boolean> => {
    const ids = values.map((v) => v.id);
    const [moved] = ids.splice(index, 1);
    const value = values[index];
    if (moved === undefined || !value) return false;
    ids.splice(index + by, 0, moved);
    try {
      await calls.order(ids);
    } catch (error) {
      // The server takes the whole list: one changed elsewhere since it was read is refused.
      if (error instanceof ApiError && error.status === 400) {
        feedback.refusedWith(t('admin.priorities.problem.listChanged'));
        await reload();
      } else {
        feedback.refused(error);
      }
      return false;
    }
    await feedback.said(
      t(by < 0 ? 'admin.priorities.movedUp' : 'admin.priorities.movedDown', { name: value.name }),
    );
    return true;
  };

  return (
    <section aria-labelledby={headingId} className="glass-card people-card">
      <CardHead
        action={
          <NewButton
            label={words.newLabel}
            open={creating.open}
            onToggle={creating.toggle}
            ref={creating.button}
          />
        }
      >
        <h2 id={headingId} ref={heading} tabIndex={-1} className="facts-title">
          {words.heading}
        </h2>
      </CardHead>
      <p className="page-note">{words.note}</p>
      {creating.open && (
        <ValueForm
          label={words.add}
          submitLabel={words.add}
          onCancel={creating.close}
          onSubmit={async (body) => {
            try {
              await calls.create(body);
            } catch (error) {
              feedback.refused(error);
              return false;
            }
            creating.close();
            await feedback.said(t('admin.priorities.added', { name: body.name }));
            return true;
          }}
        />
      )}
      <p role="status" className="form-status">
        {feedback.message}
      </p>
      {feedback.problem && (
        <p role="alert" className="form-error">
          {feedback.problem}
        </p>
      )}
      {values.length === 0 ? (
        <EmptyState compact title={words.emptyTitle}>
          {words.empty}
        </EmptyState>
      ) : (
        <ul className="people-list">
          {values.map((value, index) => (
            <ValueRow
              key={value.id}
              value={value}
              index={index}
              count={values.length}
              others={values.filter((v) => v.id !== value.id)}
              glyph={glyph?.(value)}
              words={words}
              calls={calls}
              feedback={feedback}
              onMove={(by) => move(index, by)}
              onGone={() => heading.current?.focus()}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** A value's name and description, to add one or change one. */
function ValueForm({
  label,
  submitLabel,
  initial,
  onSubmit,
  onCancel,
  nameRef,
}: {
  label: string;
  submitLabel: string;
  initial?: ListValue;
  /** Answers whether it was saved; the form keeps what was typed when it was not. */
  onSubmit: (body: Required<NamedValue>) => Promise<boolean>;
  onCancel: () => void;
  nameRef?: Ref<HTMLInputElement>;
}) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState(initial?.name ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const wanted = name.trim();
    if (!wanted) return;
    void onSubmit({ name: wanted, description: description.trim() }).then((saved) => {
      if (saved && !initial) {
        setName('');
        setDescription('');
      }
    });
  };
  return (
    <form className="people-inline" aria-label={label} onSubmit={submit}>
      <div className="form-field">
        <label htmlFor={`${id}-name`} className="form-label">
          {t('admin.priorities.name')}
        </label>
        <input
          ref={nameRef}
          id={`${id}-name`}
          type="text"
          required
          maxLength={255}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-about`} className="form-label">
          {t('admin.priorities.description')}
        </label>
        <input
          id={`${id}-about`}
          type="text"
          maxLength={2000}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      <div className="form-actions">
        <button type="submit" className="button-primary">
          {submitLabel}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('admin.priorities.cancel')}
        </button>
      </div>
    </form>
  );
}

function ValueRow({
  value,
  index,
  count,
  others,
  glyph,
  words,
  calls,
  feedback,
  onMove,
  onGone,
}: {
  value: ListValue;
  index: number;
  count: number;
  others: ListValue[];
  glyph?: ReactNode;
  words: ValueWords;
  calls: ValueCalls;
  feedback: Feedback;
  /** Answers whether the value moved. */
  onMove: (by: -1 | 1) => Promise<boolean>;
  /** The value is gone: its list's heading takes the focus. */
  onGone: () => void;
}) {
  const t = useT();
  const id = useId();
  const row = useRef<HTMLLIElement>(null);
  const up = useRef<HTMLButtonElement>(null);
  const down = useRef<HTMLButtonElement>(null);
  const change = useRef<HTMLButtonElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const replaceSelect = useRef<HTMLSelectElement>(null);
  const [editing, setEditing] = useState(false);
  /** Set once the server said the value is in use: the choice of what takes its place shows. */
  const [inUse, setInUse] = useState<InUse | null>(null);
  const [replacement, setReplacement] = useState('');
  /** Which move button had the focus, to keep it on this value once the list is redrawn. */
  const moving = useRef<-1 | 1 | null>(null);
  const chosen = others.some((o) => String(o.id) === replacement)
    ? replacement
    : String(others[0]?.id ?? '');

  useEffect(() => {
    if (editing) nameInput.current?.focus();
  }, [editing]);
  useEffect(() => {
    if (inUse) replaceSelect.current?.focus();
  }, [inUse]);
  // After a move the value sits elsewhere; at the top or bottom its button in that direction is
  // off, so the focus goes to the other one rather than falling to the page.
  useEffect(() => {
    const by = moving.current;
    if (by === null) return;
    moving.current = null;
    const wanted = by < 0 ? (index === 0 ? down : up) : index === count - 1 ? up : down;
    wanted.current?.focus();
  }, [index, count]);

  const remove = async (replacementId?: number) => {
    try {
      await calls.remove(value.id, replacementId);
    } catch (error) {
      const body =
        error instanceof ApiError
          ? (error.body as {
              error?: string;
              ticketCount?: number;
              workflows?: { name: string }[];
            } | null)
          : null;
      if (error instanceof ApiError && error.status === 409 && body?.error === 'in_use') {
        setInUse({ tickets: body.ticketCount ?? 0 });
        return;
      }
      if (error instanceof ApiError && error.status === 409 && body?.error === 'used_by_workflow') {
        setInUse({ workflows: (body.workflows ?? []).map((w) => w.name) });
        return;
      }
      feedback.refused(error);
      throw error;
    }
    setInUse(null);
    const into = others.find((o) => o.id === replacementId)?.name;
    await feedback.said(
      into
        ? words.deletedInto(value.name, into)
        : t('admin.priorities.deleted', { name: value.name }),
    );
    onGone();
  };

  return (
    <li ref={row} className="people-item">
      <div className="people-main">
        <p className="people-name">
          {glyph}
          {value.name}
        </p>
        {value.description && <p className="people-meta">{value.description}</p>}
      </div>
      <div className="people-actions">
        <button
          ref={up}
          type="button"
          className="button-secondary people-action"
          aria-label={words.moveUp(value.name)}
          disabled={index === 0}
          onClick={() => {
            moving.current = -1;
            void onMove(-1).then((moved) => {
              if (!moved) moving.current = null;
            });
          }}
        >
          {t('admin.priorities.up')}
        </button>
        <button
          ref={down}
          type="button"
          className="button-secondary people-action"
          aria-label={words.moveDown(value.name)}
          disabled={index === count - 1}
          onClick={() => {
            moving.current = 1;
            void onMove(1).then((moved) => {
              if (!moved) moving.current = null;
            });
          }}
        >
          {t('admin.priorities.down')}
        </button>
        <button
          ref={change}
          type="button"
          className="button-secondary people-action"
          aria-expanded={editing}
          aria-label={words.changeOf(value.name)}
          onClick={() => setEditing(!editing)}
        >
          {t('admin.priorities.change')}
        </button>
        {/* Asks first, saying what will happen (D13); a value in use asks what takes its place. */}
        <DangerAction
          label={t('admin.priorities.delete')}
          name={words.deleteOf(value.name)}
          outcome={words.confirmDelete(value.name)}
          confirmLabel={words.deleteOf(value.name)}
          onConfirm={() => remove()}
        />
      </div>
      {editing && (
        <div className="people-panel">
          <ValueForm
            label={words.changeOf(value.name)}
            submitLabel={t('admin.priorities.save')}
            initial={value}
            nameRef={nameInput}
            onCancel={() => {
              setEditing(false);
              change.current?.focus();
            }}
            onSubmit={async (body) => {
              try {
                await calls.update(value.id, body);
              } catch (error) {
                feedback.refused(error);
                return false;
              }
              setEditing(false);
              change.current?.focus();
              await feedback.said(t('admin.priorities.saved', { name: body.name }));
              return true;
            }}
          />
        </div>
      )}
      {inUse && (
        <div className="people-panel">
          <form
            className="people-inline"
            aria-label={t('admin.priorities.replaceOf', { name: value.name })}
            onSubmit={(event) => {
              event.preventDefault();
              if (chosen) remove(Number(chosen)).catch(() => {});
            }}
          >
            <p className="people-meta">{words.inUse(value.name, inUse)}</p>
            {others.length === 0 ? (
              <p className="people-meta">{words.noOther}</p>
            ) : (
              <div className="form-field">
                <label htmlFor={`${id}-replace`} className="form-label">
                  {t('admin.priorities.replaceWith')}
                </label>
                <select
                  ref={replaceSelect}
                  id={`${id}-replace`}
                  value={chosen}
                  onChange={(event) => setReplacement(event.target.value)}
                >
                  {others.map((other) => (
                    <option key={other.id} value={other.id}>
                      {other.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="form-actions">
              {others.length > 0 && (
                <button type="submit" className="button-danger">
                  {words.deleteOf(value.name)}
                </button>
              )}
              <button
                type="button"
                className="button-secondary"
                onClick={() => {
                  setInUse(null);
                  // Back to the value's own Delete.
                  row.current?.querySelector<HTMLButtonElement>('.button-danger-quiet')?.focus();
                }}
              >
                {t('admin.priorities.cancel')}
              </button>
            </div>
          </form>
        </div>
      )}
    </li>
  );
}
