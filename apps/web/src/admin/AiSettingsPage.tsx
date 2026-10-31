import { type FormEvent, useEffect, useId, useState } from 'react';
import { ApiError, api } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { useSession } from '../session/SessionProvider';

export type ProviderId = 'anthropic' | 'bedrock' | 'vertex' | 'foundry' | 'openai-compatible';
export type CredentialSlot =
  | 'apiKey'
  | 'accessKeyId'
  | 'secretAccessKey'
  | 'sessionToken'
  | 'accessToken';
export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** The provider's settings without its keys, as the server stores them. */
export type ProviderSettings = { provider: ProviderId } & Record<string, string>;

export interface FeatureChoice {
  enabled: boolean;
  model?: string;
  effort?: Effort;
}

export interface AiSettings {
  enabled: boolean;
  strict: boolean;
  provider: ProviderSettings | null;
  features: Record<string, FeatureChoice>;
}

/** `GET /api/v1/admin/ai` (M1-075, M1-076). Keys appear only as their last four characters. */
export interface AiView {
  settings: AiSettings & { tracks?: Record<string, boolean> };
  credentials: {
    slot: CredentialSlot;
    last4: string;
    source: 'admin' | 'environment';
    updatedAt: string;
    updatedBy: { id: number; name: string } | null;
  }[];
  keyStorage: 'kms' | 'vault' | 'master_key' | 'pepper' | 'none';
  providers: { id: ProviderId; slots: CredentialSlot[]; required: CredentialSlot[] }[];
  features: { id: string; effort: Effort }[];
  models: string[];
  defaultModel: string;
  efforts: Effort[];
  tracks: { id: number; key: string; name: string; enabled: boolean | null; on: boolean }[];
}

export type TestResult =
  | { ok: true; models: { id: string; displayName?: string }[] | null }
  | { ok: false; error: { kind: string; message: string } };

export interface AiClient {
  load: () => Promise<AiView>;
  save: (settings: AiSettings) => Promise<void>;
  setKey: (slot: CredentialSlot, value: string) => Promise<void>;
  removeKey: (slot: CredentialSlot) => Promise<void>;
  test: (candidate: {
    provider: ProviderSettings | null;
    credentials: Partial<Record<CredentialSlot, string>>;
  }) => Promise<TestResult>;
  setTrack: (trackId: number, enabled: boolean) => Promise<void>;
}

export const aiClient: AiClient = {
  load: () => api<AiView>('/admin/ai'),
  save: async (settings) => {
    await api('/admin/ai', { method: 'PUT', body: settings });
  },
  setKey: async (slot, value) => {
    await api(`/admin/ai/credentials/${slot}`, { method: 'PUT', body: { value } });
  },
  removeKey: async (slot) => {
    await api(`/admin/ai/credentials/${slot}`, { method: 'DELETE' });
  },
  test: (candidate) =>
    api<TestResult>('/admin/ai/test', {
      method: 'POST',
      body: {
        ...(candidate.provider ? { provider: candidate.provider } : {}),
        credentials: candidate.credentials,
      },
    }),
  setTrack: async (trackId, enabled) => {
    await api(`/admin/ai/tracks/${trackId}`, { method: 'PUT', body: { enabled } });
  },
};

const PROVIDERS: { id: ProviderId; label: MessageId }[] = [
  { id: 'anthropic', label: 'ai.provider.anthropic' },
  { id: 'bedrock', label: 'ai.provider.bedrock' },
  { id: 'vertex', label: 'ai.provider.vertex' },
  { id: 'foundry', label: 'ai.provider.foundry' },
  { id: 'openai-compatible', label: 'ai.provider.openaiCompatible' },
];

/** The provider settings that are not secret, per provider. */
const FIELDS: Record<ProviderId, { name: string; label: MessageId; required: boolean }[]> = {
  anthropic: [{ name: 'baseUrl', label: 'ai.field.baseUrlOptional', required: false }],
  bedrock: [{ name: 'region', label: 'ai.field.region', required: true }],
  vertex: [
    { name: 'region', label: 'ai.field.region', required: true },
    { name: 'projectId', label: 'ai.field.projectId', required: true },
  ],
  foundry: [{ name: 'resource', label: 'ai.field.resource', required: true }],
  'openai-compatible': [
    { name: 'baseUrl', label: 'ai.field.baseUrl', required: true },
    { name: 'model', label: 'ai.field.model', required: true },
  ],
};

const SLOTS: Record<CredentialSlot, MessageId> = {
  apiKey: 'ai.slot.apiKey',
  accessKeyId: 'ai.slot.accessKeyId',
  secretAccessKey: 'ai.slot.secretAccessKey',
  sessionToken: 'ai.slot.sessionToken',
  accessToken: 'ai.slot.accessToken',
};

