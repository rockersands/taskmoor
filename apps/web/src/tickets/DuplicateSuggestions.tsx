import { useEffect, useId, useState } from 'react';
import { api } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';

export interface DuplicateHit {
  ticket: { id: number; key: string; summary?: string };
  score: number;
  likely?: boolean;
  reason?: string;
}

export interface DuplicateAnswer {
  similar: DuplicateHit[];
  reranked?: boolean;
}

export type DuplicateLookup = (
  text: string,
  track: string,
  reasons: boolean,
  signal: AbortSignal,
) => Promise<DuplicateAnswer>;

export const lookupDuplicates: DuplicateLookup = (text, track, reasons) =>
  api<DuplicateAnswer>('/tickets/similar', {
    method: 'POST',
    body: { text, track, limit: 5, minScore: 0.4, reasons },
  });

/** Typing pauses this long before a lookup. */
const PAUSE_MS = 400;
/** Fewer characters than this find nothing worth showing. */
const MIN_CHARS = 8;

/**
 * Likely duplicates while a ticket is written (M1-079; AI-016): tickets close in meaning to
 * the summary, from the bundled embedding model, so they show with no AI key (NFR-011). With a
 * model set up and the AI notice read (`reasons`), the server re-orders them and says why;
 * those reasons are marked as written by AI. Only tickets the person may see appear.
 */
export function DuplicateSuggestions({
  text,
  track,
  reasons = false,
  lookup = lookupDuplicates,
}: {
  text: string;
  track: string;
  reasons?: boolean;
  lookup?: DuplicateLookup;
}) {
  const t = useT();
  const id = useId();
  const [answer, setAnswer] = useState<DuplicateAnswer | null>(null);

  useEffect(() => {
    const words = text.trim();
    if (words.length < MIN_CHARS || track === '') {
      setAnswer(null);
      return;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => {
      lookup(words, track, reasons, abort.signal).then(
        (found) => !abort.signal.aborted && setAnswer(found),
        () => !abort.signal.aborted && setAnswer(null),
      );
    }, PAUSE_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [text, track, reasons, lookup]);

  if (!answer || answer.similar.length === 0) return null;
  return (
    <section aria-labelledby={`${id}-title`} className="duplicate-suggestions">
      <h3 id={`${id}-title`} className="facts-title">
        {t('duplicates.title')}
      </h3>
      <ul className="duplicate-list">
        {answer.similar.map((hit) => (
          <li key={hit.ticket.id} className="duplicate-item">
            <a
              href={routeHref(`#/tickets/${encodeURIComponent(hit.ticket.key)}`)}
              target="_blank"
              rel="noopener"
            >
              {t('duplicates.ticket', { key: hit.ticket.key, summary: hit.ticket.summary ?? '' })}
            </a>
            {hit.reason && (
              <p className="form-hint">
                {hit.likely ? t('duplicates.likely') : ''}
                {t('duplicates.reason', { reason: hit.reason })}
              </p>
            )}
          </li>
        ))}
      </ul>
      {answer.reranked && <p className="form-hint">{t('duplicates.byAi')}</p>}
    </section>
  );
}
