import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { TRACK_KINDS, type TypeChoice } from './client';

/** A type set as its form holds it: the types in order, the preselected one, its default kinds. */
export interface TypeSetDraft {
  ticketTypeIds: number[];
  defaultTypeId: number | null;
  defaultFor: string[];
}

/**
 * The settings of a type set (CORE-005): which ticket types it holds, their order, which one the
 * create form preselects and, for a shared set, the kinds of track it is the default for. A kind
 * the set is already the default for stays ticked: another set takes it over (`fixedKinds`).
 */
export function TypeSetFields({
  types,
  draft,
  onChange,
  fixedKinds,
}: {
  types: TypeChoice[];
  draft: TypeSetDraft;
  onChange: (draft: TypeSetDraft) => void;
  /** Null on a local-mode track's own set, which is never a default. */
  fixedKinds: readonly string[] | null;
}) {
  const t = useT();
  const id = useId();
  const nameOf = (typeId: number) => types.find((type) => type.id === typeId)?.name ?? '';
  const setTypes = (ticketTypeIds: number[]) =>
    onChange({
      ...draft,
      ticketTypeIds,
      // A preselected type the set no longer holds is preselected no more.
      defaultTypeId:
        draft.defaultTypeId !== null && ticketTypeIds.includes(draft.defaultTypeId)
          ? draft.defaultTypeId
          : null,
    });
  return (
    <>
      <TypePicker
        legend={t('admin.sets.typesIn')}
        types={types}
        chosen={draft.ticketTypeIds}
        onChange={setTypes}
      />
      {draft.ticketTypeIds.length > 0 && (
        <TypeOrder ids={draft.ticketTypeIds} nameOf={nameOf} onChange={setTypes} />
      )}
      <div className="form-field">
        <label htmlFor={`${id}-preselected`} className="form-label">
          {t('admin.sets.preselected')}
        </label>
        <select
          id={`${id}-preselected`}
          value={draft.defaultTypeId ?? ''}
          onChange={(event) =>
            onChange({
              ...draft,
              defaultTypeId: event.target.value === '' ? null : Number(event.target.value),
            })
          }
        >
          <option value="">{t('admin.sets.preselectedFirst')}</option>
          {draft.ticketTypeIds.map((typeId) => (
            <option key={typeId} value={typeId}>
              {nameOf(typeId)}
            </option>
          ))}
        </select>
      </div>
      {fixedKinds && (
        <>
          <fieldset className="sets-choices" aria-describedby={`${id}-kinds-hint`}>
            <legend>{t('admin.sets.defaultForLegend')}</legend>
            {TRACK_KINDS.map((kind) => (
              <div key={kind} className="form-field form-field-inline">
                <input
                  id={`${id}-${kind}`}
                  type="checkbox"
                  checked={draft.defaultFor.includes(kind)}
                  disabled={fixedKinds.includes(kind)}
                  onChange={(event) =>
                    onChange({
                      ...draft,
                      defaultFor: event.target.checked
                        ? [...draft.defaultFor, kind]
                        : draft.defaultFor.filter((k) => k !== kind),
                    })
                  }
                />
                <label htmlFor={`${id}-${kind}`}>
                  {t(`admin.sets.kindChoice.${kind}` as MessageId)}
                </label>
              </div>
            ))}
          </fieldset>
          <p id={`${id}-kinds-hint`} className="form-hint">
            {t('admin.sets.defaultForHint')}
          </p>
        </>
      )}
    </>
  );
}

/** Checkboxes for the ticket types a set holds; a type ticked goes to the end of the order. */
export function TypePicker({
  legend,
  types,
  chosen,
  onChange,
}: {
  legend: string;
  types: TypeChoice[];
  chosen: number[];
  onChange: (ids: number[]) => void;
}) {
  const id = useId();
  return (
    <fieldset className="sets-choices">
      <legend>{legend}</legend>
      {types.map((type) => (
        <div key={type.id} className="form-field form-field-inline">
          <input
            id={`${id}-${type.id}`}
            type="checkbox"
            checked={chosen.includes(type.id)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...chosen, type.id]
                  : chosen.filter((typeId) => typeId !== type.id),
              )
            }
          />
          <label htmlFor={`${id}-${type.id}`}>{type.name}</label>
        </div>
      ))}
    </fieldset>
  );
}

/**
 * The order the create form offers the set's types in, with Move up and Move down on each (the
 * keyboard path ADR-114 section 7 asks for). After a move the keyboard stays on the type's button,
 * or on its other one once it reaches an end.
 */
