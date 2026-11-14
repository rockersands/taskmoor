import { type FormEvent, useEffect, useId, useState } from 'react';
import { api } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { PageHeader } from '../shell/PageHeader';
import { BreakAtSlashes } from './BreakAtSlashes';

export type McpProfile = 'read-only' | 'planner' | 'full';

/** The MCP server's settings (M1-072; API-012), as `GET /api/v1/admin/mcp` gives them. */
export interface McpSettings {
  enabled: boolean;
  allowedClients: string[];
  profile: McpProfile;
  /** Whether MCP clients may register themselves to sign in with OAuth (M1-072). */
  oauthRegistration: boolean;
}

export interface McpClient {
  load: () => Promise<McpSettings>;
  save: (settings: McpSettings) => Promise<McpSettings>;
}

export const mcpClient: McpClient = {
  load: async () => (await api<{ settings: McpSettings }>('/admin/mcp')).settings,
  save: async (settings) =>
    (await api<{ settings: McpSettings }>('/admin/mcp', { method: 'PUT', body: settings }))
      .settings,
};

const PROFILES: { id: McpProfile; label: MessageId; hint: MessageId }[] = [
  { id: 'read-only', label: 'mcp.profile.readOnly', hint: 'mcp.profile.readOnlyHint' },
  { id: 'planner', label: 'mcp.profile.planner', hint: 'mcp.profile.plannerHint' },
  { id: 'full', label: 'mcp.profile.full', hint: 'mcp.profile.fullHint' },
];

/**
 * The MCP server's settings for site administrators (M1-072; API-012): whether agents may
 * connect, which tools they get (read-only, planner or full), which clients may connect (by
 * the name they give; none listed means any), and how to connect one. Every tool call is in the
 * audit log; a tool never does more than the token it runs with.
 */
export function McpPage({
  client = mcpClient,
  origin = window.location.origin,
}: {
  client?: McpClient;
  origin?: string;
}) {
  const t = useT();
  const id = useId();
  const [settings, setSettings] = useState<McpSettings | null>(null);
  const [clients, setClients] = useState('');
  const [failed, setFailed] = useState(false);
  const [status, setStatus] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    client.load().then(
      (s) => {
        setSettings(s);
        setClients(s.allowedClients.join('\n'));
      },
      () => setFailed(true),
    );
  }, [client]);

  const header = (
    <PageHeader
      titleId={`${id}-title`}
      title={t('mcp.title')}
      purpose={t('settings.mcpHint')}
      about={t('mcp.intro')}
    />
  );

  if (failed) {
    return (
      <section className="page admin-page mcp-page" aria-labelledby={`${id}-title`}>
        {header}
        <p role="alert" className="form-error">
          {t('mcp.failed')}
        </p>
      </section>
    );
  }
  if (!settings) {
    return (
      <section className="page admin-page mcp-page" aria-labelledby={`${id}-title`}>
        {header}
        <p className="page-note">{t('reports.loading')}</p>
      </section>
    );
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    const next = {
      ...settings,
      allowedClients: clients
        .split('\n')
        .map((c) => c.trim())
        .filter(Boolean),
    };
    client.save(next).then(
      (saved) => {
        setSettings(saved);
        setStatus(t('mcp.saved'));
      },
      () => setProblem(t('mcp.saveFailed')),
    );
  };

  return (
    <section className="page admin-page mcp-page" aria-labelledby={`${id}-title`}>
      {header}
      <form
        className="glass-card people-card people-form"
        aria-label={t('mcp.formLabel')}
        onSubmit={submit}
      >
        <div className="form-field form-field-inline">
          <input
            id={`${id}-enabled`}
            type="checkbox"
            checked={settings.enabled}
            onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })}
          />
          <label htmlFor={`${id}-enabled`}>{t('mcp.enabled')}</label>
        </div>
        <div className="form-field form-field-inline">
          <input
            id={`${id}-oauth`}
            type="checkbox"
            checked={settings.oauthRegistration}
            aria-describedby={`${id}-oauth-hint`}
            onChange={(event) =>
              setSettings({ ...settings, oauthRegistration: event.target.checked })
            }
          />
          <label htmlFor={`${id}-oauth`}>{t('mcp.oauthRegistration')}</label>
        </div>
        <p id={`${id}-oauth-hint`} className="form-hint">
          {t('mcp.oauthRegistrationHint')}
        </p>
        <fieldset className="form-field">
          <legend className="form-label">{t('mcp.profile')}</legend>
          {PROFILES.map((p) => (
            <label key={p.id} className="form-field form-field-inline">
              <input
                type="radio"
                name={`${id}-profile`}
                value={p.id}
                checked={settings.profile === p.id}
                onChange={() => setSettings({ ...settings, profile: p.id })}
              />
              <span>
                <strong>{t(p.label)}</strong> {t(p.hint)}
              </span>
            </label>
          ))}
        </fieldset>
        <div className="form-field">
          <label htmlFor={`${id}-clients`} className="form-label">
            {t('mcp.clients')}
          </label>
          <textarea
            id={`${id}-clients`}
            rows={4}
            value={clients}
            aria-describedby={`${id}-clients-hint`}
            onChange={(event) => setClients(event.target.value)}
          />
          <p id={`${id}-clients-hint`} className="form-hint">
            {t('mcp.clientsHint')}
          </p>
        </div>
        <div className="form-actions">
          <button type="submit" className="button-primary">
            {t('mcp.save')}
          </button>
        </div>
        <p role="status" className="form-status">
          {status}
        </p>
        {problem && (
          <p role="alert" className="form-error">
            {problem}
          </p>
        )}
      </form>
      <section aria-labelledby={`${id}-connect`} className="glass-card account-section">
        <h2 id={`${id}-connect`} className="facts-title">
          {t('mcp.connect')}
        </h2>
        <p className="page-note">{t('mcp.connectHttp')}</p>
        <pre className="mcp-snippet">
          <code>
            <BreakAtSlashes text={`${origin}/api/v1/mcp\nAuthorization: Bearer <token>`} />
          </code>
        </pre>
        <p className="page-note">{t('mcp.connectStdio')}</p>
        {/* Breaks at its spaces and after a '/', never inside the host or the port (AD-35), nor
            between TASKMOOR_TOKEN= and <token>, where Chromium would otherwise break a line. */}
        <pre className="mcp-snippet">
          <code>
            <BreakAtSlashes text={`TASKMOOR_URL=${origin} `} />
            <span className="mcp-word">TASKMOOR_TOKEN=&lt;token&gt;</span>
            {' node cli.mjs mcp'}
          </code>
        </pre>
      </section>
    </section>
  );
}
