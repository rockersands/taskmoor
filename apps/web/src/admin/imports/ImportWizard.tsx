import { type FormEvent, useEffect, useId, useState } from 'react';
import { useIntl } from 'react-intl';
import { ApiError } from '../../api/client';
import { useT } from '../../i18n/I18nProvider';
import type { MessageId } from '../../i18n/messages.en';
import type {
  FidelityReport,
  FilesView,
  ImportRecord,
  ImportRunView,
  ImportsClient,
  StartImport,
} from './client';
import { ImportRunPanel } from './ImportRunPanel';
import { formatLabel } from './labels';
import { PeopleMapping } from './PeopleMapping';

type Format = 'dc-backup' | 'taskmoor' | 'csv' | 'cloud-rest';
const WIZARD_FORMATS: readonly Format[] = ['dc-backup', 'taskmoor', 'csv', 'cloud-rest'];
const SCOPES = ['all', 'tickets', 'configuration'] as const;
const ADMINS = ['site_admin', 'configuration_admin'] as const;
/** People a dry run lists for mapping; the rest go by address. */
const PEOPLE_LIMIT = 500;

/** What the server's refusal of a start means, in words. */
function startProblem(error: unknown): MessageId {
  const code = error instanceof ApiError ? error.code : undefined;
  switch (code) {
    case 'not_found':
      return 'admin.imports.problem.notFound';
    case 'outside_import_folder':
    case 'no_import_folder':
      return 'admin.imports.problem.folder';
    case 'invalid_source':
      return 'admin.imports.problem.invalidSource';
    case 'mapping_required':
    case 'unknown_mapping_run':
      return 'admin.imports.problem.mapping';
    case 'invalid_people_mapping':
      return 'admin.imports.problem.people';
    case 'run_in_progress':
      return 'admin.imports.problem.busy';
    case 'delta_source_mismatch':
    case 'delta_from_dry_run':
    case 'delta_from_unfinished':
    case 'delta_not_supported':
    case 'unknown_delta_run':
      return 'admin.imports.problem.delta';
    case 'invalid_fields':
      return 'admin.imports.problem.fields';
    case 'forbidden':
      return 'admin.imports.problem.forbidden';
    default:
      return 'admin.imports.problem.failed';
  }
}

function uploadProblem(error: unknown): MessageId {
  const code = error instanceof ApiError ? error.code : undefined;
  if (code === 'file_exists') return 'admin.imports.upload.exists';
  if (code === 'invalid_name') return 'admin.imports.upload.invalidName';
  if (code === 'too_large') return 'admin.imports.upload.tooLarge';
  return 'admin.imports.upload.failed';
}

/**
 * The import wizard (M1-097; IMP-007, IMP-009, IMP-013): choose a source (a Data Center
 * backup, a Taskmoor export or a CSV file in the imports folder, uploaded here or copied there
 * on the server, or a Cloud site with its own API token), set its options, run a dry run, map
 * the people it found to people here, then run the import and follow it to its report. Given an
 * earlier run (`delta`), it starts a delta run from it: only what changed since.
 */
