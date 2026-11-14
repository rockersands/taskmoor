import type { Translate } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';

const FIELDS: Readonly<Record<string, MessageId>> = {
  Points: 'field.name.points',
};

const TYPES: Readonly<Record<string, MessageId>> = {
  Outcome: 'ticketType.name.outcome',
  Feature: 'ticketType.name.feature',
  Bug: 'ticketType.name.bug',
  Chore: 'ticketType.name.chore',
  'To-do': 'ticketType.name.toDo',
  Idea: 'ticketType.name.idea',
  Subticket: 'ticketType.name.subticket',
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

/**
 * A ticket type's name in the person's language, the same way: the seeded types are stored in
 * English, a type someone renamed or added shows as they wrote it (`00-terminology.md`, rule 4).
 * Queries and the configuration pages keep the stored name.
 */
export function typeName(t: Translate, name: string): string {
  const id = Object.hasOwn(TYPES, name) ? TYPES[name] : undefined;
  return id ? t(id) : name;
}

const CLOSE_REASONS: Readonly<Record<string, MessageId>> = {
  Completed: 'closeReason.name.completed',
  'Not planned': 'closeReason.name.notPlanned',
  Duplicate: 'closeReason.name.duplicate',
  'Not reproducible': 'closeReason.name.notReproducible',
};

/**
 * A close reason's name in the person's language, the same way (T-299): the seeded reasons are
 * stored in English, a reason someone renamed or added shows as they wrote it.
 */
export function closeReasonName(t: Translate, name: string): string {
  const id = Object.hasOwn(CLOSE_REASONS, name) ? CLOSE_REASONS[name] : undefined;
  return id ? t(id) : name;
}
