import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { useAdminAccess } from '../admin/access';
import { NewButton, useNewForm } from '../admin/NewButton';
import { ApiError } from '../api/client';
import { type Translate, useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { DangerAction } from '../shell/DangerAction';
import { EmptyState } from '../shell/EmptyState';
import { PageHeader } from '../shell/PageHeader';
import { TypeGlyph } from '../shell/TicketIcons';
import {
  type HierarchyImpact,
  type Level,
  type TicketType,
  type TicketTypeChange,
  type TicketTypesClient,
  ticketTypesClient,
} from './client';

export interface TicketTypesPageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: TicketTypesClient;
}

/** The shapes a type's icon names, in the order the picker offers them (shell/TicketIcons.tsx). */
const SHAPES = ['outcome', 'feature', 'bug', 'chore', 'to-do', 'idea', 'subticket'] as const;
/** Any other icon name draws a plain hexagon; this is the one the page stores. */
const PLAIN = 'hexagon';
const SHAPE_WORDS: Readonly<Record<string, MessageId>> = {
  outcome: 'admin.ticketTypes.icon.outcome',
  feature: 'admin.ticketTypes.icon.feature',
  bug: 'admin.ticketTypes.icon.bug',
  chore: 'admin.ticketTypes.icon.chore',
  'to-do': 'admin.ticketTypes.icon.toDo',
  idea: 'admin.ticketTypes.icon.idea',
  subticket: 'admin.ticketTypes.icon.subticket',
  [PLAIN]: 'admin.ticketTypes.icon.plain',
};
/** The lowest rank an added level takes: right above Outcome (rank 1). */
const FIRST_ADDED_RANK = 2;

/** The shape a type draws: its icon if it is one of ours, then its name's, then the hexagon. */
function shapeOf(icon: string | null, name: string): string {
  const wanted = icon ?? name.trim().toLowerCase();
  return (SHAPES as readonly string[]).includes(wanted) ? wanted : PLAIN;
}

/** Why a change is refused, in words: the parent links it breaks and the tickets left without one. */
const breaking = (t: Translate, impact: HierarchyImpact) =>
  t('admin.ticketTypes.breaks', {
    links: impact.brokenLinkCount,
    orphans: impact.ticketsNeedingParent.length,
  });

type Feedback = {
  /** Says what was done, then reads the lists again. */
  said: (message: string) => Promise<void>;
  failed: (error: unknown, kind?: 'level' | 'type', name?: string) => void;
};

/**
 * Ticket types and hierarchy levels (CORE-005 to CORE-007), for site and configuration
 * administrators. The levels are the page's headings, top first; each lists the shared types at
 * it. Levels are added above Outcome, renamed, and the added ones moved and removed; removing one
 * says first what it would do (`GET /api/v1/hierarchy-levels/impact`). A type is added, renamed,
 * described, given one of our shapes, put at another level and deleted. Every change that would
 * break a parent link is refused by the server, and the page says so with the counts.
 *
 * The page shows stored names, as the other configuration pages do. A type's colour is stored but
 * drawn nowhere, so it has no control here; a local-mode track's own types are not listed.
 */
