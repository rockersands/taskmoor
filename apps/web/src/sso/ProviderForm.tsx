import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import type { GroupSummary } from '../admin/SecurityPage';
import { ApiError } from '../api/client';
import { type Translate, useT } from '../i18n/I18nProvider';
import { PasswordField } from '../session/PasswordField';
import type { IdentityProvider, ProviderInput } from './client';
import { DomainListField } from './DomainListField';
import { changesOf, draftOf, emptyDraft, inputOf, type ProviderDraft } from './draft';
import { GroupMapField } from './GroupMapField';

export interface ProviderFormProps {
  /** The provider being edited; a new one when absent. */
  provider?: IdentityProvider | undefined;
  /** The groups the mapping can use; null when they could not be read. */
  groups: GroupSummary[] | null;
  /**
   * Saves a new provider (everything) or an edit (only what changed). Rejects with the
   * backend's ApiError, which the form explains next to the fields.
   */
  onSave: (input: Partial<ProviderInput>) => Promise<void>;
  onCancel: () => void;
}

type Field = 'name' | 'issuer' | 'domains' | null;

/** The backend's refusal as a sentence, and the field it is about. */
function problemOf(
  t: Translate,
  formatList: (items: string[]) => string,
  error: unknown,
  editing: boolean,
): { field: Field; message: string } {
  const code = error instanceof ApiError ? error.code : undefined;
  switch (code) {
    case 'insecure_issuer':
      return { field: 'issuer', message: t('admin.sso.error.insecureIssuer') };
    case 'name_taken':
      return { field: 'name', message: t('admin.sso.error.nameTaken') };
    case 'domain_taken': {
      const raw = (error as ApiError).body as { domains?: unknown } | null;
      const domains = Array.isArray(raw?.domains)
        ? raw.domains.filter((d): d is string => typeof d === 'string')
        : [];
      return {
        field: 'domains',
        message: t('admin.sso.error.domainTaken', {
          count: domains.length,
          domains: formatList(domains),
        }),
      };
    }
    case 'not_found':
      return {
        field: null,
        message: t(editing ? 'admin.sso.error.notFound' : 'admin.sso.error.groupMissing'),
      };
    case 'invalid_request':
      return { field: null, message: t('admin.sso.error.invalid') };
    default:
      return { field: null, message: t('admin.sso.error.failed') };
  }
}

/**
 * Adds or edits an identity provider (M1-080, IAM-003): where it is, the client Taskmoor uses
 * there (the secret is write-only: blank keeps it), the domains it serves, the sign-in policy
 * for them and the group mapping.
 */
