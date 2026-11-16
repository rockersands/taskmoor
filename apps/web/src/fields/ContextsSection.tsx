import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { DangerAction } from '../shell/DangerAction';
import { EmptyState } from '../shell/EmptyState';
import { typeName } from '../shell/seededNames';
import { PersonPicker } from '../tickets/PersonPicker';
import {
  type ContextBody,
  type Field,
  type FieldContext,
  type FieldsClient,
  type Named,
  type NamedTrack,
  NO_DEFAULT_TYPES,
  OPTION_TYPES,
} from './client';
import {
  type DefaultDraft,
  defaultInput,
  defaultOptionIds,
  draftOf,
  EMPTY_DRAFT,
} from './defaultValue';
import { OptionList } from './OptionList';

/** The lists a context names: tracks, ticket types, and for person fields groups and roles. */
export interface ContextLists {
  tracks: NamedTrack[];
  types: Named[];
  groups: Named[];
  roles: Named[];
}

export interface ContextsSectionProps {
  field: Field;
  client: FieldsClient;
  /** The lists, once read; names show as numbers until then. */
  lists: ContextLists | null;
  onField: (field: Field) => void;
  onChanged: (message: string) => void;
  /** A refusal; `context` when it is about a context, whose name or reach is at fault. */
  onProblem: (error: unknown, about?: 'context') => void;
}

/**
 * Where a field applies (CORE-009 (1) and (2); T-320): its contexts, each with its reach (every
 * track and ticket type, or the ones it names), for a person field whom it offers (anyone, a
 * group's members or a track role's holders), its default value and, for choice lists, its
 * options. Change edits a context; Add a context makes another; Delete asks first and says what
 * follows, also that the field applies nowhere once its last context goes. A local-mode track's
 * field covers its own track only, so no other track is offered.
 */
export function ContextsSection({
  field,
  client,
  lists,
  onField,
  onChanged,
  onProblem,
}: ContextsSectionProps) {
  const t = useT();
  const headingId = useId();
  const [adding, setAdding] = useState(false);
  const problem = (error: unknown) => onProblem(error, 'context');

  return (
    <section aria-labelledby={headingId} className="people-panel">
      <h2 id={headingId} className="facts-title">
        {t('admin.fields.contexts.title', { name: field.name })}
      </h2>
      <p className="form-hint">{t('admin.fields.contexts.hint')}</p>
      {field.contexts.length === 0 ? (
        <EmptyState compact title={t('admin.fields.contexts.none')}>
          {t('admin.fields.contexts.noneBody')}
        </EmptyState>
      ) : (
        <ul className="people-list">
          {field.contexts.map((context) => (
            <ContextItem
              key={context.id}
              field={field}
              context={context}
              client={client}
              lists={lists}
              last={field.contexts.length === 1}
              onField={onField}
              onChanged={onChanged}
              onProblem={problem}
            />
          ))}
        </ul>
      )}
      {adding ? (
        <ContextForm
          field={field}
          lists={lists}
          label={t('admin.fields.contexts.add')}
          submit={t('admin.fields.contexts.add')}
          onCancel={() => setAdding(false)}
          onSave={(body) =>
            client.addContext(field.id, body).then((saved) => {
              onField(saved);
              setAdding(false);
              onChanged(t('admin.fields.contexts.added', { name: body.name }));
            }, problem)
          }
        />
      ) : (
        <div className="form-actions">
          <button type="button" className="button-secondary" onClick={() => setAdding(true)}>
            {t('admin.fields.contexts.new')}
          </button>
        </div>
      )}
    </section>
  );
}

const nameOf = (list: readonly Named[] | undefined, id: number) =>
  list?.find((x) => x.id === id)?.name ?? `#${id}`;

/** "Every track; every ticket type", or the tracks and types a context names. */
function useReach() {
  const t = useT();
  return (context: FieldContext, lists: ContextLists | null) => {
    const tracks =
      context.trackIds === null
        ? t('admin.fields.contexts.everyTrack')
        : t('admin.fields.contexts.someTracks', {
            names: context.trackIds.map((id) => nameOf(lists?.tracks, id)).join(', '),
          });
    const types =
      context.ticketTypeIds === null
        ? t('admin.fields.contexts.everyType')
        : t('admin.fields.contexts.someTypes', {
            names: context.ticketTypeIds
              .map((id) => typeName(t, nameOf(lists?.types, id)))
              .join(', '),
          });
    return t('admin.fields.contexts.reach', { tracks, types });
  };
}

