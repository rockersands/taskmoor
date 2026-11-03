import type { Translate } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';

const SEEDED: Readonly<Record<string, MessageId>> = {
  Urgent: 'priority.name.urgent',
  High: 'priority.name.high',
  Normal: 'priority.name.normal',
  Low: 'priority.name.low',
  'Very low': 'priority.name.veryLow',
};

/**
 * A priority's name in the person's language. The list a workspace starts with is stored in English
 * and stays so until an administrator renames it, as a new board's filter does; a name someone
 * gave it shows as they wrote it.
 */
export function priorityName(t: Translate, name: string): string {
  const id = Object.hasOwn(SEEDED, name) ? SEEDED[name] : undefined;
  return id ? t(id) : name;
}
