import { useId, useRef, useState } from 'react';
import { CardHead, NewButton, useNewForm } from '../admin/NewButton';
import { ApiError } from '../api/client';
import { type Translate, useT } from '../i18n/I18nProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { DangerAction } from '../shell/DangerAction';
import { EmptyState } from '../shell/EmptyState';
import { TypeGlyph } from '../shell/TicketIcons';
import type { HierarchyImpact, Level, TicketType, TicketTypeChange } from '../tickettypes/client';
import { IconPicker, LevelSelect, shapeOf } from '../tickettypes/TicketTypesPage';
import type { SetsClient } from './client';
import type { ScopeTrack } from './trackScope';

export interface OwnTypesSectionProps {
  client: SetsClient;
  track: ScopeTrack;
  /** Every level, top first. */
  levels: Level[];
  /** The ticket types the track owns. */
  types: TicketType[];
  /** The types its type set holds: a type of its own is offered once it is ticked there. */
  offered: ReadonlySet<number>;
  /** Says what was done, then reads the page again. */
  said: (message: string) => void;
  /** Says why a change was refused. */
  refused: (message: string) => void;
}

/** A refusal of a change to one of the track's types, in words (`routes/ticket-types.ts`). */
function refusalOf(t: Translate, track: ScopeTrack, error: unknown, name: string): string {
  if (!(error instanceof ApiError)) return t('admin.ticketTypes.problem.other');
  const body = error.body as {
    error?: string;
    impact?: HierarchyImpact;
    typeSets?: { name: string }[];
    ticketCount?: number;
  } | null;
  switch (body?.error) {
    case 'name_taken':
      return t('admin.ticketTypes.problem.typeNameTaken');
    case 'in_type_sets':
      return t('ownTypes.problem.inTypeSet', {
        name,
        sets: (body.typeSets ?? []).map((s) => s.name).join(', '),
      });
    case 'has_tickets':
      return t('admin.ticketTypes.problem.hasTickets', { tickets: body.ticketCount ?? 0 });
    case 'breaks_tickets':
      return body.impact
        ? t('admin.ticketTypes.problem.breaks', {
            why: t('admin.ticketTypes.breaks', {
              links: body.impact.brokenLinkCount,
              orphans: body.impact.ticketsNeedingParent.length,
            }),
          })
        : t('admin.ticketTypes.problem.other');
    case 'track_archived':
      return t('ownSets.archived', { key: track.key });
  }
  if (error.status === 403) return t('admin.ticketTypes.problem.forbidden');
  if (error.status === 400) return t('admin.ticketTypes.problem.invalid');
  return t('admin.ticketTypes.problem.other');
}

/**
 * A local-mode track's own ticket types (CORE-003, CORE-005; spec 01a section 1.1; T-322), on its
 * own Configuration sets page: whoever runs the track adds a type at a level, with a description
 * and an icon, changes them, and deletes a type once no type set holds it and no ticket has it.
 * Each row says whether the track's type set holds the type, since a type is offered only once it
 * is ticked there. No preview of a level change: that preview reads tickets across tracks, so it
 * is for administrators, and the server's refusal says the counts instead. Levels themselves are
 * the site's, changed on Ticket types.
 */
