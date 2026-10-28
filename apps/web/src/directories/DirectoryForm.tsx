import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { useIntl } from 'react-intl';
import { ApiError } from '../api/client';
import { type Translate, useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';
import { PasswordField } from '../session/PasswordField';
import {
  ATTRIBUTE_KEYS,
  type AttributeMap,
  DIRECTORY_KINDS,
  type Directory,
  type DirectoryInput,
  type DirectoryKind,
  type DirectoryMode,
  type KindPreset,
  type TestResult,
} from './client';
import {
  changesOf,
  type DirectoryDraft,
  draftOf,
  emptyDraft,
  FULL_HOURS,
  INTERVAL,
  inputOf,
  testInputOf,
  wholeNumber,
  withKind,
} from './draft';

export interface DirectoryFormProps {
  /** The directory being edited; a new one when absent. */
  directory?: Directory | undefined;
  presets: Partial<Record<DirectoryKind, KindPreset>>;
  /** Saves a new directory (everything) or an edit (only what changed); rejects with ApiError. */
  onSave: (input: Partial<DirectoryInput>) => Promise<void>;
  /** Tries the settings without saving them. */
  onTest: (input: Partial<DirectoryInput> & { id?: number }) => Promise<TestResult>;
  onCancel: () => void;
}

type Field =
  | 'name'
  | 'url'
  | 'certificates'
  | 'userFilter'
  | 'groupFilter'
  | 'interval'
  | 'fullHours'
  | null;

export const KIND_LABELS: Record<DirectoryKind, MessageId> = {
  active_directory: 'admin.directories.kind.activeDirectory',
  openldap: 'admin.directories.kind.openldap',
  generic: 'admin.directories.kind.generic',
};

const ATTRIBUTE_LABELS: Record<keyof AttributeMap, MessageId> = {
  id: 'admin.directories.form.attribute.id',
  username: 'admin.directories.form.attribute.username',
  email: 'admin.directories.form.attribute.email',
  emailFallback: 'admin.directories.form.attribute.emailFallback',
  name: 'admin.directories.form.attribute.name',
  givenName: 'admin.directories.form.attribute.givenName',
  surname: 'admin.directories.form.attribute.surname',
  changeMark: 'admin.directories.form.attribute.changeMark',
  groupName: 'admin.directories.form.attribute.groupName',
  member: 'admin.directories.form.attribute.member',
};

/** The backend's refusal as a sentence, and the field it is about. */
function problemOf(
  t: Translate,
  error: unknown,
  editing: boolean,
): { field: Field; message: string } {
  const code = error instanceof ApiError ? error.code : undefined;
  switch (code) {
    case 'insecure_transport':
      return { field: 'url', message: t('admin.directories.error.insecureTransport') };
    case 'invalid_url':
      return { field: 'url', message: t('admin.directories.error.invalidUrl') };
    case 'invalid_certificate':
      return { field: 'certificates', message: t('admin.directories.error.invalidCertificate') };
    case 'name_taken':
      return { field: 'name', message: t('admin.directories.error.nameTaken') };
    case 'not_found':
      return { field: null, message: t('admin.directories.error.notFound') };
    case 'invalid_request':
      return {
        field: null,
        message: t(
          editing ? 'admin.directories.error.invalidEdit' : 'admin.directories.error.invalid',
        ),
      };
    default:
      return { field: null, message: t('admin.directories.error.failed') };
  }
}

/** What a connection test found, as a sentence. */
function testMessage(t: Translate, result: TestResult): string {
  if (!result.ok) {
    const reason: Record<typeof result.error, MessageId> = {
      unreachable: 'admin.directories.test.unreachable',
      tls_failed: 'admin.directories.test.tlsFailed',
      bind_refused: 'admin.directories.test.bindRefused',
      password_unreadable: 'admin.directories.test.passwordUnreadable',
      search_failed: 'admin.directories.test.searchFailed',
    };
    return t(reason[result.error]);
  }
  return t('admin.directories.test.found', {
    people: result.users.count,
    peopleMore: String(result.users.more),
    groups: result.groups.count,
    groupsMore: String(result.groups.more),
  });
}

/**
 * Adds or edits a directory (M1-082, IAM-005): its kind, where it is and how to trust it,
 * the service account Taskmoor binds as (the password is write-only: blank keeps it), where
 * and what to read, attribute names that differ from the kind's, read-only or read-write, and
 * the schedule. "Test connection" tries the settings as typed without saving them.
 */
export function DirectoryForm({
  directory,
  presets,
  onSave,
  onTest,
  onCancel,
}: DirectoryFormProps) {
  const t = useT();
  const intl = useIntl();
  const id = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<DirectoryDraft>(() =>
    directory ? draftOf(directory) : emptyDraft('active_directory', presets.active_directory),
  );
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState<{ ok: boolean; message: string } | null>(null);
  const [problem, setProblem] = useState<{ field: Field; message: string } | null>(null);
  const editing = directory !== undefined;
  const errorId = `${id}-error`;
  const defaults = directory?.attributes ?? presets[draft.kind]?.attributes;

  useEffect(() => {
    nameInput.current?.focus();
  }, []);

  const set = <K extends keyof DirectoryDraft>(key: K, value: DirectoryDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));

  /** The numbers are checked here; the rest is the backend's to judge. */
  const local = (): { field: Field; message: string } | null => {
    if (wholeNumber(draft.syncIntervalMinutes, INTERVAL.min, INTERVAL.max) === null) {
      return { field: 'interval', message: t('admin.directories.error.interval') };
    }
    if (wholeNumber(draft.fullSyncHours, FULL_HOURS.min, FULL_HOURS.max) === null) {
      return { field: 'fullHours', message: t('admin.directories.error.fullHours') };
    }
    return null;
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setProblem(null);
    const found = local();
    if (found) {
      setProblem(found);
      return;
    }
    setBusy(true);
    try {
      await onSave(directory ? changesOf(directory, draft) : inputOf(draft));
    } catch (error) {
      setProblem(problemOf(t, error, editing));
    } finally {
      setBusy(false);
    }
  };

  const test = async () => {
    setProblem(null);
    setTested(null);
    setTesting(true);
    try {
      const result = await onTest(testInputOf(draft, directory));
      setTested({ ok: result.ok, message: testMessage(t, result) });
    } catch (error) {
      setProblem(problemOf(t, error, editing));
    } finally {
      setTesting(false);
    }
  };

  const describe = (field: Field, hintId: string) =>
    problem?.field === field
      ? { 'aria-invalid': true, 'aria-describedby': `${hintId} ${errorId}` }
      : { 'aria-describedby': hintId };

  const text = (
    key: 'name' | 'url' | 'bindDn' | 'baseDn' | 'userBaseDn' | 'groupBaseDn',
    field: Field,
    label: MessageId,
    hint: MessageId,
    options: { required?: boolean; max?: number; inputRef?: typeof nameInput } = {},
  ) => (
    <div className="form-field">
      <label htmlFor={`${id}-${key}`}>{t(label)}</label>
      <input
        ref={options.inputRef}
        id={`${id}-${key}`}
        required={options.required ?? false}
        maxLength={options.max ?? 1000}
        autoComplete="off"
        spellCheck={false}
        value={draft[key]}
        onChange={(e) => set(key, e.target.value)}
        {...describe(field, `${id}-${key}-hint`)}
      />
      <p id={`${id}-${key}-hint`} className="form-hint">
        {t(hint)}
      </p>
    </div>
  );

  const filter = (key: 'userFilter' | 'groupFilter', label: MessageId, hint: MessageId) => (
    <div className="form-field">
      <label htmlFor={`${id}-${key}`}>{t(label)}</label>
      <textarea
        id={`${id}-${key}`}
        rows={2}
        required
        maxLength={4000}
        spellCheck={false}
        autoComplete="off"
        className="sso-code"
        value={draft[key]}
        onChange={(e) => set(key, e.target.value)}
        {...describe(key, `${id}-${key}-hint`)}
      />
      <p id={`${id}-${key}-hint`} className="form-hint">
        {t(hint)}
      </p>
    </div>
  );

  const passwordHint = !directory
    ? t('admin.directories.form.bindPasswordHintNew')
    : t('admin.directories.form.bindPasswordHintKeep');

  return (
    <form className="form sso-form" onSubmit={submit} aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="token-form-title">
        {directory
          ? t('admin.directories.editTitle', { name: directory.name })
          : t('admin.directories.newTitle')}
      </h3>
      {!directory && (
        <fieldset>
          <legend>{t('admin.directories.form.kind')}</legend>
          {DIRECTORY_KINDS.map((kind) => (
            <div key={kind} className="form-field form-field-inline">
              <input
                id={`${id}-kind-${kind}`}
                type="radio"
                name={`${id}-kind`}
                value={kind}
                checked={draft.kind === kind}
                onChange={() => setDraft((current) => withKind(current, kind, presets))}
              />
              <label htmlFor={`${id}-kind-${kind}`}>{t(KIND_LABELS[kind])}</label>
            </div>
          ))}
        </fieldset>
      )}
      {text('name', 'name', 'admin.directories.form.name', 'admin.directories.form.nameHint', {
        required: true,
        max: 100,
        inputRef: nameInput,
      })}
      <fieldset>
        <legend>{t('admin.directories.form.connection')}</legend>
        {text('url', 'url', 'admin.directories.form.url', 'admin.directories.form.urlHint', {
          required: true,
          max: 500,
        })}
        <div className="form-field form-field-inline sso-option">
          <input
            id={`${id}-start-tls`}
            type="checkbox"
            checked={draft.startTls}
            aria-describedby={`${id}-start-tls-hint`}
            onChange={(e) => set('startTls', e.target.checked)}
          />
          <label htmlFor={`${id}-start-tls`}>{t('admin.directories.form.startTls')}</label>
          <p id={`${id}-start-tls-hint`} className="form-hint sso-option-hint">
            {t('admin.directories.form.startTlsHint')}
          </p>
        </div>
        <div className="form-field">
          <label htmlFor={`${id}-ca`}>{t('admin.directories.form.caCertificates')}</label>
          <textarea
            id={`${id}-ca`}
            rows={4}
            spellCheck={false}
            autoComplete="off"
            className="sso-code"
            value={draft.caCertificates}
            onChange={(e) => set('caCertificates', e.target.value)}
            {...describe('certificates', `${id}-ca-hint`)}
          />
          <div id={`${id}-ca-hint`} className="form-hint">
            <p>
              {t(
                directory
                  ? 'admin.directories.form.caCertificatesHintEdit'
                  : 'admin.directories.form.caCertificatesHint',
              )}
            </p>
            {directory && directory.caCertificates.length > 0 && (
              <ul className="sso-certificates">
                {directory.caCertificates.map((c) => (
                  <li key={c.fingerprint}>
                    {t('admin.directories.form.certificateSaved', {
                      subject: c.subject,
                      until: intl.formatDate(c.notAfter, { dateStyle: 'medium' }),
                      fingerprint: c.fingerprint,
                    })}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </fieldset>
      <fieldset>
        <legend>{t('admin.directories.form.serviceAccount')}</legend>
        {text(
          'bindDn',
          null,
          'admin.directories.form.bindDn',
          'admin.directories.form.bindDnHint',
          {
            required: true,
          },
        )}
        <PasswordField
          label={t('admin.directories.form.bindPassword')}
          toggleLabel={t('admin.directories.form.showBindPassword')}
          autoComplete="new-password"
          required={!directory}
          hint={passwordHint}
          value={draft.bindPassword}
          onChange={(value) => set('bindPassword', value)}
        />
      </fieldset>
      <fieldset>
        <legend>{t('admin.directories.form.search')}</legend>
        {text(
          'baseDn',
          null,
          'admin.directories.form.baseDn',
          'admin.directories.form.baseDnHint',
          {
            required: true,
          },
        )}
        {text(
          'userBaseDn',
          null,
          'admin.directories.form.userBaseDn',
          'admin.directories.form.userBaseDnHint',
        )}
        {filter(
          'userFilter',
          'admin.directories.form.userFilter',
          'admin.directories.form.userFilterHint',
        )}
        {text(
          'groupBaseDn',
          null,
          'admin.directories.form.groupBaseDn',
          'admin.directories.form.groupBaseDnHint',
        )}
        {filter(
          'groupFilter',
          'admin.directories.form.groupFilter',
          'admin.directories.form.groupFilterHint',
        )}
      </fieldset>
      <details className="directory-attributes">
        <summary>{t('admin.directories.form.attributes')}</summary>
        <p className="form-hint">{t('admin.directories.form.attributesHint')}</p>
        <div className="directory-attribute-grid">
          {ATTRIBUTE_KEYS.map((key) => (
            <div key={key} className="form-field">
              <label htmlFor={`${id}-attribute-${key}`}>{t(ATTRIBUTE_LABELS[key])}</label>
              <input
                id={`${id}-attribute-${key}`}
                maxLength={64}
                autoComplete="off"
                spellCheck={false}
                placeholder={defaults?.[key] || undefined}
                value={draft.attributes[key]}
                onChange={(e) =>
                  setDraft((current) => ({
                    ...current,
                    attributes: { ...current.attributes, [key]: e.target.value },
                  }))
                }
              />
            </div>
          ))}
        </div>
      </details>
      <fieldset>
        <legend>{t('admin.directories.form.mode')}</legend>
        {(
          [
            ['read_only', 'admin.directories.form.readOnly', 'admin.directories.form.readOnlyHint'],
            [
              'read_write',
              'admin.directories.form.readWrite',
              'admin.directories.form.readWriteHint',
            ],
          ] as const
        ).map(([mode, label, hint]) => (
          <div key={mode} className="form-field form-field-inline sso-option">
            <input
              id={`${id}-mode-${mode}`}
              type="radio"
              name={`${id}-mode`}
              value={mode}
              checked={draft.mode === mode}
              aria-describedby={`${id}-mode-${mode}-hint`}
              onChange={() => set('mode', mode as DirectoryMode)}
            />
            <label htmlFor={`${id}-mode-${mode}`}>{t(label)}</label>
            <p id={`${id}-mode-${mode}-hint`} className="form-hint sso-option-hint">
              {t(hint)}
            </p>
          </div>
        ))}
      </fieldset>
      <fieldset>
        <legend>{t('admin.directories.form.schedule')}</legend>
        <div className="directory-numbers">
          <div className="form-field">
            <label htmlFor={`${id}-interval`}>{t('admin.directories.form.interval')}</label>
            <input
              id={`${id}-interval`}
              inputMode="numeric"
              required
              value={draft.syncIntervalMinutes}
              onChange={(e) => set('syncIntervalMinutes', e.target.value)}
              {...describe('interval', `${id}-interval-hint`)}
            />
            <p id={`${id}-interval-hint`} className="form-hint">
              {t('admin.directories.form.intervalHint')}
            </p>
          </div>
          <div className="form-field">
            <label htmlFor={`${id}-full`}>{t('admin.directories.form.fullHours')}</label>
            <input
              id={`${id}-full`}
              inputMode="numeric"
              required
              value={draft.fullSyncHours}
              onChange={(e) => set('fullSyncHours', e.target.value)}
              {...describe('fullHours', `${id}-full-hint`)}
            />
            <p id={`${id}-full-hint`} className="form-hint">
              {t('admin.directories.form.fullHoursHint')}
            </p>
          </div>
        </div>
        <div className="form-field form-field-inline sso-option">
          <input
            id={`${id}-enabled`}
            type="checkbox"
            checked={draft.enabled}
            aria-describedby={`${id}-enabled-hint`}
            onChange={(e) => set('enabled', e.target.checked)}
          />
          <label htmlFor={`${id}-enabled`}>{t('admin.directories.form.enabled')}</label>
          <p id={`${id}-enabled-hint`} className="form-hint sso-option-hint">
            {t('admin.directories.form.enabledHint')}
          </p>
        </div>
      </fieldset>
      {problem && (
        <p id={errorId} role="alert" className="form-error">
          {problem.message}
        </p>
      )}
      <p role="status" className={tested?.ok === false ? 'form-error' : 'form-status'}>
        {testing ? t('admin.directories.test.running') : (tested?.message ?? '')}
      </p>
      <div className="form-actions">
        <button type="submit" className="button-primary" disabled={busy}>
          {t(directory ? 'admin.directories.form.save' : 'admin.directories.form.create')}
        </button>
        <button
          type="button"
          className="button-secondary"
          disabled={testing}
          onClick={() => void test()}
        >
          {t('admin.directories.form.test')}
        </button>
        <button type="button" className="button-secondary" onClick={onCancel}>
          {t('admin.directories.form.cancel')}
        </button>
      </div>
    </form>
  );
}
