import { useIntl } from 'react-intl';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';

/**
 * Locks as the backend reports them (M1-029; WF-007): a status that reserves an action to some
 * roles and groups, or a field only some may set. Controls a lock covers are shown read-only,
 * with the sentence this hook words, so people learn why and whom to ask (WF-007 (2)).
 */
export interface LockHolder {
  type: 'role' | 'group';
  id: number;
  name: string;
}
export type LockAction = 'edit' | 'comment' | 'attach' | 'assign' | 'transition';
export type Lock =
  | { by: 'status'; statusId: number; statusName: string; allowed: LockHolder[] }
  | { by: 'field'; field: string; allowed: LockHolder[] };

const STATUS_MESSAGES: Record<LockAction, MessageId> = {
  edit: 'locks.status.edit',
  comment: 'locks.status.comment',
  attach: 'locks.status.attach',
  assign: 'locks.status.assign',
  transition: 'locks.status.transition',
};

/** The lock a field shows: its own, else the status's edit lock, else none. */
export function lockOfField(locks: readonly Lock[] | undefined, key: string): Lock | null {
  return (
    locks?.find((l) => l.by === 'field' && l.field === key) ??
    locks?.find((l) => l.by === 'status') ??
    null
  );
}

/** Words a lock: "In status Approved, only the Approvers group can add or remove files." */
export function useLockText(): (lock: Lock, action?: LockAction) => string {
  const intl = useIntl();
  const t = useT();
  return (lock, action = 'edit') => {
    const names = lock.allowed.map((h) =>
      t(h.type === 'role' ? 'locks.role' : 'locks.group', { name: h.name }),
    );
    const who = intl.formatList(names, { type: 'disjunction' });
    if (lock.by === 'field') {
      return names.length === 0 ? t('locks.field.nobody') : t('locks.field', { who });
    }
    if (names.length === 0) return t('locks.status.nobody', { status: lock.statusName });
    return t(STATUS_MESSAGES[action], { status: lock.statusName, who });
  };
}
