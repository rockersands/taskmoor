import { useCallback, useEffect, useId, useState } from 'react';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { useSession } from '../session/SessionProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import { PageHeader } from '../shell/PageHeader';
import { type Guardrail, type GuardrailsClient, guardrailsClient } from './client';
import { StorageQuotas } from './StorageQuotas';
import type { StorageClient } from './storage-client';

export interface GuardrailsPageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: GuardrailsClient;
  /** The attachment storage section's backend (M1-118), likewise. */
  storage?: StorageClient;
}

/**
 * Configuration guardrails (M1-055; CORE-026), for site administrators: every limit with its
 * default and where it is used most, and a form to change it. A raise takes effect at once and
 * comes with guidance; a lowered limit leaves what exists and refuses further additions.
 * Attachment storage against its quotas follows (M1-118; ASVS 12.1.3).
 */
export function GuardrailsPage({ client = guardrailsClient, storage }: GuardrailsPageProps) {
  const t = useT();
  const { session } = useSession();
  const expired = useSessionExpiry();
  const titleId = useId();
  const notAdmin = session.status === 'signed-in' && !session.user.isSiteAdmin;
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'loaded'; guardrails: Guardrail[]; ceiling: number }
    | { status: 'failed' }
    | { status: 'forbidden' }
  >(notAdmin ? { status: 'forbidden' } : { status: 'loading' });
  const [message, setMessage] = useState('');
  const [raised, setRaised] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const answer = await client.list();
      setState({ status: 'loaded', ...answer });
    } catch (error) {
      if (expired(error)) return;
      if (error instanceof ApiError && error.status === 403) setState({ status: 'forbidden' });
      else setState({ status: 'failed' });
    }
  }, [client, expired]);
  useEffect(() => {
    if (!notAdmin) void load();
  }, [load, notAdmin]);

  const save = async (guardrail: Guardrail, limit: number) => {
    try {
      await client.set(guardrail.name, limit);
      const name = t(`guardrails.name.${guardrail.name}` as MessageId);
      setMessage(t('guardrails.saved', { name, limit }));
      setRaised(limit > guardrail.limit);
      setProblem(null);
      await load();
    } catch {
      setProblem(t('guardrails.failed'));
    }
  };

  return (
    <section aria-labelledby={titleId} className="page admin-page people-page">
      <PageHeader
        titleId={titleId}
        title={t('guardrails.title')}
        {...(state.status === 'forbidden'
          ? {}
          : { purpose: t('settings.guardrailsHint'), about: t('guardrails.intro') })}
      />
      {state.status === 'forbidden' ? (
        <p className="page-note">{t('guardrails.forbidden')}</p>
      ) : (
        <>
          <p role="status" className="form-status">
            {message}
          </p>
          {raised && <p className="page-note guardrails-guidance">{t('guardrails.guidance')}</p>}
          {problem && (
            <p role="alert" className="form-error">
              {problem}
            </p>
          )}
          {state.status === 'loading' && <p className="page-note">{t('guardrails.loading')}</p>}
          {state.status === 'failed' && (
            <p role="alert" className="form-error">
              {t('guardrails.loadFailed')}
            </p>
          )}
          {state.status === 'loaded' && (
            <ul className="people-list">
              {state.guardrails.map((g) => (
                <GuardrailRow
                  key={g.name}
                  guardrail={g}
                  ceiling={state.ceiling}
                  onSave={(limit) => void save(g, limit)}
                />
              ))}
            </ul>
          )}
          {!notAdmin && <StorageQuotas {...(storage ? { client: storage } : {})} />}
        </>
      )}
    </section>
  );
}

function GuardrailRow({
  guardrail,
  ceiling,
  onSave,
}: {
  guardrail: Guardrail;
  ceiling: number;
  onSave: (limit: number) => void;
}) {
  const t = useT();
  const id = useId();
  const [value, setValue] = useState(String(guardrail.limit));
  const name = t(`guardrails.name.${guardrail.name}` as MessageId);
  const over = guardrail.usage.value > guardrail.limit;
  const share = Math.min(100, Math.round((guardrail.usage.value / guardrail.limit) * 100));
  return (
    <li className="people-item people-group">
      <div className="people-main">
        <p className="people-name">
          {name}
          {over && <span className="people-badge">{t('guardrails.over')}</span>}
        </p>
        <p className="people-meta">
          {guardrail.usage.where
            ? t('guardrails.usage', {
                value: guardrail.usage.value,
                limit: guardrail.limit,
                where: guardrail.usage.where.name,
              })
            : t('guardrails.unused', { limit: guardrail.limit })}
        </p>
        <meter
          className="guardrails-meter"
          min={0}
          max={guardrail.limit}
          low={guardrail.limit * 0.7}
          high={guardrail.limit * 0.9}
          optimum={0}
          value={Math.min(guardrail.usage.value, guardrail.limit)}
          aria-label={t('guardrails.share', { name, share })}
        />
      </div>
      <form
        className="people-inline guardrails-form"
        aria-label={t('guardrails.changeOf', { name })}
        onSubmit={(event) => {
          event.preventDefault();
          const limit = Number(value);
          if (Number.isInteger(limit) && limit >= 1 && limit <= ceiling) onSave(limit);
        }}
      >
        <div className="form-field">
          <label htmlFor={`${id}-limit`} className="form-label">
            {t('guardrails.limit')}
          </label>
          <input
            id={`${id}-limit`}
            type="number"
            min={1}
            max={ceiling}
            step={1}
            inputMode="numeric"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <p className="form-hint">{t('guardrails.default', { value: guardrail.default })}</p>
        </div>
        <button type="submit" className="button-secondary">
          {t('guardrails.save')}
        </button>
      </form>
    </li>
  );
}
