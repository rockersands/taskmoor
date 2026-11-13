import { type FormEvent, useCallback, useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { ApiError } from '../api/client';
import { type Translate, useT } from '../i18n/I18nProvider';
import { type MessageId, messagesEn } from '../i18n/messages.en';
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
 * default and where it is used most, all changed in one form with one Save (D20). A raise takes effect at once and
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

  /** Every changed limit, saved together with the page's one Save (D20). */
  const saveAll = async (changes: { guardrail: Guardrail; limit: number }[]) => {
    setProblem(null);
    if (changes.length === 0) {
      setMessage(t('guardrails.nothingChanged'));
      setRaised(false);
      return;
    }
    try {
      for (const { guardrail, limit } of changes) await client.set(guardrail.name, limit);
      const [only] = changes;
      setMessage(
        changes.length === 1 && only
          ? t('guardrails.saved', {
              name: t(`guardrails.name.${only.guardrail.name}` as MessageId),
              limit: only.limit,
            })
          : t('guardrails.savedMany', { count: changes.length }),
      );
      setRaised(changes.some(({ guardrail, limit }) => limit > guardrail.limit));
      await load();
    } catch {
      setProblem(t('guardrails.failed'));
      await load();
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
            <LimitsForm
              key={state.guardrails.map((g) => `${g.name}:${g.limit}`).join()}
              guardrails={state.guardrails}
              ceiling={state.ceiling}
              onSave={saveAll}
            />
          )}
          {!notAdmin && <StorageQuotas {...(storage ? { client: storage } : {})} />}
        </>
      )}
    </section>
  );
}

/** A number typed with or without separators ("20,000", "20 000"), or null when it is not one. */
export function parseLimit(text: string): number | null {
  const digits = text.replace(/[\s,.  ']/g, '');
  return /^\d+$/.test(digits) ? Number(digits) : null;
}

/** Every limit in one form with one Save (D20, AD-32). */
function LimitsForm({
  guardrails,
  ceiling,
  onSave,
}: {
  guardrails: Guardrail[];
  ceiling: number;
  onSave: (changes: { guardrail: Guardrail; limit: number }[]) => Promise<void>;
}) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  // Each limit as written, with the separators the text beside it uses.
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(guardrails.map((g) => [g.name, intl.formatNumber(g.limit)])),
  );
  const [invalid, setInvalid] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const wrong = guardrails
      .filter((g) => {
        const limit = parseLimit(values[g.name] ?? '');
        return limit === null || limit < 1 || limit > ceiling;
      })
      .map((g) => g.name);
    setInvalid(wrong);
    if (wrong.length > 0) return;
    const changes = guardrails
      .map((guardrail) => ({ guardrail, limit: parseLimit(values[guardrail.name] ?? '') ?? 0 }))
      .filter(({ guardrail, limit }) => limit !== guardrail.limit);
    setBusy(true);
    try {
      await onSave(changes);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="guardrails-limits"
      aria-label={t('guardrails.formLabel')}
      onSubmit={(event) => void submit(event)}
      noValidate
    >
      <ul className="people-list">
        {guardrails.map((g) => (
          <GuardrailRow
            key={g.name}
            id={`${id}-${g.name}`}
            guardrail={g}
            value={values[g.name] ?? ''}
            invalid={invalid.includes(g.name)}
            onChange={(value) => setValues((was) => ({ ...was, [g.name]: value }))}
          />
        ))}
      </ul>
      {invalid.length > 0 && (
        <p role="alert" className="form-error">
          {t('guardrails.invalid', { ceiling })}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={busy}>
          {t('guardrails.saveAll')}
        </button>
      </div>
    </form>
  );
}

/** Where a limit is used most, in words: a permission by its label, a bulk change by its kind. */
function usageText(t: Translate, guardrail: Guardrail): string {
  const { value, where } = guardrail.usage;
  const { limit } = guardrail;
  if (!where) return t('guardrails.unused', { limit });
  if (where.kind === 'access_policy') {
    // The server names it "<policy>: <permission key>"; the key reads as its label (AD-32).
    const cut = where.name.lastIndexOf(': ');
    const key = cut < 0 ? '' : where.name.slice(cut + 2);
    if (`permission.${key}` in messagesEn) {
      return t('guardrails.usagePermission', {
        value,
        limit,
        policy: where.name.slice(0, cut),
        permission: t(`permission.${key}` as MessageId),
      });
    }
  }
  if (where.kind === 'bulk_operation' && BULK_ACTIONS.includes(where.name)) {
    return t('guardrails.usageBulk', {
      value,
      limit,
      action: t(`guardrails.bulk.${where.name}` as MessageId),
    });
  }
  return t('guardrails.usage', { value, limit, where: where.name });
}

const BULK_ACTIONS: readonly string[] = ['edit', 'move', 'transition', 'delete', 'clone'];

function GuardrailRow({
  id,
  guardrail,
  value,
  invalid,
  onChange,
}: {
  id: string;
  guardrail: Guardrail;
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  const t = useT();
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
        <p className="people-meta">{usageText(t, guardrail)}</p>
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
      <div className="form-field guardrails-form">
        <label htmlFor={id} className="form-label">
          {t('guardrails.limitOf', { name })}
        </label>
        <input
          id={id}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={value}
          aria-invalid={invalid || undefined}
          aria-describedby={`${id}-default`}
          onChange={(event) => onChange(event.target.value)}
        />
        <p id={`${id}-default`} className="form-hint">
          {t('guardrails.default', { value: guardrail.default })}
        </p>
      </div>
    </li>
  );
}
