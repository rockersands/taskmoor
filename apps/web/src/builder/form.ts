import {
  type AI_PROVIDERS,
  type BuilderInputs,
  type InputProblem,
  type LANGUAGES,
  type UserSecrets,
  validateInputs,
} from '@taskmoor/builder-core';

/**
 * The Builder page's form (M1-112; spec 05b section 1.2) as the text people type, and the way
 * to and from the core's inputs. Loading a project file fills the form with `formFrom`, and
 * `formInputs` gives the same inputs back, so a saved project rebuilds the same kits.
 */
export type AiProvider = (typeof AI_PROVIDERS)[number];
export type Language = (typeof LANGUAGES)[number];

export interface BuilderForm {
  backendUrl: string;
  frontendUrl: string;
  instanceName: string;
  defaultLanguage: Language;
  routing: 'path' | 'hash';
  useAccent: boolean;
  accentColour: string;
  withSmtp: boolean;
  smtpHost: string;
  smtpPort: string;
  smtpUser: string;
  smtpFrom: string;
  smtpPassword: string;
  aiProvider: AiProvider | '';
  aiKey: string;
  target: 'compose' | 'helm';
  signIn: 'auto' | 'session' | 'oauth';
}

/**
 * The page has no control for the accent colour yet: no kit uses it so far (ADR-088). The form
 * keeps a loaded project's colour, so saving that project again does not drop it.
 */
export const DEFAULT_ACCENT = '#6d5bd0';

export const EMPTY_FORM: Readonly<BuilderForm> = Object.freeze({
  backendUrl: '',
  frontendUrl: '',
  instanceName: '',
  defaultLanguage: 'en',
  routing: 'path',
  useAccent: false,
  accentColour: DEFAULT_ACCENT,
  withSmtp: false,
  smtpHost: '',
  smtpPort: '587',
  smtpUser: '',
  smtpFrom: '',
  smtpPassword: '',
  aiProvider: '',
  aiKey: '',
  target: 'compose',
  signIn: 'auto',
});

/** The form as the raw inputs the core validates. */
export function formInputs(form: BuilderForm): unknown {
  return {
    backendUrl: form.backendUrl.trim(),
    frontendUrl: form.frontendUrl.trim(),
    instanceName: form.instanceName,
    defaultLanguage: form.defaultLanguage,
    routing: form.routing,
    branding: form.useAccent ? { accentColour: form.accentColour } : {},
    ...(form.withSmtp
      ? {
          smtp: {
            host: form.smtpHost.trim(),
            port: /^\d+$/.test(form.smtpPort.trim()) ? Number(form.smtpPort) : Number.NaN,
            user: form.smtpUser,
            from: form.smtpFrom.trim(),
          },
        }
      : {}),
    ...(form.aiProvider ? { ai: { provider: form.aiProvider } } : {}),
    target: form.target,
    signIn: form.signIn,
  };
}

/** What the person typed that stays secret: only for the parts that are switched on. */
export function formUserSecrets(form: BuilderForm): UserSecrets {
  return {
    ...(form.withSmtp && form.smtpPassword ? { smtpPassword: form.smtpPassword } : {}),
    ...(form.aiProvider && form.aiKey ? { aiKey: form.aiKey } : {}),
  };
}

/** The form for a project's inputs, with the secrets it kept when its passphrase opened it. */
export function formFrom(inputs: BuilderInputs, user: UserSecrets = {}): BuilderForm {
  return {
    backendUrl: inputs.backendUrl,
    frontendUrl: inputs.frontendUrl,
    instanceName: inputs.instanceName,
    defaultLanguage: inputs.defaultLanguage,
    routing: inputs.routing,
    useAccent: inputs.branding.accentColour !== undefined,
    accentColour: inputs.branding.accentColour ?? DEFAULT_ACCENT,
    withSmtp: inputs.smtp !== undefined,
    smtpHost: inputs.smtp?.host ?? '',
    smtpPort: String(inputs.smtp?.port ?? EMPTY_FORM.smtpPort),
    smtpUser: inputs.smtp?.user ?? '',
    smtpFrom: inputs.smtp?.from ?? '',
    smtpPassword: user.smtpPassword ?? '',
    aiProvider: inputs.ai?.provider ?? '',
    aiKey: user.aiKey ?? '',
    target: inputs.target,
    signIn: inputs.signIn,
  };
}

export type FormCheck =
  | { ok: true; inputs: BuilderInputs }
  | { ok: false; problems: InputProblem[] };

/** The core's validation of the form, with problems named by the form's own fields. */
export function checkForm(form: BuilderForm): FormCheck {
  const checked = validateInputs(formInputs(form));
  return checked.ok ? checked : { ok: false, problems: checked.problems };
}

/** The control a problem belongs to; `form` when it is none of them. */
export type FieldName =
  | 'backendUrl'
  | 'frontendUrl'
  | 'instanceName'
  | 'accentColour'
  | 'smtpHost'
  | 'smtpPort'
  | 'smtpUser'
  | 'smtpFrom'
  | 'form';

const FIELDS: Record<string, FieldName> = {
  backendUrl: 'backendUrl',
  frontendUrl: 'frontendUrl',
  instanceName: 'instanceName',
  'branding.accentColour': 'accentColour',
  'smtp.host': 'smtpHost',
  'smtp.port': 'smtpPort',
  'smtp.user': 'smtpUser',
  'smtp.from': 'smtpFrom',
};

export const fieldOf = (problem: InputProblem): FieldName => FIELDS[problem.field] ?? 'form';
