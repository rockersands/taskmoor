import { api } from '../api/client';

/**
 * The built-in notification events (M1-056), in the order settings list them; mentions of the
 * person first, a product event outside policies (M1-058).
 */
export const NOTIFICATION_EVENTS = [
  'mentioned',
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
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];
export const CHANNELS = ['email', 'inbox'] as const;
export type Channel = (typeof CHANNELS)[number];
export type EmailDelivery = 'instant' | 'daily' | 'weekly' | 'off';

/** A person's choices, as `GET /api/v1/account/notification-preferences` gives them. */
export interface NotificationPreferences {
  ownChanges: boolean;
  emailDelivery: EmailDelivery;
  quietHours: { start: number; end: number } | null;
  events: Record<string, Record<Channel, boolean>>;
}
export interface PreferenceChanges {
  ownChanges?: boolean;
  emailDelivery?: EmailDelivery;
  quietHours?: { start: number; end: number } | null;
  events?: Record<string, Partial<Record<Channel, boolean>>>;
}

/** What an unsubscribe link turns off: one event, or all email (`event` null). */
export interface UnsubscribeLink {
  event: string | null;
  email: string;
  used: boolean;
}

export interface NotificationsClient {
  preferences(): Promise<NotificationPreferences>;
  update(changes: PreferenceChanges): Promise<NotificationPreferences>;
}
export interface UnsubscribeClient {
  inspect(token: string): Promise<UnsubscribeLink>;
  confirm(token: string): Promise<void>;
}

/** The settings from an answer; an answer without them is a failure, not empty settings. */
function preferencesOf(body: { preferences?: NotificationPreferences } | null) {
  if (!body?.preferences?.events) throw new Error('no notification preferences in the answer');
  return body.preferences;
}

export const notificationsClient: NotificationsClient = {
  preferences: async () =>
    preferencesOf(
      await api<{ preferences?: NotificationPreferences }>('/account/notification-preferences'),
    ),
  update: async (changes) =>
    preferencesOf(
      await api<{ preferences?: NotificationPreferences }>('/account/notification-preferences', {
        method: 'PATCH',
        body: changes,
      }),
    ),
};

export const unsubscribeClient: UnsubscribeClient = {
  inspect: async (token) =>
    (await api<{ unsubscribe: UnsubscribeLink }>(`/unsubscribe?token=${encodeURIComponent(token)}`))
      .unsubscribe,
  confirm: async (token) => {
    await api(`/unsubscribe?token=${encodeURIComponent(token)}`, { method: 'POST' });
  },
};
