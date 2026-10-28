import {
  CHANNELS,
  NOTIFICATION_EVENTS,
  type NotificationPreferences,
  type NotificationsClient,
  type UnsubscribeClient,
  type UnsubscribeLink,
} from './client';

/** Everything on, email at once: what a new account starts with. */
export function defaultPreferences(): NotificationPreferences {
  return {
    ownChanges: false,
    emailDelivery: 'instant',
    quietHours: null,
    events: Object.fromEntries(
      NOTIFICATION_EVENTS.map((e) => [e, Object.fromEntries(CHANNELS.map((c) => [c, true]))]),
    ) as NotificationPreferences['events'],
  };
}

/** An in-memory notification settings backend for stories and tests. */
export function fakeNotificationsClient(
  overrides: Partial<NotificationsClient> = {},
  start: NotificationPreferences = defaultPreferences(),
): NotificationsClient {
  let prefs = structuredClone(start);
  return {
    preferences: async () => structuredClone(prefs),
    update: async (changes) => {
      prefs = {
        ...prefs,
        ...(changes.ownChanges !== undefined ? { ownChanges: changes.ownChanges } : {}),
        ...(changes.emailDelivery !== undefined ? { emailDelivery: changes.emailDelivery } : {}),
        ...(changes.quietHours !== undefined ? { quietHours: changes.quietHours } : {}),
        events: { ...prefs.events },
      };
      for (const [event, choice] of Object.entries(changes.events ?? {})) {
        prefs.events[event] = {
          ...(prefs.events[event] ?? { email: true, inbox: true }),
          ...choice,
        };
      }
      return structuredClone(prefs);
    },
    ...overrides,
  };
}

export const UPDATES_LINK: UnsubscribeLink = {
  event: 'ticket_updated',
  email: 'k…@example.com',
  used: false,
};

export function fakeUnsubscribeClient(
  overrides: Partial<UnsubscribeClient> = {},
  link: UnsubscribeLink = UPDATES_LINK,
): UnsubscribeClient {
  return {
    inspect: async () => link,
    confirm: async () => {},
    ...overrides,
  };
}
