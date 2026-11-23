import { useT } from '../../i18n/I18nProvider';
import type { MessageId } from '../../i18n/messages.en';
import type { SearchField } from '../../search/client';
import { customFieldId } from '../../search/columns';
import { fieldName } from '../../shell/seededNames';

/** The Grid's words shared by its page and its structure dialog (ADR-122 stage 10). */

/** The words of a refused structure write. */
export const STRUCTURE_REFUSED: Record<string, MessageId> = {
  too_many_structures: 'grid.refused.tooMany',
  name_taken: 'grid.refused.nameTaken',
  version_conflict: 'grid.refused.conflict',
  forbidden: 'grid.refused.forbidden',
  not_found: 'grid.refused.gone',
  invalid_fields: 'grid.refused.invalid',
  invalid_query: 'grid.refused.query',
  unsupported_query: 'grid.refused.query',
};

/** The names a total or a formula reads: system refs by message, custom fields by their name. */
const SYSTEM_REFS: Record<string, MessageId> = {
  originalEstimate: 'grid.ref.originalEstimate',
  remainingEstimate: 'grid.ref.remainingEstimate',
  timeSpent: 'grid.ref.timeSpent',
  start: 'grid.ref.start',
  due: 'grid.ref.due',
};

/** A ref's name in the page's words. */
export function useRefName(fields: readonly SearchField[]): (ref: string) => string {
  const t = useT();
  return (ref) => {
    const system = SYSTEM_REFS[ref];
    if (system) return t(system);
    const id = customFieldId(ref);
    const field = id === null ? undefined : fields.find((f) => f.id === id);
    return field ? fieldName(t, field.name) : t('search.column.field', { id: id ?? 0 });
  };
}
