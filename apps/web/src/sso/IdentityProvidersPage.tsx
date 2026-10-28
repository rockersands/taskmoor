import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import type { GroupSummary } from '../admin/SecurityPage';
import { ApiError } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { useSession } from '../session/SessionProvider';
import { useSessionExpiry } from '../session/useSessionExpiry';
import {
  type IdentityProvider,
  type IdentityProvidersClient,
  identityProvidersClient,
  isSaml,
  type ProviderInput,
} from './client';
import { ProviderForm } from './ProviderForm';
import { RedirectUriField } from './RedirectUriField';

export interface IdentityProvidersPageProps {
  /** Stories and tests pass their own backend; the page calls the API otherwise. */
  client?: IdentityProvidersClient;
}

type State =
  | { status: 'loading' }
  | {
      status: 'loaded';
      providers: IdentityProvider[];
      redirectUri: string;
      groups: GroupSummary[] | null;
    }
  | { status: 'failed' }
  | { status: 'forbidden' };

/** Which form is open: a new provider, one provider's editor, or none. */
type Editing = 'new' | number | null;

/**
 * Single sign-on for site administrators (#/admin/identity-providers; M1-080, M1-081, IAM-002,
 * IAM-003, IAM-004): the redirect URI to register at an OpenID Connect provider, the providers
 * (SAML ones with the addresses to register for each) with their domains and policy, and a
 * form to add, edit or delete one. The groups list feeds the mapping editor; when
 * it cannot be read the providers still load and the mapping is left as it is.
 */
export function IdentityProvidersPage({
  client = identityProvidersClient,
}: IdentityProvidersPageProps) {
  const t = useT();
  const { session } = useSession();
  const expired = useSessionExpiry();
  const titleId = useId();
  const listId = useId();
  const listHeading = useRef<HTMLHeadingElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const notAdmin = session.status === 'signed-in' && !session.user.isSiteAdmin;
  const [state, setState] = useState<State>(
    notAdmin ? { status: 'forbidden' } : { status: 'loading' },
  );
  const [editing, setEditing] = useState<Editing>(null);
  const [done, setDone] = useState('');

  const refuse = useCallback(
    (error: unknown): boolean => {
      if (expired(error)) return true;
      if (error instanceof ApiError && error.status === 403) {
        setState({ status: 'forbidden' });
        return true;
      }
      return false;
    },
    [expired],
  );

  const load = useCallback(async () => {
    try {
      const [{ providers, redirectUri }, groups] = await Promise.all([
        client.list(),
        client.groups().catch(() => null),
      ]);
      setState({ status: 'loaded', providers, redirectUri, groups });
    } catch (error) {
      if (!refuse(error)) setState({ status: 'failed' });
    }
  }, [client, refuse]);

  useEffect(() => {
    if (!notAdmin) void load();
  }, [notAdmin, load]);

  /** Saves the open form; the form explains a refusal, so other errors go back to it. */
  const save = async (target: IdentityProvider | null, input: Partial<ProviderInput>) => {
    setDone('');
    if (target && Object.keys(input).length === 0) {
      setEditing(null);
      setDone(t('admin.sso.unchanged'));
      listHeading.current?.focus();
      return;
    }
    try {
      const saved = target
        ? await client.update(target.id, input)
        : await client.create(input as ProviderInput);
      setEditing(null);
      setDone(t(target ? 'admin.sso.saved' : 'admin.sso.added', { name: saved.name }));
      await load();
      listHeading.current?.focus();
    } catch (error) {
      if (!refuse(error)) throw error;
    }
  };

  const remove = async (provider: IdentityProvider) => {
    setDone('');
    try {
      await client.remove(provider.id);
    } catch (error) {
      // Already gone is as good as deleted; anything else is the item's to report.
      if (!(error instanceof ApiError && error.status === 404)) throw error;
    }
    if (editing === provider.id) setEditing(null);
    setDone(t('admin.sso.deleted', { name: provider.name }));
    await load();
    listHeading.current?.focus();
  };

  return (
    <section aria-labelledby={titleId} className="sso-page">
      <h1 id={titleId} className="page-title">
        {t('admin.sso.title')}
      </h1>
      {state.status === 'forbidden' ? (
        <p className="page-note">{t('admin.sso.forbidden')}</p>
      ) : (
        <>
          <p className="page-note">{t('admin.sso.intro')}</p>
          <div className="sso-sections">
            {state.status === 'loaded' && <RedirectUriField uri={state.redirectUri} />}
            <section aria-labelledby={listId} className="account-section">
              <div className="sso-list-head">
                <h2 id={listId} ref={listHeading} tabIndex={-1} className="facts-title">
                  {t('admin.sso.list')}
                </h2>
                {state.status === 'loaded' && (
                  <button
                    ref={addButton}
                    type="button"
                    className="button-primary"
                    aria-expanded={editing === 'new'}
                    onClick={() => {
                      setDone('');
                      setEditing('new');
                    }}
                  >
                    {t('admin.sso.add')}
                  </button>
                )}
              </div>
              {state.status === 'loaded' && editing === 'new' && (
                <div className="sso-editor">
                  <ProviderForm
                    groups={state.groups}
                    onSave={(input) => save(null, input)}
                    onCancel={() => {
                      setEditing(null);
                      addButton.current?.focus();
                    }}
                  />
                </div>
              )}
              {state.status === 'loading' && (
                <p role="status" className="page-note">
                  {t('admin.sso.loading')}
                </p>
              )}
              {state.status === 'failed' && (
                <p role="alert" className="form-error">
                  {t('admin.sso.failed')}
                </p>
              )}
              {state.status === 'loaded' &&
                (state.providers.length === 0 ? (
                  <p className="page-note">{t('admin.sso.none')}</p>
                ) : (
                  <ul className="sso-provider-list" aria-labelledby={listId}>
                    {state.providers.map((provider) => (
                      <ProviderItem
                        key={provider.id}
                        provider={provider}
                        groups={state.groups}
                        editing={editing === provider.id}
                        onEdit={() => {
                          setDone('');
                          setEditing(provider.id);
                        }}
                        onCancelEdit={() => setEditing(null)}
                        onSave={(input) => save(provider, input)}
                        onDelete={() => remove(provider)}
                        refuse={refuse}
                      />
                    ))}
                  </ul>
                ))}
              <p role="status" className="form-status">
                {done}
              </p>
            </section>
          </div>
        </>
      )}
    </section>
  );
}

