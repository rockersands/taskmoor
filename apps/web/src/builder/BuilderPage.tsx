import {
  AI_PROVIDERS,
  type GeneratedSecrets,
  type InputProblem,
  type KitOutput,
  LANGUAGES,
  loadProject,
  MIN_SEED_LENGTH,
  ProjectError,
  projectKeepsSecrets,
  runSecrets,
  saveProject,
  utf8,
  type WebFiles,
} from '@taskmoor/builder-core';
import { type ChangeEvent, type FormEvent, useEffect, useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { PasswordField } from '../session/PasswordField';
import { PageHeader } from '../shell/PageHeader';
import {
  type BuilderForm,
  checkForm,
  EMPTY_FORM,
  type FieldName,
  fieldOf,
  formFrom,
  formUserSecrets,
} from './form';
import {
  blobUrl,
  generateKits,
  OUTPUT_ORDER,
  OUTPUT_TYPES,
  outputName,
  saveFile,
  sha256Hex,
} from './generate';

export const PROJECT_FILE_NAME = 'taskmoor-project.json';

export interface BuilderPageProps {
  /** The web build the kits are made from: the one the page carries. */
  web: WebFiles;
  /** The version of that build; the kits are for it. */
  version: string;
  /** The form to start with; empty by default. */
  initialForm?: BuilderForm;
}

interface Download {
  key: KitOutput;
  name: string;
  url: string;
  sha256: string;
  size: number;
}

type Notice = { tone: 'error' | 'info'; id: MessageId; values?: Record<string, string> };

const PROBLEM_MESSAGES: Record<InputProblem['code'], MessageId> = {
  invalid: 'builder.problem.invalid',
  not_a_url: 'builder.problem.notAUrl',
  insecure_url: 'builder.problem.insecureUrl',
  has_path: 'builder.problem.hasPath',
  has_query: 'builder.problem.hasQuery',
  not_a_directory: 'builder.problem.notADirectory',
};

/** Fields whose "not valid" has a message of its own. */
const INVALID_MESSAGES: Partial<Record<FieldName, MessageId>> = {
  smtpHost: 'builder.problem.smtpHost',
  smtpPort: 'builder.problem.smtpPort',
  instanceName: 'builder.problem.instanceName',
};

const PROJECT_ERRORS: Record<ProjectError['code'], MessageId> = {
  not_a_project: 'builder.project.notAProject',
  invalid_inputs: 'builder.project.invalidInputs',
  wrong_passphrase: 'builder.project.wrongPassphrase',
};

const PROVIDER_NAMES: Record<(typeof AI_PROVIDERS)[number], MessageId> = {
  anthropic: 'builder.ai.anthropic',
  bedrock: 'builder.ai.bedrock',
  vertex: 'builder.ai.vertex',
  foundry: 'builder.ai.foundry',
  'openai-compatible': 'builder.ai.openaiCompatible',
};

const LANGUAGE_NAMES: Record<(typeof LANGUAGES)[number], MessageId> = {
  en: 'builder.language.en',
  es: 'builder.language.es',
};

const OUTPUT_LABELS: Record<KitOutput, MessageId> = {
  backend: 'builder.result.backend',
  frontend: 'builder.result.frontend',
  single: 'builder.result.single',
};

/**
 * The Taskmoor Builder page (M1-112; OPS-014 to OPS-016, spec 05b section 1.2): the form of a
 * new install, checked by the Builder core, and both kits made in this browser. It runs from
 * one static file with no network: secrets come from the browser's generator, the zips are
 * built here and handed out through Blob URLs, and a project file saves the form (with the
 * secrets too, under a passphrase) so the same kits can be made again.
 */
export function BuilderPage({ web, version, initialForm = EMPTY_FORM }: BuilderPageProps) {
  const t = useT();
  const id = useId();
  const [form, setForm] = useState<BuilderForm>(initialForm);
  const [problems, setProblems] = useState<InputProblem[]>([]);
  const [secrets, setSecrets] = useState<GeneratedSecrets | null>(null);
  const [seed, setSeed] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState<'generating' | 'saving' | 'loading' | null>(null);
  const [downloads, setDownloads] = useState<Download[]>([]);
  const [notice, setNotice] = useState<Notice | null>(null);

  // Blob URLs live until they are replaced or the page goes.
  useEffect(
    () => () => {
      for (const d of downloads) URL.revokeObjectURL(d.url);
    },
    [downloads],
  );

  const field = (name: string) => `${id}-${name}`;
  const set = <K extends keyof BuilderForm>(key: K, value: BuilderForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setDownloads([]);
  };
  const text = (key: keyof BuilderForm) => (e: ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    set(key, e.target.value as never);

  const problemFor = (name: FieldName) => problems.find((p) => fieldOf(p) === name);
  const problemText = (p: InputProblem) =>
    t(
      p.code === 'invalid'
        ? (INVALID_MESSAGES[fieldOf(p)] ?? PROBLEM_MESSAGES.invalid)
        : PROBLEM_MESSAGES[p.code],
    );
  const invalid = (name: FieldName) =>
    problemFor(name)
      ? { 'aria-invalid': true as const, 'aria-describedby': field(`${name}-problem`) }
      : {};
  const problemLine = (name: FieldName) => {
    const p = problemFor(name);
    return p ? (
      <p className="form-hint builder-problem" id={field(`${name}-problem`)}>
        {problemText(p)}
      </p>
    ) : null;
  };

  const seedProblem = seed !== '' && seed.length < MIN_SEED_LENGTH;

  /** The checked inputs, or null with the problems shown. */
  const checked = () => {
    const result = checkForm(form);
    setProblems(result.ok ? [] : result.problems);
    if (!result.ok) {
      setNotice({ tone: 'error', id: 'builder.problemsIntro' });
      return null;
    }
    if (seedProblem) {
      setNotice({ tone: 'error', id: 'builder.seed.tooShort' });
      return null;
    }
    return result.inputs;
  };

  const generate = async (event: FormEvent) => {
    event.preventDefault();
    const inputs = checked();
    if (!inputs) return;
    setBusy('generating');
    setNotice(null);
    try {
      const result = await generateKits({
        inputs,
        user: formUserSecrets(form),
        secrets,
        seed,
        web,
        version,
      });
      setSecrets(result.secrets);
      setDownloads(
        await Promise.all(
          OUTPUT_ORDER.map(async (key) => {
            const bytes = result.outputs[key];
            return {
              key,
              name: outputName(key),
              url: blobUrl(bytes, OUTPUT_TYPES[key]),
              sha256: await sha256Hex(bytes),
              size: bytes.length,
            };
          }),
        ),
      );
      setNotice({ tone: 'info', id: 'builder.generated' });
    } catch {
      setNotice({ tone: 'error', id: 'builder.failed' });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    const inputs = checked();
    if (!inputs) return;
    setBusy('saving');
    try {
      let kept = secrets;
      if (passphrase && !kept) {
        // The project keeps the instance's secrets: the same ones the next kits get.
        kept = await runSecrets(null, seed || undefined);
        setSecrets(kept);
      }
      const project = await saveProject(inputs, {
        builderVersion: version,
        ...(passphrase && kept
          ? { passphrase, secrets: { generated: kept, user: formUserSecrets(form) } }
          : {}),
      });
      saveFile(PROJECT_FILE_NAME, utf8(project), 'application/json');
      setNotice({
        tone: 'info',
        id: passphrase ? 'builder.project.savedWithSecrets' : 'builder.project.saved',
      });
    } catch {
      setNotice({ tone: 'error', id: 'builder.failed' });
    } finally {
      setBusy(null);
    }
  };

  const load = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy('loading');
    try {
      const content = await file.text();
      const keeps = projectKeepsSecrets(content);
      const project = await loadProject(content, keeps && passphrase ? passphrase : undefined);
      setForm(formFrom(project.inputs, project.secrets?.user));
      setSecrets(project.secrets?.generated ?? null);
      setProblems([]);
      setDownloads([]);
      setNotice(
        keeps && !project.secrets
          ? { tone: 'info', id: 'builder.project.locked', values: { name: file.name } }
          : { tone: 'info', id: 'builder.project.loaded', values: { name: file.name } },
      );
    } catch (e) {
      setNotice({
        tone: 'error',
        id: e instanceof ProjectError ? PROJECT_ERRORS[e.code] : 'builder.project.notAProject',
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="builder">
      <PageHeader title={t('builder.title')} purpose={t('builder.intro')} />
      <p className="form-hint">{t('builder.version', { version })}</p>

      <form className="form builder-form" onSubmit={generate} aria-label={t('builder.formName')}>
        <fieldset>
          <legend>{t('builder.project.title')}</legend>
          <p className="form-hint">{t('builder.project.hint')}</p>
          <PasswordField
            label={t('builder.project.passphrase')}
            toggleLabel={t('builder.project.showPassphrase')}
            hint={t('builder.project.passphraseHint')}
            autoComplete="new-password"
            required={false}
            value={passphrase}
            onChange={setPassphrase}
          />
          <div className="form-actions builder-file-actions">
            <input
              id={field('project-file')}
              className="builder-file-input"
              type="file"
              accept=".json,application/json"
              onChange={load}
              disabled={busy !== null}
            />
            <label className="button-secondary builder-file" htmlFor={field('project-file')}>
              {t('builder.project.load')}
            </label>
            <button
              type="button"
              className="button-secondary"
              onClick={save}
              disabled={busy !== null}
            >
              {t('builder.project.save')}
            </button>
          </div>
        </fieldset>

        <fieldset>
          <legend>{t('builder.addresses')}</legend>
          <div className="form-field">
            <label htmlFor={field('backend')}>{t('builder.backendUrl')}</label>
            <input
              id={field('backend')}
              type="url"
              inputMode="url"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={form.backendUrl}
              onChange={text('backendUrl')}
              aria-describedby={field('backend-hint')}
              {...invalid('backendUrl')}
            />
            <p className="form-hint" id={field('backend-hint')}>
              {t('builder.backendUrlHint')}
            </p>
            {problemLine('backendUrl')}
          </div>
          <div className="form-field">
            <label htmlFor={field('frontend')}>{t('builder.frontendUrl')}</label>
            <input
              id={field('frontend')}
              type="url"
              inputMode="url"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={form.frontendUrl}
              onChange={text('frontendUrl')}
              aria-describedby={field('frontend-hint')}
              {...invalid('frontendUrl')}
            />
            <p className="form-hint" id={field('frontend-hint')}>
              {t('builder.frontendUrlHint')}
            </p>
            {problemLine('frontendUrl')}
          </div>
        </fieldset>

        <fieldset>
          <legend>{t('builder.instance')}</legend>
          <div className="form-field">
            <label htmlFor={field('name')}>{t('builder.instanceName')}</label>
            <input
              id={field('name')}
              maxLength={100}
              value={form.instanceName}
              onChange={text('instanceName')}
              {...invalid('instanceName')}
            />
            {problemLine('instanceName')}
          </div>
          <div className="form-field">
            <label htmlFor={field('language')}>{t('builder.defaultLanguage')}</label>
            <select
              id={field('language')}
              value={form.defaultLanguage}
              onChange={text('defaultLanguage')}
            >
              {LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {t(LANGUAGE_NAMES[l])}
                </option>
              ))}
            </select>
          </div>
        </fieldset>

        <fieldset>
          <legend>{t('builder.frontend')}</legend>
          <div className="form-field">
            <label htmlFor={field('routing')}>{t('builder.routing')}</label>
            <select
              id={field('routing')}
              value={form.routing}
              onChange={text('routing')}
              aria-describedby={field('routing-hint')}
            >
              <option value="path">{t('builder.routing.path')}</option>
              <option value="hash">{t('builder.routing.hash')}</option>
            </select>
            <p className="form-hint" id={field('routing-hint')}>
              {t('builder.routingHint')}
            </p>
          </div>
          <div className="form-field">
            <label htmlFor={field('sign-in')}>{t('builder.signIn')}</label>
            <select
              id={field('sign-in')}
              value={form.signIn}
              onChange={text('signIn')}
              aria-describedby={field('sign-in-hint')}
            >
              <option value="auto">{t('builder.signIn.auto')}</option>
              <option value="session">{t('builder.signIn.session')}</option>
              <option value="oauth">{t('builder.signIn.oauth')}</option>
            </select>
            <p className="form-hint" id={field('sign-in-hint')}>
              {t('builder.signInHint')}
            </p>
          </div>
        </fieldset>

        <fieldset>
          <legend>{t('builder.backend')}</legend>
          <div className="form-field">
            <label htmlFor={field('target')}>{t('builder.target')}</label>
            <select id={field('target')} value={form.target} onChange={text('target')}>
              <option value="compose">{t('builder.target.compose')}</option>
              <option value="helm">{t('builder.target.helm')}</option>
            </select>
          </div>
          <div className="form-field form-field-inline">
            <input
              id={field('with-smtp')}
              type="checkbox"
              checked={form.withSmtp}
              onChange={(e) => set('withSmtp', e.target.checked)}
            />
            <label htmlFor={field('with-smtp')}>{t('builder.withSmtp')}</label>
          </div>
          {form.withSmtp && (
            <>
              <div className="form-field">
                <label htmlFor={field('smtp-host')}>{t('builder.smtpHost')}</label>
                <input
                  id={field('smtp-host')}
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                  value={form.smtpHost}
                  onChange={text('smtpHost')}
                  {...invalid('smtpHost')}
                />
                {problemLine('smtpHost')}
              </div>
              <div className="form-field">
                <label htmlFor={field('smtp-port')}>{t('builder.smtpPort')}</label>
                <input
                  id={field('smtp-port')}
                  inputMode="numeric"
                  required
                  value={form.smtpPort}
                  onChange={text('smtpPort')}
                  {...invalid('smtpPort')}
                />
                {problemLine('smtpPort')}
              </div>
              <div className="form-field">
                <label htmlFor={field('smtp-user')}>{t('builder.smtpUser')}</label>
                <input
                  id={field('smtp-user')}
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  value={form.smtpUser}
                  onChange={text('smtpUser')}
                  {...invalid('smtpUser')}
                />
                {problemLine('smtpUser')}
              </div>
              <PasswordField
                label={t('builder.smtpPassword')}
                toggleLabel={t('builder.showSmtpPassword')}
                autoComplete="new-password"
                required={false}
                value={form.smtpPassword}
                onChange={(v) => set('smtpPassword', v)}
              />
              <div className="form-field">
                <label htmlFor={field('smtp-from')}>{t('builder.smtpFrom')}</label>
                <input
                  id={field('smtp-from')}
                  type="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={form.smtpFrom}
                  onChange={text('smtpFrom')}
                  {...invalid('smtpFrom')}
                />
                {problemLine('smtpFrom')}
              </div>
            </>
          )}
          <div className="form-field">
            <label htmlFor={field('ai')}>{t('builder.aiProvider')}</label>
            <select id={field('ai')} value={form.aiProvider} onChange={text('aiProvider')}>
              <option value="">{t('builder.ai.none')}</option>
              {AI_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {t(PROVIDER_NAMES[p])}
                </option>
              ))}
            </select>
          </div>
          {form.aiProvider !== '' && (
            <PasswordField
              label={t('builder.aiKey')}
              toggleLabel={t('builder.showAiKey')}
              hint={t('builder.aiKeyHint')}
              autoComplete="new-password"
              required={false}
              value={form.aiKey}
              onChange={(v) => set('aiKey', v)}
            />
          )}
          <p className="form-hint">{t('builder.secretsHint')}</p>
        </fieldset>

        <details className="glass-card builder-advanced">
          <summary>{t('builder.advanced')}</summary>
          <div className="form-field">
            <label htmlFor={field('seed')}>{t('builder.seed')}</label>
            <input
              id={field('seed')}
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              value={seed}
              onChange={(e) => {
                setSeed(e.target.value);
                setSecrets(null);
                setDownloads([]);
              }}
              aria-describedby={field('seed-hint')}
              {...(seedProblem ? { 'aria-invalid': true } : {})}
            />
            <p className="form-hint" id={field('seed-hint')}>
              {t('builder.seedHint', { min: String(MIN_SEED_LENGTH) })}
            </p>
          </div>
        </details>

        {notice?.tone === 'error' && (
          <div className="form-error" role="alert">
            <p>{t(notice.id, notice.values)}</p>
            {problems.length > 0 && (
              <ul>
                {problems.map((p) => (
                  <li key={`${p.field}-${p.code}`}>{problemText(p)}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        <p className="form-status" role="status">
          {busy === 'generating'
            ? t('builder.generating')
            : busy === 'loading'
              ? t('builder.project.loading')
              : notice?.tone === 'info'
                ? t(notice.id, notice.values)
                : ''}
        </p>

        <div className="form-actions">
          <button type="submit" className="button-primary" disabled={busy !== null}>
            {t('builder.generate')}
          </button>
        </div>
      </form>

      {downloads.length > 0 && (
        <section className="glass-card builder-results" aria-labelledby={field('results')}>
          <h2 id={field('results')}>{t('builder.results')}</h2>
          <p className="form-hint">{t('builder.resultsHint')}</p>
          <ul>
            {downloads.map((d) => (
              <li key={d.key}>
                <a className="button-secondary builder-download" href={d.url} download={d.name}>
                  {t(OUTPUT_LABELS[d.key])}
                </a>
                <span className="builder-file-name">
                  <code>{d.name}</code>
                  {t('builder.result.size', { kb: String(Math.max(1, Math.ceil(d.size / 1024))) })}
                </span>
                <span className="builder-hash">
                  {t('builder.result.sha256')} <code>{d.sha256}</code>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
