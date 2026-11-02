import type { AlertRules, SecurityAlerts, SecurityAlertsClient } from './SecurityAlertsForm';

/** The server's defaults (`security/alerts.ts`, ADR-109). */
export const ALERT_DEFAULTS: AlertRules = {
  sign_in_failures_account: { enabled: true, threshold: 10, windowMinutes: 60 },
  sign_in_failures_address: { enabled: true, threshold: 25, windowMinutes: 15 },
  access_refusals: { enabled: true, threshold: 50, windowMinutes: 15 },
  bulk_exports: { enabled: true, threshold: 5, windowMinutes: 60 },
};

/** Synthetic alerts, newest first. */
export const RECENT_ALERTS: SecurityAlerts['recent'] = [
  {
    id: 2,
    rule: 'sign_in_failures_address',
    count: 25,
    threshold: 25,
    windowMinutes: 15,
    subject: { address: '203.0.113.9' },
    raisedAt: '2026-11-01T22:14:00Z',
  },
  {
    id: 1,
    rule: 'bulk_exports',
    count: 5,
    threshold: 5,
    windowMinutes: 60,
    subject: { userId: 7 },
    raisedAt: '2026-10-30T09:02:00Z',
  },
];

/** The rules in memory, so saving behaves like the server. */
export function fakeAlertsClient(
  recent: SecurityAlerts['recent'] = RECENT_ALERTS,
  overrides: Partial<SecurityAlertsClient> = {},
): SecurityAlertsClient & { saved: AlertRules[] } {
  let rules = ALERT_DEFAULTS;
  const saved: AlertRules[] = [];
  return {
    saved,
    load: async () => ({ rules, defaults: ALERT_DEFAULTS, recent }),
    save: async (next) => {
      saved.push(next);
      rules = next;
      return { rules, defaults: ALERT_DEFAULTS, recent };
    },
    ...overrides,
  };
}
