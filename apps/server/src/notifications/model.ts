import type { NotificationChannel, NotificationRecipient } from '@taskmoor/db';

/**
 * Notification events, recipient types and channels (M1-056; NTF-001, NTF-004; spec 01c
 * section 3). Policies map events to recipients; people choose channels per event.
 */
export const NOTIFICATION_EVENTS = [
  'ticket_created',
  'ticket_updated',
  'ticket_assigned',
  'ticket_close_reason_set',
  'ticket_closed',
  'ticket_commented',
  'ticket_reopened',
  'ticket_deleted',
  'ticket_moved',
  'time_entry_added',
  'time_entry_updated',
  'time_entry_deleted',
  'work_started',
  'work_stopped',
  'generic',
] as const;
export type BuiltInEvent = (typeof NOTIFICATION_EVENTS)[number];

/** A transition's own event name becomes `custom:<name>` (WF-005, NTF-001 (2)). */
export const CUSTOM_PREFIX = 'custom:';
const CUSTOM = /^custom:[A-Za-z0-9 _.-]{1,100}$/;

export function isNotificationEvent(value: string): boolean {
  return (NOTIFICATION_EVENTS as readonly string[]).includes(value) || CUSTOM.test(value);
}

export const RECIPIENTS = [
  'assignee',
  'requester',
  'area_owner',
  'user',
  'group',
  'role',
  'follower',
  'track_owner',
  'current_user',
  'user_field',
  'group_field',
] as const satisfies readonly NotificationRecipient[];

export const CHANNELS = ['email', 'inbox'] as const satisfies readonly NotificationChannel[];
