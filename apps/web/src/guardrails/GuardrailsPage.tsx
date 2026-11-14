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
  const intl = useIntl();
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

  /**
   * Every changed limit, saved together with the page's one Save (D20). The server takes one
   * limit at a time, so a failure partway says which limits were saved and which were not; the
   * form stays as it is, with what was typed, so nothing is lost.
   */
  const saveAll = async (changes: { guardrail: Guardrail; limit: number }[]) => {
    setProblem(null);
    setMessage('');
    setRaised(false);
    if (changes.length === 0) {
      setMessage(t('guardrails.nothingChanged'));
      return;
    }
    const saved: typeof changes = [];
    const failed: typeof changes = [];
    for (const change of changes) {
      try {
        await client.set(change.guardrail.name, change.limit);
        saved.push(change);
      } catch (error) {
        if (expired(error)) return;
        failed.push(change);
      }
    }
    const names = (list: typeof changes) =>
      intl.formatList(
        list.map(({ guardrail }) => t(`guardrails.name.${guardrail.name}` as MessageId)),
      );
    const [only] = saved;
    if (failed.length > 0) {
      if (saved.length > 0) setMessage(t('guardrails.savedSome', { names: names(saved) }));
      setProblem(t('guardrails.failedSome', { count: failed.length, names: names(failed) }));
    } else {
      setMessage(
        saved.length === 1 && only
          ? t('guardrails.saved', {
              name: t(`guardrails.name.${only.guardrail.name}` as MessageId),
              limit: only.limit,
            })
          : t('guardrails.savedMany', { count: saved.length }),
      );
    }
    setRaised(saved.some(({ guardrail, limit }) => limit > guardrail.limit));
    await load();
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
            <LimitsForm guardrails={state.guardrails} ceiling={state.ceiling} onSave={saveAll} />
          )}
          {!notAdmin && <StorageQuotas {...(storage ? { client: storage } : {})} />}
        </>
      )}
    </section>
  );
}

/**
 * A whole number typed with or without the locale's group separator ("20,000" in English,
 * "20.000" in Spanish), or null when it is not one. Only that separator is skipped, so a
 * decimal ("1.5" in English, "1,5" in Spanish) is refused rather than read as thousands. Where
 * the separator is a space, any space will do.
 */
export function parseLimit(text: string, locale: string): number | null {
  const group =
    new Intl.NumberFormat(locale).formatToParts(1_000_000).find((part) => part.type === 'group')
      ?.value ?? '';
  const trimmed = text.trim();
  const digits =
    group === ''
      ? trimmed
      : /^\s$/.test(group)
        ? trimmed.replace(/\s/g, '')
        : trimmed.split(group).join('');
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
    if (busy) return;
    const wrong = guardrails
      .filter((g) => {
        const limit = parseLimit(values[g.name] ?? '', intl.locale);
        return limit === null || limit < 1 || limit > ceiling;
      })
      .map((g) => g.name);
    setInvalid(wrong);
    if (wrong.length > 0) return;
    const changes = guardrails
      .map((guardrail) => ({
        guardrail,
        limit: parseLimit(values[guardrail.name] ?? '', intl.locale) ?? 0,
      }))
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
        {/* aria-disabled rather than disabled: a disabled button drops the focus to the page. */}
        <button type="submit" className="button-primary" aria-disabled={busy || undefined}>
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
  if (where.kind === 'access_policy' && where.permission) {
    // The policy by its name, the permission by its label (AD-32); a key this app does not
    // know yet is shown as it is (T-255).
    const key = where.permission;
    return t('guardrails.usagePermission', {
      value,
      limit,
      policy: where.name,
      permission: `permission.${key}` in messagesEn ? t(`permission.${key}` as MessageId) : key,
    });
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