export function TicketTypesPage({ client = ticketTypesClient }: TicketTypesPageProps) {
  const t = useT();
  const expired = useSessionExpiry();
  const titleId = useId();
  const title = useRef<HTMLHeadingElement>(null);
  const access = useAdminAccess();
  // Everyone signed in reads the lists, so the session decides who may use the page.
  const notAdmin = access !== null && access !== 'site' && access !== 'setup';
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'loaded'; levels: Level[]; types: TicketType[] }
    | { status: 'failed' }
    | { status: 'forbidden' }
  >({ status: 'loading' });
  /** Counts the reads, so previews made against an older ladder are made again. */
  const [version, setVersion] = useState(0);
  const [open, setOpen] = useState<number | null>(null);
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const newType = useNewForm();
  const newLevel = useNewForm();
  const forbidden = notAdmin || state.status === 'forbidden';

  const load = useCallback(async () => {
    try {
      const [levels, types] = await Promise.all([client.levels(), client.ticketTypes()]);
      setState({ status: 'loaded', levels: [...levels].sort((a, b) => b.rank - a.rank), types });
      setVersion((v) => v + 1);
    } catch (error) {
      if (expired(error)) return;
      if (error instanceof ApiError && error.status === 403) setState({ status: 'forbidden' });
      else setState({ status: 'failed' });
    }
  }, [client, expired]);
  useEffect(() => {
    if (access !== null && !notAdmin) void load();
  }, [load, access, notAdmin]);

  const refusal = useCallback(
    (error: unknown, kind: 'level' | 'type' = 'type', name = '') => {
      if (!(error instanceof ApiError)) return t('admin.ticketTypes.problem.other');
      const body = error.body as {
        error?: string;
        impact?: HierarchyImpact;
        typeSets?: { name: string }[];
        ticketCount?: number;
      } | null;
      switch (body?.error) {
        case 'breaks_tickets':
          return body.impact
            ? t('admin.ticketTypes.problem.breaks', { why: breaking(t, body.impact) })
            : t('admin.ticketTypes.problem.other');
        case 'name_taken':
          return t(
            kind === 'level'
              ? 'admin.ticketTypes.problem.levelNameTaken'
              : 'admin.ticketTypes.problem.typeNameTaken',
          );
        case 'in_type_sets':
          return t('admin.ticketTypes.problem.inTypeSets', {
            name,
            sets: (body.typeSets ?? []).map((s) => s.name).join(', '),
          });
        case 'has_tickets':
          return t('admin.ticketTypes.problem.hasTickets', { tickets: body.ticketCount ?? 0 });
        case 'builtin_level':
          return t('admin.ticketTypes.problem.builtin');
        case 'rank_out_of_range':
          return t('admin.ticketTypes.problem.rank');
      }
      if (error.status === 403) return t('admin.ticketTypes.problem.forbidden');
      if (error.status === 400) return t('admin.ticketTypes.problem.invalid');
      return t('admin.ticketTypes.problem.other');
    },
    [t],
  );
  const said = (text: string) => {
    setMessage(text);
    setProblem(null);
    return load();
  };
  const failed: Feedback['failed'] = (error, kind, name) => {
    if (expired(error)) return;
    setProblem(refusal(error, kind, name));
    // A refusal can come from a ladder someone else changed: read it again.
    void load();
  };

  return (
    <section aria-labelledby={titleId} className="page admin-page people-page">
      <PageHeader
        titleId={titleId}
        titleRef={title}
        title={t('admin.ticketTypes.title')}
        {...(forbidden
          ? {}
          : {
              purpose: t('settings.ticketTypesHint'),
              about: t('admin.ticketTypes.intro'),
              actions: (
                <>
                  <NewButton
                    label={t('admin.ticketTypes.newType')}
                    open={newType.open}
                    onToggle={newType.toggle}
                    ref={newType.button}
                  />
                  <NewButton
                    label={t('admin.ticketTypes.newLevel')}
                    open={newLevel.open}
                    onToggle={newLevel.toggle}
                    ref={newLevel.button}
                  />
                </>
              ),
            })}
      />
      {forbidden ? (
        <p className="page-note">{t('admin.ticketTypes.forbidden')}</p>
      ) : (
        <>
          {state.status === 'loaded' && newType.open && (
            <NewTypeForm
              client={client}
              levels={state.levels}
              onCancel={newType.close}
              onAdded={(made) => {
                newType.close();
                setOpen(made.id);
                void said(t('admin.ticketTypes.typeAdded', { name: made.name }));
              }}
              failed={failed}
            />
          )}
          {state.status === 'loaded' && newLevel.open && (
            <NewLevelForm
              client={client}
              levels={state.levels}
              onCancel={newLevel.close}
              onAdded={(made) => {
                newLevel.close();
                void said(t('admin.ticketTypes.levelCreated', { name: made.name }));
              }}
              failed={failed}
            />
          )}
          <p role="status" className="form-status">
            {message}
          </p>
          {problem && (
            <p role="alert" className="form-error">
              {problem}
            </p>
          )}
          {state.status === 'loading' && (
            <p className="page-note">{t('admin.ticketTypes.loading')}</p>
          )}
          {state.status === 'failed' && (
            <p role="alert" className="form-error">
              {t('admin.ticketTypes.failed')}
            </p>
          )}
          {state.status === 'loaded' &&
            state.levels.map((level) => (
              <LevelCard
                key={level.id}
                level={level}
                levels={state.levels}
                types={state.types}
                open={open}
                onOpen={setOpen}
                version={version}
                client={client}
                said={said}
                failed={failed}
                onTypeDeleted={(name) => {
                  // The type's row goes: the page's heading takes the focus.
                  setOpen(null);
                  void said(t('admin.ticketTypes.typeDeleted', { name }));
                  title.current?.focus();
                }}
                onLevelRemoved={() => {
                  // The level's card goes at once, before the lists are read again, so the
                  // keyboard is not left on a button that is about to go: the heading takes it.
                  setState((was) =>
                    was.status === 'loaded'
                      ? { ...was, levels: was.levels.filter((l) => l.id !== level.id) }
                      : was,
                  );
                  title.current?.focus();
                }}
              />
            ))}
        </>
      )}
    </section>
  );
}

