import {
  ATTRIBUTE_KEYS,
  type AttributeMap,
  type Directory,
  type DirectoryInput,
  type DirectoryKind,
  type DirectoryMode,
  type KindPreset,
} from './client';

/**
 * The directory form's values as typed (M1-082). Optional DNs are blank when unused; attribute
 * names are blank where the kind's default applies; the password and certificates are blank
 * when the saved ones stay.
 */
export interface DirectoryDraft {
  kind: DirectoryKind;
  name: string;
  url: string;
  startTls: boolean;
  /** PEM text pasted here replaces the saved certificates; blank keeps them. */
  caCertificates: string;
  bindDn: string;
  bindPassword: string;
  baseDn: string;
  userBaseDn: string;
  userFilter: string;
  groupBaseDn: string;
  groupFilter: string;
  attributes: Record<keyof AttributeMap, string>;
  mode: DirectoryMode;
  enabled: boolean;
  syncIntervalMinutes: string;
  fullSyncHours: string;
}

const blankAttributes = (): Record<keyof AttributeMap, string> =>
  Object.fromEntries(ATTRIBUTE_KEYS.map((k) => [k, ''])) as Record<keyof AttributeMap, string>;

/** A new directory of a kind, with that kind's filters: read-only, enabled, hourly. */
export function emptyDraft(kind: DirectoryKind, preset: KindPreset | undefined): DirectoryDraft {
  return {
    kind,
    name: '',
    url: '',
    startTls: false,
    caCertificates: '',
    bindDn: '',
    bindPassword: '',
    baseDn: '',
    userBaseDn: '',
    userFilter: preset?.userFilter ?? '',
    groupBaseDn: '',
    groupFilter: preset?.groupFilter ?? '',
    attributes: blankAttributes(),
    mode: 'read_only',
    enabled: true,
    syncIntervalMinutes: '60',
    fullSyncHours: '24',
  };
}

/**
 * Another kind for a new directory: filters still at the old kind's defaults take the new
 * kind's; what the administrator typed stays.
 */
export function withKind(
  draft: DirectoryDraft,
  kind: DirectoryKind,
  presets: Partial<Record<DirectoryKind, KindPreset>>,
): DirectoryDraft {
  const from = presets[draft.kind];
  const to = presets[kind];
  return {
    ...draft,
    kind,
    userFilter:
      draft.userFilter === '' || draft.userFilter === from?.userFilter
        ? (to?.userFilter ?? draft.userFilter)
        : draft.userFilter,
    groupFilter:
      draft.groupFilter === '' || draft.groupFilter === from?.groupFilter
        ? (to?.groupFilter ?? draft.groupFilter)
        : draft.groupFilter,
  };
}

export function draftOf(directory: Directory): DirectoryDraft {
  const attributes = blankAttributes();
  for (const key of ATTRIBUTE_KEYS) {
    const value = directory.attributeOverrides[key];
    if (typeof value === 'string') attributes[key] = value;
  }
  return {
    kind: directory.kind,
    name: directory.name,
    url: directory.url,
    startTls: directory.startTls,
    caCertificates: '',
    bindDn: directory.bindDn,
    bindPassword: '',
    baseDn: directory.baseDn,
    userBaseDn: directory.userBaseDn ?? '',
    userFilter: directory.userFilter,
    groupBaseDn: directory.groupBaseDn ?? '',
    groupFilter: directory.groupFilter,
    attributes,
    mode: directory.mode,
    enabled: directory.enabled,
    syncIntervalMinutes: String(directory.syncIntervalMinutes),
    fullSyncHours: String(directory.fullSyncHours),
  };
}

const optional = (value: string) => (value.trim() === '' ? null : value.trim());

/** Attribute names that differ from the kind's defaults, as the backend stores them. */
function overridesOf(draft: DirectoryDraft): Partial<AttributeMap> {
  const out: Partial<AttributeMap> = {};
  for (const key of ATTRIBUTE_KEYS) {
    const value = draft.attributes[key].trim();
    if (value !== '') out[key] = value;
  }
  return out;
}

/** Whole numbers within bounds, else null (the form says which field is wrong). */
export function wholeNumber(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return n >= min && n <= max ? n : null;
}

export const INTERVAL = { min: 5, max: 1440 } as const;
export const FULL_HOURS = { min: 1, max: 720 } as const;

/** Everything a new directory sends. */
export function inputOf(draft: DirectoryDraft): DirectoryInput {
  return {
    name: draft.name.trim(),
    kind: draft.kind,
    url: draft.url.trim(),
    startTls: draft.startTls,
    ...(draft.caCertificates.trim() !== ''
      ? { caCertificates: [draft.caCertificates.trim()] }
      : {}),
    bindDn: draft.bindDn.trim(),
    ...(draft.bindPassword !== '' ? { bindPassword: draft.bindPassword } : {}),
    baseDn: draft.baseDn.trim(),
    userBaseDn: optional(draft.userBaseDn),
    userFilter: draft.userFilter.trim(),
    groupBaseDn: optional(draft.groupBaseDn),
    groupFilter: draft.groupFilter.trim(),
    attributes: overridesOf(draft),
    mode: draft.mode,
    enabled: draft.enabled,
    syncIntervalMinutes:
      wholeNumber(draft.syncIntervalMinutes, INTERVAL.min, INTERVAL.max) ?? INTERVAL.min,
    fullSyncHours: wholeNumber(draft.fullSyncHours, FULL_HOURS.min, FULL_HOURS.max) ?? 24,
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What an edit changes, and nothing else. The kind stays the directory's. */
export function changesOf(directory: Directory, draft: DirectoryDraft): Partial<DirectoryInput> {
  const next = inputOf(draft);
  const before: Omit<DirectoryInput, 'caCertificates' | 'bindPassword'> = {
    name: directory.name,
    kind: directory.kind,
    url: directory.url,
    startTls: directory.startTls,
    bindDn: directory.bindDn,
    baseDn: directory.baseDn,
    userBaseDn: directory.userBaseDn,
    userFilter: directory.userFilter,
    groupBaseDn: directory.groupBaseDn,
    groupFilter: directory.groupFilter,
    attributes: directory.attributeOverrides,
    mode: directory.mode,
    enabled: directory.enabled,
    syncIntervalMinutes: directory.syncIntervalMinutes,
    fullSyncHours: directory.fullSyncHours,
  };
  const out: Partial<DirectoryInput> = {};
  for (const key of Object.keys(before) as (keyof typeof before)[]) {
    if (key === 'kind') continue;
    if (!same(before[key], next[key])) (out as Record<string, unknown>)[key] = next[key];
  }
  if (next.caCertificates) out.caCertificates = next.caCertificates;
  if (next.bindPassword !== undefined) out.bindPassword = next.bindPassword;
  return out;
}

/** What the connection test sends: the typed settings, and the saved directory for the rest. */
export function testInputOf(
  draft: DirectoryDraft,
  directory: Directory | undefined,
): Partial<DirectoryInput> & { id?: number } {
  const input = inputOf(draft);
  return directory ? { ...input, id: directory.id } : input;
}
