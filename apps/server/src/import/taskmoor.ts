import { createReadStream, createWriteStream, readFileSync, statSync } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { JsonValue } from '@taskmoor/db';
import yauzl from 'yauzl';
import { z } from 'zod';
import { EXPORT_FILES, MANIFEST, type Manifest, manifestSchema } from '../export/format';
import { ArchiveLimitError, checkArchive } from './archive';
import { readJsonLines } from './lines';
import type {
  Command,
  ImportFormat,
  ImportSource,
  Mapped,
  Ref,
  SourceItem,
  SourceRecord,
  Warning,
} from './model';

/**
 * Taskmoor's own export as an import source (M1-098; IMP-014 (1); ADR-063): a folder written by
 * `export/write.ts`, or the same folder as a ZIP (unpacked once next to it, then read as a
 * folder). Each kind's file is read a page at a time from a byte offset, the offset after a
 * record being its cursor, so a run resumes in the middle of a large file without reading it
 * again. Records map one to one onto the framework's commands; values with ids inside are kept
 * as stored and mapped on load (`remap.ts`), and the format is verbatim: history, time spent
 * and formulas come from the export, not from the import.
 */
export const EXPORT_SOURCE = 'taskmoor';

export const exportSource = z
  .object({
    format: z.literal(EXPORT_SOURCE),
    /** An export folder or ZIP on the server (the route keeps it inside the imports folder). */
    path: z.string().min(1).max(4096),
  })
  .strict();
export type ExportSettings = z.infer<typeof exportSource>;

export class ExportFormatError extends Error {}

const ENTRY = /^(manifest\.json|[a-z-]+\.ndjson|attachments\/[A-Za-z0-9:_-]{1,40})$/;
const UNPACKED = '.unpacked';

/**
 * Unpacks an export ZIP into `dir`, refusing entries outside the format (and zip slip), and an
 * archive beyond the archive limits before anything is written (ASVS 12.1.2).
 */
async function unzip(zipPath: string, dir: string): Promise<void> {
  try {
    await checkArchive(zipPath);
  } catch (error) {
    if (error instanceof ArchiveLimitError) throw new ExportFormatError(error.message);
    throw error;
  }
  const zip = await new Promise<yauzl.ZipFile>((ok, fail) =>
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (error, file) =>
      error || !file ? fail(error ?? new Error('zip')) : ok(file),
    ),
  );
  await new Promise<void>((done, fail) => {
    zip.on('error', fail);
    zip.on('end', () => done());
    zip.on('entry', (entry: yauzl.Entry) => {
      if (entry.fileName.endsWith('/')) {
        zip.readEntry();
        return;
      }
      if (!ENTRY.test(entry.fileName)) {
        fail(new ExportFormatError(`unexpected entry ${entry.fileName.slice(0, 100)}`));
        zip.close();
        return;
      }
      const target = join(dir, entry.fileName);
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          fail(error ?? new Error('zip entry'));
          return;
        }
        mkdir(dirname(target), { recursive: true })
          .then(() => pipeline(stream, createWriteStream(target)))
          .then(() => zip.readEntry(), fail);
      });
    });
    zip.readEntry();
  });
}

/** Reads and checks an export's manifest. */
export function readManifest(root: string): Manifest {
  let text: string;
  try {
    text = readFileSync(join(root, MANIFEST), 'utf8');
  } catch {
    throw new ExportFormatError('no manifest.json');
  }
  const parsed = manifestSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new ExportFormatError('not a taskmoor-export manifest, version 1');
  return parsed.data;
}

/** The folder an export at `path` is read from: itself, or a ZIP's unpacked copy. */
export async function exportFolder(path: string): Promise<string> {
  const info = await stat(path);
  if (info.isDirectory()) return path;
  const dir = `${path}${UNPACKED}`;
  try {
    if ((await stat(join(dir, MANIFEST))).isFile()) return dir;
  } catch {
    // Not unpacked yet.
  }
  const partial = `${dir}.part`;
  await rm(partial, { recursive: true, force: true });
  await mkdir(partial, { recursive: true });
  try {
    await unzip(path, partial);
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }
  await rm(dir, { recursive: true, force: true });
  await rename(partial, dir);
  return dir;
}

