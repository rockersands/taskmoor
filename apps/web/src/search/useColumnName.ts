import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { fieldName } from '../shell/seededNames';
import { type ColumnField, customFieldId } from './columns';

/** A column's heading: the system column's name, or the custom field's own name. */
export function useColumnName(fields: readonly ColumnField[]): (column: string) => string {
  const t = useT();
  return (column) => {
    const id = customFieldId(column);
    if (id === null) return t(`search.column.${column}` as MessageId);
    const field = fields.find((f) => f.id === id);
    return field ? fieldName(t, field.name) : t('search.column.field', { id });
  };
}