export function OwnTypesSection({
  client,
  track,
  levels,
  types,
  offered,
  said,
  refused,
}: OwnTypesSectionProps) {
  const t = useT();
  const expired = useSessionExpiry();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const creating = useNewForm();
  const [open, setOpen] = useState<number | null>(null);
  const failed = (error: unknown, name = '') => {
    if (!expired(error)) refused(refusalOf(t, track, error, name));
  };
  return (
    <section aria-labelledby={headingId} className="glass-card people-card">
      <CardHead
        action={
          <NewButton
            label={t('admin.ticketTypes.newType')}
            open={creating.open}
            onToggle={creating.toggle}
            ref={creating.button}
          />
        }
      >
        <h2 id={headingId} ref={heading} tabIndex={-1} className="facts-title">
          {t('ownTypes.title')}
        </h2>
      </CardHead>
      <p className="page-note">{t('ownTypes.intro', { key: track.key })}</p>
      {creating.open && (
        <NewOwnTypeForm
          client={client}
          track={track}
          levels={levels}
          onCancel={creating.close}
          onAdded={(made) => {
            creating.close();
            said(t('ownTypes.added', { name: made.name }));
          }}
          failed={failed}
        />
      )}
      {types.length === 0 ? (
        <EmptyState compact title={t('ownTypes.none', { key: track.key })}>
          {t('ownTypes.noneBody')}
        </EmptyState>
      ) : (
        <ul className="people-list" aria-label={t('ownTypes.listOf', { key: track.key })}>
          {types.map((type) => (
            <li key={type.id} className="people-item people-group">
              <div className="people-main">
                <p className="people-name">
                  <TypeGlyph name={type.name} icon={type.icon} />
                  {type.name}
                </p>
                <p className="people-meta">
                  {t('ownTypes.summary', {
                    level: type.level.name,
                    offered: offered.has(type.id) ? 'yes' : 'no',
                  })}
                </p>
                {type.description && <p className="people-meta">{type.description}</p>}
              </div>
              <div className="people-actions">
                <button
                  type="button"
                  className="button-secondary people-action"
                  aria-expanded={open === type.id}
                  aria-label={t('admin.ticketTypes.manageOf', { name: type.name })}
                  onClick={() => setOpen(open === type.id ? null : type.id)}
                >
                  {t('admin.ticketTypes.manage')}
                </button>
              </div>
              {open === type.id && (
                <OwnTypePanel
                  key={type.id}
                  type={type}
                  levels={levels}
                  client={client}
                  said={said}
                  failed={failed}
                  onDeleted={() => {
                    // The type's row goes: the section's heading takes the focus.
                    setOpen(null);
                    heading.current?.focus();
                    said(t('admin.ticketTypes.typeDeleted', { name: type.name }));
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The fields a type is made and changed with: its name, description, level and icon. */
function TypeFields({
  levels,
  name,
  onName,
  description,
  onDescription,
  levelId,
  onLevel,
  icon,
  onIcon,
}: {
  levels: Level[];
  name: string;
  onName: (name: string) => void;
  description: string;
  onDescription: (description: string) => void;
  levelId: number;
  onLevel: (levelId: number) => void;
  icon: string;
  onIcon: (icon: string) => void;
}) {
  const t = useT();
  const id = useId();
  return (
    <>
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
          onChange={(event) => onName(event.target.value)}
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
          onChange={(event) => onDescription(event.target.value)}
        />
      </div>
      <LevelSelect id={`${id}-level`} levels={levels} value={levelId} onChange={onLevel} />
      <IconPicker value={icon} onChange={onIcon} />
    </>
  );
}

function NewOwnTypeForm({
  client,
  track,
  levels,
  onCancel,
  onAdded,
  failed,
}: {
  client: SetsClient;
  track: ScopeTrack;
  levels: Level[];
  onCancel: () => void;
  onAdded: (made: TicketType) => void;
  failed: (error: unknown) => void;
}) {
  const t = useT();
  const standard = levels.find((l) => l.kind === 'standard') ?? levels[0];
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [levelId, setLevelId] = useState(standard?.id ?? 0);
  const [icon, setIcon] = useState(shapeOf(null, ''));
  return (
    <form
      className="people-inline"
      aria-label={t('admin.ticketTypes.addType')}
      onSubmit={(event) => {
        event.preventDefault();
        const wanted = name.trim();
        if (!wanted) return;
        client
          .createType({
            name: wanted,
            levelId,
            trackId: track.id,
            ...(description.trim() ? { description: description.trim() } : {}),
            // A type with no icon draws its name's shape: store one only when it differs.
            ...(icon !== shapeOf(null, wanted) ? { icon } : {}),
          })
          .then(onAdded, failed);
      }}
    >
      <TypeFields
        levels={levels}
        name={name}
        onName={setName}
        description={description}
        onDescription={setDescription}
        levelId={levelId}
        onLevel={setLevelId}
        icon={icon}
        onIcon={setIcon}
      />
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

/** One of the track's types: its settings, then Delete type, which asks first (D13). */
function OwnTypePanel({
  type,
  levels,
  client,
  said,
  failed,
  onDeleted,
}: {
  type: TicketType;
  levels: Level[];
  client: SetsClient;
  said: (message: string) => void;
  failed: (error: unknown, name?: string) => void;
  onDeleted: () => void;
}) {
  const t = useT();
  const hintId = useId();
  const [name, setName] = useState(type.name);
  const [description, setDescription] = useState(type.description);
  const [levelId, setLevelId] = useState(type.level.id);
  const [icon, setIcon] = useState(shapeOf(type.icon, type.name));
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
        if (Object.keys(change).length === 0) return;
        client.updateType(type.id, change).then(
          (saved) => said(t('admin.ticketTypes.typeSaved', { name: saved.name })),
          (error) => failed(error, type.name),
        );
      }}
    >
      <TypeFields
        levels={levels}
        name={name}
        onName={setName}
        description={description}
        onDescription={setDescription}
        levelId={levelId}
        onLevel={setLevelId}
        icon={icon}
        onIcon={setIcon}
      />
      <p id={hintId} className="form-hint">
        {t('ownTypes.levelHint')}
      </p>
      <div className="form-actions">
        <button type="submit" className="button-primary" aria-describedby={hintId}>
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
              failed(error, type.name);
              throw error;
            }
            onDeleted();
          }}
        />
      </div>
    </form>
  );
}
