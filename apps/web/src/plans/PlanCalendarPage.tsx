import { useCallback, useEffect, useRef, useState } from 'react';
import { useCsvSeparator } from '../account/csvStyle';
import { withoutTrackName } from '../calendar/CalendarPage';
import { CalendarView, monthOf, monthWeeks } from '../calendar/CalendarView';
import { useT } from '../i18n/I18nProvider';
import { useTicketChanges } from '../tickets/view/ticketChanges';
import { dayNumber, isoDay, localDay } from '../timeline/client';
import type { PlanCalendar, PlanTrack } from './client';
import { DownloadMenu } from './DownloadMenu';
import { csvBlob, fileName, saveBlob } from './download';
import { draftCalls } from './drafting';
import type { PlanSectionProps } from './PlanSummaryPage';
import { calendarCsv } from './planExport';

/**
 * A sprint's name on a plan's calendar (S3-PL-4). A plan spans tracks, so the track's name stays,
 * but after what tells two sprints apart: a chip cut short reads "Sprint 1 · Mobile apps" and
 * "Sprint 2 · Mobile apps", not "Mobile apps Spri…" twice. The longest track name that starts the
 * sprint's is the one taken off; a name no track starts is left as it is.
 */
export function planSprintName(
  name: string,
  tracks: readonly PlanTrack[],
  label: (sprint: string, track: string) => string,
): string {
  const named = tracks
    .flatMap((track) => (track.name ? [track.name] : []))
    .sort((a, b) => b.length - a.length);
  for (const track of named) {
    const rest = withoutTrackName(name, track);
    if (rest !== name) return label(rest, track.trim());
  }
  return name;
}

/**
 * A plan's Calendar (PLN-012): a month of its tickets across tracks on their due and start days,
 * with their tracks' sprints and releases, drawn by `CalendarView`; at most 10,000 tickets, and it
 * says so. Moving one is the ticket's own change, so its track's permission and history apply.
 */
export function PlanCalendarPage({
  id,
  plan,
  filters,
  client,
  now,
  position,
  onPosition,
  scenario,
  scenarios,
  onDrafted,
}: PlanSectionProps) {
  const t = useT();
  // Commas or semicolons, as the person's spreadsheet opens them (T-263).
  const csvSeparator = useCsvSeparator();
  const today = localDay(now());
  // Kept in the address on a plan's page, so a link opens the same month.
  const [monthHere, setMonthHere] = useState(() => monthOf(dayNumber(today)));
  const month = position?.month ? dayNumber(`${position.month}-01`) : monthHere;
  const setMonth = (next: number) => {
    setMonthHere(next);
    onPosition?.({
      month: next === monthOf(dayNumber(today)) ? undefined : isoDay(next).slice(0, 7),
    });
  };
  const [data, setData] = useState<PlanCalendar | null>(null);
  const [failed, setFailed] = useState(false);
  const { first, last } = monthWeeks(month);
  const filterKey = JSON.stringify(filters);

  /** Counts requests: only the latest one's answer is drawn, however they come back. */
  const latest = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: filters change by their values
  const load = useCallback(() => {
    const asked = ++latest.current;
    client.calendar(id, filters, isoDay(first), isoDay(last), false, scenario?.id).then(
      (d) => {
        if (asked !== latest.current) return;
        setData(d);
        setFailed(false);
      },
      () => {
        if (asked === latest.current) setFailed(true);
      },
    );
  }, [client, id, filterKey, first, last, scenario?.id]);
  useEffect(load, [load]);
  useTicketChanges(load);

  if (failed) {
    return (
      <p className="board-problem" role="alert">
        {t('plans.calendar.failed')}
      </p>
    );
  }
  if (!data) return <p className="report-loading">{t('reports.loading')}</p>;
  if (data.query === null) return null;

  // In a scenario a move is a draft in it (ADR-122 stage 6), never the ticket's own change.
  const drafts =
    scenario && scenarios
      ? draftCalls(
          id,
          scenario,
          scenarios,
          (key) => data.tickets.find((x) => x.key === key)?.id,
          onDrafted,
        )
      : null;

  const shown = {
    ...data,
    sprints: data.sprints.map((s) => ({
      ...s,
      name: planSprintName(s.name, data.tracks, (sprint, track) =>
        t('plans.calendar.sprint', { sprint, track }),
      ),
    })),
  };

  return (
    <div className="calendar-page plan-calendar">
      <CalendarView
        data={shown}
        month={month}
        onMonth={setMonth}
        move={drafts?.move ?? client.move}
        {...(scenario ? { draftIn: scenario.name } : {})}
        reload={load}
        now={now}
        truncatedText={t('plans.truncated', { count: data.tickets.length })}
        tools={
          <DownloadMenu
            items={[
              {
                key: 'csv',
                label: t('plans.download.csv'),
                make: async () => {
                  const fresh = await client.calendar(
                    id,
                    filters,
                    isoDay(first),
                    isoDay(last),
                    true,
                    scenario?.id,
                  );
                  const name = fileName(plan.name, 'calendar', isoDay(month).slice(0, 7), 'csv');
                  saveBlob(name, csvBlob(calendarCsv(t, fresh, csvSeparator)));
                  return name;
                },
              },
            ]}
            notes={
              data.truncated ? [t('plans.download.first', { count: data.tickets.length })] : []
            }
          />
        }
      />
    </div>
  );
}
