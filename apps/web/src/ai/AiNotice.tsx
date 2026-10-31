import { type ReactNode, useEffect, useId, useState } from 'react';
import { api } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { type DataStatement, DataStatementView } from './DataStatement';

/** The first-use notice as `GET /api/v1/ai/notice` answers (M1-077; IAM-022). */
export interface AiNoticeState {
  acknowledgedAt: string | null;
  statement: DataStatement;
}

export interface AiNoticeClient {
  notice: () => Promise<AiNoticeState>;
  acknowledge: () => Promise<void>;
}

export const aiNoticeClient: AiNoticeClient = {
  notice: () => api<AiNoticeState>('/ai/notice'),
  acknowledge: async () => {
    await api('/ai/notice', { method: 'POST' });
  },
};

/**
 * Shown before a person's first use of an AI feature: what leaves the instance and where it
 * goes. Its children (the feature) appear once the person has read it; an AI feature wraps
 * its controls in it.
 */
export function AiNotice({
  client = aiNoticeClient,
  children,
}: {
  client?: AiNoticeClient;
  children?: ReactNode;
}) {
  const t = useT();
  const titleId = useId();
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'failed' }
    | { status: 'ready'; notice: AiNoticeState; saving: boolean; failed: boolean }
  >({ status: 'loading' });

  useEffect(() => {
    let live = true;
    client.notice().then(
      (notice) => live && setState({ status: 'ready', notice, saving: false, failed: false }),
      () => live && setState({ status: 'failed' }),
    );
    return () => {
      live = false;
    };
  }, [client]);

  if (state.status === 'loading') return null;
  if (state.status === 'failed') {
    return (
      <p role="alert" className="form-error">
        {t('ai.notice.failed')}
      </p>
    );
  }
  if (state.notice.acknowledgedAt) return <>{children}</>;

  const acknowledge = async () => {
    setState({ ...state, saving: true, failed: false });
    try {
      await client.acknowledge();
      setState({
        ...state,
        saving: false,
        notice: { ...state.notice, acknowledgedAt: new Date().toISOString() },
      });
    } catch {
      setState({ ...state, saving: false, failed: true });
    }
  };

  return (
    <section aria-labelledby={titleId} className="ai-notice">
      <h2 id={titleId} className="facts-title">
        {t('ai.notice.title')}
      </h2>
      <p>{t('ai.notice.intro')}</p>
      <DataStatementView statement={state.notice.statement} headingLevel={3} />
      <div className="form-actions">
        <button
          type="button"
          className="button-primary"
          disabled={state.saving}
          onClick={() => void acknowledge()}
        >
          {t('ai.notice.acknowledge')}
        </button>
        {state.failed && (
          <p role="alert" className="form-error">
            {t('ai.notice.saveFailed')}
          </p>
        )}
      </div>
    </section>
  );
}

/** What an AI feature says when the gateway refused its call (OPS-020 (1), AI-009). */
export function aiRefusalMessage(
  body: unknown,
  t: ReturnType<typeof useT>,
  formatDate: (iso: string) => string,
): string {
  const error = (body as { error?: string } | null)?.error;
  if (error === 'ai_limit_reached') {
    const resetsAt = (body as { limit?: { resetsAt?: string } }).limit?.resetsAt;
    return resetsAt
      ? t('ai.refused.limitUntil', { when: formatDate(resetsAt) })
      : t('ai.refused.limit');
  }
  if (error === 'ai_disabled') return t('ai.refused.disabled');
  if (error === 'ai_unavailable') return t('ai.refused.unavailable');
  return t('ai.refused.failed');
}
