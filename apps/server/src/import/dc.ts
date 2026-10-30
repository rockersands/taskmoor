import { join } from 'node:path';
import { z } from 'zod';
import {
  CONSUMED,
  NOT_NEEDED,
  STAGED_KINDS,
  type StagedGroup,
  type StagedIssueType,
  type StagedNamed,
  type StagedProject,
  type StagedStatus,
  type StagedUser,
  type StageSummary,
  stageDcBackup,
} from './dc-backup/stage';
import { readJsonLines } from './lines';
import type {
  Command,
  ImportFormat,
  ImportSource,
  Mapped,
  Ref,
  SourceItem,
  SourceNote,
  SourceRecord,
  Stage,
  Warning,
} from './model';

/**
 * A Data Center backup ZIP as an import source (M1-088; IMP-001, IMP-004, IMP-007; ADR-081).
 * The backup is staged once (`dc-backup/stage.ts`): a streaming pass that writes one file of
 * records per kind next to the ZIP. The source then reads those files a page at a time, so a
 * run resumes from its checkpoint without reading the backup again. Every element the mapping
 * does not import yet is counted from the stage and reported with its reason, never dropped
 * silently, and the characters XML forbids that the reader removed are reported as warnings.
 *
 * This task maps people, groups with their members, roles, projects (to tracks, with their role
 * actors), issue types (to ticket types), statuses with their stage, priorities and resolutions
 * (to close reasons). Custom fields, workflows, issues and the rest follow in M1-089 to M1-094.
 */
export const DC_SOURCE = 'dc-backup';

export const dcBackupSource = z
  .object({
    format: z.literal(DC_SOURCE),
    /** A backup ZIP on the server (the route keeps it inside the imports folder). */
    path: z.string().min(1).max(4096),
    /** Names the instance: importing a later backup with the same system updates. */
    system: z.string().min(1).max(200).default('dc'),
  })
  .strict();
export type DcBackupSettings = z.infer<typeof dcBackupSource>;

/** Why an element is not imported, as the report gives it. */
export const NOT_IMPORTED_YET = 'not_imported_yet';
export const NOT_NEEDED_REASON = 'not_needed';

/** The staged backup as a source: records of a kind from its file, cursors are byte offsets. */
export class DcBackupSource implements ImportSource {
  readonly importSource = DC_SOURCE;
  readonly system: string;
  private staged: Promise<{ dir: string; summary: StageSummary }> | null = null;

  constructor(private readonly settings: DcBackupSettings) {
    this.system = settings.system;
  }

  /** The stage of the backup, made on first use. */
  stage(): Promise<{ dir: string; summary: StageSummary }> {
    this.staged ??= stageDcBackup(this.settings.path).catch((error: unknown) => {
      this.staged = null;
      throw error;
    });
    return this.staged;
  }

  /** What the source reports as not imported: elements, tables and files, by name. */
  private async leftOut(): Promise<Map<string, { count: number; reason: string }>> {
    const { summary } = await this.stage();
    const out = new Map<string, { count: number; reason: string }>();
    for (const [name, count] of Object.entries(summary.entities)) {
      if (CONSUMED.has(name)) continue;
      out.set(name, { count, reason: NOT_NEEDED.has(name) ? NOT_NEEDED_REASON : NOT_IMPORTED_YET });
    }
    for (const [table, count] of Object.entries(summary.activeObjects)) {
      out.set(table, { count, reason: NOT_IMPORTED_YET });
    }
    for (const [folder, count] of Object.entries(summary.files)) {
      out.set(folder, { count, reason: NOT_IMPORTED_YET });
    }
    return out;
  }

  async kinds(): Promise<string[]> {
    const { summary } = await this.stage();
    const staged = Object.keys(STAGED_KINDS).filter((k) => (summary.kinds[k] ?? 0) > 0);
    return [...staged, ...(await this.leftOut()).keys()];
  }

  async read(kind: string, after: string | null, limit: number): Promise<SourceItem[]> {
    const { dir, summary } = await this.stage();
    if (!(kind in STAGED_KINDS) || (summary.kinds[kind] ?? 0) === 0) return [];
    return (await readJsonLines(join(dir, `${kind}.ndjson`), after, limit)).map(
      ({ value, cursor }) => ({
        kind,
        id: String(value.id),
        label: String(value.label),
        data: value.data as Record<string, unknown>,
        cursor,
      }),
    );
  }

  async unsupported(kind: string): Promise<{ count: number; reason: string } | null> {
    return (await this.leftOut()).get(kind) ?? null;
  }

  async notes(): Promise<SourceNote[]> {
    const { summary } = await this.stage();
    const detail = {
      nul: 'nul',
      control: 'control',
      noncharacter: 'noncharacter',
      charRef: 'char_ref',
    };
    return (Object.keys(detail) as (keyof typeof detail)[])
      .filter((k) => summary.removed[k].count > 0)
      .map((k) => ({
        code: 'removed_character',
        detail: detail[k],
        count: summary.removed[k].count,
        examples: summary.removed[k].examples,
      }));
  }
}

// --- Mapping ----------------------------------------------------------------------------------

const ref = (kind: Ref['kind'], id: string): Ref => ({ kind, id });

/** Status categories by the number the backup stores (or, leniently, by their key). */
const STAGES: Record<string, Stage> = {
  '2': 'new',
  '4': 'active',
  '3': 'closed',
  new: 'new',
  indeterminate: 'active',
  done: 'closed',
};