/** One level: its heading, what may be done to it, and the types that sit at it. */
function LevelCard({
  level,
  levels,
  types,
  open,
  onOpen,
  version,
  client,
  said,
  failed,
  onTypeDeleted,
  onLevelRemoved,
}: Feedback & {
  level: Level;
  levels: Level[];
  types: TicketType[];
  open: number | null;
  onOpen: (id: number | null) => void;
  version: number;
  client: TicketTypesClient;
  onTypeDeleted: (name: string) => void;
  onLevelRemoved: () => void;
}) {
  const t = useT();
  const headingId = useId();
  const formId = useId();
  const card = useRef<HTMLElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(level.name);
  const [description, setDescription] = useState(level.description);
  /** After a move, the move button that keeps the keyboard; the other one at the end of the ladder. */
  const [moved, setMoved] = useState<'up' | 'down' | null>(null);
  const added = level.kind === 'custom';
  const top = Math.max(...levels.map((l) => l.rank));
  const atLevel = types.filter((type) => type.level.id === level.id);
  const removal = useRemovalPreview(client, added ? level.id : null, version);

  useEffect(() => {
    if (!moved) return;
    const buttons = card.current?.querySelectorAll<HTMLButtonElement>('[data-move]');
    const wanted = [...(buttons ?? [])].find((b) => b.dataset.move === moved);
    const other = [...(buttons ?? [])].find((b) => b.dataset.move !== moved);
    (wanted && !wanted.disabled ? wanted : other)?.focus();
    setMoved(null);
  }, [moved]);

  const move = (direction: 'up' | 'down') =>
    client.updateLevel(level.id, { rank: level.rank + (direction === 'up' ? 1 : -1) }).then(
      () =>
        said(
          t(
            direction === 'up'
              ? 'admin.ticketTypes.levelMovedUp'
              : 'admin.ticketTypes.levelMovedDown',
            { name: level.name },
          ),
        ).then(() => setMoved(direction)),
      (error) => failed(error, 'level'),
    );

  return (
    <section ref={card} aria-labelledby={headingId} className="glass-card people-card">
      <div className="admin-card-head">
        <h2 id={headingId} className="facts-title">
          {level.name}
        </h2>
        <div className="people-actions">
          {added && (
            <>
              <button
                type="button"
                className="button-secondary people-action"
                data-move="up"
                aria-label={t('admin.ticketTypes.moveUp', { name: level.name })}
                disabled={level.rank >= top}
                onClick={() => void move('up')}
              >
                {t('admin.ticketTypes.up')}
              </button>
              <button
                type="button"
                className="button-secondary people-action"
                data-move="down"
                aria-label={t('admin.ticketTypes.moveDown', { name: level.name })}
                disabled={level.rank <= FIRST_ADDED_RANK}
                onClick={() => void move('down')}
              >
                {t('admin.ticketTypes.down')}
              </button>
            </>
          )}
          <button
            type="button"
            className="button-secondary people-action"
            aria-expanded={renaming}
            aria-label={t('admin.ticketTypes.renameLevelOf', { name: level.name })}
            onClick={() => {
              setName(level.name);
              setDescription(level.description);
              setRenaming(!renaming);
            }}
          >
            {t('admin.ticketTypes.renameLevel')}
          </button>
          {added && (
            <RemoveLevel
              level={level}
              levels={levels}
              types={atLevel}
              impact={removal}
              client={client}
              said={said}
              failed={failed}
              onRemoved={onLevelRemoved}
            />
          )}
        </div>
      </div>
      <p className="people-meta">
        {t(added ? 'admin.ticketTypes.levelAdded' : 'admin.ticketTypes.levelBuiltin')}
      </p>
      {level.description && <p className="people-meta">{level.description}</p>}
      {removal !== null && removal !== 'failed' && removal.breaksTickets && (
        <p className="form-hint">
          {t('admin.ticketTypes.cannotRemove', { name: level.name, why: breaking(t, removal) })}
        </p>
      )}
      {renaming && (
        <form
          className="people-inline"
          aria-label={t('admin.ticketTypes.renameLevelOf', { name: level.name })}
          onSubmit={(event) => {
            event.preventDefault();
            const wanted = name.trim();
            if (!wanted) return;
            client.updateLevel(level.id, { name: wanted, description }).then(
              (saved) => {
                setRenaming(false);
                void said(t('admin.ticketTypes.levelSaved', { name: saved.name }));
              },
              (error) => failed(error, 'level'),
            );
          }}
        >
          <div className="form-field">
            <label htmlFor={`${formId}-name`} className="form-label">
              {t('admin.ticketTypes.levelName')}
            </label>
            <input
              id={`${formId}-name`}
              type="text"
              required
              maxLength={255}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="form-field">
            <label htmlFor={`${formId}-about`} className="form-label">
              {t('admin.ticketTypes.description')}
            </label>
            <input
              id={`${formId}-about`}
              type="text"
              maxLength={2000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <button type="submit" className="button-secondary">
            {t('admin.ticketTypes.saveLevel')}
          </button>
        </form>
      )}
      {atLevel.length === 0 ? (
        <EmptyState compact title={t('admin.ticketTypes.noTypes')} />
      ) : (
        <ul
          className="people-list"
          aria-label={t('admin.ticketTypes.typesAt', { name: level.name })}
        >
          {atLevel.map((type) => (
            <li key={type.id} className="people-item people-group">
              <div className="people-main">
                <p className="people-name">
                  <TypeGlyph name={type.name} icon={type.icon} />
                  {type.name}
                </p>
                {type.description && <p className="people-meta">{type.description}</p>}
              </div>
              <div className="people-actions">
                <button
                  type="button"
                  className="button-secondary people-action"
                  aria-expanded={open === type.id}
                  aria-label={t('admin.ticketTypes.manageOf', { name: type.name })}
                  onClick={() => onOpen(open === type.id ? null : type.id)}
                >
                  {t('admin.ticketTypes.manage')}
                </button>
              </div>
              {open === type.id && (
                <TypePanel
                  key={type.id}
                  type={type}
                  levels={levels}
                  client={client}
                  said={said}
                  failed={failed}
                  onDeleted={() => onTypeDeleted(type.name)}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * What removing an added level would do, read again with every read of the lists (`version`):
 * null while the server has not said, and for a built-in level, which is never removed.
 */
function useRemovalPreview(
  client: TicketTypesClient,
  levelId: number | null,
  version: number,
): HierarchyImpact | 'failed' | null {
  const [impact, setImpact] = useState<HierarchyImpact | 'failed' | null>(null);
  useEffect(() => {
    setImpact(null);
    if (levelId === null) return;
    let live = true;
    // The preview belongs to one read of the ladder: a new read makes a new preview.
    void version;
    client.impact({ change: 'remove', levelId }).then(
      (found) => live && setImpact(found),
      () => live && setImpact('failed'),
    );
    return () => {
      live = false;
    };
  }, [client, levelId, version]);
  return impact;
}

/**
 * Removing an added level asks first and says what it would do (CORE-007 (1)): its types fall to
 * the standard level, and how many tickets change level. While it would break a parent link it is
 * not offered, and the level's card says why.
 */
function RemoveLevel({
  level,
  levels,
  types,
  impact,
  client,
  said,
  failed,
  onRemoved,
}: Feedback & {
  level: Level;
  levels: Level[];
  types: TicketType[];
  impact: HierarchyImpact | 'failed' | null;
  client: TicketTypesClient;
  onRemoved: () => void;
}) {
  const t = useT();
  const intl = useIntl();
  const known = impact !== null && impact !== 'failed' ? impact : null;
  const standard = levels.find((l) => l.kind === 'standard')?.name ?? '';
  return (
    <DangerAction
      label={t('admin.ticketTypes.removeLevel')}
      name={t('admin.ticketTypes.removeLevelOf', { name: level.name })}
      outcome={t('admin.ticketTypes.confirmRemove', {
        name: level.name,
        types: types.length,
        names: intl.formatList(types.map((type) => type.name)),
        standard,
        known: known ? 'yes' : 'no',
        tickets: known?.ticketsChangingLevel ?? 0,
      })}
      confirmLabel={t('admin.ticketTypes.removeLevelOf', { name: level.name })}
      disabled={impact === null || (known?.breaksTickets ?? false)}
      onConfirm={async () => {
        try {
          await client.deleteLevel(level.id);
        } catch (error) {
          failed(error, 'level');
          throw error;
        }
        void said(t('admin.ticketTypes.levelRemoved', { name: level.name }));
        onRemoved();
      }}
    />
  );
}

/** The eight icons a type may have, as radio buttons with each shape beside its name. */
function IconPicker({ value, onChange }: { value: string; onChange: (shape: string) => void }) {
  const t = useT();
  const id = useId();
  return (
    <fieldset className="sets-choices">
      <legend>{t('admin.ticketTypes.icon')}</legend>
      {[...SHAPES, PLAIN].map((shape) => (
        <div key={shape} className="form-field form-field-inline">
          <input
            id={`${id}-${shape}`}
            type="radio"
            name={`${id}-icon`}
            value={shape}
            checked={value === shape}
            onChange={() => onChange(shape)}
          />
          <label htmlFor={`${id}-${shape}`}>
            <span className="people-sublist-row">
              <TypeGlyph name="" icon={shape} />
              {t(SHAPE_WORDS[shape] as MessageId)}
            </span>
          </label>
        </div>
      ))}
    </fieldset>
  );
}

/** The levels a type may sit at, top first. */
function LevelSelect({
  id,
  levels,
  value,
  onChange,
}: {
  id: string;
  levels: Level[];
  value: number;
  onChange: (levelId: number) => void;
}) {
  const t = useT();
  return (
    <div className="form-field">
      <label htmlFor={id} className="form-label">
        {t('admin.ticketTypes.level')}
      </label>
      <select id={id} value={value} onChange={(event) => onChange(Number(event.target.value))}>
        {levels.map((level) => (
          <option key={level.id} value={level.id}>
            {level.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function NewTypeForm({
  client,
  levels,
  onCancel,
  onAdded,
  failed,
}: Pick<Feedback, 'failed'> & {
  client: TicketTypesClient;
  levels: Level[];
  onCancel: () => void;
  onAdded: (made: TicketType) => void;
}) {
  const t = useT();
  const id = useId();
  const standard = levels.find((l) => l.kind === 'standard') ?? levels[0];
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [levelId, setLevelId] = useState(standard?.id ?? 0);
  const [icon, setIcon] = useState<string>(PLAIN);
  return (
    <form
      className="glass-card people-card people-form"
      aria-label={t('admin.ticketTypes.addType')}
      onSubmit={(event) => {
        event.preventDefault();
        const wanted = name.trim();
        if (!wanted) return;
        client
          .createType({
            name: wanted,
            levelId,
            ...(description.trim() ? { description: description.trim() } : {}),
            // A type with no icon draws its name's shape: store one only when it differs.
            ...(icon !== shapeOf(null, wanted) ? { icon } : {}),
          })
          .then(onAdded, (error) => failed(error, 'type'));
      }}
    >
      <div className="form-field">
        <label htmlFor={`${id}-name`} className="form-label">
          {t('admin.ticketTypes.typeName')}
        </label>
        <input
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
          {t('admin.ticketTypes.description')}
        </label>
        <input
          id={`${id}-about`}
          type="text"
          maxLength={2000}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      <LevelSelect id={`${id}-level`} levels={levels} value={levelId} onChange={setLevelId} />
      <IconPicker value={icon} onChange={setIcon} />
      <div className="form-actions">
        <button type="submit" className="button-primary">
          {t('admin.ticketTypes.addType')}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('admin.ticketTypes.cancelNew')}
        </button>
      </div>
    </form>
  );
}

function NewLevelForm({
  client,
  levels,
  onCancel,
  onAdded,
  failed,
}: Pick<Feedback, 'failed'> & {
  client: TicketTypesClient;
  levels: Level[];
  onCancel: () => void;
  onAdded: (made: Level) => void;
}) {
  const t = useT();
  const id = useId();
  // A new level goes right above Outcome or above any level added there, the top by default.
  const places = levels.filter((l) => l.rank >= FIRST_ADDED_RANK - 1);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rank, setRank] = useState((places[0]?.rank ?? 1) + 1);
  return (
    <form
      className="glass-card people-card people-form"
      aria-label={t('admin.ticketTypes.addLevel')}
      onSubmit={(event) => {
        event.preventDefault();
        const wanted = name.trim();
        if (!wanted) return;
        client
          .createLevel({
            name: wanted,
            rank,
            ...(description.trim() ? { description: description.trim() } : {}),
          })
          .then(onAdded, (error) => failed(error, 'level'));
      }}
    >
      <div className="form-field">
        <label htmlFor={`${id}-name`} className="form-label">
          {t('admin.ticketTypes.levelName')}
        </label>
        <input
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
          {t('admin.ticketTypes.description')}
        </label>
        <input
          id={`${id}-about`}
          type="text"
          maxLength={2000}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-place`} className="form-label">
          {t('admin.ticketTypes.place')}
        </label>
        <select
          id={`${id}-place`}
          value={rank}
          aria-describedby={`${id}-place-hint`}
          onChange={(event) => setRank(Number(event.target.value))}
        >
          {places.map((level) => (
            <option key={level.id} value={level.rank + 1}>
              {t('admin.ticketTypes.placeAbove', { name: level.name })}
            </option>
          ))}
        </select>
        <p id={`${id}-place-hint`} className="form-hint">
          {t('admin.ticketTypes.placeHint')}
        </p>
      </div>
      <div className="form-actions">
        <button type="submit" className="button-primary">
          {t('admin.ticketTypes.addLevel')}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('admin.ticketTypes.cancelNew')}
        </button>
      </div>
    </form>
  );
}

/** A type's settings: name, description, level and icon, then Delete, which asks first (D13). */
function TypePanel({
  type,
  levels,
  client,
  said,
  failed,
  onDeleted,
}: Feedback & {
  type: TicketType;
  levels: Level[];
  client: TicketTypesClient;
  onDeleted: () => void;
}) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState(type.name);
  const [description, setDescription] = useState(type.description);
  const [levelId, setLevelId] = useState(type.level.id);
  const [icon, setIcon] = useState(shapeOf(type.icon, type.name));
  /** What putting the type at the chosen level would do, once the server has said. */
  const [preview, setPreview] = useState<HierarchyImpact | null>(null);
  useEffect(() => {
    setPreview(null);
    if (levelId === type.level.id) return;
    let live = true;
    client.impact({ change: 'retype', typeId: type.id, levelId }).then(
      (found) => live && setPreview(found),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [client, levelId, type.id, type.level.id]);

  return (
    <form
      className="people-panel"
      aria-label={t('admin.ticketTypes.settingsOf', { name: type.name })}
      onSubmit={(event) => {
        event.preventDefault();
        const wanted = name.trim();
        if (!wanted) return;
        const change: TicketTypeChange = {};
        if (wanted !== type.name) change.name = wanted;
        if (description !== type.description) change.description = description;
        if (levelId !== type.level.id) change.levelId = levelId;
        // Sent only when what the type draws would change: a type with none keeps none.
        if (icon !== shapeOf(type.icon, wanted)) change.icon = icon;
        client.updateType(type.id, change).then(
          (saved) => void said(t('admin.ticketTypes.typeSaved', { name: saved.name })),
          (error) => failed(error, 'type', type.name),
        );
      }}
    >
      <div className="form-field">
        <label htmlFor={`${id}-name`} className="form-label">
          {t('admin.ticketTypes.typeName')}
        </label>
        <input
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
          {t('admin.ticketTypes.description')}
        </label>
        <input
          id={`${id}-about`}
          type="text"
          maxLength={2000}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      <LevelSelect id={`${id}-level`} levels={levels} value={levelId} onChange={setLevelId} />
      <p className="form-hint" aria-live="polite">
        {preview &&
          (preview.breaksTickets
            ? t('admin.ticketTypes.retypeRefused', { why: breaking(t, preview) })
            : t('admin.ticketTypes.retypePreview', { tickets: preview.ticketsChangingLevel }))}
      </p>
      <IconPicker value={icon} onChange={setIcon} />
      <div className="form-actions">
        <button type="submit" className="button-primary">
          {t('admin.ticketTypes.save')}
        </button>
        <DangerAction
          label={t('admin.ticketTypes.deleteType')}
          name={t('admin.ticketTypes.deleteTypeOf', { name: type.name })}
          outcome={t('admin.ticketTypes.confirmDelete', { name: type.name })}
          confirmLabel={t('admin.ticketTypes.deleteTypeOf', { name: type.name })}
          onConfirm={async () => {
            try {
              await client.deleteType(type.id);
            } catch (error) {
              failed(error, 'type', type.name);
              throw error;
            }
            onDeleted();
          }}
        />
      </div>
    </form>
  );
}
