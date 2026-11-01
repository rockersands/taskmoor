import { useId } from 'react';
import { useT } from '../../i18n/I18nProvider';
import type { MessageId } from '../../i18n/messages.en';
import type { ImportRecord } from './client';

/** What a dry run says will happen to a person of the source. */
function personFate(record: ImportRecord): MessageId {
  const codes = new Set(record.warnings.map((w) => w.code));
  if (codes.has('person_unmapped')) return 'admin.imports.people.unmapped';
  if (record.outcome === 'linked' || record.outcome === 'unchanged') {
    return 'admin.imports.people.matched';
  }
  if (codes.has('no_email') || codes.has('deleted_user')) return 'admin.imports.people.placeholder';
  if (record.outcome === 'failed' || record.outcome === 'skipped') {
    return 'admin.imports.people.left';
  }
  return 'admin.imports.people.created';
}

/**
 * The people of a source as a dry run found them (M1-097; IMP-007): who matches someone here by
 * address, who would be added, who becomes a placeholder; for each, the address of an existing
 * Taskmoor person to link them to instead. People left empty are matched by address.
 */
export function PeopleMapping({
  people,
  value,
  onChange,
  more,
}: {
  people: ImportRecord[];
  value: Readonly<Record<string, string>>;
  onChange: (next: Record<string, string>) => void;
  /** More people than listed: the rest go by address. */
  more?: boolean;
}) {
  const t = useT();
  const id = useId();
  return (
    <fieldset className="import-people">
      <legend>{t('admin.imports.people.title')}</legend>
      <p className="page-note">{t('admin.imports.people.intro')}</p>
      {people.length === 0 ? (
        <p className="page-note">{t('admin.imports.people.none')}</p>
      ) : (
        <ul className="import-people-list">
          {people.map((person, i) => {
            const name = person.label ?? person.sourceId;
            return (
              <li key={person.sourceId} className="import-person">
                <p className="import-person-name">
                  {t('admin.imports.people.person', { name, id: person.sourceId })}
                </p>
                <p className="page-note">{t(personFate(person))}</p>
                <div className="form-field">
                  <label htmlFor={`${id}-${i}`}>{t('admin.imports.people.mapTo', { name })}</label>
                  <input
                    id={`${id}-${i}`}
                    type="email"
                    autoComplete="off"
                    value={value[person.sourceId] ?? ''}
                    onChange={(e) => {
                      const next = { ...value };
                      if (e.target.value.trim() === '') delete next[person.sourceId];
                      else next[person.sourceId] = e.target.value;
                      onChange(next);
                    }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {more && <p className="page-note">{t('admin.imports.people.more')}</p>}
    </fieldset>
  );
}