export function ProviderForm({ provider, groups, onSave, onCancel }: ProviderFormProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<ProviderDraft>(() =>
    provider ? draftOf(provider) : emptyDraft(),
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ field: Field; message: string } | null>(null);
  const editing = provider !== undefined;
  const errorId = `${id}-error`;

  // The form opens where the work starts.
  useEffect(() => {
    nameInput.current?.focus();
  }, []);

  const set = <K extends keyof ProviderDraft>(key: K, value: ProviderDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await onSave(provider ? changesOf(provider, draft, groups !== null) : inputOf(draft));
    } catch (error) {
      setProblem(
        problemOf(t, (items) => intl.formatList(items, { type: 'conjunction' }), error, editing),
      );
    } finally {
      setBusy(false);
    }
  };

  /** The hint, and the backend's refusal when it is about this field. */
  const describe = (field: Field, hintId: string) =>
    problem?.field === field
      ? { 'aria-invalid': true, 'aria-describedby': `${hintId} ${errorId}` }
      : { 'aria-describedby': hintId };
  const secretHint = !provider
    ? t('admin.sso.form.clientSecretHintNew')
    : provider.hasClientSecret
      ? t('admin.sso.form.clientSecretHintKeep')
      : t('admin.sso.form.clientSecretHintNone');

  return (
    <form className="form sso-form" onSubmit={submit} aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="token-form-title">
        {provider ? t('admin.sso.editTitle', { name: provider.name }) : t('admin.sso.newTitle')}
      </h3>
      <div className="form-field">
        <label htmlFor={`${id}-name`}>{t('admin.sso.form.name')}</label>
        <input
          ref={nameInput}
          id={`${id}-name`}
          required
          maxLength={100}
          autoComplete="off"
          value={draft.name}
          onChange={(e) => set('name', e.target.value)}
          {...describe('name', `${id}-name-hint`)}
        />
        <p id={`${id}-name-hint`} className="form-hint">
          {t('admin.sso.form.nameHint')}
        </p>
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-issuer`}>{t('admin.sso.form.issuer')}</label>
        <input
          id={`${id}-issuer`}
          type="url"
          required
          maxLength={500}
          autoComplete="off"
          spellCheck={false}
          value={draft.issuer}
          onChange={(e) => set('issuer', e.target.value)}
          {...describe('issuer', `${id}-issuer-hint`)}
        />
        <p id={`${id}-issuer-hint`} className="form-hint">
          {t('admin.sso.form.issuerHint')}
        </p>
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-client`}>{t('admin.sso.form.clientId')}</label>
        <input
          id={`${id}-client`}
          required
          maxLength={500}
          autoComplete="off"
          spellCheck={false}
          value={draft.clientId}
          onChange={(e) => set('clientId', e.target.value)}
        />
      </div>
      <PasswordField
        label={t('admin.sso.form.clientSecret')}
        toggleLabel={t('admin.sso.form.showClientSecret')}
        autoComplete="new-password"
        required={false}
        hint={secretHint}
        value={draft.clientSecret}
        onChange={(value) => set('clientSecret', value)}
      />
      <div className="form-field">
        <label htmlFor={`${id}-scopes`}>{t('admin.sso.form.scopes')}</label>
        <input
          id={`${id}-scopes`}
          required
          minLength={6}
          maxLength={500}
          autoComplete="off"
          spellCheck={false}
          value={draft.scopes}
          aria-describedby={`${id}-scopes-hint`}
          onChange={(e) => set('scopes', e.target.value)}
        />
        <p id={`${id}-scopes-hint`} className="form-hint">
          {t('admin.sso.form.scopesHint')}
        </p>
      </div>
      <DomainListField
        domains={draft.domains}
        onChange={(domains) => set('domains', domains)}
        invalid={problem?.field === 'domains'}
        describedBy={errorId}
      />
      <fieldset>
        <legend>{t('admin.sso.form.policy')}</legend>
        {(
          [
            ['enforceSso', 'admin.sso.form.enforce', 'admin.sso.form.enforceHint'],
            ['jit', 'admin.sso.form.jit', 'admin.sso.form.jitHint'],
            ['enabled', 'admin.sso.form.enabled', 'admin.sso.form.enabledHint'],
          ] as const
        ).map(([key, label, hint]) => (
          <div key={key} className="form-field form-field-inline sso-option">
            <input
              id={`${id}-${key}`}
              type="checkbox"
              checked={draft[key]}
              aria-describedby={`${id}-${key}-hint`}
              onChange={(e) => set(key, e.target.checked)}
            />
            <label htmlFor={`${id}-${key}`}>{t(label)}</label>
            <p id={`${id}-${key}-hint`} className="form-hint sso-option-hint">
              {t(hint)}
            </p>
          </div>
        ))}
      </fieldset>
      <div className="form-field">
        <label htmlFor={`${id}-claim`}>{t('admin.sso.form.groupClaim')}</label>
        <input
          id={`${id}-claim`}
          maxLength={100}
          autoComplete="off"
          spellCheck={false}
          value={draft.groupClaim}
          aria-describedby={`${id}-claim-hint`}
          onChange={(e) => set('groupClaim', e.target.value)}
        />
        <p id={`${id}-claim-hint`} className="form-hint">
          {t('admin.sso.form.groupClaimHint')}
        </p>
      </div>
      <GroupMapField
        rows={draft.groupMap}
        groups={groups}
        onChange={(rows) => set('groupMap', rows)}
      />
      {problem && (
        <p id={errorId} role="alert" className="form-error">
          {problem.message}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={busy}>
          {t(provider ? 'admin.sso.form.save' : 'admin.sso.form.create')}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('admin.sso.form.cancel')}
        </button>
      </div>
    </form>
  );
}
