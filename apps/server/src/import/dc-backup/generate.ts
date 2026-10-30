import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import yazl from 'yazl';
import {
  ACTIVE_OBJECTS_FILE,
  AO_NAMESPACE,
  AO_ROOT,
  AO_TABLES,
  ATTRIBUTE_TEXT_MAX,
  attachmentPath,
  ENTITIES_FILE,
  ENTITIES_ROOT,
  ENTITY_ORDER,
  type EntityName,
  STATUS_CATEGORIES,
  timestamp,
  XSI_NAMESPACE,
} from './format';
import {
  type GeneratorOptions,
  generatorOptions,
  MANIFEST_FORMAT,
  type Manifest,
} from './manifest';
import * as parts from './parts';
import { Random } from './random';
import { buildWorld, FIRST_ID, type Person, type World, walkIssues } from './world';
import { escapeAttr, TextOut } from './xml';

/**
 * The synthetic Data Center backup generator (M1-087): a seeded, streaming writer of a backup
 * ZIP in the shape `format.ts` describes, at any size (10,000 and 1,000,000 issues are the
 * tested ones), with a manifest of exact counts beside it. Memory holds the small parts of the
 * instance (people, projects, boards) and one issue at a time; the ZIP's central directory
 * grows with the number of attachment files.
 */

/** Options for a size, scaled the way real instances grow; any of them can be overridden. */
export function defaultOptions(
  issues: number,
  seed: number,
  overrides: Partial<GeneratorOptions> = {},
): GeneratorOptions {
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));
  const users = overrides.users ?? clamp(issues / 200, 20, 5000);
  return generatorOptions.parse({
    seed,
    issues,
    projects: clamp(issues / 2500, 2, 400),
    users,
    groups: clamp(users / 25, 3, 200),
    attachmentRate: 0.05,
    forbiddenRate: 0.002,
    exportedAt: '2026-01-01T00:00:00.000Z',
    compressionLevel: 6,
    ...overrides,
  });
}

/** `backup.zip` keeps its manifest in `backup.manifest.json`. */
export function manifestPathFor(zipPath: string): string {
  return `${zipPath.replace(/\.zip$/i, '')}.manifest.json`;
}

type Value = string | number | null | undefined;

/** A text value, and the stream that decides whether it carries a forbidden character. */
interface TextValue {
  text: string;
  poison?: Random;
}

const CONTROL = [1, 2, 3, 4, 5, 6, 7, 8, 11, 12, 14, 15, 16, 20, 27, 31];
const CHAR_REFS = ['&#0;', '&#x1;', '&#12;', '&#xFFFE;', '&#65535;', '&#x8;'];

/** Writes entity rows and counts everything the manifest says about them. */
class EntityWriter {
  readonly counts: Record<string, number> = {};
  readonly maxIds: Record<string, number> = {};
  readonly cases: Record<string, number> = {
    textInChildElements: 0,
    cdataSplits: 0,
  };
  readonly forbidden = { nul: 0, control: 0, noncharacter: 0, charRef: 0 };
  readonly deletedReferenced = new Set<string>();

  constructor(
    private readonly out: TextOut,
    private readonly forbiddenRate: number,
  ) {}

  note(name: string, by = 1): void {
    this.cases[name] = (this.cases[name] ?? 0) + by;
  }

  /** A person as a user attribute; deleted people are counted, they have no rows. */
  user(person: Person | null): string | null {
    if (!person) return null;
    if (person.deleted) {
      this.deletedReferenced.add(person.key);
      this.note('deletedUserReferences');
    }
    return person.key;
  }