/** The manifest of an export folder or ZIP (for the route that starts an import). */
export async function exportManifest(path: string): Promise<Manifest> {
  return readManifest(await exportFolder(path));
}

/** An export as a source: records of a kind from its file, cursors are byte offsets. */
export class ExportSource implements ImportSource {
  readonly importSource = EXPORT_SOURCE;
  private root: string | null = null;
  private manifest: Manifest | null = null;

  constructor(private readonly path: string) {}

  get system(): string {
    return this.manifest?.system ?? '';
  }

  private async folder(): Promise<string> {
    if (this.root === null) {
      this.root = await exportFolder(this.path);
      this.manifest = readManifest(this.root);
    }
    return this.root;
  }

  async kinds(): Promise<string[]> {
    await this.folder();
    const present = new Set((this.manifest as Manifest).files.map((f) => f.kind));
    return EXPORT_FILES.filter((f) => present.has(f.kind)).map((f) => f.kind);
  }

  async read(kind: string, after: string | null, limit: number): Promise<SourceItem[]> {
    const root = await this.folder();
    const file = EXPORT_FILES.find((f) => f.kind === kind)?.file;
    if (!file) return [];
    return (await readJsonLines(join(root, file), after, limit)).map(({ value, cursor }) => ({
      kind,
      id: String(value.id),
      data: value,
      cursor,
    }));
  }

  private file(locator: string): string {
    const root = this.root as string;
    const path = resolve(root, locator);
    if (!ENTRY.test(locator) || !path.startsWith(`${resolve(root)}${sep}`)) {
      throw new ExportFormatError('not an attachment of the export');
    }
    return path;
  }

  async openFile(locator: string): Promise<NodeJS.ReadableStream> {
    await this.folder();
    return createReadStream(this.file(locator));
  }

  async fileSize(locator: string): Promise<number | null> {
    await this.folder();
    try {
      return statSync(this.file(locator)).size;
    } catch {
      return null;
    }
  }
}

// --- Mapping ----------------------------------------------------------------------------------

const id = z.string().min(1).max(100);
const nullableId = id.nullable();
const text = z.string();
const nullableText = z.string().nullable();
const json = z.custom<JsonValue>(() => true);
const ids = z.array(id);

const r = (kind: Ref['kind'], value: string): Ref => ({ kind, id: value });
const nr = (kind: Ref['kind'], value: string | null): Ref | null =>
  value === null ? null : { kind, id: value };

