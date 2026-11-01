import { type FormEvent, useEffect, useId, useState } from 'react';
import { ApiError, api } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { useSession } from '../session/SessionProvider';
import { type SessionPolicyClient, SessionPolicyForm } from './SessionPolicyForm';

/** Who must sign in with a second factor (M1-084), as `/api/v1/security/two-factor` keeps it. */
export interface TwoFactorPolicy {
  required: 'none' | 'site_admins' | 'everyone';
  /** Members of these groups need a second factor too, whatever `required` says. */
  groupIds: number[];
  /**
   * The organization's email domains (M1-085; IAM-004): people at any other domain are
   * external and need a second factor. Older servers leave it out.
   */
  organizationDomains?: string[];
}

/** Domains as typed: separated by spaces, commas or lines, lower case, each once. */
export function parseDomains(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((d) => d.trim().toLowerCase().replace(/^@/, ''))
        .filter((d) => d !== ''),
    ),
  ];
}

export interface GroupSummary {
  id: number;
  name: string;
}

/** The endpoints the page uses. Stories and some tests pass their own. */
export interface SecurityClient {
  loadPolicy: () => Promise<TwoFactorPolicy>;
  savePolicy: (policy: TwoFactorPolicy) => Promise<TwoFactorPolicy>;
  listGroups: () => Promise<GroupSummary[]>;
}

export const securityClient: SecurityClient = {
  loadPolicy: () => api<TwoFactorPolicy>('/security/two-factor'),
  savePolicy: (policy) =>
    api<TwoFactorPolicy>('/security/two-factor', { method: 'PUT', body: policy }),
  listGroups: async () =>
    (await api<{ groups: GroupSummary[] }>('/groups')).groups.map(({ id, name }) => ({
      id,
      name,
    })),
};

const CHOICES: { value: TwoFactorPolicy['required']; labelId: MessageId }[] = [
  { value: 'none', labelId: 'admin.security.none' },
  { value: 'site_admins', labelId: 'admin.security.siteAdmins' },
  { value: 'everyone', labelId: 'admin.security.everyone' },
];

type State =
  | { status: 'loading' }
  | { status: 'loaded'; policy: TwoFactorPolicy; groups: GroupSummary[] | null }
  | { status: 'forbidden' }
  | { status: 'failed' };

export interface SecurityPageProps {
  /** Stories and tests pass their own endpoints; the page calls the backend otherwise. */
  client?: SecurityClient;
  /** The session part's endpoints (the user's decision of 2026-11-01); none hides it. */
  sessions?: SessionPolicyClient | null;
}

/**
 * Security settings for site administrators (#/admin/security): the two-factor policy (M1-084):
 * nobody, site administrators or everyone, plus chosen groups; and how long a sign-in lasts.
 * The groups list is a convenience; when it cannot be read the policy still loads and saves.
 */
export function SecurityPage({ client = securityClient, sessions }: SecurityPageProps) {
  const t = useT();
  const { session } = useSession();
  const titleId = useId();
  const id = useId();
  const notAdmin = session.status === 'signed-in' && !session.user.isSiteAdmin;
  const [state, setState] = useState<State>(
    notAdmin ? { status: 'forbidden' } : { status: 'loading' },
  );
  const [required, setRequired] = useState<TwoFactorPolicy['required']>('none');
  const [groupIds, setGroupIds] = useState<number[]>([]);
  const [domains, setDomains] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState('');

  useEffect(() => {
    if (notAdmin) return;
    let cancelled = false;
    Promise.all([client.loadPolicy(), client.listGroups().catch(() => null)]).then(
      ([policy, groups]) => {
        if (cancelled) return;
        setRequired(policy.required);
        setGroupIds(policy.groupIds);
        setDomains((policy.organizationDomains ?? []).join('\n'));
        setState({ status: 'loaded', policy, groups });
      },
      (e: unknown) => {
        if (cancelled) return;
        const forbidden = e instanceof ApiError && (e.status === 403 || e.status === 401);
        setState({ status: forbidden ? 'forbidden' : 'failed' });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, notAdmin]);

  const toggleGroup = (groupId: number, checked: boolean) =>
    setGroupIds((ids) =>
      checked ? [...ids, groupId].sort((a, b) => a - b) : ids.filter((g) => g !== groupId),
    );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSaved('');
    try {
      const policy = await client.savePolicy({
        required,
        groupIds,
        organizationDomains: parseDomains(domains),
      });
      setRequired(policy.required);
      setGroupIds(policy.groupIds);
      setDomains((policy.organizationDomains ?? []).join('\n'));
      setSaved(t('admin.security.saved'));
    } catch {
      setError(t('admin.security.saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={titleId} className="security-page">
      <h1 id={titleId} className="page-title">
        {t('admin.security.title')}
      </h1>
      {state.status === 'loading' && (
        <p role="status" className="page-note">
          {t('admin.security.loading')}
        </p>
      )}
      {state.status === 'forbidden' && <p className="page-note">{t('admin.security.forbidden')}</p>}
      {state.status === 'failed' && (
        <p role="alert" className="form-error">
          {t('admin.security.failed')}
        </p>
      )}
      {state.status === 'loaded' && (
        <form className="form" onSubmit={submit} aria-labelledby={`${id}-title`}>
          <h2 id={`${id}-title`} className="facts-title">
            {t('admin.security.twoFactor')}
          </h2>
          <p className="page-note">{t('admin.security.twoFactorIntro')}</p>
          <fieldset>
            <legend>{t('admin.security.required')}</legend>
            {CHOICES.map((choice) => (
              <div key={choice.value} className="form-field form-field-inline">
                <input
                  id={`${id}-${choice.value}`}
                  type="radio"
                  name={`${id}-required`}
                  value={choice.value}
                  checked={required === choice.value}
                  onChange={() => setRequired(choice.value)}
                />
                <label htmlFor={`${id}-${choice.value}`}>{t(choice.labelId)}</label>
              </div>
            ))}
          </fieldset>
          <fieldset>
            <legend>{t('admin.security.groups')}</legend>
            {state.groups === null ? (
              <p className="form-hint">{t('admin.security.groupsFailed')}</p>
            ) : state.groups.length === 0 ? (
              <p className="form-hint">{t('admin.security.noGroups')}</p>
            ) : (
              state.groups.map((group) => (
                <div key={group.id} className="form-field form-field-inline">
                  <input
                    id={`${id}-group-${group.id}`}
                    type="checkbox"
                    checked={groupIds.includes(group.id)}
                    onChange={(event) => toggleGroup(group.id, event.target.checked)}
                  />
                  <label htmlFor={`${id}-group-${group.id}`}>
                    {t('common.value', { value: group.name })}
                  </label>
                </div>
              ))
            )}
          </fieldset>
          <div className="form-field">
            <label htmlFor={`${id}-domains`}>{t('admin.security.domains')}</label>
            <textarea
              id={`${id}-domains`}
              rows={3}
              value={domains}
              spellCheck={false}
              aria-describedby={`${id}-domains-hint`}
              onChange={(event) => setDomains(event.target.value)}
            />
            <p id={`${id}-domains-hint`} className="form-hint">
              {t('admin.security.domainsHint')}
            </p>
          </div>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <div className="form-actions">
            <button type="submit" className="button-primary" disabled={busy}>
              {t('admin.security.save')}
            </button>
          </div>
          <p role="status" className="form-status">
            {saved}
          </p>
        </form>
      )}
      {state.status === 'loaded' && sessions !== null && (
        <SessionPolicyForm {...(sessions ? { client: sessions } : {})} />
      )}
    </section>
  );
}