  /** Writes one row; resolves only when a chunk had to wait for the ZIP. */
  async row(name: EntityName, values: Record<string, Value | TextValue>): Promise<void> {
    const attrs: string[] = [];
    const children: string[] = [];
    for (const [key, value] of Object.entries(values)) {
      if (value === null || value === undefined) continue;
      if (typeof value === 'object') {
        if (value.text.includes('\n') || value.text.length > ATTRIBUTE_TEXT_MAX) {
          children.push(`        <${key}><![CDATA[${this.cdata(value)}]]></${key}>\n`);
          this.cases.textInChildElements = (this.cases.textInChildElements ?? 0) + 1;
        } else {
          attrs.push(` ${key}="${this.poisoned(escapeAttr(value.text), value.poison, true)}"`);
        }
        continue;
      }
      if (key === 'id') {
        const n = Number(value);
        if (n > (this.maxIds[name] ?? 0)) this.maxIds[name] = n;
      }
      attrs.push(` ${key}="${typeof value === 'number' ? value : escapeAttr(value)}"`);
    }
    this.counts[name] = (this.counts[name] ?? 0) + 1;
    const line =
      children.length === 0
        ? `    <${name}${attrs.join('')}/>\n`
        : `    <${name}${attrs.join('')}>\n${children.join('')}    </${name}>\n`;
    if (this.out.push(line)) await this.out.flush();
  }

  private cdata(value: TextValue): string {
    const pieces = value.text.split(']]>');
    this.cases.cdataSplits = (this.cases.cdataSplits ?? 0) + pieces.length - 1;
    return this.poisoned(pieces.join(']]]]><![CDATA[>'), value.poison, false);
  }

  /** Puts one character XML forbids into already escaped text, sometimes. */
  private poisoned(escaped: string, random: Random | undefined, attribute: boolean): string {
    if (!random?.chance(this.forbiddenRate)) return escaped;
    const kinds = attribute
      ? (['nul', 'control', 'noncharacter', 'charRef'] as const)
      : (['nul', 'control', 'noncharacter'] as const);
    const kind = random.pick(kinds);
    this.forbidden[kind]++;
    const bad =
      kind === 'nul'
        ? '\u0000'
        : kind === 'control'
          ? String.fromCharCode(random.pick(CONTROL))
          : kind === 'noncharacter'
            ? random.pick(['￾', '￿'])
            : random.pick(CHAR_REFS);
    const at = escaped.indexOf(' ');
    return at < 0 ? escaped + bad : escaped.slice(0, at) + bad + escaped.slice(at);
  }
}

const bool = (b: boolean) => (b ? 1 : 0);