function ProviderItem({
  provider,
  groups,
  editing,
  onEdit,
  onCancelEdit,
  onSave,
  onDelete,
  refuse,
}: {
  provider: IdentityProvider;
  groups: GroupSummary[] | null;
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (input: Partial<ProviderInput>) => Promise<void>;
  onDelete: () => Promise<void>;
  refuse: (error: unknown) => boolean;
}) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const editButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = (text: string) => t('common.value', { value: text });

  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
  }, [confirming]);

  const confirmDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      await onDelete();
    } catch (e) {
      if (!refuse(e)) setError(t('admin.sso.actionFailed'));
      setBusy(false);
    }
  };

  return (
    <li className="sso-provider">
      <div className="service-account-head">
        <div className="token-main">
          <p className="token-name">
            <span>{value(provider.name)}</span>
            {isSaml(provider) && <span className="token-badge">{t('admin.sso.saml')}</span>}
            {!provider.enabled && (
              <span className="token-badge token-badge-revoked">{t('admin.sso.disabled')}</span>
            )}
            {provider.enforceSso && <span className="token-badge">{t('admin.sso.enforced')}</span>}
          </p>
          {isSaml(provider) ? (
            <p className="token-meta">
              <span>{t('admin.sso.entityIdValue', { entityId: provider.entityId })}</span>
              <span>
                {t('admin.sso.certificatesValue', { count: provider.certificates.length })}
              </span>
              {provider.idpInitiated && <span>{t('admin.sso.idpInitiatedOn')}</span>}
            </p>
          ) : (
            <p className="token-meta">
              <span>{t('admin.sso.issuerValue', { issuer: provider.issuer })}</span>
              <span>{t('admin.sso.clientIdValue', { clientId: provider.clientId })}</span>
              <span>
                {t(provider.hasClientSecret ? 'admin.sso.secretSaved' : 'admin.sso.noSecret')}
              </span>
            </p>
          )}
          <p className="token-meta">
            <span>
              {provider.domains.length > 0
                ? t('admin.sso.domainsValue', {
                    domains: intl.formatList(provider.domains, { type: 'conjunction' }),
                  })
                : t('admin.sso.noDomains')}
            </span>
            <span>{t(provider.jit ? 'admin.sso.jitOn' : 'admin.sso.jitOff')}</span>
            <span>
              {provider.groupClaim
                ? t(isSaml(provider) ? 'admin.sso.groupAttributeValue' : 'admin.sso.groupsValue', {
                    claim: provider.groupClaim,
                    count: provider.groupMap.length,
                  })
                : t('admin.sso.noGroupSync')}
            </span>
          </p>
          {isSaml(provider) && (
            // What to register at the identity provider for this one: its own addresses.
            <dl className="sso-addresses">
              <dt>{t('admin.sso.spEntityId')}</dt>
              <dd>
                <code>{provider.serviceProvider.spEntityId}</code>
              </dd>
              <dt>{t('admin.sso.acsUrl')}</dt>
              <dd>
                <code>{provider.serviceProvider.acsUrl}</code>
              </dd>
              <dt>{t('admin.sso.spMetadata')}</dt>
              <dd>
                <a
                  href={provider.serviceProvider.metadataUrl}
                  aria-label={t('admin.sso.spMetadataNamed', { name: provider.name })}
                >
                  {provider.serviceProvider.metadataUrl}
                </a>
              </dd>
            </dl>
          )}
        </div>
        <div className="token-actions">
          <button
            ref={editButton}
            type="button"
            className="button-secondary"
            aria-label={t('admin.sso.editNamed', { name: provider.name })}
            aria-expanded={editing}
            aria-controls={`${id}-editor`}
            onClick={onEdit}
          >
            {t('admin.sso.edit')}
          </button>
          <button
            ref={deleteButton}
            type="button"
            className="button-secondary"
            aria-label={t('admin.sso.deleteNamed', { name: provider.name })}
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            {t('admin.sso.delete')}
          </button>
        </div>
      </div>
      {confirming && (
        <div className="token-confirm">
          <p>{t('admin.sso.deleteConfirm', { name: provider.name })}</p>
          <div className="token-confirm-actions">
            <button
              ref={confirmButton}
              type="button"
              className="button-danger"
              disabled={busy}
              onClick={() => void confirmDelete()}
            >
              {t('admin.sso.confirmDelete')}
            </button>
            <button
              type="button"
              className="button-secondary"
              onClick={() => {
                setConfirming(false);
                deleteButton.current?.focus();
              }}
            >
              {t('admin.sso.cancel')}
            </button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {editing && (
        <div id={`${id}-editor`} className="sso-editor">
          <ProviderForm
            provider={provider}
            groups={groups}
            onSave={onSave}
            onCancel={() => {
              onCancelEdit();
              editButton.current?.focus();
            }}
          />
        </div>
      )}
    </li>
  );
}
