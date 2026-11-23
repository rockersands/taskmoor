import { useEffect, useState } from 'react';
import { useT } from '../../i18n/I18nProvider';
import { SubticketIcon } from '../../shell/icons';
import type { SubticketProgress } from './client';

/** A share as a whole percent, from what counts; nothing to count reads 0. */
export function percentOf(done: number, counted: number): number {
  return counted <= 0 ? 0 : Math.round((done / counted) * 100);
}

/** A progress bar: a percentage, with its numbers in the name. */
export function ProgressBar({ percent, label }: { percent: number; label: string }) {
  return (
    <div
      className="tool-progress-bar"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-label={label}
    >
      <span style={{ inlineSize: `${percent}%` }} />
    </div>
  );
}

/**
 * Subtickets' progress on a board card or a list's row: the numbers in text, and a small bar.
 * `named` says what the numbers count where nothing around them does (PL-31): in words where the
 * line has room (a phone's stacked row), and in a table's narrow key cell with the subticket icon
 * beside the numbers and the bar under them, so the cell keeps the key's width and the row its
 * neighbours' height (S3-TR-3, S3-PL-9). Its full words are its name and its tooltip either way.
 */
export function SubticketProgressMini({
  progress,
  named,
}: {
  progress: SubticketProgress;
  named?: 'words' | 'icon';
}) {
  const t = useT();
  const percent = percentOf(progress.closed, progress.total);
  const numbers = { closed: progress.closed, total: progress.total };
  const label = t(named ? 'ticketTools.subtickets.miniLabel' : 'ticketTools.subtickets.progress', {
    ...numbers,
    percent,
  });
  return (
    <span
      className={
        named === 'icon' ? 'tool-progress-mini tool-progress-stacked' : 'tool-progress-mini'
      }
      title={label}
    >
      <span className="visually-hidden">{label}</span>
      <span className="tool-progress-count" aria-hidden="true">
        {named === 'icon' && <SubticketIcon width={14} height={14} />}
        {t(
          named === 'words' ? 'ticketTools.subtickets.miniNamed' : 'ticketTools.subtickets.mini',
          numbers,
        )}
      </span>
      <span className="tool-progress-bar tool-progress-bar-small" aria-hidden="true">
        <span style={{ inlineSize: `${percent}%` }} />
      </span>
    </span>
  );
}

/**
 * The progress of the tickets on a page, read again whenever the list they come in changes (a
 * board's refresh, say). Quiet when it fails: it adds to a card or a row, and a card without it
 * still works.
 */
export function useSubticketProgress(
  tickets: readonly { id: number }[] | null,
  load: ((ids: number[]) => Promise<Record<string, SubticketProgress>>) | undefined,
): Record<string, SubticketProgress> {
  const [found, setFound] = useState<Record<string, SubticketProgress>>({});
  useEffect(() => {
    if (!load || !tickets || tickets.length === 0) {
      setFound({});
      return;
    }
    let live = true;
    load(tickets.map((ticket) => ticket.id)).then(
      (progress) => {
        if (live) setFound(progress);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [tickets, load]);
  return found;
}