function TypeOrder({
  ids,
  nameOf,
  onChange,
}: {
  ids: number[];
  nameOf: (typeId: number) => string;
  onChange: (ids: number[]) => void;
}) {
  const t = useT();
  const id = useId();
  const list = useRef<HTMLOListElement>(null);
  const [moved, setMoved] = useState<{ typeId: number; direction: 'up' | 'down' } | null>(null);
  useEffect(() => {
    if (!moved) return;
    const buttons = [
      ...(list.current?.querySelectorAll<HTMLButtonElement>(`[data-type="${moved.typeId}"]`) ?? []),
    ];
    const wanted = buttons.find((b) => b.dataset.move === moved.direction);
    (wanted && !wanted.disabled ? wanted : buttons.find((b) => b !== wanted))?.focus();
    setMoved(null);
  }, [moved]);
  const move = (index: number, direction: 'up' | 'down') => {
    const to = direction === 'up' ? index - 1 : index + 1;
    const next = [...ids];
    [next[index], next[to]] = [next[to] as number, next[index] as number];
    onChange(next);
    setMoved({ typeId: ids[index] as number, direction });
  };
  return (
    <div className="form-field">
      <p id={`${id}-label`} className="form-label">
        {t('admin.sets.order')}
      </p>
      <ol
        ref={list}
        className="people-sublist"
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-hint`}
      >
        {ids.map((typeId, index) => (
          <li key={typeId}>
            <span className="people-sublist-row">{nameOf(typeId)}</span>
            <span className="people-actions">
              <button
                type="button"
                className="button-secondary people-action"
                data-type={typeId}
                data-move="up"
                aria-label={t('admin.sets.moveUp', { name: nameOf(typeId) })}
                disabled={index === 0}
                onClick={() => move(index, 'up')}
              >
                {t('admin.sets.up')}
              </button>
              <button
                type="button"
                className="button-secondary people-action"
                data-type={typeId}
                data-move="down"
                aria-label={t('admin.sets.moveDown', { name: nameOf(typeId) })}
                disabled={index === ids.length - 1}
                onClick={() => move(index, 'down')}
              >
                {t('admin.sets.down')}
              </button>
            </span>
          </li>
        ))}
      </ol>
      <p id={`${id}-hint`} className="form-hint">
        {t('admin.sets.orderHint')}
      </p>
    </div>
  );
}

/**
 * Where the tickets of each dropped type go (CORE-005 (2)), once the server has said that tickets
 * still have them (`type_in_use`): a kept type at the same level, or why there is none. The first
 * choice takes the keyboard when the question appears.
 */
export function TypeMapping({
  dropped,
  tickets,
  types,
  kept,
  mapping,
  onChange,
}: {
  /** The dropped types whose tickets need another type. */
  dropped: number[];
  /** How many tickets that is, as the server counted them. */
  tickets: number;
  types: TypeChoice[];
  kept: number[];
  mapping: Readonly<Record<string, number>>;
  onChange: (mapping: Record<string, number>) => void;
}) {
  const t = useT();
  const id = useId();
  const first = useRef<HTMLSelectElement>(null);
  // Once, when the question appears.
  useEffect(() => {
    first.current?.focus();
  }, []);
  const typeOf = (typeId: number) => types.find((type) => type.id === typeId);
  /** Each dropped type with the kept types of its level that its tickets may take. */
  const rows = dropped.map((typeId) => {
    const from = typeOf(typeId);
    const targets = kept
      .map(typeOf)
      .filter((type): type is TypeChoice => type !== undefined && type.level.id === from?.level.id);
    return { typeId, name: from?.name ?? '', level: from?.level.name ?? '', targets };
  });
  const firstChoice = rows.find((row) => row.targets.length > 0)?.typeId;
  return (
    <div className="people-inline">
      <p id={`${id}-intro`} className="page-note">
        {t('admin.sets.mappingIntro', { tickets })}
      </p>
      <fieldset className="sets-choices" aria-describedby={`${id}-intro`}>
        <legend>{t('admin.sets.mapping')}</legend>
        {rows.map(({ typeId, name, level, targets }) => {
          if (targets.length === 0) {
            return (
              <p key={typeId} className="form-hint">
                {t('admin.sets.mappingNowhere', { name, level })}
              </p>
            );
          }
          return (
            <div key={typeId} className="form-field">
              <label htmlFor={`${id}-${typeId}`} className="form-label">
                {t('admin.sets.mappingFor', { name })}
              </label>
              <select
                ref={typeId === firstChoice ? first : undefined}
                id={`${id}-${typeId}`}
                value={mapping[String(typeId)] ?? ''}
                onChange={(event) => {
                  const others = Object.entries(mapping).filter(
                    ([from]) => from !== String(typeId),
                  );
                  onChange(
                    Object.fromEntries(
                      event.target.value === ''
                        ? others
                        : [...others, [String(typeId), Number(event.target.value)]],
                    ),
                  );
                }}
              >
                <option value="">{t('admin.sets.mappingChoose')}</option>
                {targets.map((type) => (
                  <option key={type.id} value={type.id}>
                    {type.name}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </fieldset>
    </div>
  );
}