const FEATURES: Record<string, MessageId> = {
  summarize: 'ai.feature.summarize',
  'query-from-text': 'ai.feature.queryFromText',
  'assisted-creation': 'ai.feature.assistedCreation',
  duplicates: 'ai.feature.duplicates',
};

const EFFORTS: Record<Effort, MessageId> = {
  low: 'ai.effort.low',
  medium: 'ai.effort.medium',
  high: 'ai.effort.high',
  xhigh: 'ai.effort.xhigh',
  max: 'ai.effort.max',
};

/** What a refused save says, from the backend's answer. */
function saveProblem(error: unknown): MessageId {
  if (error instanceof ApiError && error.code === 'key_storage_unavailable') {
    return 'ai.keyStorageNone';
  }
  if (error instanceof ApiError && error.status === 400) return 'ai.invalid';
  return 'ai.saveFailed';
}

/**
 * The AI settings for site administrators (M1-076; AI-001, AI-006, IAM-019, IAM-020): the
 * provider and its settings, its keys (write-only: only the last four characters are shown),
 * "test connection", which lists the models the provider offers right now, the model and effort
 * of each feature, the workspace switch, strict mode and the switch of each track. With AI off,
 * the per-feature and per-track controls are hidden, as AI controls are everywhere else.
 */
export function AiSettingsPage({ client = aiClient }: { client?: AiClient }) {
  const t = useT();
  const id = useId();
  const { session } = useSession();
  const notAdmin = session.status === 'signed-in' && !session.user.isSiteAdmin;
  const [view, setView] = useState<AiView | null>(null);
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [keys, setKeys] = useState<Partial<Record<CredentialSlot, string>>>({});
  const [status, setStatus] = useState('');
  const [problem, setProblem] = useState<MessageId | null>(null);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  /** Track switches as just clicked, until the saved answer comes back. */
  const [switching, setSwitching] = useState<Record<number, boolean>>({});

  const reload = async () => {
    const next = await client.load();
    setView(next);
    setSettings({
      enabled: next.settings.enabled,
      strict: next.settings.strict,
      provider: next.settings.provider,
      features: next.settings.features,
    });
  };

  useEffect(() => {
    if (notAdmin) return;
    let live = true;
    client.load().then(
      (next) => {
        if (!live) return;
        setView(next);
        setSettings({
          enabled: next.settings.enabled,
          strict: next.settings.strict,
          provider: next.settings.provider,
          features: next.settings.features,
        });
      },
      () => live && setLoadFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client, notAdmin]);

  if (notAdmin) {
    return (
      <section className="admin-page">
        <h1 className="page-title">{t('ai.title')}</h1>
        <p className="page-note">{t('ai.forbidden')}</p>
      </section>
    );
  }
  if (loadFailed) {
    return (
      <section className="admin-page">
        <h1 className="page-title">{t('ai.title')}</h1>
        <p role="alert" className="form-error">
          {t('ai.loadFailed')}
        </p>
      </section>
    );
  }
  if (!view || !settings) return <p className="page-note">{t('ai.loading')}</p>;

  const provider = settings.provider;
  const providerInfo = provider
    ? view.providers.find((p) => p.id === provider.provider)
    : undefined;
  const stored = new Map(view.credentials.map((c) => [c.slot, c]));
  const claude = provider !== null && provider.provider !== 'openai-compatible';

  const done = (message: MessageId) => {
    setProblem(null);
    setStatus(t(message));
  };
  const failed = (error: unknown) => {
    setStatus('');
    setProblem(saveProblem(error));
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    client.save(settings).then(() => reload().then(() => done('ai.saved')), failed);
  };

  const chooseProvider = (next: string) => {
    setResult(null);
    setSettings({
      ...settings,
      provider: next ? ({ provider: next as ProviderId } as ProviderSettings) : null,
    });
  };

  const setField = (name: string, value: string) => {
    if (!provider) return;
    const next: ProviderSettings = { ...provider };
    if (value.trim() === '') delete next[name];
    else next[name] = value.trim();
    setSettings({ ...settings, provider: next });
  };

  const saveKey = (slot: CredentialSlot) => {
    const value = keys[slot]?.trim() ?? '';
    if (!value) return;
    client.setKey(slot, value).then(
      () =>
        reload().then(() => {
          setKeys({ ...keys, [slot]: '' });
          done('ai.keySaved');
        }),
      failed,
    );
  };

  const removeKey = (slot: CredentialSlot) =>
    client.removeKey(slot).then(() => reload().then(() => done('ai.keyRemoved')), failed);

  const test = () => {
    setTesting(true);
    setResult(null);
    const typed = Object.fromEntries(
      Object.entries(keys).filter(([, v]) => typeof v === 'string' && v.trim() !== ''),
    ) as Partial<Record<CredentialSlot, string>>;
    client
      .test({ provider, credentials: typed })
      .then(setResult, () =>
        setResult({ ok: false, error: { kind: 'unknown', message: t('ai.testFailed') } }),
      )
      .finally(() => setTesting(false));
  };

  const setFeature = (
    featureId: string,
    change: { enabled?: boolean; model?: string | undefined; effort?: Effort | undefined },
  ) => {
    const current = settings.features[featureId] ?? { enabled: true };
    const merged = { ...current, ...change };
    const next: FeatureChoice = { enabled: merged.enabled };
    if (merged.model) next.model = merged.model;
    if (merged.effort) next.effort = merged.effort;
    setSettings({ ...settings, features: { ...settings.features, [featureId]: next } });
  };

  const switchTrack = (trackId: number, enabled: boolean) => {
    setSwitching((current) => ({ ...current, [trackId]: enabled }));
    const settle = () =>
      setSwitching((current) => {
        const { [trackId]: _, ...rest } = current;
        return rest;
      });
    return client.setTrack(trackId, enabled).then(
      () =>
        reload().then(() => {
          settle();
          done('ai.trackSaved');
        }),
      (error) => {
        settle();
        failed(error);
      },
    );
  };

  return (
    <section className="admin-page" aria-labelledby={`${id}-title`}>
      <h1 id={`${id}-title`} className="page-title">
        {t('ai.title')}
      </h1>
      <p className="page-note">{t('ai.intro')}</p>
      {view.keyStorage === 'none' && (
        <p role="alert" className="form-error">
          {t('ai.keyStorageNone')}
        </p>
      )}
      <form className="people-form" aria-label={t('ai.formLabel')} onSubmit={submit}>
        <div className="form-field form-field-inline">
          <input
            id={`${id}-enabled`}
            type="checkbox"
            checked={settings.enabled}
            onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })}
          />
          <label htmlFor={`${id}-enabled`}>{t('ai.enabled')}</label>
        </div>
        <div className="form-field form-field-inline">
          <input
            id={`${id}-strict`}
            type="checkbox"
            checked={settings.strict}
            aria-describedby={`${id}-strict-hint`}
            onChange={(event) => setSettings({ ...settings, strict: event.target.checked })}
          />
          <label htmlFor={`${id}-strict`}>{t('ai.strict')}</label>
        </div>
        <p id={`${id}-strict-hint`} className="form-hint">
          {t('ai.strictHint')}
        </p>
        <div className="form-field">
          <label htmlFor={`${id}-provider`}>{t('ai.provider')}</label>
          <select
            id={`${id}-provider`}
            value={provider?.provider ?? ''}
            onChange={(event) => chooseProvider(event.target.value)}
          >
            <option value="">{t('ai.provider.none')}</option>
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {t(p.label)}
              </option>
            ))}
          </select>
        </div>
        {provider &&
          FIELDS[provider.provider].map((field) => (
            <div key={field.name} className="form-field">
              <label htmlFor={`${id}-${field.name}`}>{t(field.label)}</label>
              <input
                id={`${id}-${field.name}`}
                type={field.name === 'baseUrl' ? 'url' : 'text'}
                required={field.required}
                value={provider[field.name] ?? ''}
                onChange={(event) => setField(field.name, event.target.value)}
              />
            </div>
          ))}

        {settings.enabled && (
          <fieldset className="form-field ai-features">
            <legend className="form-label">{t('ai.features')}</legend>
            <p className="form-hint">{t('ai.featuresHint', { model: view.defaultModel })}</p>
            {view.features.map((feature) => {
              const choice = settings.features[feature.id] ?? { enabled: true };
              const title = t(FEATURES[feature.id] ?? 'ai.feature.other');
              return (
                <fieldset key={feature.id} className="ai-feature" aria-label={title}>
                  <div className="form-field form-field-inline">
                    <input
                      id={`${id}-${feature.id}-on`}
                      type="checkbox"
                      checked={choice.enabled}
                      onChange={(event) =>
                        setFeature(feature.id, { enabled: event.target.checked })
                      }
                    />
                    <label htmlFor={`${id}-${feature.id}-on`}>{title}</label>
                  </div>
                  {claude && (
                    <div className="form-field">
                      <label htmlFor={`${id}-${feature.id}-model`}>{t('ai.model')}</label>
                      <select
                        id={`${id}-${feature.id}-model`}
                        value={choice.model ?? view.defaultModel}
                        onChange={(event) =>
                          setFeature(feature.id, {
                            model:
                              event.target.value === view.defaultModel ? '' : event.target.value,
                          })
                        }
                      >
                        {view.models.map((model) => (
                          <option key={model} value={model}>
                            {model === view.defaultModel
                              ? t('ai.defaultChoice', { choice: model })
                              : model}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  {claude && (
                    <div className="form-field">
                      <label htmlFor={`${id}-${feature.id}-effort`}>{t('ai.effort')}</label>
                      <select
                        id={`${id}-${feature.id}-effort`}
                        value={choice.effort ?? feature.effort}
                        onChange={(event) =>
                          setFeature(feature.id, {
                            effort:
                              event.target.value === feature.effort
                                ? undefined
                                : (event.target.value as Effort),
                          })
                        }
                      >
                        {view.efforts.map((effort) => (
                          <option key={effort} value={effort}>
                            {effort === feature.effort
                              ? t('ai.defaultChoice', { choice: t(EFFORTS[effort]) })
                              : t(EFFORTS[effort])}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </fieldset>
              );
            })}
          </fieldset>
        )}
        <div className="form-actions">
          <button type="submit" className="button-primary">
            {t('ai.save')}
          </button>
        </div>
        <p role="status" className="form-status">
          {status}
        </p>
        {problem && (
          <p role="alert" className="form-error">
            {t(problem)}
          </p>
        )}
      </form>

      {provider && providerInfo && (
        <section aria-labelledby={`${id}-keys`}>
          <h2 id={`${id}-keys`}>{t('ai.keys')}</h2>
          <p className="page-note">{t('ai.keysHint')}</p>
          {providerInfo.slots.map((slot) => {
            const found = stored.get(slot);
            return (
              <div key={slot} className="people-form ai-key">
                <div className="form-field">
                  <label htmlFor={`${id}-key-${slot}`}>{t(SLOTS[slot])}</label>
                  <input
                    id={`${id}-key-${slot}`}
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    value={keys[slot] ?? ''}
                    aria-describedby={`${id}-key-${slot}-state`}
                    onChange={(event) => setKeys({ ...keys, [slot]: event.target.value })}
                  />
                  <p id={`${id}-key-${slot}-state`} className="form-hint">
                    {found
                      ? found.last4
                        ? t('ai.keyStoredEnding', { last4: found.last4 })
                        : t('ai.keyStored')
                      : t('ai.keyNotSet')}
                    {found?.source === 'environment' ? ` ${t('ai.keyFromEnvironment')}` : ''}
                  </p>
                </div>
                <div className="form-actions">
                  <button
                    type="button"
                    className="button-secondary"
                    onClick={() => saveKey(slot)}
                    disabled={!keys[slot]?.trim()}
                  >
                    {t('ai.saveKey', { slot: t(SLOTS[slot]) })}
                  </button>
                  {found && (
                    <button
                      type="button"
                      className="button-danger"
                      onClick={() => void removeKey(slot)}
                    >
                      {t('ai.removeKey', { slot: t(SLOTS[slot]) })}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          <div className="form-actions">
            <button type="button" className="button-secondary" onClick={test} disabled={testing}>
              {testing ? t('ai.testing') : t('ai.test')}
            </button>
          </div>
          {result?.ok === true && (
            <div role="status" className="form-status">
              <p>{result.models ? t('ai.testOk') : t('ai.testOkNoListing')}</p>
              {result.models && (
                <ul aria-label={t('ai.models')} className="link-list">
                  {result.models.map((model) => (
                    <li key={model.id}>
                      <code>{model.id}</code>
                      {model.displayName ? ` ${model.displayName}` : ''}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {result?.ok === false && (
            <p role="alert" className="form-error">
              {t('ai.testRefused', { message: result.error.message })}
            </p>
          )}
        </section>
      )}

      {settings.enabled && view.settings.enabled && (
        <section aria-labelledby={`${id}-tracks`}>
          <h2 id={`${id}-tracks`}>{t('ai.tracks')}</h2>
          <p className="page-note">
            {view.settings.strict ? t('ai.tracksStrictHint') : t('ai.tracksHint')}
          </p>
          {view.tracks.length === 0 ? (
            <p className="page-note">{t('ai.noTracks')}</p>
          ) : (
            <ul className="link-list">
              {view.tracks.map((track) => (
                <li key={track.id} className="form-field form-field-inline">
                  <input
                    id={`${id}-track-${track.id}`}
                    type="checkbox"
                    checked={switching[track.id] ?? track.on}
                    onChange={(event) => void switchTrack(track.id, event.target.checked)}
                  />
                  <label htmlFor={`${id}-track-${track.id}`}>
                    {t('ai.trackLabel', { key: track.key, name: track.name })}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </section>
  );
}
