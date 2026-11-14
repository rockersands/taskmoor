import { EDITABLE_SYSTEM, PICKED_SYSTEM, SYSTEM_FIELDS } from '../tickets/form';

/**
 * Whether the create-ticket form sets a field, from the same lists the form itself uses
 * (`tickets/form.ts`; PL-20, D30): a system field it neither edits nor picks is set on the ticket
 * once it exists, Close reason among them. A custom field counts as set here: its type, which
 * decides, is not known to the layout editor.
 */
export function setAtCreate(key: string): boolean {
  if (!Object.hasOwn(SYSTEM_FIELDS, key)) return true;
  return EDITABLE_SYSTEM.has(key) || PICKED_SYSTEM.has(key);
}

/** Never on a create form (D30), so a Create layout does not offer it to place. */
export const NEVER_ON_CREATE: ReadonlySet<string> = new Set(['closeReason']);
