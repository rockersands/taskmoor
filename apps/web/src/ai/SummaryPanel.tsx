import { Fragment, useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { AiFeature, type AiFeatures } from './AiFeature';
import { type AiNoticeClient, aiNoticeClient, aiRefusalMessage } from './AiNotice';
import { type AiClient, aiClient, type SummaryCitation } from './client';
import { useFirstUse } from './FirstUse';

type Run =
  | { status: 'idle' }
  | { status: 'streaming'; scope: 'ticket' | 'thread'; text: string }
  | {
      status: 'done';
      scope: 'ticket' | 'thread';
      text: string;
      citations: SummaryCitation[];
      externalLinks: string[];
      omitted: number;
    }
  | { status: 'cancelled'; text: string }
  | { status: 'failed'; message: string };

const MARK = /\s?\[c(\d+)\]/g;

/** The summary's text with each cited comment as a numbered link to it; other marks dropped. */
function CitedText({
  text,
  citations,
  ticketKey,
}: {
  text: string;
  citations: SummaryCitation[];
  ticketKey: string;
}) {
  const t = useT();
  const order = new Map(citations.map((c, i) => [c.commentId, { n: i + 1, author: c.author }]));
  const parts: (string | { id: number; n: number; author: string | undefined })[] = [];
  let last = 0;
  for (const m of text.matchAll(MARK)) {
    parts.push(text.slice(last, m.index));
    const id = Number(m[1]);
    const cite = order.get(id);
    if (cite) parts.push({ id, n: cite.n, author: cite.author });
    last = (m.index ?? 0) + m[0].length;
  }
  parts.push(text.slice(last));
  return (
    <p className="ai-summary-text">
      {parts.map((part, i) =>
        typeof part === 'string' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: pieces of one text, in order
          <Fragment key={i}>{part}</Fragment>
        ) : (
          <a
            // biome-ignore lint/suspicious/noArrayIndexKey: a comment may be cited twice
            key={i}
            className="ai-cite"
            href={routeHref(`#/tickets/${encodeURIComponent(ticketKey)}?comment=${part.id}`)}
            aria-label={
              part.author
                ? t('ai.summary.citeBy', { n: part.n, author: part.author })
                : t('ai.summary.cite', { n: part.n })
            }
          >
            [{part.n}]
          </a>
        ),
      )}
    </p>
  );
}

export interface SummaryPanelProps {
  ticket: { id: number; key: string };
  trackId?: number;
  client?: AiClient;
  notice?: AiNoticeClient;
  features?: (trackId?: number) => Promise<AiFeatures>;
}

/**
 * Summaries on the ticket page (M1-079; AI-013, AI-007): a summary of the ticket or of its
 * comments, streamed as the model writes it, with each cited comment linked and a Cancel that
 * stops the provider. Shown only where the summary feature is available (NFR-011); the first
 * use shows the AI notice; a refusal says why.
 */
export function SummaryPanel({
  ticket,
  trackId,
  client = aiClient,
  notice = aiNoticeClient,
  features,
}: SummaryPanelProps) {
  return (
    <AiFeature
      feature="summarize"
      {...(trackId !== undefined ? { trackId } : {})}
      {...(features ? { load: features } : {})}
    >
      <SummaryBody ticket={ticket} client={client} notice={notice} />
    </AiFeature>
  );
}

function SummaryBody({
  ticket,
  client,
  notice,
}: {
  ticket: { id: number; key: string };
  client: AiClient;
  notice: AiNoticeClient;
}) {
  const t = useT();
  const intl = useIntl();
  const headingId = useId();
  const [run, setRun] = useState<Run>({ status: 'idle' });
  const controller = useRef<AbortController | null>(null);
  const firstUse = useFirstUse(notice);

  // Leaving the ticket cancels a summary still being written.
  useEffect(() => () => controller.current?.abort(), []);

  const start = (scope: 'ticket' | 'thread') => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setRun({ status: 'streaming', scope, text: '' });
    client
      .summary(
        ticket.id,
        scope,
        (piece) => setRun((r) => (r.status === 'streaming' ? { ...r, text: r.text + piece } : r)),
        abort.signal,
      )
      .then(
        (outcome) => {
          if (abort.signal.aborted) return;
          if (outcome.status === 'done') {
            setRun({ ...outcome, status: 'done', scope });
          } else if (outcome.status === 'refused') {
            setRun({ status: 'failed', message: t('ai.refused.failed') });
          } else {
            setRun({ status: 'failed', message: aiRefusalMessage(outcome.body, t, when) });
          }
        },
        (error: unknown) => {
          if (abort.signal.aborted) return;
          setRun({
            status: 'failed',
            message: aiRefusalMessage(error instanceof ApiError ? error.body : null, t, when),
          });
        },
      );
  };
  const when = (iso: string) =>
    intl.formatDate(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' });
  const cancel = () => {
    controller.current?.abort();
    setRun((r) => (r.status === 'streaming' ? { status: 'cancelled', text: r.text } : r));
  };

  const streaming = run.status === 'streaming';
  return (
    <section aria-labelledby={headingId} className="ai-panel">
      <h2 id={headingId} className="ticket-section-title">
        {t('ai.summary.title')}
      </h2>
      <div className="ai-actions">
        <button
          type="button"
          className="button-secondary"
          disabled={streaming}
          onClick={() => firstUse.run(() => start('ticket'))}
        >
          {t('ai.summary.ticket')}
        </button>
        <button
          type="button"
          className="button-secondary"
          disabled={streaming}
          onClick={() => firstUse.run(() => start('thread'))}
        >
          {t('ai.summary.thread')}
        </button>
        {streaming && (
          <button type="button" className="button-secondary" onClick={cancel}>
            {t('ai.summary.cancel')}
          </button>
        )}
      </div>
      {firstUse.gate}
      <div className="ai-summary" aria-live="polite" aria-busy={streaming}>
        {streaming && (
          <>
            <p role="status" className="page-note">
              {t('ai.summary.writing')}
            </p>
            <p className="ai-summary-text">{run.text.replace(MARK, '')}</p>
          </>
        )}
        {run.status === 'cancelled' && (
          <>
            <p role="status" className="page-note">
              {t('ai.summary.cancelled')}
            </p>
            <p className="ai-summary-text">{run.text.replace(MARK, '')}</p>
          </>
        )}
        {run.status === 'done' && (
          <>
            <CitedText text={run.text} citations={run.citations} ticketKey={ticket.key} />
            <p className="form-hint">
              {run.citations.length > 0
                ? t('ai.summary.basedOn', { count: run.citations.length })
                : t('ai.summary.noCitations')}
              {run.omitted > 0 ? ` ${t('ai.summary.omitted', { count: run.omitted })}` : ''}
            </p>
            {run.externalLinks.length > 0 && (
              <p className="form-hint">
                {t('ai.summary.external', {
                  hosts: [
                    ...new Set(
                      run.externalLinks.map((l) => {
                        try {
                          return new URL(l).host;
                        } catch {
                          return l;
                        }
                      }),
                    ),
                  ].join(', '),
                })}
              </p>
            )}
            <p className="form-hint">{t('ai.summary.generated')}</p>
          </>
        )}
      </div>
      {run.status === 'failed' && (
        <p role="alert" className="form-error">
          {run.message}
        </p>
      )}
    </section>
  );
}
