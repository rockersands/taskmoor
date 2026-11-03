import type { Translate } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';

const FIELDS: Readonly<Record<string, MessageId>> = {
  Points: 'field.name.points',
};

/**
 * A custom field's name in the person's language. A workspace's seeded Points field is stored in
 * English and stays so until an administrator renames it; a name someone gave it shows as they
 * wrote it. Queries keep using the stored name.
 */
export function fieldName(t: Translate, name: string): string {
  const id = Object.hasOwn(FIELDS, name) ? FIELDS[name] : undefined;
  return id ? t(id) : name;
}
