import { useEffect, useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { navigate } from '../routing/router';
import type { Plan, PlanClient, PlanShare, PlanSourceInput, SourceOptions } from './client';
import { SourcePicker } from './SourcePicker';

type Visibility = 'private' | 'any_user' | 'custom';

/** The page's choice of who sees a plan; other shares are kept as they are. */
function visibilityOf(shares: readonly PlanShare[]): Visibility {
  if (shares.length === 0) return 'private';
  if (shares.length === 1 && shares[0]?.scope === 'any_user') return 'any_user';
  return 'custom';
}

const inputOf = (plan: Plan): PlanSourceInput[] =>
  plan.sources.map((s) =>
    s.kind === 'track'
      ? { kind: 'track', trackId: s.id }
      : { kind: 'savedSearch', savedSearchId: s.id },
  );

export interface PlanSettingsPageProps {
  plan: Plan;
  client: PlanClient;
  onSaved: () => void;
}

/**
 * A plan's settings (PLN-001), for its owner and site administrators: its name, description,
 * sources and who sees it, and deleting it. The sources hidden from the editor stay as they are:
 * nobody removes what they cannot see. Sharing needs "Share dashboards and saved searches".
 */
export function PlanSettingsPage({ plan, client, onSaved }: PlanSettingsPageProps) {
  const t = useT();
  const id = useId();
  const [name, setName] = useState(plan.name);
  const [description, setDescription] = useState(plan.description);
  const [sources, setSources] = useState<PlanSourceInput[]>(() => inputOf(plan));
  const [visibility, setVisibility] = useState<Visibility>(() => visibilityOf(plan.shares));
  const [options, setOptions] = useState<SourceOptions | null>(null);
  const [status, setStatus] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [optionsFailed, setOptionsFailed] = useState(false);

  // Read once per plan, not again for each version saved.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per plan, not per version
  useEffect(() => {
    let live = true;
    client.sourceOptions().then(
      (o) => {
        if (!live) return;
        // A source the plan has that the directory did not list still shows, ticked.
        const tracks = [...o.tracks];
        const searches = [...o.savedSearches];
        for (const s of plan.sources) {
          if (s.kind === 'track' && !tracks.some((x) => x.id === s.id)) {
            tracks.push({ id: s.id, key: s.key, name: s.name });
          }
          if (s.kind === 'savedSearch' && !searches.some((x) => x.id === s.id)) {
            searches.push({ id: s.id, name: s.name });
          }
        }
        setOptions({ tracks, savedSearches: searches });
      },
      () => live && setOptionsFailed(true),
    );
    return () => {
      live = false;
    };
  }, [client, plan.id]);

  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setProblem(null);
    setStatus('');
    const saved = await client.update(plan.id, {
      name: name.trim(),
      description,
      sources,
      ...(visibility === 'custom'
        ? {}
        : { shares: visibility === 'private' ? [] : [{ scope: 'any_user' as const }] }),
      version: plan.version,
    });
    setBusy(false);
    if (saved.ok) {
      setStatus(t('plans.settings.saved'));
      onSaved();
      return;
    }
    setProblem(
      saved.error === 'version_conflict'
        ? t('plans.settings.conflict')
        : saved.error === 'forbidden'
          ? t('plans.settings.mayNotShare')
          : Object.values(saved.fields).includes('not_found')
            ? t('plans.create.sourceGone')
            : t('plans.settings.failed'),
    );
  };

  const remove = async () => {
    if (!window.confirm(t('plans.settings.confirmDelete', { name: plan.name }))) return;
    await client.remove(plan.id);
    navigate('#/plans');
  };

  return (
    <form
      className="plan-settings"
      aria-label={t('plans.section.settings')}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="form-field">
        <label htmlFor={`${id}-name`}>{t('plans.name')}</label>
        <input
          id={`${id}-name`}
          value={name}
          maxLength={255}
          required
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="form-field">
        <label htmlFor={`${id}-description`}>{t('plans.description')}</label>
        <textarea
          id={`${id}-description`}
          value={description}
          maxLength={4000}
          rows={3}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      {optionsFailed ? (
        <p className="board-problem" role="alert">
          {t('plans.sources.failed')}
        </p>
      ) : (
        <SourcePicker options={options} value={sources} onChange={setSources} />
      )}
      {plan.hiddenSources > 0 && (
        <p className="board-hint">
          {t('plans.settings.hiddenKept', { count: plan.hiddenSources })}
        </p>
      )}
      <div className="form-field">
        <label htmlFor={`${id}-visibility`}>{t('plans.visibility')}</label>
        <select
          id={`${id}-visibility`}
          value={visibility}
          onChange={(event) => setVisibility(event.target.value as Visibility)}
        >
          <option value="private">{t('plans.visibility.private')}</option>
          <option value="any_user">{t('plans.visibility.any_user')}</option>
          {visibilityOf(plan.shares) === 'custom' && (
            <option value="custom">{t('plans.visibility.custom')}</option>
          )}
        </select>
      </div>
      <p className="board-hint" role="status">
        {status}
      </p>
      {problem && (
        <p className="board-problem" role="alert">
          {problem}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={busy || !name.trim()}>
          {t('plans.settings.save')}
        </button>
        <button type="button" className="button-secondary" onClick={() => void remove()}>
          {t('plans.settings.delete')}
        </button>
      </div>
    </form>
  );
}
