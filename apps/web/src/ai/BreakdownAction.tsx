import { useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { routeHref } from '../routing/router';
import { leaveMotion } from '../shell/motion';
import { AiFeature, type AiFeatures } from './AiFeature';
import { type AiNoticeClient, aiNoticeClient, aiRefusalMessage } from './AiNotice';
import { type AiClient, aiClient, type Breakdown } from './client';
import { useFirstUse } from './FirstUse';

interface Row {
  include: boolean;
  summary: string;
  description: string;
  ticketTypeId: number;
  created?: string;
  failed?: boolean;
}

export interface BreakdownActionProps {
  ticket: { id: number; key: string };
  trackId?: number;
  client?: AiClient;
  notice?: AiNoticeClient;
  features?: (trackId?: number) => Promise<AiFeatures>;
  /** Told when children were created, so the page shows them. */
  onCreated?: (keys: string[]) => void;
}

/**
 * Breaking a ticket down (M1-079; AI-015): the model proposes children of the types that may
 * sit under the ticket; the person edits, deselects and then creates the chosen ones in one
 * action, through the ticket route with their own rights. Nothing is created before that
 * (AI-015 (2)). Shown only where the feature is available.
 */
export function BreakdownAction({
  ticket,
  trackId,
  client = aiClient,
  notice = aiNoticeClient,
  features,
  onCreated,
}: BreakdownActionProps) {
  return (
    <AiFeature
      feature="assisted-creation"
      {...(trackId !== undefined ? { trackId } : {})}
      {...(features ? { load: features } : {})}
    >
      <BreakdownBody ticket={ticket} client={client} notice={notice} onCreated={onCreated} />
    </AiFeature>
  );
}

function BreakdownBody({
  ticket,
  client,
  notice,
  onCreated,
}: {
  ticket: { id: number; key: string };
  client: AiClient;
  notice: AiNoticeClient;
  onCreated: ((keys: string[]) => void) | undefined;
}) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const [state, setState] = useState<
    | { status: 'closed' }
    | { status: 'loading' }
    | { status: 'ready'; proposal: Breakdown; rows: Row[]; creating: boolean; done: boolean }
    | { status: 'failed'; message: string }
  >({ status: 'closed' });
  const firstUse = useFirstUse(notice);
  const heading = useRef<HTMLHeadingElement>(null);
  const opener = useRef<HTMLButtonElement>(null);

  const open = state.status === 'loading' || state.status === 'ready';
  useEffect(() => {
    if (open) heading.current?.focus();
  }, [open]);

  const refused = (error: unknown) => {
    const body = error instanceof ApiError ? error.body : null;
    if ((body as { error?: string } | null)?.error === 'no_child_types') {
      return t('ai.breakdown.noTypes');
    }
    return aiRefusalMessage(body, t, (iso) =>
      intl.formatDate(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' }),
    );
  };
  const propose = async () => {
    setState({ status: 'loading' });
    try {
      const proposal = await client.breakdown(ticket.id);
      setState({
        status: 'ready',
        proposal,
        creating: false,
        done: false,
        rows: proposal.children.map((c) => ({
          include: true,
          summary: c.summary,
          description: c.description,
          ticketTypeId: c.ticketType.id,
        })),
      });
    } catch (error) {
      setState({ status: 'failed', message: refused(error) });
    }
  };
  const close = () => {
    setState({ status: 'closed' });
    opener.current?.focus();
  };
  const edit = (i: number, change: Partial<Row>) =>
    setState((s) =>
      s.status === 'ready'
        ? { ...s, rows: s.rows.map((r, j) => (j === i ? { ...r, ...change } : r)) }
        : s,
    );
  const create = async () => {
    if (state.status !== 'ready') return;
    setState({ ...state, creating: true });
    const rows = [...state.rows];
    const made: string[] = [];
    for (const [i, row] of rows.entries()) {
      if (!row.include || row.created || !row.summary.trim()) continue;
      try {
        const child = await client.createChild({
          track: state.proposal.track.key,
          ticketTypeId: row.ticketTypeId,
          parent: state.proposal.parent.key,
          summary: row.summary.trim(),
          ...(row.description.trim() ? { description: row.description } : {}),
        });
        rows[i] = { ...row, created: child.key, failed: false };
        made.push(child.key);
      } catch {
        rows[i] = { ...row, failed: true };
      }
    }
    setState({ ...state, rows, creating: false, done: rows.every((r) => !r.include || r.created) });
    if (made.length > 0) onCreated?.(made);
  };

  const chosen = state.status === 'ready' ? state.rows.filter((r) => r.include && !r.created) : [];
  return (
    <>
      <button
        ref={opener}
        type="button"
        className="button-secondary ticket-action"
        onClick={() => firstUse.run(() => void propose())}
      >
        {t('ai.breakdown.open')}
      </button>
      {firstUse.gate && <div className="ai-gate">{firstUse.gate}</div>}
      {state.status === 'failed' && (
        <p role="alert" className="form-error">
          {state.message}
        </p>
      )}
      {open && (
        <div className="ticket-dialog-backdrop">
          <div
            ref={leaveMotion}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`${id}-title`}
            className="ticket-dialog ai-breakdown"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                close();
              }
            }}
          >
            <h2 id={`${id}-title`} ref={heading} tabIndex={-1} className="ticket-section-title">
              {t('ai.breakdown.title', { key: ticket.key })}
            </h2>
            {state.status === 'loading' && (
              <p role="status" className="page-note">
                {t('ai.breakdown.loading')}
              </p>
            )}
            {state.status === 'ready' && (
              <>
                <p className="form-hint">{t('ai.breakdown.intro')}</p>
                <ol className="ai-proposals">
                  {state.rows.map((row, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: proposals have no id
                    <li key={i} className="ai-proposal">
                      <div className="form-field-inline">
                        <label>
                          <input
                            type="checkbox"
                            checked={row.include}
                            disabled={Boolean(row.created) || state.creating}
                            onChange={(e) => edit(i, { include: e.target.checked })}
                          />
                          {t('ai.breakdown.include', { n: i + 1 })}
                        </label>
                      </div>
                      <div className="form-field">
                        <label htmlFor={`${id}-s${i}`} className="form-label">
                          {t('ai.breakdown.summary', { n: i + 1 })}
                        </label>
                        <input
                          id={`${id}-s${i}`}
                          type="text"
                          maxLength={255}
                          value={row.summary}
                          disabled={Boolean(row.created) || !row.include}
                          onChange={(e) => edit(i, { summary: e.target.value })}
                        />
                      </div>
                      <div className="form-field">
                        <label htmlFor={`${id}-d${i}`} className="form-label">
                          {t('ai.breakdown.description', { n: i + 1 })}
                        </label>
                        <textarea
                          id={`${id}-d${i}`}
                          rows={3}
                          value={row.description}
                          disabled={Boolean(row.created) || !row.include}
                          onChange={(e) => edit(i, { description: e.target.value })}
                        />
                      </div>
                      <div className="form-field">
                        <label htmlFor={`${id}-t${i}`} className="form-label">
                          {t('ai.breakdown.type', { n: i + 1 })}
                        </label>
                        <select
                          id={`${id}-t${i}`}
                          value={row.ticketTypeId}
                          disabled={Boolean(row.created) || !row.include}
                          onChange={(e) => edit(i, { ticketTypeId: Number(e.target.value) })}
                        >
                          {state.proposal.childTypes.map((type) => (
                            <option key={type.id} value={type.id}>
                              {type.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      {row.created && (
                        <p className="form-hint">
                          <a href={routeHref(`#/tickets/${encodeURIComponent(row.created)}`)}>
                            {t('ai.breakdown.created', { key: row.created })}
                          </a>
                        </p>
                      )}
                      {row.failed && (
                        <p role="alert" className="form-error">
                          {t('ai.breakdown.failed')}
                        </p>
                      )}
                    </li>
                  ))}
                </ol>
                <p className="form-hint">{t('ai.summary.generated')}</p>
              </>
            )}
            <div className="form-actions">
              {state.status === 'ready' && !state.done && (
                <button
                  type="button"
                  className="button-primary"
                  disabled={state.creating || chosen.length === 0}
                  onClick={() => void create()}
                >
                  {state.creating
                    ? t('ai.breakdown.creating')
                    : t('ai.breakdown.create', { count: chosen.length })}
                </button>
              )}
              <button type="button" className="button-secondary" onClick={close}>
                {state.status === 'ready' && state.done
                  ? t('ai.breakdown.close')
                  : t('ai.breakdown.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