/** The entity rows of one element name. */
async function writeEntity(world: World, w: EntityWriter, name: EntityName): Promise<void> {
  const seed = world.options.seed;
  const poison = (label: string, index: number) => Random.derive(seed, `poison:${label}`, index);
  switch (name) {
    case 'Directory':
      await w.row(name, {
        id: 1,
        directoryName: 'Internal directory',
        active: 1,
        directoryPosition: 0,
      });
      return;
    case 'User':
      for (const p of world.users) {
        await w.row(name, {
          id: p.id,
          directoryId: 1,
          userName: p.username,
          lowerUserName: p.username.toLowerCase(),
          active: bool(p.active),
          createdDate: timestamp(p.created),
          updatedDate: timestamp(p.created),
          firstName: p.firstName,
          lowerFirstName: p.firstName.toLowerCase(),
          lastName: p.lastName,
          lowerLastName: p.lastName.toLowerCase(),
          displayName: p.displayName,
          lowerDisplayName: p.displayName.toLowerCase(),
          emailAddress: p.email,
          lowerEmailAddress: p.email.toLowerCase(),
        });
      }
      return;
    case 'ApplicationUser':
      for (const p of world.users) {
        await w.row(name, { id: p.id, userKey: p.key, lowerUserName: p.username.toLowerCase() });
      }
      return;
    case 'Group':
      for (const g of world.groups) {
        await w.row(name, {
          id: g.id,
          groupName: g.name,
          lowerGroupName: g.name.toLowerCase(),
          active: 1,
          local: 0,
          createdDate: timestamp(world.start),
          updatedDate: timestamp(world.start),
          type: 'GROUP',
          directoryId: 1,
        });
      }
      return;
    case 'Membership': {
      let id = FIRST_ID;
      for (const g of world.groups) {
        for (const m of g.members) {
          const p = world.people[m] as Person;
          await w.row(name, {
            id: id++,
            parentId: g.id,
            childId: p.id,
            membershipType: 'GROUP_USER',
            parentName: g.name,
            lowerParentName: g.name.toLowerCase(),
            childName: p.username,
            lowerChildName: p.username.toLowerCase(),
            directoryId: 1,
          });
        }
      }
      return;
    }
    case 'ProjectRole':
      for (const role of world.roles) {
        await w.row(name, { id: role.id, name: role.name, description: role.description });
      }
      return;
    case 'ProjectRoleActor': {
      let id = FIRST_ID;
      const [managers, contributors, observers] = world.roles.map((r) => r.id) as [
        number,
        number,
        number,
      ];
      for (const project of world.projects) {
        const r = Random.derive(seed, 'role-actors', project.index);
        const actor = async (role: number, type: 'user' | 'group', parameter: string) =>
          w.row(name, {
            id: id++,
            pid: project.id,
            projectroleid: role,
            roletype: `atlassian-${type}-role-actor`,
            roletypeparameter: parameter,
          });
        await actor(managers, 'user', project.lead.key);
        await actor(contributors, 'group', r.pick(world.groups).name);
        const seen = new Set<string>([project.lead.key]);
        for (let n = r.int(0, 2); n > 0; n--) {
          const p = world.users[r.int(0, world.users.length - 1)] as Person;
          if (seen.has(p.key)) continue;
          seen.add(p.key);
          await actor(observers, 'user', p.key);
        }
      }
      return;
    }
    case 'Project':
      for (const p of world.projects) {
        await w.row(name, {
          id: p.id,
          name: p.name,
          key: p.key,
          originalkey: p.key,
          lead: w.user(p.lead),
          description: { text: p.description },
          counter: p.counter,
          projecttype: p.type,
        });
      }
      return;
    case 'IssueType':
      for (const [k, t] of world.issueTypes.entries()) {
        await w.row(name, {
          id: t.id,
          sequence: k,
          name: t.name,
          style: t.subtask ? 'jira_subtask' : null,
          description: t.description,
        });
      }
      return;
    case 'Status':
      for (const [k, s] of world.statuses.entries()) {
        await w.row(name, {
          id: s.id,
          sequence: k,
          name: s.name,
          description: `Work that is ${s.name.toLowerCase()}`,
          statuscategory: STATUS_CATEGORIES[s.category],
        });
      }
      return;
    case 'Priority':
    case 'Resolution':
      for (const [k, x] of (name === 'Priority' ? world.priorities : world.resolutions).entries()) {
        await w.row(name, { id: x.id, sequence: k, name: x.name, description: x.description });
      }
      return;
    case 'IssueLinkType':
      for (const t of world.linkTypes) {
        await w.row(name, {
          id: t.id,
          linkname: t.name,
          inward: t.inward,
          outward: t.outward,
          style: t.subtask ? 'jira_subtask' : null,
        });
      }
      return;
    case 'SearchRequest':
      for (const b of world.boards) {
        await w.row(name, {
          id: b.filterId,
          name: `Filter for ${b.name}`,
          author: w.user(b.owner),
          request: { text: `project = ${b.project.key} ORDER BY Rank ASC` },
        });
      }
      return;
    case 'Issue':
      for (const issue of walkIssues(world)) {
        const logs = parts.worklogs(world, issue);
        const spent = logs.reduce((sum, l) => sum + l.seconds, 0);
        const text = parts.description(world, issue);
        if (issue.skipped) w.note('issueNumbersSkipped', issue.skipped);
        if (issue.parent) w.note('subtasks');
        if (!issue.assignee) w.note('unassignedIssues');
        if (issue.resolution) w.note('resolvedIssues');
        await w.row(name, {
          id: issue.id,
          project: issue.project.id,
          number: issue.number,
          type: issue.type.id,
          status: issue.status.id,
          priority: issue.priority.id,
          resolution: issue.resolution?.id,
          reporter: w.user(issue.reporter),
          assignee: w.user(issue.assignee),
          creator: w.user(issue.creator),
          summary: { text: parts.summary(world, issue), poison: poison('summary', issue.index) },
          description: text === null ? null : { text, poison: poison('description', issue.index) },
          created: timestamp(issue.created),
          updated: timestamp(issue.updated),
          resolutiondate: issue.resolved === null ? null : timestamp(issue.resolved),
          duedate: issue.due === null ? null : timestamp(issue.due - (issue.due % 86_400_000)),
          votes: issue.votes,
          watches: issue.watches,
          timeoriginalestimate: issue.estimate,
          timeestimate: issue.estimate === null ? null : Math.max(0, issue.estimate - spent),
          timespent: spent === 0 ? null : spent,
        });
      }
      return;
    case 'Action': {
      let id = FIRST_ID;
      for (const issue of walkIssues(world)) {
        const r = poison('comment', issue.index);
        for (const c of parts.comments(world, issue)) {
          if (c.group) w.note('commentsForGroup');
          if (c.role) w.note('commentsForRole');
          if (c.updated !== c.created) w.note('commentsEdited');
          await w.row(name, {
            id: id++,
            issue: issue.id,
            author: w.user(c.author),
            type: 'comment',
            level: c.group,
            rolelevel: c.role,
            body: { text: c.body, poison: r },
            created: timestamp(c.created),
            updateauthor: w.user(c.updateAuthor),
            updated: timestamp(c.updated),
          });
        }
      }
      return;
    }
    case 'ChangeGroup':
    case 'ChangeItem': {
      let group = FIRST_ID;
      let item = FIRST_ID;
      for (const issue of walkIssues(world)) {
        for (const g of parts.history(world, issue)) {
          if (name === 'ChangeGroup') {
            if (!g.author) w.note('anonymousChanges');
            await w.row(name, {
              id: group,
              issue: issue.id,
              author: w.user(g.author),
              created: timestamp(g.created),
            });
          } else {
            for (const i of g.items) {
              if (i.fieldtype === 'custom') w.note('customFieldChanges');
              await w.row(name, {
                id: item++,
                group,
                fieldtype: i.fieldtype,
                field: i.field,
                oldvalue: i.oldvalue,
                oldstring: i.oldstring === null ? null : { text: i.oldstring },
                newvalue: i.newvalue,
                newstring: i.newstring === null ? null : { text: i.newstring },
              });
            }
          }
          group++;
        }
      }
      return;
    }
    case 'IssueLink': {
      let id = FIRST_ID;
      for (const issue of walkIssues(world)) {
        for (const l of parts.links(world, issue)) {
          await w.row(name, {
            id: id++,
            linktype: l.linkType,
            source: l.source,
            destination: l.destination,
            sequence: l.sequence,
          });
        }
      }
      return;
    }
    case 'Label': {
      let id = FIRST_ID;
      for (const issue of walkIssues(world)) {
        for (const label of parts.labels(world, issue)) {
          await w.row(name, { id: id++, issue: issue.id, label });
        }
      }
      return;
    }
    case 'Worklog': {
      let id = FIRST_ID;
      for (const issue of walkIssues(world)) {
        const r = poison('worklog', issue.index);
        for (const l of parts.worklogs(world, issue)) {
          await w.row(name, {
            id: id++,
            issue: issue.id,
            author: w.user(l.author),
            body: l.body === null ? null : { text: l.body, poison: r },
            created: timestamp(l.created),
            updateauthor: w.user(l.updateAuthor),
            updated: timestamp(l.updated),
            startdate: timestamp(l.started),
            timeworked: l.seconds,
          });
        }
      }
      return;
    }
    case 'FileAttachment': {
      let id = FIRST_ID;
      for (const issue of walkIssues(world)) {
        for (const a of parts.attachments(world, issue)) {
          await w.row(name, {
            id: id++,
            issue: issue.id,
            mimetype: a.mimetype,
            filename: a.filename,
            created: timestamp(a.created),
            filesize: a.size,
            author: w.user(a.author),
            zip: 0,
            thumbnailable: 0,
          });
        }
      }
      return;
    }
    case 'SequenceValueItem':
      for (const entity of ENTITY_ORDER) {
        const max = w.maxIds[entity];
        if (entity === 'SequenceValueItem' || max === undefined) continue;
        // The next free id, rounded up to the block of ten ids the server hands out.
        await w.row(name, { seqName: entity, seqId: Math.ceil((max + 1) / 10) * 10 });
      }
      return;
  }
}

