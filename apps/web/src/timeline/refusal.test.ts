import { createIntl } from 'react-intl';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import type { Translate } from '../i18n/I18nProvider';
import { messagesEn } from '../i18n/messages.en';
import { refusalOf } from './client';
import { scheduleRefusal } from './refusal';

const intl = createIntl({ locale: 'en', messages: messagesEn });
const t: Translate = (id, values) => intl.formatMessage({ id }, values);

describe('refused dates in plain words (PLN-012)', () => {
  it('[PLN-012] reads the permission and the locks from the ticket route’s refusal', () => {
    expect(
      refusalOf(new ApiError(403, { error: 'forbidden', permission: 'schedule_tickets' })),
    ).toEqual({ ok: false, code: 'forbidden', permission: 'schedule_tickets' });
    expect(
      refusalOf(
        new ApiError(403, { error: 'forbidden', permission: 'edit', locks: [{ by: 'status' }] }),
      ),
    ).toEqual({ ok: false, code: 'forbidden', permission: 'edit', locked: true });
    expect(refusalOf(new ApiError(502, null))).toEqual({ ok: false, code: '502' });
  });

  it('[PLN-012] tells a lock from a missing permission', () => {
    expect(scheduleRefusal(t, 'PAY-4', { code: 'forbidden', permission: 'schedule_tickets' })).toBe(
      'PAY-4 could not be rescheduled: you may not schedule tickets in its track.',
    );
    expect(
      scheduleRefusal(t, 'PAY-4', { code: 'forbidden', permission: 'edit', locked: true }),
    ).toBe('PAY-4 could not be rescheduled: its status or its dates are locked for you.');
    expect(
      scheduleRefusal(t, 'PAY-4', { code: 'forbidden', permission: 'edit_field', locked: true }),
    ).toBe('PAY-4 could not be rescheduled: its status or its dates are locked for you.');
    // Another permission is not said to be the scheduling one.
    expect(scheduleRefusal(t, 'PAY-4', { code: 'forbidden', permission: 'edit_tickets' })).toBe(
      'PAY-4 could not be rescheduled: you may not schedule it, or its dates were refused.',
    );
    expect(scheduleRefusal(t, 'PAY-4', { code: 'track_archived' })).toBe(
      'PAY-4 could not be rescheduled: its track is archived.',
    );
  });
});