/** Whom a person field's context offers, in words. */
function usePeopleLimit() {
  const t = useT();
  return (context: FieldContext, lists: ContextLists | null) => {
    const config = context.config ?? {};
    if (config.userGroupId !== undefined) {
      return t('admin.fields.contexts.peopleGroup', {
        name: nameOf(lists?.groups, config.userGroupId),
      });
    }
    if (config.userRoleId !== undefined) {
      return t('admin.fields.contexts.peopleRole', {
        name: nameOf(lists?.roles, config.userRoleId),
      });
    }
    return t('admin.fields.contexts.peopleAnyone');
  };
}

function ContextItem({
  field,
  context,
  client,
  lists,
  last,
  onField,
  onChanged,
  onProblem,
}: {
  field: Field;
  context: FieldContext;
  client: FieldsClient;
  lists: ContextLists | null;
  last: boolean;
  onField: (field: Field) => void;
  onChanged: (message: string) => void;
  onProblem: (error: unknown) => void;
}) {
  const t = useT();
  const reach = useReach();
  const people = usePeopleLimit();
  const [editing, setEditing] = useState(false);
  return (
    <li className="people-item">
      <div className="people-main">
        <h3 className="facts-title">{context.name}</h3>
        <p className="people-meta">{reach(context, lists)}</p>
        {field.type === 'user' && <p className="people-meta">{people(context, lists)}</p>}
      </div>
      <div className="people-actions">
        <button
          type="button"
          className="button-secondary people-action"
          aria-expanded={editing}
          aria-label={t('admin.fields.contexts.changeOf', { name: context.name })}
          onClick={() => setEditing(!editing)}
        >
          {t('admin.fields.contexts.change')}
        </button>
        {/* Asks first, saying what will happen (D13); a refusal keeps the question open. */}
        <DangerAction
          label={t('admin.fields.contexts.delete')}
          name={t('admin.fields.contexts.deleteOf', { name: context.name })}
          outcome={t(
            last
              ? 'admin.fields.contexts.confirmDeleteLast'
              : 'admin.fields.contexts.confirmDelete',
            { name: context.name },
          )}
          confirmLabel={t('admin.fields.contexts.deleteOf', { name: context.name })}
          onConfirm={async () => {
            try {
              await client.deleteContext(field.id, context.id);
            } catch (error) {
              onProblem(error);
              throw error;
            }
            onChanged(t('admin.fields.contexts.deleted', { name: context.name }));
            await client.field(field.id).then(onField, onProblem);
          }}
        />
      </div>
      {editing && (
        <ContextForm
          field={field}
          context={context}
          lists={lists}
          label={t('admin.fields.contexts.changeOf', { name: context.name })}
          submit={t('admin.fields.contexts.save')}
          onCancel={() => setEditing(false)}
          onSave={(body) =>
            client.updateContext(field.id, context.id, body).then((saved) => {
              onField(saved);
              setEditing(false);
              onChanged(t('admin.fields.contexts.saved', { name: body.name }));
            }, onProblem)
          }
        />
      )}
      <DefaultForm
        field={field}
        context={context}
        client={client}
        lists={lists}
        onField={onField}
        onChanged={onChanged}
        onProblem={onProblem}
      />
      {OPTION_TYPES.has(field.type) && (
        <OptionList
          field={field}
          context={context}
          client={client}
          onField={onField}
          onChanged={onChanged}
          onProblem={onProblem}
          defaultIds={defaultOptionIds(context.defaultValue)}
        />
      )}
    </li>
  );
}

type Reach = 'all' | 'some';
type PeopleLimit = 'anyone' | 'group' | 'role';

