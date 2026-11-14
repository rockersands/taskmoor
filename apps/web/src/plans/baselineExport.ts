import type { useT } from '../i18n/I18nProvider';
import type { BaselineDays, BaselineTicket } from './baselineClient';
import { csvText } from './planExport';

type T = ReturnType<typeof useT>;

const datedWords = (t: T, d: BaselineDays | null) =>
  d?.dated === 'own'
    ? t('baselines.csv.own')
    : d?.dated === 'sprint'
      ? t('baselines.csv.sprint')
      : '';

/**
 * A baseline comparison's file (ADR-122 stage 9), through the CSV rule every export shares
 * (`planExport.ts`, `@taskmoor/webconfig` `csv.ts`): the baseline's name first, then a ticket a
 * row with its days then and now, where they came from, and its delay. It holds the tickets the
 * page read for the reader, so tickets the plan does not show them never enter it.
 */
export function baselineCsv(
  t: T,
  name: string,
  tickets: readonly BaselineTicket[],
  notShown: number,
): string {
  return csvText([
    [t('baselines.csv.baseline', { name })],
    ...(notShown > 0 ? [[t('baselines.compare.notShown', { count: notShown })]] : []),
    [
      t('plans.csv.key'),
      t('plans.csv.summary'),
      t('plans.csv.closed'),
      t('baselines.csv.startThen'),
      t('baselines.csv.dueThen'),
      t('baselines.csv.datedThen'),
      t('baselines.csv.startNow'),
      t('baselines.csv.dueNow'),
      t('baselines.csv.datedNow'),
      t('baselines.csv.delay'),
      t('baselines.csv.startShift'),
    ],
    ...tickets.map((x) => [
      x.key,
      x.summary,
      t(x.closed ? 'plans.csv.yes' : 'plans.csv.no'),
      x.was?.start ?? '',
      x.was?.due ?? '',
      datedWords(t, x.was),
      x.now.start ?? '',
      x.now.due ?? '',
      datedWords(t, x.now),
      x.delay ?? '',
      x.startShift ?? '',
    ]),
  ]);
}
