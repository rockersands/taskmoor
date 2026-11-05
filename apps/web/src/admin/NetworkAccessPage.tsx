import { type FormEvent, useEffect, useId, useState } from 'react';
import { ApiError, api } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { peopleClient } from '../people/client';
import { useSession } from '../session/SessionProvider';
import { PageHeader } from '../shell/PageHeader';

/** The IP allowlist as `GET /api/v1/admin/ip-allowlist` answers (M1-085; IAM-015). */
export interface AllowlistView {
  allowlist: {
    enabled: boolean;
    exemptGroups: { id: number; name: string }[];
    entries: { id?: number; range: string; note: string }[];
  };
  yourAddress: string;
  yourAddressAllowed: boolean;
}

export interface AllowlistSave {
  enabled: boolean;
  exemptGroupIds: number[];
  entries: { range: string; note: string }[];
  confirmLockout?: boolean;
}

export interface NetworkAccessClient {
  load: () => Promise<AllowlistView>;
  save: (list: AllowlistSave) => Promise<AllowlistView>;
  groups: () => Promise<{ id: number; name: string }[]>;
}

export const networkAccessClient: NetworkAccessClient = {
  load: () => api('/admin/ip-allowlist'),
  save: (list) => api('/admin/ip-allowlist', { method: 'PUT', body: list }),
  groups: async () => (await peopleClient.groups('')).map((g) => ({ id: g.id, name: g.name })),
};

/** Entries as typed: one per line, an address or a range, then an optional note after `#`. */
export function parseEntries(text: string): { range: string; note: string }[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const hash = line.indexOf('#');
      return hash < 0
        ? { range: line, note: '' }
        : { range: line.slice(0, hash).trim(), note: line.slice(hash + 1).trim() };
    });
}

const formatEntries = (entries: AllowlistView['allowlist']['entries']) =>
  entries.map((e) => (e.note ? `${e.range} # ${e.note}` : e.range)).join('\n');

type Problem = 'lockout' | 'invalid' | 'failed' | null;

/**
 * Who may connect, by address (M1-085; IAM-015): the list of addresses and ranges, the groups
 * whose members connect from anywhere, and a switch. Saving a list that would leave you outside
 * asks you to confirm first.
 */
export function NetworkAccessPage({
  client = networkAccessClient,
}: {
  client?: NetworkAccessClient;
}) {
  const t = useT();
  const { session } = useSession();
  const titleId = useId();
  const id = useId();
  const notAdmin = session.status === 'signed-in' && !session.user.isSiteAdmin;
  const [view, setView] = useState<AllowlistView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [groups, setGroups] = useState<{ id: number; name: string }[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [text, setText] = useState('');
  const [exempt, setExempt] = useState<number[]>([]);
  const [problem, setProblem] = useState<Problem>(null);
  const [invalidLines, setInvalidLines] = useState<number[]>([]);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (notAdmin) return;
    let live = true;
    client.load().then(
      (found) => {
        if (!live) return;
        setView(found);
        setEnabled(found.allowlist.enabled);
        setText(formatEntries(found.allowlist.entries));
        setExempt(found.allowlist.exemptGroups.map((g) => g.id));
      },
      () => live && setLoadFailed(true),
    );
    client.groups().then(
      (found) => live && setGroups(found),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client, notAdmin]);

  const save = async (confirmLockout: boolean) => {
    setBusy(true);
    setSaved(false);
    setProblem(null);
    setInvalidLines([]);
    try {
      const next = await client.save({
        enabled,
        exemptGroupIds: exempt,
        entries: parseEntries(text),
        ...(confirmLockout ? { confirmLockout: true } : {}),
      });
      setView(next);
      setText(formatEntries(next.allowlist.entries));
      setSaved(true);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setProblem('lockout');
      else if (error instanceof ApiError && error.status === 400) {
        const fields = (error.body as { fields?: Record<string, string> }).fields ?? {};
        setInvalidLines(
          Object.keys(fields)
            .map((k) => /^entries\.(\d+)\.range$/.exec(k)?.[1])
            .filter((n): n is string => n !== undefined)
            .map((n) => Number(n) + 1),
        );
        setProblem('invalid');
      } else setProblem('failed');
    } finally {
      setBusy(false);
    }
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save(false);
  };

  return (
    <section aria-labelledby={titleId} className="page network-page">
      <PageHeader
        titleId={titleId}
        title={t('admin.network.title')}
        {...(notAdmin
          ? {}
          : { purpose: t('settings.networkAccessHint'), about: t('admin.network.intro') })}
      />
      {notAdmin ? (
        <p className="page-note">{t('admin.network.forbidden')}</p>
      ) : loadFailed ? (
        <p role="alert" className="form-error">
          {t('admin.network.loadFailed')}
        </p>
      ) : !view ? (
        <p role="status" className="page-note">
          {t('admin.network.loading')}
        </p>
      ) : (
        <form className="form glass-card account-section network-form" onSubmit={submit}>
          <p className={view.yourAddressAllowed ? 'page-note' : 'page-note status-warn'}>
            {t(view.yourAddressAllowed ? 'admin.network.youAreIn' : 'admin.network.youAreOut', {
              address: view.yourAddress,
            })}
          </p>
          <div className="form-field form-field-inline">
            <input
              id={`${id}-enabled`}
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            <label htmlFor={`${id}-enabled`}>{t('admin.network.enabled')}</label>
          </div>
          <div className="form-field">
            <label htmlFor={`${id}-entries`}>{t('admin.network.entries')}</label>
            <textarea
              id={`${id}-entries`}
              rows={8}
              value={text}
              spellCheck={false}
              aria-describedby={`${id}-entries-hint`}
              aria-invalid={invalidLines.length > 0 || undefined}
              onChange={(e) => setText(e.target.value)}
            />
            <p id={`${id}-entries-hint`} className="form-hint">
              {t('admin.network.entriesHint')}
            </p>
          </div>
          <fieldset>
            <legend>{t('admin.network.exempt')}</legend>
            <p className="form-hint">{t('admin.network.exemptHint')}</p>
            {groups.length === 0 ? (
              <p className="form-hint">{t('admin.network.noGroups')}</p>
            ) : (
              groups.map((group) => (
                <div key={group.id} className="form-field form-field-inline">
                  <input
                    id={`${id}-group-${group.id}`}
                    type="checkbox"
                    checked={exempt.includes(group.id)}
                    onChange={(e) =>
                      setExempt(
                        e.target.checked
                          ? [...exempt, group.id]
                          : exempt.filter((g) => g !== group.id),
                      )
                    }
                  />
                  <label htmlFor={`${id}-group-${group.id}`}>
                    {t('common.value', { value: group.name })}
                  </label>
                </div>
              ))
            )}
          </fieldset>
          {problem === 'lockout' && (
            <div role="alert" className="form-error">
              <p>{t('admin.network.lockout', { address: view.yourAddress })}</p>
              <button
                type="button"
                className="button-danger"
                disabled={busy}
                onClick={() => void save(true)}
              >
                {t('admin.network.saveAnyway')}
              </button>
            </div>
          )}
          {problem === 'invalid' && (
            <p role="alert" className="form-error">
              {t('admin.network.invalid', { lines: invalidLines.join(', ') })}
            </p>
          )}
          {problem === 'failed' && (
            <p role="alert" className="form-error">
              {t('admin.network.failed')}
            </p>
          )}
          {saved && (
            <p role="status" className="form-status">
              {t('admin.network.saved')}
            </p>
          )}
          <div className="form-actions">
            <button type="submit" className="button-primary" disabled={busy}>
              {t('admin.network.save')}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