const TRACK_TYPES: Record<string, 'software' | 'business'> = {
  software: 'software',
  business: 'business',
};

const USER_ROLE_ACTOR = 'atlassian-user-role-actor';
const GROUP_ROLE_ACTOR = 'atlassian-group-role-actor';

function mapUser(u: StagedUser): Mapped {
  if (u.deleted) {
    // A deleted person keeps their attribution as an inactive placeholder (IMP-007), if anything
    // names them.
    if (!u.referenced) return { skip: 'deleted_user_not_referenced' };
    return {
      command: {
        kind: 'user',
        email: null,
        name: u.userName ?? u.key,
        active: false,
        timeZone: null,
      },
      warnings: [{ code: 'deleted_user' }],
    };
  }
  return {
    command: {
      kind: 'user',
      email: u.email,
      name: u.displayName || u.userName || u.key,
      active: u.active,
      timeZone: null,
    },
    warnings: u.email ? [] : [{ code: 'no_email' }],
  };
}

function mapGroup(g: StagedGroup): Mapped {
  const warnings: Warning[] = [
    ...g.nested.map((n) => ({ code: 'nested_group_not_imported', detail: n })),
    ...g.unknownMembers.map(() => ({ code: 'member_not_found' })),
  ];
  return {
    command: {
      kind: 'group',
      name: g.name,
      description: g.description,
      members: g.members.map((m) => ref('user', m)),
    },
    warnings,
  };
}

function mapTrack(p: StagedProject): Mapped {
  const warnings: Warning[] = [];
  let trackType = p.type === null ? undefined : TRACK_TYPES[p.type];
  if (trackType === undefined) {
    warnings.push({ code: 'unknown_project_type', detail: p.type ?? '' });
    trackType = 'business';
  }
  // Earlier keys become key aliases with the tickets (M1-128).
  if (p.originalKey !== null && p.originalKey !== p.key) {
    warnings.push({ code: 'original_key_not_kept', detail: p.originalKey });
  }
  const roleActors: NonNullable<Extract<Command, { kind: 'track' }>['roleActors']> = [];
  for (const a of p.actors) {
    if (!a.roleKnown) {
      warnings.push({ code: 'role_actor_unknown_role', detail: a.role });
    } else if (a.type === USER_ROLE_ACTOR && a.user !== null) {
      roleActors.push({ role: ref('role', a.role), user: ref('user', a.user), group: null });
    } else if (a.type === GROUP_ROLE_ACTOR && a.group !== null) {
      roleActors.push({ role: ref('role', a.role), user: null, group: ref('group', a.group) });
    } else if (a.type === GROUP_ROLE_ACTOR) {
      warnings.push({ code: 'role_actor_unknown_group', detail: a.parameter });
    } else {
      warnings.push({ code: 'role_actor_not_imported', detail: a.type });
    }
  }
  return {
    command: {
      kind: 'track',
      key: p.key,
      name: p.name,
      description: p.description,
      owner: p.lead === null ? null : ref('user', p.lead),
      trackType,
      ...(p.counter !== null ? { lastNumber: p.counter } : {}),
      roleActors,
    },
    warnings,
  };
}

const MAPPERS: Record<string, (data: Record<string, unknown>) => Mapped> = {
  user: (d) => mapUser(d as unknown as StagedUser),
  group: (d) => mapGroup(d as unknown as StagedGroup),
  role: (d) => {
    const r = d as unknown as StagedNamed;
    return { command: { kind: 'role', name: r.name, description: r.description } };
  },
  status: (d) => {
    const s = d as unknown as StagedStatus;
    const stage = s.category === null ? undefined : STAGES[s.category];
    return {
      command: { kind: 'status', name: s.name, description: s.description, stage: stage ?? 'new' },
      warnings:
        stage === undefined ? [{ code: 'unknown_status_category', detail: s.category ?? '' }] : [],
    };
  },
  priority: (d) => {
    const p = d as unknown as StagedNamed;
    return {
      command: {
        kind: 'priority',
        name: p.name,
        description: p.description,
        icon: null,
        color: null,
      },
    };
  },
  close_reason: (d) => {
    const r = d as unknown as StagedNamed;
    return { command: { kind: 'close_reason', name: r.name, description: r.description } };
  },
  ticket_type: (d) => {
    const t = d as unknown as StagedIssueType;
    return {
      command: {
        kind: 'ticket_type',
        name: t.name,
        description: t.description,
        level: t.style === 'jira_subtask' ? 'subticket' : 'standard',
      },
    };
  },
  track: (d) => mapTrack(d as unknown as StagedProject),
};

/** Maps a staged record; a name the target cannot hold fails the record. */
export function mapDcRecord(record: SourceRecord): Mapped {
  const mapper = MAPPERS[record.kind];
  if (!mapper) return { fail: 'unsupported_kind' };
  const name = (record.data as { name?: unknown }).name;
  if (record.kind !== 'user' && (typeof name !== 'string' || name.trim() === '')) {
    return { fail: 'no_name' };
  }
  return mapper(record.data);
}

export const dcBackupFormat: ImportFormat = {
  importSource: DC_SOURCE,
  open: (source) => new DcBackupSource(dcBackupSource.parse(source)),
  map: mapDcRecord,
};
