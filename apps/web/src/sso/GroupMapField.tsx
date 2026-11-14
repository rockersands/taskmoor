import { useEffect, useId, useRef, useState } from 'react';
import type { GroupSummary } from '../admin/SecurityPage';
import { useT } from '../i18n/I18nProvider';
import { EmptyState } from '../shell/EmptyState';
import { type MappingRow, mappingRow } from './draft';

export interface GroupMapFieldProps {
  rows: MappingRow[];
  /** The groups to choose from; null when they could not be read. */
  groups: GroupSummary[] | null;
  onChange: (rows: MappingRow[]) => void;
}

/**
 * The group mapping of a provider (M1-080): each row maps a value of the group claim to a
 * Taskmoor group. Rows stack on phones; every row is a named group of two fields and a button.
 */
export function GroupMapField({ rows, groups, onChange }: GroupMapFieldProps) {
  const t = useT();
  const id = useId();
  const addButton = useRef<HTMLButtonElement>(null);
  const [focusKey, setFocusKey] = useState<number | null>(null);

  // A new row takes the cursor; a removed one hands it back to the Add button.
  useEffect(() => {
    if (focusKey === null) return;
    document.getElementById(`${id}-claim-${focusKey}`)?.focus();
    setFocusKey(null);
  }, [focusKey, id]);

  const update = (key: number, change: Partial<MappingRow>) =>
    onChange(rows.map((row) => (row.key === key ? { ...row, ...change } : row)));

  const add = () => {
    const row = mappingRow();
    onChange([...rows, row]);
    setFocusKey(row.key);
  };

  const remove = (key: number) => {
    onChange(rows.filter((row) => row.key !== key));
    addButton.current?.focus();
  };

  return (
    <fieldset className="sso-group-map" aria-describedby={`${id}-hint`}>
      <legend>{t('admin.sso.form.groupMap')}</legend>
      <p id={`${id}-hint`} className="form-hint">
        {t('admin.sso.form.groupMapHint')}
      </p>
      {groups === null ? (
        <p className="form-hint">{t('admin.sso.form.groupsFailed')}</p>
      ) : (
        <>
          {groups.length === 0 && rows.length === 0 ? (
            <EmptyState compact title={t('admin.sso.form.noGroups')}>
              {t('admin.sso.form.noGroupsBody')}
            </EmptyState>
          ) : (
            rows.length === 0 && <EmptyState compact title={t('admin.sso.form.noMappings')} />
          )}
          {rows.map((row, index) => {
            const number = index + 1;
            return (
              <fieldset key={row.key} className="sso-mapping">
                <legend className="visually-hidden">
                  {t('admin.sso.form.mapping', { number })}
                </legend>
                <div className="form-field">
                  <label htmlFor={`${id}-claim-${row.key}`}>{t('admin.sso.form.claimValue')}</label>
                  <input
                    id={`${id}-claim-${row.key}`}
                    required
                    maxLength={500}
                    autoComplete="off"
                    spellCheck={false}
                    value={row.claimValue}
                    onChange={(e) => update(row.key, { claimValue: e.target.value })}
                  />
                </div>
                <div className="form-field">
                  <label htmlFor={`${id}-group-${row.key}`}>{t('admin.sso.form.group')}</label>
                  <select
                    id={`${id}-group-${row.key}`}
                    required
                    value={row.groupId ?? ''}
                    onChange={(e) =>
                      update(row.key, {
                        groupId: e.target.value === '' ? null : Number(e.target.value),
                      })
                    }
                  >
                    <option value="">{t('admin.sso.form.chooseGroup')}</option>
                    {groups.map((group) => (
                      <option key={group.id} value={group.id}>
                        {t('common.value', { value: group.name })}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  className="button-secondary"
                  aria-label={t('admin.sso.form.removeMappingNamed', { number })}
                  onClick={() => remove(row.key)}
                >
                  {t('admin.sso.form.removeMapping')}
                </button>
              </fieldset>
            );
          })}
          {groups.length > 0 && (
            <div>
              <button ref={addButton} type="button" className="button-secondary" onClick={add}>
                {t('admin.sso.form.addMapping')}
              </button>
            </div>
          )}
        </>
      )}
    </fieldset>
  );
}
