import { afterEach, describe, expect, it } from 'vitest';
import { snoozeTimes } from '../inbox/client';
import { useTimeZone } from '../test/timeZone';
import { localDay } from '../timeline/client';
import { shippedDay } from './days';
import {
  instantOfLocalText,
  localDateTimeText,
  personDay,
  personTimeZone,
  setAccountTimeZone,
} from './zone';

/**
 * One clock per person (T-280): the zone saved on the account, else the device's. The device here
 * is Mexico City (UTC−6), and the account's zone is set apart from it, so a test that passes on
 * the device's clock alone fails.
 */
describe('the person’s clock (T-280)', () => {
  useTimeZone('America/Mexico_City');
  afterEach(() => setAccountTimeZone(null));
  // 8 pm on Wednesday 4 November in Mexico City: 02:00 on Thursday 5 November in UTC, 11:00 in Tokyo.
  const evening = new Date('2026-11-05T02:00:00Z');

  it('[NFR-006] [AGL-015] reads today on the device with Automatic, on the account’s zone once one is saved', () => {
    expect(personTimeZone()).toBe('America/Mexico_City');
    expect(personDay(evening)).toBe('2026-11-04');
    setAccountTimeZone('Asia/Tokyo');
    expect(personTimeZone()).toBe('Asia/Tokyo');
    expect(personDay(evening)).toBe('2026-11-05');
    // `localDay`, which every "today" of the app reads, is the same clock.
    expect(localDay(evening)).toBe('2026-11-05');
    // A zone the browser does not know is Automatic.
    setAccountTimeZone('Mars/Olympus');
    expect(personTimeZone()).toBe('America/Mexico_City');
    expect(localDay(evening)).toBe('2026-11-04');
  });

  it('[NFR-006] says the day a release shipped on the person’s clock, its release date first', () => {
    // Shipped at 03:00 in UTC on 2 October: still 1 October on the device in Mexico City, already
    // 2 October in Tokyo.
    expect(shippedDay(null, '2026-10-02T03:00:00Z')).toBe('2026-10-01');
    setAccountTimeZone('Asia/Tokyo');
    expect(shippedDay(null, '2026-10-02T03:00:00Z')).toBe('2026-10-02');
    expect(shippedDay('2026-09-30', '2026-10-02T03:00:00Z')).toBe('2026-09-30');
  });

  it('[IAM-008] reads a typed date and time on the account’s zone, and writes an instant back on it', () => {
    setAccountTimeZone('America/New_York');
    // 14:00 typed by someone whose account says New York (EST, UTC−5) is 19:00 in UTC, whatever
    // the device says; and it reads back as 14:00, not as Mexico City's 13:00.
    expect(instantOfLocalText('2026-11-16T14:00')?.toISOString()).toBe('2026-11-16T19:00:00.000Z');
    expect(localDateTimeText(new Date('2026-11-16T19:00:00Z'))).toBe('2026-11-16T14:00');
    expect(instantOfLocalText('2026-11-16T14:00:30')?.toISOString()).toBe(
      '2026-11-16T19:00:30.000Z',
    );
    // In summer New York is UTC−4.
    expect(instantOfLocalText('2026-07-01T09:15')?.toISOString()).toBe('2026-07-01T13:15:00.000Z');
    // 01:30 comes twice the night summer time ends: the first, still on summer time.
    expect(instantOfLocalText('2026-11-01T01:30')?.toISOString()).toBe('2026-11-01T05:30:00.000Z');
    // 02:30 never comes the night summer time starts: an hour away, as the device's clock does.
    const skipped = instantOfLocalText('2026-03-08T02:30')?.getTime() ?? 0;
    expect(Math.abs(skipped - Date.parse('2026-03-08T07:00:00Z'))).toBe(30 * 60_000);
    expect(instantOfLocalText('not a time')).toBeNull();
    // Automatic: the device's clock, as the browser's own parsing reads it.
    setAccountTimeZone(null);
    expect(instantOfLocalText('2026-11-16T14:00')?.toISOString()).toBe(
      new Date('2026-11-16T14:00').toISOString(),
    );
    expect(localDateTimeText(new Date('2026-11-16T20:00:00Z'))).toBe('2026-11-16T14:00');
  });

  it('[NTF-003] snoozes until nine tomorrow and next Monday on the person’s clock', () => {
    // Automatic: Wednesday evening in Mexico City.
    const device = snoozeTimes(evening);
    expect(device.hour.toISOString()).toBe('2026-11-05T03:00:00.000Z');
    expect(device.tomorrow.toISOString()).toBe('2026-11-05T15:00:00.000Z');
    expect(device.nextWeek.toISOString()).toBe('2026-11-09T15:00:00.000Z');
    // Saved as Tokyo: already Thursday there, so tomorrow is Friday the 6th at nine in Tokyo.
    setAccountTimeZone('Asia/Tokyo');
    const tokyo = snoozeTimes(evening);
    expect(tokyo.tomorrow.toISOString()).toBe('2026-11-06T00:00:00.000Z');
    expect(tokyo.nextWeek.toISOString()).toBe('2026-11-09T00:00:00.000Z');
    // A Monday goes to the one after.
    const monday = snoozeTimes(new Date('2026-11-09T01:00:00Z'));
    expect(monday.nextWeek.toISOString()).toBe('2026-11-16T00:00:00.000Z');
  });
});