export function ImportWizard({
  client,
  delta = null,
  pollMs,
  onStarted,
  onDone,
}: {
  client: ImportsClient;
  delta?: ImportRunView | null;
  pollMs?: number;
  onStarted?: (run: ImportRunView) => void;
  onDone?: () => void;
}) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const fixed = delta ? (delta.importSource as Format) : null;
  const [format, setFormat] = useState<Format>(fixed ?? 'dc-backup');
  const [files, setFiles] = useState<FilesView | null>(null);
  const [filesFailed, setFilesFailed] = useState(false);
  const [path, setPath] = useState('');
  const [upload, setUpload] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadNote, setUploadNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [projects, setProjects] = useState('');
  const [name, setName] = useState(
    delta ? t('admin.imports.wizard.deltaName', { id: delta.id }) : '',
  );
  const [scope, setScope] = useState<(typeof SCOPES)[number]>('all');
  const [admins, setAdmins] = useState<(typeof ADMINS)[number]>('site_admin');
  const [mapping, setMapping] = useState('');
  const [people, setPeople] = useState<ImportRecord[] | null>(null);
  const [morePeople, setMorePeople] = useState(false);
  const [peopleMap, setPeopleMap] = useState<Record<string, string>>({});
  const [current, setCurrent] = useState<{ id: number; dryRun: boolean } | null>(null);
  const [finished, setFinished] = useState<{ dryRun: boolean; ok: boolean } | null>(null);
  const [problem, setProblem] = useState<MessageId | null>(null);
  const [busy, setBusy] = useState(false);

  const fileFormat = format !== 'cloud-rest';
  const needsFile = fileFormat && !(fixed === 'cloud-rest');
  const cloudDelta = fixed === 'cloud-rest';

  const loadFiles = async (select?: string) => {
    try {
      const found = await client.files();
      setFiles(found);
      setFilesFailed(false);
      if (select) setPath(select);
    } catch {
      setFilesFailed(true);
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: loads once per client
  useEffect(() => {
    void loadFiles();
  }, [client]);

  const offered = (files?.files ?? []).filter((f) =>
    format === 'csv'
      ? f.kind === 'csv'
      : f.kind === format || (f.kind === null && format !== 'taskmoor'),
  );

  const doUpload = async () => {
    if (!upload) return;
    setUploading(true);
    setUploadNote(null);
    try {
      const saved = await client.upload(upload);
      setUploadNote({ ok: true, text: t('admin.imports.upload.done', { name: saved.name }) });
      setUpload(null);
      if (saved.kind && saved.kind !== format && WIZARD_FORMATS.includes(saved.kind) && !fixed) {
        setFormat(saved.kind);
      }
      await loadFiles(saved.name);
    } catch (error) {
      setUploadNote({ ok: false, text: t(uploadProblem(error)) });
    } finally {
      setUploading(false);
    }
  };

  const rows = Object.entries(peopleMap)
    .map(([source, target]) => ({ source, target: target.trim().toLowerCase() }))
    .filter((r) => r.target !== '');
  const peopleSetting = rows.length > 0 ? { people: { mode: 'map', rows } } : {};

  /** The body of the start request, or the problem with the form. */
  const request = (dryRun: boolean): StartImport | MessageId => {
    const base = {
      ...(name.trim() ? { name: name.trim() } : {}),
      dryRun,
      ...(delta ? { deltaFrom: delta.id } : {}),
    };
    if (cloudDelta) return base;
    if (needsFile && !path) return 'admin.imports.problem.chooseFile';
    switch (format) {
      case 'dc-backup':
        return {
          ...base,
          source: { format, path, scope, systemAdmins: admins, ...peopleSetting },
        };
      case 'taskmoor':
        return { ...base, source: { format, path } };
      case 'csv': {
        let parsed: unknown;
        try {
          parsed = JSON.parse(mapping);
        } catch {
          return 'admin.imports.problem.mappingJson';
        }
        return { ...base, source: { format, path, mapping: parsed } };
      }
      default: {
        if (!baseUrl.trim() || !token) return 'admin.imports.problem.cloud';
        const keys = projects
          .split(',')
          .map((p) => p.trim().toUpperCase())
          .filter(Boolean);
        return {
          ...base,
          source: {
            format: 'cloud-rest',
            baseUrl: baseUrl.trim(),
            token,
            ...(email.trim() ? { email: email.trim() } : {}),
            ...(keys.length > 0 ? { projects: keys } : {}),
            ...peopleSetting,
          },
        };
      }
    }
  };

  const start = async (dryRun: boolean) => {
    const body = request(dryRun);
    if (typeof body === 'string') {
      setProblem(body);
      return;
    }
    setBusy(true);
    setProblem(null);
    setFinished(null);
    try {
      const run = await client.start(body);
      setCurrent({ id: run.id, dryRun: run.dryRun });
      onStarted?.(run);
    } catch (error) {
      setProblem(startProblem(error));
    } finally {
      setBusy(false);
    }
  };

  const finishedRun = async (run: ImportRunView, report: FidelityReport | null) => {
    setFinished({ dryRun: run.dryRun, ok: run.status === 'done' && report !== null });
    if (run.dryRun && run.status === 'done') {
      try {
        const found = await client.records(run.id, { kind: 'user', limit: PEOPLE_LIMIT });
        setPeople(found.records);
        setMorePeople(found.next !== null);
      } catch {
        setPeople([]);
      }
    }
    onDone?.();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void start(true);
  };

  const running = current !== null && finished === null;
  const imported = finished !== null && !finished.dryRun;
  const maxUpload = files?.maxUpload ?? 0;

  return (
    <div className="import-wizard">
      <form className="import-form" onSubmit={submit} aria-labelledby={`${id}-title`}>
        <h2 id={`${id}-title`} className="facts-title">
          {delta
            ? t('admin.imports.wizard.deltaTitle', { id: delta.id })
            : t('admin.imports.wizard.title')}
        </h2>
        <fieldset disabled={running || imported}>
          <legend>{t('admin.imports.wizard.source')}</legend>
          {fixed ? (
            <p className="page-note">
              {t(
                fixed === 'cloud-rest'
                  ? 'admin.imports.wizard.deltaCloud'
                  : 'admin.imports.wizard.deltaBackup',
                { id: delta?.id ?? 0, system: delta?.sourceSystem ?? '' },
              )}
            </p>
          ) : (
            <div
              role="radiogroup"
              aria-label={t('admin.imports.wizard.format')}
              className="import-choices"
            >
              {WIZARD_FORMATS.map((f) => (
                <div key={f} className="form-field form-field-inline">
                  <input
                    id={`${id}-format-${f}`}
                    type="radio"
                    name={`${id}-format`}
                    checked={format === f}
                    onChange={() => {
                      setFormat(f);
                      setPath('');
                    }}
                  />
                  <label htmlFor={`${id}-format-${f}`}>{t(formatLabel(f))}</label>
                </div>
              ))}
            </div>
          )}
          {needsFile && (
            <>
              {filesFailed ? (
                <p role="alert" className="form-error">
                  {t('admin.imports.files.loadFailed')}
                </p>
              ) : files && !files.folder ? (
                <p className="page-note">{t('admin.imports.files.noFolder')}</p>
              ) : (
                <div className="form-field">
                  <label htmlFor={`${id}-file`}>{t('admin.imports.files.choose')}</label>
                  <select id={`${id}-file`} value={path} onChange={(e) => setPath(e.target.value)}>
                    <option value="">{t('admin.imports.files.none')}</option>
                    {offered.map((f) => (
                      <option key={f.name} value={f.name}>
                        {t('admin.imports.files.option', {
                          name: f.name,
                          size: intl.formatNumber(f.size / 1e6, { maximumFractionDigits: 1 }),
                        })}
                      </option>
                    ))}
                  </select>
                  <p className="form-hint">{t('admin.imports.files.hint')}</p>
                </div>
              )}
              {files?.folder && (
                <div className="form-field">
                  <label htmlFor={`${id}-upload`}>{t('admin.imports.upload.label')}</label>
                  <input
                    id={`${id}-upload`}
                    type="file"
                    accept=".zip,.csv"
                    onChange={(e) => setUpload(e.target.files?.[0] ?? null)}
                  />
                  <p className="form-hint">
                    {t('admin.imports.upload.hint', {
                      max: intl.formatNumber(maxUpload / 1024 ** 3, { maximumFractionDigits: 1 }),
                    })}
                  </p>
                  <div className="form-actions">
                    <button
                      type="button"
                      className="button-secondary"
                      disabled={!upload || uploading}
                      onClick={() => void doUpload()}
                    >
                      {uploading
                        ? t('admin.imports.upload.busy')
                        : t('admin.imports.upload.button')}
                    </button>
                  </div>
                  {uploadNote && (
                    <p
                      role={uploadNote.ok ? 'status' : 'alert'}
                      className={uploadNote.ok ? 'form-status' : 'form-error'}
                    >
                      {uploadNote.text}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
          {format === 'cloud-rest' && !cloudDelta && (
            <>
              <div className="form-field">
                <label htmlFor={`${id}-url`}>{t('admin.imports.cloud.url')}</label>
                <input
                  id={`${id}-url`}
                  type="url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                />
              </div>
              <div className="form-field">
                <label htmlFor={`${id}-email`}>{t('admin.imports.cloud.email')}</label>
                <input
                  id={`${id}-email`}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className="form-field">
                <label htmlFor={`${id}-token`}>{t('admin.imports.cloud.token')}</label>
                <input
                  id={`${id}-token`}
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
                <p className="form-hint">{t('admin.imports.cloud.tokenHint')}</p>
              </div>
              <div className="form-field">
                <label htmlFor={`${id}-projects`}>{t('admin.imports.cloud.projects')}</label>
                <input
                  id={`${id}-projects`}
                  type="text"
                  value={projects}
                  onChange={(e) => setProjects(e.target.value)}
                />
                <p className="form-hint">{t('admin.imports.cloud.projectsHint')}</p>
              </div>
            </>
          )}
        </fieldset>

        <fieldset disabled={running || imported}>
          <legend>{t('admin.imports.wizard.options')}</legend>
          <div className="form-field">
            <label htmlFor={`${id}-name`}>{t('admin.imports.wizard.name')}</label>
            <input
              id={`${id}-name`}
              type="text"
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          {format === 'dc-backup' && (
            <>
              <div
                role="radiogroup"
                aria-label={t('admin.imports.scope.label')}
                className="import-choices"
              >
                <p className="import-choices-title">{t('admin.imports.scope.label')}</p>
                {SCOPES.map((s) => (
                  <div key={s} className="form-field form-field-inline">
                    <input
                      id={`${id}-scope-${s}`}
                      type="radio"
                      name={`${id}-scope`}
                      checked={scope === s}
                      onChange={() => setScope(s)}
                    />
                    <label htmlFor={`${id}-scope-${s}`}>
                      {t(`admin.imports.scope.${s}` as MessageId)}
                    </label>
                  </div>
                ))}
              </div>
              <div
                role="radiogroup"
                aria-label={t('admin.imports.admins.label')}
                className="import-choices"
              >
                <p className="import-choices-title">{t('admin.imports.admins.label')}</p>
                {ADMINS.map((a) => (
                  <div key={a} className="form-field form-field-inline">
                    <input
                      id={`${id}-admins-${a}`}
                      type="radio"
                      name={`${id}-admins`}
                      checked={admins === a}
                      onChange={() => setAdmins(a)}
                    />
                    <label htmlFor={`${id}-admins-${a}`}>
                      {t(`admin.imports.admins.${a}` as MessageId)}
                    </label>
                  </div>
                ))}
              </div>
            </>
          )}
          {format === 'csv' && (
            <div className="form-field">
              <label htmlFor={`${id}-mapping`}>{t('admin.imports.csv.mapping')}</label>
              <textarea
                id={`${id}-mapping`}
                rows={6}
                value={mapping}
                onChange={(e) => setMapping(e.target.value)}
              />
              <p className="form-hint">{t('admin.imports.csv.mappingHint')}</p>
            </div>
          )}
        </fieldset>

        {people !== null && !imported && (
          <PeopleMapping
            people={people}
            value={peopleMap}
            onChange={setPeopleMap}
            more={morePeople}
          />
        )}

        {problem && (
          <p role="alert" className="form-error">
            {t(problem)}
          </p>
        )}
        {!imported && (
          <div className="form-actions">
            <button
              type="submit"
              className={finished?.dryRun && finished.ok ? 'button-secondary' : 'button-primary'}
              disabled={busy || running}
            >
              {finished?.dryRun
                ? t('admin.imports.wizard.dryRunAgain')
                : t('admin.imports.wizard.dryRun')}
            </button>
            <button
              type="button"
              className={finished?.dryRun && finished.ok ? 'button-primary' : 'button-secondary'}
              disabled={busy || running}
              onClick={() => void start(false)}
            >
              {t('admin.imports.wizard.run')}
            </button>
          </div>
        )}
        <p className="page-note">
          {finished?.dryRun && finished.ok
            ? t('admin.imports.wizard.afterDryRun')
            : t('admin.imports.wizard.dryRunHint')}
        </p>
      </form>
      {current && (
        <ImportRunPanel
          key={current.id}
          client={client}
          runId={current.id}
          {...(pollMs !== undefined ? { pollMs } : {})}
          onFinished={(run, report) => void finishedRun(run, report)}
        />
      )}
    </div>
  );
}