/** The attachment files in the order of their rows, with their ZIP paths. */
function* attachmentFiles(world: World): Generator<{ id: number; path: string; size: number }> {
  let id = FIRST_ID;
  for (const issue of walkIssues(world)) {
    for (const a of parts.attachments(world, issue)) {
      yield {
        id,
        path: attachmentPath(issue.project.key, issue.number, issue.key, id),
        size: a.size,
      };
      id++;
    }
  }
}

function aoValue(type: string, value: string | number | boolean | null): string {
  if (value === null) return `<${type} xsi:nil="true"/>`;
  return `<${type}>${typeof value === 'string' ? escapeAttr(value) : String(value)}</${type}>`;
}

async function writeActiveObjects(world: World, out: TextOut): Promise<Record<string, number>> {
  out.push('<?xml version="1.0" encoding="UTF-8"?>\n');
  out.push(`<${AO_ROOT} xmlns="${AO_NAMESPACE}" xmlns:xsi="${XSI_NAMESPACE}">\n`);
  for (const [table, columns] of Object.entries(AO_TABLES)) {
    out.push(`    <table name="${table}">\n`);
    for (const c of columns) {
      out.push(
        `        <column name="${c.name}" primaryKey="${!!c.primaryKey}" autoIncrement="${!!c.autoIncrement}" sqlType="${c.sqlType}" precision="${c.precision ?? 0}"/>\n`,
      );
    }
    out.push('    </table>\n');
  }
  const rows: Record<string, (string | number | boolean | null)[][]> = {
    AO_60DB71_RAPIDVIEW: world.boards.map((b) => [b.id, b.name, b.owner.key, b.filterId, true]),
    AO_60DB71_SPRINT: world.sprints.map((s) => [
      s.id,
      s.name,
      s.board.id,
      s.started,
      s.closed,
      s.start,
      s.end,
      s.complete,
      s.goal,
      s.sequence,
    ]),
  };
  const counts: Record<string, number> = {};
  for (const [table, columns] of Object.entries(AO_TABLES)) {
    out.push(`    <data tableName="${table}">\n`);
    for (const c of columns) out.push(`        <column name="${c.name}"/>\n`);
    for (const row of rows[table] ?? []) {
      const values = row.map((v, k) => aoValue((columns[k] as { type: string }).type, v));
      out.push(`        <row>\n            ${values.join('\n            ')}\n        </row>\n`);
      counts[table] = (counts[table] ?? 0) + 1;
    }
    out.push('    </data>\n');
    counts[table] ??= 0;
  }
  out.push(`</${AO_ROOT}>\n`);
  return counts;
}