/** A context's name, reach and, for a person field, whom it offers: to add one or change one. */
function ContextForm({
  field,
  context,
  lists,
  label,
  submit,
  onCancel,
  onSave,
}: {
  field: Field;
  context?: FieldContext;
  lists: ContextLists | null;
  label: string;
  submit: string;
  onCancel: () => void;
  onSave: (body: ContextBody) => Promise<unknown>;
}) {
  const t = useT();
  const id = useId();
  const local = field.trackId !== null;
  const [name, setName] = useState(context?.name ?? '');
  const [trackReach, setTrackReach] = useState<Reach>(
    context && context.trackIds !== null ? 'some' : 'all',
  );
  const [tracks, setTracks] = useState<number[]>(context?.trackIds ?? []);
  const [typeReach, setTypeReach] = useState<Reach>(
    context && context.ticketTypeIds !== null ? 'some' : 'all',
  );
  const [types, setTypes] = useState<number[]>(context?.ticketTypeIds ?? []);
  const config = context?.config ?? {};
  const [limit, setLimit] = useState<PeopleLimit>(
    config.userGroupId !== undefined
      ? 'group'
      : config.userRoleId !== undefined
        ? 'role'
        : 'anyone',
  );
  const [groupId, setGroupId] = useState(String(config.userGroupId ?? ''));
  const [roleId, setRoleId] = useState(String(config.userRoleId ?? ''));
  const [missing, setMissing] = useState<MessageId | null>(null);

  const save = (event: FormEvent) => {
    event.preventDefault();
    const wanted = name.trim();
    if (!wanted) return;
    if (!local && trackReach === 'some' && tracks.length === 0) {
      setMissing('admin.fields.contexts.chooseTrack');
      return;
    }
    if (typeReach === 'some' && types.length === 0) {
      setMissing('admin.fields.contexts.chooseType');
      return;
    }
    if ((limit === 'group' && groupId === '') || (limit === 'role' && roleId === '')) {
      setMissing('admin.fields.contexts.choosePeople');
      return;
    }
    setMissing(null);
    const body: ContextBody = {
      name: wanted,
      trackIds: local ? [field.trackId as number] : trackReach === 'all' ? null : tracks,
      ticketTypeIds: typeReach === 'all' ? null : types,
    };
    if (field.type === 'user') {
      // A null clears a limit, so the one not chosen goes (CORE-009 (2)).
      body.config = {
        userGroupId: limit === 'group' ? Number(groupId) : null,
        userRoleId: limit === 'role' ? Number(roleId) : null,
      };
    }
    void onSave(body);
  };

  return (
    <form className="people-form people-panel" aria-label={label} onSubmit={save}>
      <div className="form-field">
        <label htmlFor={`${id}-name`} className="form-label">
          {t('admin.fields.contexts.name')}
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
      {local ? (
        <p className="form-hint">
          {t('admin.fields.contexts.ownTrack', {
            name: nameOf(lists?.tracks, field.trackId as number),
          })}
        </p>
      ) : (
        <ReachChoice
          legend={t('admin.fields.contexts.tracks')}
          all={t('admin.fields.contexts.allTracks')}
          some={t('admin.fields.contexts.chosenTracks')}
          reach={trackReach}
          onReach={setTrackReach}
          items={(lists?.tracks ?? []).map((k) => ({ id: k.id, name: `${k.key} ${k.name}` }))}
          chosen={tracks}
          onChosen={setTracks}
        />
      )}
      <ReachChoice
        legend={t('admin.fields.contexts.types')}
        all={t('admin.fields.contexts.allTypes')}
        some={t('admin.fields.contexts.chosenTypes')}
        reach={typeReach}
        onReach={setTypeReach}
        items={(lists?.types ?? []).map((k) => ({ id: k.id, name: typeName(t, k.name) }))}
        chosen={types}
        onChosen={setTypes}
      />
      {field.type === 'user' && (
        <fieldset className="sets-choices">
          <legend>{t('admin.fields.contexts.people')}</legend>
          <div className="form-field">
            <label htmlFor={`${id}-limit`} className="form-label">
              {t('admin.fields.contexts.peopleFrom')}
            </label>
            <select
              id={`${id}-limit`}
              value={limit}
              onChange={(event) => setLimit(event.target.value as PeopleLimit)}
            >
              <option value="anyone">{t('admin.fields.contexts.limit.anyone')}</option>
              <option value="group">{t('admin.fields.contexts.limit.group')}</option>
              <option value="role">{t('admin.fields.contexts.limit.role')}</option>
            </select>
          </div>
          {limit === 'group' && (
            <div className="form-field">
              <label htmlFor={`${id}-group`} className="form-label">
                {t('admin.fields.contexts.group')}
              </label>
              <select
                id={`${id}-group`}
                required
                value={groupId}
                onChange={(event) => setGroupId(event.target.value)}
              >
                <option value="">{t('admin.fields.contexts.chooseOne')}</option>
                {(lists?.groups ?? []).map((g) => (
                  <option key={g.id} value={String(g.id)}>
                    {g.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {limit === 'role' && (
            <div className="form-field">
              <label htmlFor={`${id}-role`} className="form-label">
                {t('admin.fields.contexts.role')}
              </label>
              <select
                id={`${id}-role`}
                required
                value={roleId}
                onChange={(event) => setRoleId(event.target.value)}
              >
                <option value="">{t('admin.fields.contexts.chooseOne')}</option>
                {(lists?.roles ?? []).map((r) => (
                  <option key={r.id} value={String(r.id)}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </fieldset>
      )}
      {missing && (
        <p role="alert" className="form-error">
          {t(missing)}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="button-primary">
          {submit}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('admin.fields.cancelNew')}
        </button>
      </div>
    </form>
  );
}

/** Every one, or the ones ticked: a context's tracks or ticket types. */
function ReachChoice({
  legend,
  all,
  some,
  reach,
  onReach,
  items,
  chosen,
  onChosen,
}: {
  legend: string;
  all: string;
  some: string;
  reach: Reach;
  onReach: (reach: Reach) => void;
  items: Named[];
  chosen: number[];
  onChosen: (ids: number[]) => void;
}) {
  const id = useId();
  return (
    <fieldset className="sets-choices">
      <legend>{legend}</legend>
      {(['all', 'some'] as const).map((value) => (
        <div key={value} className="form-field form-field-inline">
          <input
            id={`${id}-${value}`}
            type="radio"
            name={`${id}-reach`}
            checked={reach === value}
            onChange={() => onReach(value)}
          />
          <label htmlFor={`${id}-${value}`}>{value === 'all' ? all : some}</label>
        </div>
      ))}
      {reach === 'some' &&
        items.map((item) => (
          <div key={item.id} className="form-field form-field-inline">
            <input
              id={`${id}-item-${item.id}`}
              type="checkbox"
              checked={chosen.includes(item.id)}
              onChange={(event) =>
                onChosen(
                  event.target.checked ? [...chosen, item.id] : chosen.filter((x) => x !== item.id),
                )
              }
            />
            <label htmlFor={`${id}-item-${item.id}`}>{item.name}</label>
          </div>
        ))}
    </fieldset>
  );
}

/**
 * A context's default value (CORE-009; T-320): what a new ticket's field holds when the create
 * form leaves it as it found it. Choice lists choose among the context's offered options (one, or
 * several when the field holds several; a two-level list a parent and, if wanted, a child); people,
 * groups and teams are picked by name; the other types are typed. Release, area, read-only text
 * and formula fields take none, and the form says so. No default removes it.
 */
function DefaultForm({
  field,
  context,
  client,
  lists,
  onField,
  onChanged,
  onProblem,
}: {
  field: Field;
  context: FieldContext;
  client: FieldsClient;
  lists: ContextLists | null;
  onField: (field: Field) => void;
  onChanged: (message: string) => void;
  onProblem: (error: unknown) => void;
}) {
  const t = useT();
  const id = useId();
  const stored = JSON.stringify(context.defaultValue ?? null);
  const [draft, setDraft] = useState<DefaultDraft>(() => draftOf(field, context.defaultValue));
  // What the server saved (or another change brought) shows again.
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the stored default only
  useEffect(() => setDraft(draftOf(field, context.defaultValue)), [stored]);

  if (NO_DEFAULT_TYPES.has(field.type)) {
    return (
      <p className="form-hint">
        {t('admin.fields.default.notTaken', {
          type: t(`admin.fields.type.${field.type}` as MessageId),
        })}
      </p>
    );
  }
  const send = (value: unknown) =>
    client.updateContext(field.id, context.id, { defaultValue: value }).then((saved) => {
      onField(saved);
      onChanged(
        t(value === null ? 'admin.fields.default.removed' : 'admin.fields.default.saved', {
          name: context.name,
        }),
      );
    }, onProblem);
  const label = t('admin.fields.default.label');
  const options = (context.options ?? []).filter((o) => !o.disabled);
  const set = (change: Partial<DefaultDraft>) => setDraft((d) => ({ ...d, ...change }));

  let control: ReactNode;
  switch (field.type) {
    case 'select':
      control = field.multiple ? (
        <fieldset className="sets-choices">
          <legend>{label}</legend>
          {options.map((o) => (
            <div key={o.id} className="form-field form-field-inline">
              <input
                id={`${id}-${o.id}`}
                type="checkbox"
                checked={draft.ids.includes(String(o.id))}
                onChange={(event) =>
                  set({
                    ids: event.target.checked
                      ? [...draft.ids, String(o.id)]
                      : draft.ids.filter((x) => x !== String(o.id)),
                  })
                }
              />
              <label htmlFor={`${id}-${o.id}`}>{o.value}</label>
            </div>
          ))}
        </fieldset>
      ) : (
        <OptionSelect
          id={id}
          label={label}
          options={options}
          value={draft.ids[0] ?? ''}
          onChange={(value) => set({ ids: value === '' ? [] : [value] })}
        />
      );
      break;
    case 'cascading-select': {
      const parent = options.find((o) => String(o.id) === draft.ids[0]);
      const children = (parent?.children ?? []).filter((c) => !c.disabled);
      control = (
        <>
          <OptionSelect
            id={id}
            label={label}
            options={options}
            value={draft.ids[0] ?? ''}
            onChange={(value) => set({ ids: value === '' ? [] : [value], child: '' })}
          />
          {children.length > 0 && (
            <OptionSelect
              id={`${id}-child`}
              label={t('admin.fields.default.child')}
              options={children}
              value={draft.child}
              onChange={(value) => set({ child: value })}
            />
          )}
        </>
      );
      break;
    }
    case 'user':
    case 'group':
    case 'team': {
      const kind = field.type === 'user' ? 'people' : field.type === 'group' ? 'groups' : 'teams';
      const search = (typed: string) => {
        if (field.type === 'user') return client.findPeople(typed);
        if (field.type === 'team') return client.findTeams(typed);
        const lower = typed.toLowerCase();
        return Promise.resolve(
          (lists?.groups ?? []).filter((g) => g.name.toLowerCase().includes(lower)).slice(0, 8),
        );
      };
      control = (
        <PersonPicker
          label={label}
          kind={kind}
          multiple={field.multiple}
          search={search}
          chosen={draft.picked}
          onChange={(picked) => set({ picked })}
        />
      );
      break;
    }
    case 'paragraph':
      control = (
        <div className="form-field">
          <label htmlFor={id} className="form-label">
            {label}
          </label>
          <textarea
            id={id}
            rows={3}
            value={draft.text}
            onChange={(event) => set({ text: event.target.value })}
          />
        </div>
      );
      break;
    default: {
      const kind =
        field.type === 'date'
          ? 'date'
          : field.type === 'datetime'
            ? 'datetime-local'
            : field.type === 'url'
              ? 'url'
              : 'text';
      control = (
        <div className="form-field">
          <label htmlFor={id} className="form-label">
            {label}
          </label>
          <input
            id={id}
            type={kind}
            {...(field.type === 'number' ? { inputMode: 'decimal' as const } : {})}
            aria-describedby={field.type === 'labels' ? `${id}-hint` : undefined}
            value={draft.text}
            onChange={(event) => set({ text: event.target.value })}
          />
          {field.type === 'labels' && (
            <p id={`${id}-hint`} className="form-hint">
              {t('admin.fields.default.labelsHint')}
            </p>
          )}
        </div>
      );
    }
  }

  return (
    <form
      className="people-inline"
      aria-label={t('admin.fields.default.of', { name: context.name })}
      onSubmit={(event) => {
        event.preventDefault();
        void send(defaultInput(field, draft));
      }}
    >
      {control}
      <div className="form-actions">
        <button type="submit" className="button-secondary">
          {t('admin.fields.default.save')}
        </button>
        {context.defaultValue !== null && context.defaultValue !== undefined && (
          <button
            type="button"
            className="button-secondary"
            onClick={() => {
              setDraft(EMPTY_DRAFT);
              void send(null);
            }}
          >
            {t('admin.fields.default.clear')}
          </button>
        )}
      </div>
    </form>
  );
}

function OptionSelect({
  id,
  label,
  options,
  value,
  onChange,
}: {
  id: string;
  label: string;
  options: readonly { id: number; value: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useT();
  return (
    <div className="form-field">
      <label htmlFor={id} className="form-label">
        {label}
      </label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{t('admin.fields.default.unset')}</option>
        {options.map((o) => (
          <option key={o.id} value={String(o.id)}>
            {o.value}
          </option>
        ))}
      </select>
    </div>
  );
}