/** One schema and command per kind; unknown keys are tolerated (a later minor version). */
const MAPPERS: Record<string, (data: Record<string, unknown>) => Mapped> = {
  user: (d) =>
    parse(
      z.object({
        email: text,
        name: text,
        active: z.boolean(),
        timeZone: nullableText,
        locale: nullableText,
      }),
      d,
      (u) => ({
        kind: 'user',
        email: u.email,
        name: u.name,
        active: u.active,
        timeZone: u.timeZone,
        locale: u.locale,
      }),
    ),
  group: (d) =>
    parse(z.object({ name: text, description: text, members: ids }), d, (g) => ({
      kind: 'group',
      name: g.name,
      description: g.description,
      members: g.members.map((m) => r('user', m)),
    })),
  team: (d) =>
    parse(z.object({ name: text, description: text, lead: nullableId, members: ids }), d, (t) => ({
      kind: 'team',
      name: t.name,
      description: t.description,
      lead: nr('user', t.lead),
      members: t.members.map((m) => r('user', m)),
    })),
  role: (d) =>
    parse(z.object({ name: text, description: text }), d, (x) => ({ kind: 'role', ...x })),
  status: (d) =>
    parse(
      z.object({ name: text, description: text, stage: z.enum(['new', 'active', 'closed']) }),
      d,
      (x) => ({ kind: 'status', ...x }),
    ),
  priority: (d) =>
    parse(
      z.object({ name: text, description: text, icon: nullableText, color: nullableText }),
      d,
      (x) => ({ kind: 'priority', ...x }),
    ),
  close_reason: (d) =>
    parse(z.object({ name: text, description: text }), d, (x) => ({
      kind: 'close_reason',
      ...x,
    })),
  ticket_type: (d) => {
    const level = (d as { level?: unknown }).level;
    if (level === 'custom') return { fail: 'custom_level_not_carried' };
    return parse(
      z.object({
        name: text,
        description: text,
        icon: nullableText,
        color: nullableText,
        level: z.enum(['standard', 'subticket', 'outcome']),
      }),
      d,
      (x) => ({ kind: 'ticket_type', ...x }),
    );
  },
  link_type: (d) =>
    parse(z.object({ name: text, outward: text, inward: text }), d, (x) => ({
      kind: 'link_type',
      ...x,
    })),
  track: (d) =>
    parse(
      z.object({
        key: text,
        name: text,
        description: text,
        type: z.enum(['software', 'business', 'service', 'discovery']),
        mode: z.enum(['shared', 'local']),
        owner: nullableId,
        icon: nullableText,
        color: nullableText,
        lastNumber: z.number().int().min(0),
      }),
      d,
      (t) => ({
        kind: 'track',
        key: t.key,
        name: t.name,
        description: t.description,
        owner: nr('user', t.owner),
        trackType: t.type,
        lastNumber: t.lastNumber,
        icon: t.icon,
        color: t.color,
      }),
      (t) => (t.mode === 'local' ? [{ code: 'local_mode_imported_shared' }] : []),
    ),
  release: (d) =>
    parse(
      z.object({
        track: id,
        name: text,
        description: text,
        startDate: nullableText,
        releaseDate: nullableText,
        shippedAt: nullableText,
        archivedAt: nullableText,
      }),
      d,
      (x) => ({ kind: 'release', ...x, track: r('track', x.track) }),
    ),
  area: (d) =>
    parse(
      z.object({
        track: id,
        name: text,
        description: text,
        owner: nullableId,
        // Since M1-123, only when a team owns the area.
        ownerTeam: id.optional(),
        defaultAssignee: z.enum(['area_owner', 'track_owner', 'unassigned']),
        archivedAt: nullableText,
      }),
      d,
      ({ ownerTeam, ...x }) => ({
        kind: 'area',
        ...x,
        track: r('track', x.track),
        owner: nr('user', x.owner),
        ...(ownerTeam === undefined ? {} : { ownerTeam: r('team', ownerTeam) }),
      }),
    ),
  field: (d) =>
    parse(
      z.object({
        name: text,
        description: text,
        type: z.enum([
          'text',
          'paragraph',
          'number',
          'date',
          'datetime',
          'select',
          'cascading-select',
          'user',
          'group',
          'labels',
          'url',
          'read-only-text',
          'release',
          'area',
          'formula',
          'team',
        ]),
        multiple: z.boolean(),
        config: z.record(z.string(), json),
        track: nullableId,
      }),
      d,
      (x) => ({ kind: 'field', ...x, track: nr('track', x.track) }),
    ),
  field_context: (d) =>
    parse(
      z.object({
        field: id,
        name: text,
        description: text,
        defaultValue: json.nullable(),
        config: z.record(z.string(), json),
        scopes: z.array(z.object({ track: nullableId, type: nullableId })),
      }),
      d,
      (x) => ({
        kind: 'field_context',
        field: r('field', x.field),
        name: x.name,
        description: x.description,
        defaultValue: x.defaultValue ?? null,
        config: x.config,
        scopes: x.scopes.map((s) => ({
          track: nr('track', s.track),
          type: nr('ticket_type', s.type),
        })),
      }),
    ),
  field_option: (d) =>
    parse(
      z.object({
        context: id,
        parent: nullableId,
        value: text,
        sortOrder: z.number().int(),
        disabled: z.boolean(),
        default: z.boolean(),
      }),
      d,
      (x) => ({
        kind: 'field_option',
        context: r('field_context', x.context),
        parent: nr('field_option', x.parent),
        value: x.value,
        sortOrder: x.sortOrder,
        disabled: x.disabled,
        default: x.default,
      }),
    ),
  workflow: (d) =>
    parse(
      z.object({ name: text, description: text, isDefault: z.boolean(), definition: json }),
      d,
      (x) => ({ kind: 'workflow', ...x, definition: x.definition as JsonValue }),
    ),
  workflow_map: (d) =>
    parse(
      z.object({
        name: text,
        description: text,
        isDefault: z.boolean(),
        defaultWorkflow: id,
        entries: z.array(z.object({ type: id, workflow: id })),
        tracks: ids,
      }),
      d,
      (x) => ({
        kind: 'workflow_map',
        name: x.name,
        description: x.description,
        isDefault: x.isDefault,
        defaultWorkflow: r('workflow', x.defaultWorkflow),
        entries: x.entries.map((e) => ({
          type: r('ticket_type', e.type),
          workflow: r('workflow', e.workflow),
        })),
        tracks: x.tracks.map((t) => r('track', t)),
      }),
    ),
  ticket: (d) => {
    if ((d as { visibilityLevel?: unknown }).visibilityLevel != null) {
      // Visibility policies are not carried: imported, it would show to everyone.
      return { fail: 'visibility_level_not_carried' };
    }
    return parse(
      z.object({
        track: id,
        number: z.number().int().positive(),
        type: id,
        status: id,
        parent: nullableId,
        summary: text,
        description: json.nullable(),
        environment: json.nullable(),
        assignee: nullableId,
        requester: nullableId,
        creator: nullableId,
        priority: nullableId,
        closeReason: nullableId,
        labels: z.array(text),
        startDate: nullableText,
        dueDate: nullableText,
        createdAt: text,
        updatedAt: text,
        closedAt: nullableText,
        originalEstimate: z.number().int().nullable(),
        remainingEstimate: z.number().int().nullable(),
        timeSpent: z.number().int(),
        rank: text,
        fields: z.record(z.string(), json),
        targetReleases: ids,
        foundInReleases: ids,
        areas: ids,
        followers: ids,
        voters: ids,
        deletedAt: nullableText,
        deletedBy: nullableId,
        trashedWith: nullableId,
      }),
      d,
      (t) => ({
        kind: 'ticket',
        track: r('track', t.track),
        number: t.number,
        type: r('ticket_type', t.type),
        status: r('status', t.status),
        summary: t.summary,
        description: null,
        docs: {
          description: (t.description ?? null) as JsonValue | null,
          environment: (t.environment ?? null) as JsonValue | null,
        },
        assignee: nr('user', t.assignee),
        requester: nr('user', t.requester),
        creator: nr('user', t.creator),
        parent: nr('ticket', t.parent),
        priority: null,
        priorityRef: nr('priority', t.priority),
        closeReason: nr('close_reason', t.closeReason),
        labels: t.labels,
        startDate: t.startDate,
        dueDate: t.dueDate,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        closedAt: t.closedAt,
        originalEstimate: t.originalEstimate,
        remainingEstimate: t.remainingEstimate,
        timeSpent: t.timeSpent,
        rank: t.rank,
        fields: t.fields as Record<string, JsonValue>,
        releases: {
          target: t.targetReleases.map((x) => r('release', x)),
          found: t.foundInReleases.map((x) => r('release', x)),
        },
        areas: t.areas.map((x) => r('area', x)),
        followers: t.followers.map((x) => r('user', x)),
        voters: t.voters.map((x) => r('user', x)),
        trash:
          t.deletedAt === null
            ? null
            : {
                deletedAt: t.deletedAt,
                deletedBy: nr('user', t.deletedBy),
                trashedWith: nr('ticket', t.trashedWith),
              },
      }),
    );
  },
  comment: (d) =>
    parse(
      z.object({
        ticket: id,
        author: nullableId,
        body: json,
        visibleGroup: nullableId,
        visibleRole: nullableId,
        createdAt: text,
        updatedAt: text,
        editedAt: nullableText,
        editedBy: nullableId,
        deletedAt: nullableText,
        deletedBy: nullableId,
      }),
      d,
      (c) => ({
        kind: 'comment',
        ticket: r('ticket', c.ticket),
        author: nr('user', c.author),
        body: '',
        doc: c.body as JsonValue,
        visibleGroup: nr('group', c.visibleGroup),
        visibleRole: nr('role', c.visibleRole),
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        editedAt: c.editedAt,
        editedBy: nr('user', c.editedBy),
        deletedAt: c.deletedAt,
        deletedBy: nr('user', c.deletedBy),
      }),
    ),
  link: (d) =>
    parse(
      z.object({
        source: id,
        target: id,
        type: z.object({ name: text, outward: text, inward: text }),
        creator: nullableId,
        createdAt: text,
      }),
      d,
      (l) => ({
        kind: 'link',
        source: r('ticket', l.source),
        target: r('ticket', l.target),
        linkType: l.type,
        creator: nr('user', l.creator),
        createdAt: l.createdAt,
      }),
    ),
  time_entry: (d) =>
    parse(
      z.object({
        ticket: id,
        author: id,
        startedAt: text,
        seconds: z.number().int(),
        description: text,
        visibleGroup: nullableId,
        visibleRole: nullableId,
        createdBy: nullableId,
        createdAt: text,
        updatedAt: text,
      }),
      d,
      (e) => ({
        kind: 'time_entry',
        ticket: r('ticket', e.ticket),
        author: r('user', e.author),
        startedAt: e.startedAt,
        seconds: e.seconds,
        description: e.description,
        visibleGroup: nr('group', e.visibleGroup),
        visibleRole: nr('role', e.visibleRole),
        createdBy: nr('user', e.createdBy),
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      }),
    ),
  checklist: (d) =>
    parse(
      z.object({
        ticket: id,
        name: text,
        position: z.number().int(),
        creator: nullableId,
        createdAt: text,
        updatedAt: text,
        items: z.array(
          z.object({
            text,
            state: z.enum(['open', 'in_progress', 'done', 'rejected']),
            position: z.number().int(),
            creator: nullableId,
            createdAt: text,
            updatedAt: text,
          }),
        ),
      }),
      d,
      (c) => ({
        kind: 'checklist',
        ticket: r('ticket', c.ticket),
        name: c.name,
        position: c.position,
        creator: nr('user', c.creator),
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        items: c.items.map((item) => ({ ...item, creator: nr('user', item.creator) })),
      }),
    ),
  attachment: (d) =>
    parse(
      z.object({
        ticket: id,
        name: text,
        declaredType: text,
        sniffedType: nullableText,
        size: z.number().int().min(0),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        author: nullableId,
        createdAt: text,
        width: z.number().int().nullable(),
        height: z.number().int().nullable(),
        file: text,
      }),
      d,
      (a) => ({
        kind: 'attachment',
        ...a,
        ticket: r('ticket', a.ticket),
        author: nr('user', a.author),
      }),
    ),
  history: (d) =>
    parse(
      z.object({
        ticket: id,
        at: text,
        actor: nullableId,
        items: z.array(
          z.object({
            field: text,
            from: nullableText,
            to: nullableText,
            fromDisplay: nullableText,
            toDisplay: nullableText,
            transition: z.number().int().nullable(),
          }),
        ),
      }),
      d,
      (h) => ({
        kind: 'history',
        ticket: r('ticket', h.ticket),
        actor: nr('user', h.actor),
        at: h.at,
        items: [],
        stored: h.items,
      }),
    ),
};

function parse<S extends z.ZodTypeAny>(
  schema: S,
  data: Record<string, unknown>,
  command: (value: z.infer<S>) => Command,
  warnings: (value: z.infer<S>) => Warning[] = () => [],
): Mapped {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { fail: `invalid_record:${first?.path.join('.') ?? ''}` };
  }
  return { command: command(parsed.data), warnings: warnings(parsed.data) };
}

export function mapExportRecord(record: SourceRecord): Mapped {
  const mapper = MAPPERS[record.kind];
  return mapper ? mapper(record.data) : { fail: 'unsupported_kind' };
}

export const exportFormat: ImportFormat = {
  importSource: EXPORT_SOURCE,
  open: (source) => new ExportSource(exportSource.parse(source).path),
  map: mapExportRecord,
  verbatim: true,
};