export interface Generated {
  zip: string;
  manifestPath: string;
  manifest: Manifest;
}

/**
 * Writes the backup to `zipPath` (through a `.part` file, renamed at the end) and its manifest
 * beside it. The same options give the same manifest; the ZIP's bytes also depend on zlib.
 */
export async function generateDcBackup(
  options: GeneratorOptions,
  zipPath: string,
): Promise<Generated> {
  const checked = generatorOptions.parse(options);
  const world = buildWorld(checked);
  const mtime = new Date(checked.exportedAt);
  const entry = {
    mtime,
    compress: checked.compressionLevel > 0,
    compressionLevel: checked.compressionLevel,
  };
  await mkdir(dirname(zipPath), { recursive: true });
  const part = `${zipPath}.part`;
  const zip = new yazl.ZipFile();
  const file = createWriteStream(part);
  zip.outputStream.pipe(file);
  const written = finished(file);
  // Observed here too, so a failure before the end does not surface as an unhandled rejection.
  written.catch(() => undefined);
  let failure: unknown;
  zip.outputStream.on('error', (error) => {
    failure ??= error;
    file.destroy(error as Error);
  });

  try {
    // entities.xml
    const entitiesStream = new PassThrough({ highWaterMark: 1 << 20 });
    zip.addReadStream(entitiesStream, ENTITIES_FILE, entry);
    const entitiesOut = new TextOut(entitiesStream);
    const w = new EntityWriter(entitiesOut, checked.forbiddenRate);
    entitiesOut.push(`<?xml version="1.0" encoding="UTF-8"?>\n<${ENTITIES_ROOT}>\n`);
    for (const name of ENTITY_ORDER) await writeEntity(world, w, name);
    entitiesOut.push(`</${ENTITIES_ROOT}>\n`);
    const entities = await entitiesOut.close();

    // activeobjects.xml
    const aoStream = new PassThrough({ highWaterMark: 1 << 20 });
    zip.addReadStream(aoStream, ACTIVE_OBJECTS_FILE, entry);
    const aoOut = new TextOut(aoStream);
    const activeObjects = await writeActiveObjects(world, aoOut);
    const ao = await aoOut.close();

    // data/attachments/...: each file's bytes are made when the ZIP reaches it.
    const hash = createHash('sha256');
    let files = 0;
    let bytes = 0;
    for (const f of attachmentFiles(world)) {
      const content = parts.attachmentBytes(world, f.id, f.size);
      hash.update(`${f.path}\n`);
      hash.update(content);
      files++;
      bytes += content.length;
      zip.addReadStreamLazy(f.path, { ...entry, size: f.size }, (cb) =>
        cb(null, Readable.from([parts.attachmentBytes(world, f.id, f.size)])),
      );
    }
    zip.end();
    await written;
    if (failure) throw failure;
    await rename(part, zipPath);

    const sprintState = (s: World['sprints'][number]) =>
      s.closed ? 'sprintsClosed' : s.started ? 'sprintsActive' : 'sprintsFuture';
    const cases: Record<string, number> = {
      usersPresent: world.users.length,
      usersInactive: world.users.filter((p) => !p.active).length,
      usersDeleted: world.people.length - world.users.length,
      usersDeletedReferenced: w.deletedReferenced.size,
      userKeysFromNames: world.users.filter((p) => p.key === p.username.toLowerCase()).length,
      userKeysGenerated: world.users.filter((p) => p.key !== p.username.toLowerCase()).length,
      sprintsClosed: 0,
      sprintsActive: 0,
      sprintsFuture: 0,
      ...w.cases,
    };
    for (const s of world.sprints) cases[sprintState(s)] = (cases[sprintState(s)] ?? 0) + 1;
    const manifest: Manifest = {
      format: MANIFEST_FORMAT,
      version: 1,
      options: checked,
      files: { entities, activeObjects: ao },
      attachments: { files, bytes, sha256: hash.digest('hex') },
      entities: sortKeys(w.counts),
      activeObjects: sortKeys(activeObjects),
      cases: sortKeys(cases),
      forbidden: w.forbidden,
    };
    const manifestPath = manifestPathFor(zipPath);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return { zip: zipPath, manifestPath, manifest };
  } catch (error) {
    file.destroy();
    await rm(part, { force: true });
    throw error;
  }
}

function sortKeys(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}
