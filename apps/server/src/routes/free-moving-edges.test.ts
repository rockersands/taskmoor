import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { EVENT_TYPES } from '../events/catalogue';
import { lockList } from '../tickets/fields';
import { repairWorkflowMoves } from '../workflows/free-moves';

/**
 * The edges of free moving the T-207 review found (WF-008 (1), (4); ADR-116): a status whose stage
 * changes (T-209), a status added through the draft API and a workflow left with no transitions
 * (T-210, T-237), a board's change of its workflow read under the lock (T-238), and the reason
 * free moves close with, before and after Completed is replaced (T-234).
 */
const PASSWORD = 'harbour ladder violet';
let address = 0;
const nextAddress = () => `100.73.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

interface Effect {
  type: string;
  field?: string;
  value?: unknown;
}
interface Transition {
  id: number;
  name: string;
  from: 'any' | number[];
  to: number;
  layout?: string[];
  checks?: unknown[];
  effects?: Effect[];
}
interface Definition {
  initialStatusId: number;
  statuses: { statusId: number }[];
  transitions: Transition[];
  board?: { boardId: number; columns: number[] };
}
interface Version {
  version: number;
  definition: Definition;
}
interface View {
  id: number;
  published: Version;
  draft: Version | null;
}
interface Column {
  id?: string;
  name: string;
  statusIds: number[];
}
interface Board {
  id: number;
  version: number;
  columns: Column[];
}

const CLEAR: Effect[] = [{ type: 'clear-field', field: 'close-reason' }];
const setting = (reasonId: number): Effect[] => [
  { type: 'update-system-field', field: 'close-reason', value: String(reasonId) },
];

describe('free moving at its edges (WF-008)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let cookie = '';
  const status: Record<string, number> = {};
  const reason: Record<string, number> = {};

  const as = (options: InjectOptions) =>
    app.inject({ ...options, remoteAddress: nextAddress(), headers: { cookie } });
  const get = (url: string) => as({ method: 'GET', url });
  const post = (url: string, payload?: Record<string, unknown>) =>
    as({ method: 'POST', url, ...(payload ? { payload } : {}) });
  const patch = (url: string, payload: Record<string, unknown>) =>
    as({ method: 'PATCH', url, payload });
  const put = (url: string, payload: Record<string, unknown>) =>
    as({ method: 'PUT', url, payload });

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: 'admin@example.com',
        name: 'admin',
        password_hash: await hashPassword(PASSWORD),
        is_site_admin: true,
      })
      .execute();
    const session = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'admin@example.com', password: PASSWORD },
      remoteAddress: nextAddress(),
    });
    const set = session.headers['set-cookie'];
    const list = Array.isArray(set) ? set : set ? [set] : [];
    cookie = list.find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split(';')[0] ?? '';
    for (const s of (await get('/api/v1/statuses')).json().statuses) status[s.name] = s.id;
    for (const r of (await get('/api/v1/close-reasons')).json().closeReasons) reason[r.name] = r.id;
  });
  afterAll(async () => {
    await app?.close();
  });

  const view = async (id: number) => (await get(`/api/v1/workflows/${id}`)).json().workflow as View;
  const defaultId = async () =>
    (
      (await get('/api/v1/workflows')).json().workflows as { id: number; isDefault: boolean }[]
    ).find((w) => w.isDefault)?.id as number;
  const draftOf = (v: View) => {
    if (!v.draft) throw new Error(`workflow ${v.id} has no draft`);
    return v.draft.definition;
  };
  const into = (definition: Definition, statusId: number) =>
    definition.transitions.find((t) => t.to === statusId);
  const events = (type: string) =>
    database.db
      .selectFrom('domain_event')
      .select(['type', 'payload'])
      .where('type', '=', type)
      .orderBy('id')
      .execute();
  const eventCount = async () =>
    Number(
      (
        await database.db
          .selectFrom('domain_event')
          .select((eb) => eb.fn.countAll().as('n'))
          .executeTakeFirstOrThrow()
      ).n,
    );
  const reasonOf = async (name: string) =>
    (
      (await get('/api/v1/close-reasons')).json().closeReasons as { id: number; name: string }[]
    ).find((r) => r.name === name)?.id as number;
  const newStatus = async (name: string, stage: 'new' | 'active' | 'closed') => {
    const made = await post('/api/v1/statuses', { name, stage });
    expect(made.statusCode, made.body).toBe(201);
    status[name] = made.json().status.id;
    return made.json().status.id as number;
  };
  const freeWorkflow = async (name: string, statusIds: number[]) => {
    const created = await post('/api/v1/workflows', {
      name,
      definition: {
        initialStatusId: statusIds[0],
        statuses: statusIds.map((statusId) => ({ statusId })),
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    return created.json().workflow.id as number;
  };
  const saveDraft = async (id: number, definition: Definition) => {
    const saved = await put(`/api/v1/workflows/${id}/draft`, { definition });
    expect(saved.statusCode, saved.body).toBe(200);
    return saved.json().workflow as View;
  };
  /** Until this many sessions wait on a lock (at most three seconds). */
  const lockWaits = async (count: number) => {
    const waiting = async () =>
      Number(
        (
          await sql<{ n: number }>`
            SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(database.db)
        ).rows[0]?.n,
      );
    for (let tries = 0; tries < 300 && (await waiting()) < count; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  /** A gate a test opens: `open()` lets whatever awaits `opened` go on. */
  const gate = () => {
    let open = () => {};
    const opened = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { open, opened };
  };
  const move = async (ticket: number, transitionId: number | undefined) => {
    const moved = await post(`/api/v1/tickets/${ticket}/transitions`, { transitionId });
    expect(moved.statusCode, moved.body).toBe(200);
    return moved.json().ticket as {
      status: { id: number };
      closeReason: { name: string } | null;
      closedAt: string | null;
    };
  };

  /**
   * A local-mode track whose board manages its workflow, with a column for each of `names` (after
   * the first) whose status only that workflow uses.
   */
  const managedBoard = async (key: string, names: string[]) => {
    const track = await post('/api/v1/tracks', { key, name: `Track ${key}`, mode: 'local' });
    expect(track.statusCode, track.body).toBe(201);
    const trackId = track.json().track.id as number;
    const made = await post('/api/v1/boards', {
      name: `Board ${key}`,
      kind: 'kanban',
      trackId,
      source: { query: `track = ${key}` },
    });
    expect(made.statusCode, made.body).toBe(201);
    const managed = await put(`/api/v1/boards/${made.json().board.id}/workflow`, {
      managed: true,
    });
    expect(managed.statusCode, managed.body).toBe(200);
    const board = managed.json().board as Board;
    const added = await patch(`/api/v1/boards/${board.id}`, {
      version: board.version,
      columns: [
        ...board.columns.slice(0, 1),
        ...names.map((name) => ({ name, statusIds: [] })),
        ...board.columns.slice(1),
      ],
    });
    expect(added.statusCode, added.body).toBe(200);
    const workflow = await database.db
      .selectFrom('workflow')
      .select('id')
      .where('owner_track_id', '=', trackId)
      .executeTakeFirstOrThrow();
    return { workflowId: workflow.id, board: added.json().board as Board };
  };

  /**
   * A track's own workflow as an ordinary one: its board stopped managing it, and a version without
   * the board was published. A column added without a status lets the board take it over again.
   */
  const ordinaryTrackWorkflow = async (key: string, names: string[]) => {
    const { workflowId, board } = await managedBoard(key, names);
    const off = await put(`/api/v1/boards/${board.id}/workflow`, { managed: false });
    expect(off.statusCode, off.body).toBe(200);
    const { board: _board, ...ordinary } = (await view(workflowId)).published.definition;
    await saveDraft(workflowId, ordinary);
    const published = await post(`/api/v1/workflows/${workflowId}/publish`, {});
    expect(published.statusCode, published.body).toBe(200);
    return { workflowId, board: off.json().board as Board };
  };
  /** Publishes the workflow's published definition as `change` makes it, through the API. */
  const publishChanged = async (workflowId: number, change: (d: Definition) => Definition) => {
    await saveDraft(workflowId, change((await view(workflowId)).published.definition));
    const published = await post(`/api/v1/workflows/${workflowId}/publish`, {});
    expect(published.statusCode, published.body).toBe(200);
  };
  const ASSIGNEE_REQUIRED = [{ type: 'field-required', field: 'assignee' }];
  /** Another change of the status list under way: `finish()` ends it. */
  const holdStatusList = async () => {
    const listed = gate();
    const finished = gate();
    const other = database.db.transaction().execute(async (trx) => {
      await lockList(trx, 1, 'status');
      listed.open();
      await finished.opened;
    });
    await listed.opened;
    return async () => {
      finished.open();
      await other;
    };
  };

  describe('a status that changes stage (T-209)', () => {
    it('[WF-008] a status made closed-stage closes the tickets a free move brings in, with the Closed time', async () => {
      const workflowId = await defaultId();
      const before = await view(workflowId);
      expect(into(before.published.definition, status['In Review'] as number)?.effects).toEqual(
        CLEAR,
      );
      // An open draft follows too, and stays above the new published version.
      await saveDraft(workflowId, before.published.definition);
      const count = await eventCount();

      const changed = await patch(`/api/v1/statuses/${status['In Review']}`, { stage: 'closed' });
      expect(changed.statusCode, changed.body).toBe(200);
      expect(await eventCount()).toBe(count + 1);

      const after = await view(workflowId);
      const track = await post('/api/v1/tracks', { key: 'EDGE', name: 'Edge', mode: 'shared' });
      expect(track.statusCode, track.body).toBe(201);
      const made = await post('/api/v1/tickets', { track: 'EDGE', summary: 'Into review' });
      const ticket = made.json().ticket.id as number;
      const reviewed = await move(
        ticket,
        into(after.published.definition, status['In Review'] as number)?.id,
      );
      expect(reviewed.status.id).toBe(status['In Review']);
      expect(reviewed.closeReason?.name).toBe('Completed');
      expect(reviewed.closedAt).not.toBeNull();

      expect(after.published.version).toBeGreaterThan(before.published.version);
      expect(after.draft?.version).toBeGreaterThan(after.published.version);
      for (const definition of [after.published.definition, draftOf(after)]) {
        const t = into(definition, status['In Review'] as number);
        expect(t?.from).toBe('any');
        expect(t?.effects).toEqual(setting(reason.Completed as number));
      }
      // Nothing else changed.
      expect(
        after.published.definition.transitions.filter((t) => t.to !== status['In Review']),
      ).toEqual(
        before.published.definition.transitions.filter((t) => t.to !== status['In Review']),
      );
      // One event, the status's, naming the workflows that took a new version.
      const [event] = (await events('status.updated')).slice(-1);
      expect(event?.payload).toEqual({
        changes: { stage: { from: 'active', to: 'closed' } },
        workflowIds: [workflowId],
      });
      expect(EVENT_TYPES['status.updated'].payload.safeParse(event?.payload).success).toBe(true);

      // Back out of the closed stage: the free move clears the reason again.
      const back = await move(ticket, into(after.published.definition, status.New as number)?.id);
      expect(back.closeReason).toBeNull();
      const reopened = await patch(`/api/v1/statuses/${status['In Review']}`, { stage: 'active' });
      expect(reopened.statusCode, reopened.body).toBe(200);
      const active = await view(workflowId);
      expect(into(active.published.definition, status['In Review'] as number)?.effects).toEqual(
        CLEAR,
      );
      const again = await move(
        ticket,
        into(active.published.definition, status['In Review'] as number)?.id,
      );
      expect(again.status.id).toBe(status['In Review']);
      expect(again.closeReason).toBeNull();
      expect(again.closedAt).toBeNull();
      // Thrown away, so nothing later in this file meets it.
      const discarded = await as({
        method: 'DELETE',
        url: `/api/v1/workflows/${workflowId}/draft`,
      });
      expect(discarded.statusCode, discarded.body).toBe(204);
    });

    it('[WF-008] a move with a rule or a reason someone chose stays as it was, and a status no workflow uses changes alone', async () => {
      const qa = await newStatus('QA', 'active');
      const rejected = await newStatus('Turned down', 'active');
      const dropped = await newStatus('Dropped', 'closed');
      const notPlanned = reason['Not planned'] as number;
      const created = await post('/api/v1/workflows', {
        name: 'With a rule',
        definition: {
          initialStatusId: status.New,
          statuses: [status.New as number, qa, rejected, dropped].map((statusId) => ({
            statusId,
          })),
          transitions: [
            { id: 1, name: 'New', from: 'any', to: status.New, effects: CLEAR },
            {
              id: 2,
              name: 'QA',
              from: 'any',
              to: qa,
              checks: [{ type: 'field-required', field: 'assignee' }],
              effects: CLEAR,
            },
            { id: 3, name: 'Reject', from: 'any', to: rejected, effects: setting(notPlanned) },
            { id: 4, name: 'Drop', from: 'any', to: dropped, effects: setting(notPlanned) },
          ],
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      const id = created.json().workflow.id as number;
      const before = await view(id);
      const madeClosed = await patch(`/api/v1/statuses/${qa}`, { stage: 'closed' });
      expect(madeClosed.statusCode, madeClosed.body).toBe(200);
      // A status made closed-stage that a workflow already closes into with a reason of its
      // choosing keeps that reason.
      const rejecting = await patch(`/api/v1/statuses/${rejected}`, { stage: 'closed' });
      expect(rejecting.statusCode, rejecting.body).toBe(200);
      const [event] = (await events('status.updated')).slice(-1);
      expect(event?.payload).toEqual({ changes: { stage: { from: 'active', to: 'closed' } } });
      // Out of the closed stage a reason someone chose stays too: only the free moves' one clears.
      const reopened = await patch(`/api/v1/statuses/${dropped}`, { stage: 'active' });
      expect(reopened.statusCode, reopened.body).toBe(200);
      const after = await view(id);
      expect(after.published).toEqual(before.published);

      const unused = await newStatus('Parked', 'active');
      const alone = await patch(`/api/v1/statuses/${unused}`, { stage: 'closed' });
      expect(alone.statusCode, alone.body).toBe(200);
    });

    it('[WF-008] a stage change does not wait for a ticket write that holds the workflow', async () => {
      const waiting = await newStatus('Waiting', 'active');
      const id = await freeWorkflow('Held by a write', [status.New as number, waiting]);
      // A ticket write holds its workflow (key share) and then waits for the status it moves
      // into; the stage change holds that status, so it must not wait for the workflow in turn.
      let release = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let holding = () => {};
      const held = new Promise<void>((resolve) => {
        holding = resolve;
      });
      const writer = database.db.transaction().execute(async (trx) => {
        await sql`SELECT id FROM workflow WHERE id = ${id} FOR KEY SHARE`.execute(trx);
        holding();
        await released;
      });
      await held;
      const changed = await Promise.race([
        patch(`/api/v1/statuses/${waiting}`, { stage: 'closed' }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      release();
      await writer;
      expect(changed?.statusCode, changed?.body).toBe(200);
      expect(into((await view(id)).published.definition, waiting)?.effects).toEqual(
        setting(reason.Completed as number),
      );
    });

    it('[WF-008] a stage change takes the workflow before the status, as a draft save does', async () => {
      const pending = await newStatus('Pending', 'active');
      const id = await freeWorkflow('Saved meanwhile', [status.New as number, pending]);
      // A draft save holds its workflow (no key update), then the statuses it names (key share,
      // as writing a version's statuses does). A stage change that held the status first and then
      // waited for the workflow would deadlock with it.
      let holding = () => {};
      const held = new Promise<void>((resolve) => {
        holding = resolve;
      });
      let reach = () => {};
      const reaching = new Promise<void>((resolve) => {
        reach = resolve;
      });
      const saver = database.db.transaction().execute(async (trx) => {
        await sql`SELECT id FROM workflow WHERE id = ${id} FOR NO KEY UPDATE`.execute(trx);
        holding();
        await reaching;
        await sql`SELECT id FROM status WHERE id = ${pending} FOR KEY SHARE`.execute(trx);
      });
      await held;
      const changing = patch(`/api/v1/statuses/${pending}`, { stage: 'closed' });
      // Once the stage change waits on a lock, the save reaches for the status.
      await lockWaits(1);
      reach();
      await expect(saver).resolves.toBeUndefined();
      const changed = await changing;
      expect(changed.statusCode, changed.body).toBe(200);
      expect(into((await view(id)).published.definition, pending)?.effects).toEqual(
        setting(reason.Completed as number),
      );
    });
    it("[WF-008] a board taking over its track's workflow and a stage change of a column's status both hold the workflow before the status", async () => {
      const { workflowId, board } = await ordinaryTrackWorkflow('BTAKE', ['Parked here']);
      const columns = board.columns;
      const parked = columns[1]?.statusIds[0] as number;

      // Another change of the status list is under way, so the board waits for it.
      const finish = await holdStatusList();
      // A column without a status: the board takes the workflow over, renaming a column's status.
      const takingOver = patch(`/api/v1/boards/${board.id}`, {
        version: board.version,
        columns: [
          ...columns.slice(0, 1),
          { ...columns[1], name: 'Paused here' },
          { name: 'Signed off', statusIds: [] },
          ...columns.slice(2),
        ],
      });
      await lockWaits(1);
      // A board that held the renamed status and then waited for the workflow the stage change
      // holds, while the stage change waits for that status, would have one of them ended (40P01).
      const changing = patch(`/api/v1/statuses/${parked}`, { stage: 'closed' });
      await Promise.race([changing, lockWaits(2)]);
      await finish();
      const [took, changed] = await Promise.all([takingOver, changing]);
      expect(changed.statusCode, changed.body).toBe(200);
      expect(took.statusCode, took.body).toBe(200);
      expect(took.json().board.managesWorkflow).toBe(true);
      expect((await view(workflowId)).published.definition.board).toBeDefined();
      const renamed = (await get('/api/v1/statuses')).json().statuses as {
        id: number;
        name: string;
      }[];
      expect(renamed.find((s) => s.id === parked)?.name).toBe('Paused here');
    });

    it('[WF-008] a board-managed workflow stays as its board made it, and so does a draft of it without the board', async () => {
      const { workflowId, board } = await managedBoard('BKEEP', ['Waiting here']);
      const waiting = board.columns[1]?.statusIds[0] as number;
      const before = await view(workflowId);
      // A draft saved through the API may leave the board out; the board still says which closes.
      const { board: _board, ...ordinary } = before.published.definition;
      const drafted = await saveDraft(workflowId, ordinary);
      expect(into(draftOf(drafted), waiting)?.effects).toEqual(CLEAR);
      const changed = await patch(`/api/v1/statuses/${waiting}`, { stage: 'closed' });
      expect(changed.statusCode, changed.body).toBe(200);
      const after = await view(workflowId);
      expect(after.published).toEqual(before.published);
      expect(after.draft).toEqual(drafted.draft);
      const [event] = (await events('status.updated')).slice(-1);
      expect(event?.payload).toEqual({ changes: { stage: { from: 'active', to: 'closed' } } });
    });

    it('[WF-010] a board sync holds the status list before a status, so deleting a status it renames meanwhile is refused, not deadlocked', async () => {
      const { board } = await managedBoard('BLIST', ['Queued here', 'Staged here']);
      const [first, queued, staged, ...rest] = board.columns;
      const queuedId = queued?.statusIds[0] as number;
      const stagedId = staged?.statusIds[0] as number;
      // Something holds the second column's status, so the sync stops between its two renames.
      const holding = gate();
      const finish = gate();
      const holder = database.db.transaction().execute(async (trx) => {
        await sql`SELECT id FROM status WHERE id = ${stagedId} FOR UPDATE`.execute(trx);
        holding.open();
        await finish.opened;
      });
      await holding.opened;
      const syncing = patch(`/api/v1/boards/${board.id}`, {
        version: board.version,
        columns: [
          first,
          { ...queued, name: 'Queued now' },
          { ...staged, name: 'Staged now' },
          { name: 'Shipped here', statusIds: [] },
          ...rest,
        ],
      });
      await lockWaits(1);
      // Deleting a status holds the status list, then the status. A sync that renamed it and then
      // waited for the list (its new column's status) would have one of them ended (40P01).
      const deleting = as({ method: 'DELETE', url: `/api/v1/statuses/${queuedId}` });
      await lockWaits(2);
      finish.open();
      await holder;
      const [synced, deleted] = await Promise.all([syncing, deleting]);
      expect(synced.statusCode, synced.body).toBe(200);
      expect(deleted.statusCode, deleted.body).toBe(409);
      expect(deleted.json().error).toBe('status_in_use');
    });

    it('[WF-008] a draft that takes the status while the change waits for it: the change starts again, holding that workflow first', async () => {
      const held = await newStatus('Held back', 'active');
      const id = await freeWorkflow('Took it meanwhile', [status.New as number]);
      const published = (await view(id)).published.definition;
      // A draft with the status, saved now and hidden, so the change's first look misses it.
      const draft = await saveDraft(id, {
        ...published,
        statuses: [...published.statuses, { statusId: held }],
      });
      const draftVersion = draft.draft?.version as number;
      expect(into(draftOf(draft), held)?.effects).toEqual(CLEAR);
      await database.db
        .updateTable('workflow')
        .set({ draft_version: null })
        .where('id', '=', id)
        .execute();

      // A draft save that brings it back: the workflow (no key update), then the status.
      const saving = gate();
      const finish = gate();
      const saver = database.db.transaction().execute(async (trx) => {
        await sql`SELECT id FROM workflow WHERE id = ${id} FOR NO KEY UPDATE`.execute(trx);
        await sql`SELECT id FROM status WHERE id = ${held} FOR KEY SHARE`.execute(trx);
        await sql`UPDATE workflow SET draft_version = ${draftVersion} WHERE id = ${id}`.execute(
          trx,
        );
        saving.open();
        await finish.opened;
      });
      await saving.opened;
      // The change waits for the status; another save of the same workflow waits behind the first,
      // and will reach for the status next.
      const changing = patch(`/api/v1/statuses/${held}`, { stage: 'closed' });
      await lockWaits(1);
      const second = database.db.transaction().execute(async (trx) => {
        await sql`SELECT id FROM workflow WHERE id = ${id} FOR NO KEY UPDATE`.execute(trx);
        await sql`SELECT id FROM status WHERE id = ${held} FOR KEY SHARE`.execute(trx);
      });
      await lockWaits(2);
      finish.open();
      await expect(saver).resolves.toBeUndefined();
      await expect(second).resolves.toBeUndefined();
      const changed = await changing;
      expect(changed.statusCode, changed.body).toBe(200);
      expect(into(draftOf(await view(id)), held)?.effects).toEqual(
        setting(reason.Completed as number),
      );
      const [event] = (await events('status.updated')).slice(-1);
      expect(event?.payload).toEqual({
        changes: { stage: { from: 'active', to: 'closed' } },
        workflowIds: [id],
      });
    });

    /**
     * A change of `statusId` to the closed stage that has set the new stage and holds the status,
     * and has not finished (T-237): it rewrites a workflow's free move into the status, and writing
     * that version waits for another status of that workflow, which something else holds.
     * `finish()` lets it end. Two connections of the test's five while it waits.
     */
    const stageChangeUnderWay = async (statusId: number, name: string) => {
      const held = await newStatus(`${name}, held`, 'active');
      const rewritten = await freeWorkflow(`Rewritten for ${name}`, [
        status.New as number,
        held,
        statusId,
      ]);
      const holding = gate();
      const finished = gate();
      const holder = database.db.transaction().execute(async (trx) => {
        await sql`SELECT id FROM status WHERE id = ${held} FOR UPDATE`.execute(trx);
        holding.open();
        await finished.opened;
      });
      await holding.opened;
      const changing = patch(`/api/v1/statuses/${statusId}`, { stage: 'closed' });
      await lockWaits(1);
      return async () => {
        finished.open();
        await holder;
        const changed = await changing;
        expect(changed.statusCode, changed.body).toBe(200);
        expect(into((await view(rewritten)).published.definition, statusId)?.effects).toEqual(
          setting(reason.Completed as number),
        );
      };
    };

    it('[WF-008] a draft saved or a workflow made while a stage change holds the status gives its new free move the stage the change leaves (T-237)', async () => {
      const landing = await newStatus('Landing', 'active');
      const taking = await freeWorkflow('Takes the landing', [
        status.New as number,
        status.Active as number,
      ]);
      const finish = await stageChangeUnderWay(landing, 'Landing');
      // A draft that adds Landing, and a new workflow with it: neither may decide its free move
      // from the stage Landing had before the change.
      const published = (await view(taking)).published.definition;
      const saving = put(`/api/v1/workflows/${taking}/draft`, {
        definition: { ...published, statuses: [...published.statuses, { statusId: landing }] },
      });
      const creating = post('/api/v1/workflows', {
        name: 'Made with the landing',
        definition: {
          initialStatusId: status.New,
          statuses: [status.New as number, landing].map((statusId) => ({ statusId })),
        },
      });
      await lockWaits(3);
      await finish();
      const [saved, created] = await Promise.all([saving, creating]);
      expect(saved.statusCode, saved.body).toBe(200);
      expect(created.statusCode, created.body).toBe(201);
      const closing = setting(reason.Completed as number);
      expect.soft(into(draftOf(saved.json().workflow), landing)?.effects).toEqual(closing);
      expect
        .soft(into(created.json().workflow.published.definition, landing)?.effects)
        .toEqual(closing);
    });

    it("[WF-010] a column's path added while a stage change holds the column's status gives its free move the stage the change leaves (T-237)", async () => {
      const arrival = await newStatus('Arrival', 'active');
      // A track's board with a column holding Arrival, which no transition of its workflow
      // reaches: a check keeps the board from managing that workflow.
      const { workflowId, board } = await ordinaryTrackWorkflow('BLAND', []);
      await publishChanged(workflowId, (d) => ({
        ...d,
        transitions: d.transitions.map((t, i) =>
          i === 0 ? { ...t, checks: ASSIGNEE_REQUIRED } : t,
        ),
      }));
      const withArrival = await patch(`/api/v1/boards/${board.id}`, {
        version: board.version,
        columns: [...board.columns, { name: 'Arrival', statusIds: [arrival] }],
      });
      expect(withArrival.statusCode, withArrival.body).toBe(200);
      const column = (withArrival.json().board.columns as Column[]).at(-1) as Column;
      const finish = await stageChangeUnderWay(arrival, 'Arrival');
      const adding = post(`/api/v1/boards/${board.id}/columns/${column.id}/path`);
      await lockWaits(2);
      await finish();
      const added = await adding;
      expect(added.statusCode, added.body).toBe(200);
      expect(into((await view(workflowId)).published.definition, arrival)?.effects).toEqual(
        setting(reason.Completed as number),
      );
    });
  });

  describe('a status added through the draft API (T-210)', () => {
    it('[WF-008] gets its free move on a workflow that moves freely, a closing one with the reason', async () => {
      const id = await freeWorkflow('Added by the API', [
        status.New as number,
        status.Active as number,
      ]);
      const published = (await view(id)).published.definition;
      const highest = Math.max(...published.transitions.map((t) => t.id));
      const draft = await saveDraft(id, {
        ...published,
        statuses: [
          ...published.statuses,
          { statusId: status['In Review'] as number },
          { statusId: status.Closed as number },
        ],
      });
      const definition = draftOf(draft);
      const review = into(definition, status['In Review'] as number);
      const closed = into(definition, status.Closed as number);
      expect(review).toEqual({
        id: expect.any(Number),
        name: 'In Review',
        from: 'any',
        to: status['In Review'],
        effects: CLEAR,
      });
      expect(closed).toMatchObject({
        name: 'Closed',
        from: 'any',
        to: status.Closed,
        effects: setting(reason.Completed as number),
      });
      expect(review?.id).toBeGreaterThan(highest);
      expect(closed?.id).toBeGreaterThan(highest);
      expect(review?.id).not.toBe(closed?.id);
      // What was there is kept as sent.
      expect(definition.transitions.slice(0, published.transitions.length)).toEqual(
        published.transitions,
      );

      const done = await post(`/api/v1/workflows/${id}/publish`, {});
      expect(done.statusCode, done.body).toBe(200);
      const map = await post('/api/v1/workflow-maps', { name: 'Map APIA', defaultWorkflowId: id });
      expect(map.statusCode, map.body).toBe(201);
      const track = await post('/api/v1/tracks', { key: 'APIA', name: 'APIA', mode: 'shared' });
      const linked = await patch(`/api/v1/tracks/${track.json().track.id}`, {
        workflowMapId: map.json().workflowMap.id,
      });
      expect(linked.statusCode, linked.body).toBe(200);
      const made = await post('/api/v1/tickets', { track: 'APIA', summary: 'Reaches it' });
      const closedTicket = await move(made.json().ticket.id, closed?.id);
      expect(closedTicket.closeReason?.name).toBe('Completed');
      expect(closedTicket.closedAt).not.toBeNull();
    });

    it('[WF-008] a status already there, or added beside a rule, is left for the administrator', async () => {
      const id = await freeWorkflow('Left alone', [status.New as number, status.Active as number]);
      const published = (await view(id)).published.definition;
      // The free move into Active removed on purpose: saving again does not bring it back.
      const without = {
        ...published,
        transitions: published.transitions.filter((t) => t.to !== status.Active),
      };
      const first = await saveDraft(id, without);
      expect(into(draftOf(first), status.Active as number)).toBeUndefined();
      const second = await saveDraft(id, without);
      expect(into(draftOf(second), status.Active as number)).toBeUndefined();

      // A rule in the draft: the new status's steps are the administrator's to draw.
      const ruled = await saveDraft(id, {
        ...published,
        statuses: [...published.statuses, { statusId: status['In Review'] as number }],
        transitions: published.transitions.map((t, i) =>
          i === 0 ? { ...t, checks: [{ type: 'field-required', field: 'assignee' }] } : t,
        ),
      });
      expect(into(draftOf(ruled), status['In Review'] as number)).toBeUndefined();
    });

    it('[WF-008] a draft the editor sends keeps a free move deleted from a status it had just added deleted', async () => {
      const id = await freeWorkflow('Edited by hand', [
        status.New as number,
        status.Active as number,
      ]);
      const published = (await view(id)).published.definition;
      // Add a status gave In Review its free move; the administrator deleted it, then saved.
      const sent = {
        ...published,
        statuses: [...published.statuses, { statusId: status['In Review'] as number }],
      };
      const saved = await put(`/api/v1/workflows/${id}/draft`, {
        definition: sent,
        transitionsAsSent: true,
      });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(draftOf(saved.json().workflow).transitions).toEqual(sent.transitions);
      // Publish saves first: what goes live is what was sent.
      const done = await post(`/api/v1/workflows/${id}/publish`, {});
      expect(done.statusCode, done.body).toBe(200);
      expect(into((await view(id)).published.definition, status['In Review'] as number)).toBe(
        undefined,
      );

      // A draft with no transitions at all still moves freely, as a new workflow does.
      const emptied = await put(`/api/v1/workflows/${id}/draft`, {
        definition: { ...sent, transitions: [] },
        transitionsAsSent: true,
      });
      expect(emptied.statusCode, emptied.body).toBe(200);
      expect(draftOf(emptied.json().workflow).transitions.map((t) => [t.from, t.to])).toEqual([
        ['any', status.New],
        ['any', status.Active],
        ['any', status['In Review']],
      ]);
      const discarded = await as({ method: 'DELETE', url: `/api/v1/workflows/${id}/draft` });
      expect(discarded.statusCode, discarded.body).toBe(204);
    });

    it('[WF-008] a draft with no transitions moves freely, as a new workflow does, and so does an old empty one', async () => {
      const id = await freeWorkflow('Made empty', [
        status.New as number,
        status.Active as number,
        status.Closed as number,
      ]);
      const published = (await view(id)).published.definition;
      const emptied = await saveDraft(id, { ...published, transitions: [] });
      expect(draftOf(emptied).transitions.map((t) => [t.name, t.from, t.to])).toEqual([
        ['New', 'any', status.New],
        ['Active', 'any', status.Active],
        ['Closed', 'any', status.Closed],
      ]);
      expect(into(draftOf(emptied), status.Closed as number)?.effects).toEqual(
        setting(reason.Completed as number),
      );
      // None reuses an id an earlier version gave another transition.
      const earlier = new Set(published.transitions.map((t) => t.id));
      for (const t of draftOf(emptied).transitions) {
        expect(earlier.has(t.id)).toBe(false);
      }

      // A workflow left with no transitions before this rule: the next draft gives every status
      // no transition reaches its free move.
      const old = await post('/api/v1/workflows', {
        name: 'Empty from before',
        definition: {
          initialStatusId: status.New,
          statuses: [status.New, status.Active].map((statusId) => ({ statusId })),
          transitions: [{ id: 1, name: 'Start', from: [status.New], to: status.Active }],
        },
      });
      expect(old.statusCode, old.body).toBe(201);
      const oldId = old.json().workflow.id as number;
      const stored = (await view(oldId)).published.definition;
      await database.db
        .updateTable('workflow_version')
        .set({ definition: JSON.stringify({ ...stored, transitions: [] }) as never })
        .where('workflow_id', '=', oldId)
        .execute();
      const reopened = await saveDraft(oldId, {
        ...stored,
        transitions: [{ id: 7, name: 'Active', from: 'any', to: status.Active as number }],
      });
      expect(draftOf(reopened).transitions.map((t) => [t.from, t.to])).toEqual([
        ['any', status.Active],
        ['any', status.New],
      ]);
      expect(into(draftOf(reopened), status.New as number)?.id).toBe(8);
    });

    /** A workflow made before free moving and left with no transitions (T-237). */
    const leftEmpty = async (name: string, statusIds: number[]) => {
      const made = await post('/api/v1/workflows', {
        name,
        definition: {
          initialStatusId: statusIds[0],
          statuses: statusIds.map((statusId) => ({ statusId })),
          transitions: [{ id: 4, name: 'Start', from: [statusIds[0]], to: statusIds[1] }],
        },
      });
      expect(made.statusCode, made.body).toBe(201);
      const id = made.json().workflow.id as number;
      const stored = (await view(id)).published.definition;
      await database.db
        .updateTable('workflow_version')
        .set({ definition: JSON.stringify({ ...stored, transitions: [] }) as never })
        .where('workflow_id', '=', id)
        .execute();
      return { id, stored };
    };

    it('[WF-008] an old workflow left with no moves gets them from the operator repair, as a new published version (T-237)', async () => {
      const { id, stored } = await leftEmpty('Empty until repaired', [
        status.New as number,
        status.Active as number,
        status.Closed as number,
      ]);
      // A draft someone saved: it stays as they saved it.
      await saveDraft(id, stored);
      const count = await eventCount();

      // Without --repair it only lists.
      const listed = await repairWorkflowMoves(database.db, 1, { repair: false });
      expect(listed.found).toContain(id);
      expect(listed.repaired).toEqual([]);
      expect(await eventCount()).toBe(count);
      expect((await view(id)).published.version).toBe(1);

      const run = await repairWorkflowMoves(database.db, 1, { repair: true });
      expect(run.found).toEqual(listed.found);
      expect(run.repaired).toEqual(run.found);
      const after = await view(id);
      expect(after.published.version).toBeGreaterThan(1);
      expect(
        after.published.definition.transitions.map((t) => [t.name, t.from, t.to, t.effects]),
      ).toEqual([
        ['New', 'any', status.New, CLEAR],
        ['Active', 'any', status.Active, CLEAR],
        ['Closed', 'any', status.Closed, setting(reason.Completed as number)],
      ]);
      // Numbered above every transition id the workflow used (its draft's Start is 4).
      for (const t of after.published.definition.transitions) expect(t.id).toBeGreaterThan(4);
      expect(after.draft?.version).toBeGreaterThan(after.published.version);
      expect(draftOf(after).transitions).toEqual(stored.transitions);

      // One event per workflow repaired, by the system.
      expect(await eventCount()).toBe(count + run.repaired.length);
      const repairedEvents = await database.db
        .selectFrom('domain_event')
        .select(['actor_id', 'payload'])
        .where('type', '=', 'workflow.published')
        .where('subject_id', '=', String(id))
        .execute();
      expect(repairedEvents).toEqual([
        {
          actor_id: null,
          payload: {
            version: after.published.version,
            removedStatuses: [],
            statusMapping: {},
            ticketCount: 0,
          },
        },
      ]);
      expect(
        EVENT_TYPES['workflow.published'].payload.safeParse(repairedEvents[0]?.payload).success,
      ).toBe(true);
      // Done once: the next run finds nothing to do.
      expect(await repairWorkflowMoves(database.db, 1, { repair: true })).toEqual({
        found: [],
        repaired: [],
      });

      // Its tickets move again, a closing move with the reason.
      const map = await post('/api/v1/workflow-maps', { name: 'Map RPRD', defaultWorkflowId: id });
      expect(map.statusCode, map.body).toBe(201);
      const track = await post('/api/v1/tracks', { key: 'RPRD', name: 'RPRD', mode: 'shared' });
      const linked = await patch(`/api/v1/tracks/${track.json().track.id}`, {
        workflowMapId: map.json().workflowMap.id,
      });
      expect(linked.statusCode, linked.body).toBe(200);
      const made = await post('/api/v1/tickets', { track: 'RPRD', summary: 'Moves again' });
      const closed = await move(
        made.json().ticket.id,
        into(after.published.definition, status.Closed as number)?.id,
      );
      expect(closed.status.id).toBe(status.Closed);
      expect(closed.closeReason?.name).toBe('Completed');
    });

    it('[WF-008] the operator repair leaves a workflow given transitions while it waited for it (T-237)', async () => {
      const { id } = await leftEmpty('Filled meanwhile', [
        status.New as number,
        status.Active as number,
      ]);
      const step = { id: 5, name: 'Start', from: [status.New], to: status.Active };
      // A publish under way holds the workflow and gives it a step.
      const holding = gate();
      const finish = gate();
      const publisher = database.db.transaction().execute(async (trx) => {
        await sql`SELECT id FROM workflow WHERE id = ${id} FOR UPDATE`.execute(trx);
        const { rows } = await sql<{ definition: Definition }>`
          SELECT definition FROM workflow_version WHERE workflow_id = ${id} AND version = 1`.execute(
          trx,
        );
        const definition = { ...(rows[0]?.definition as Definition), transitions: [step] };
        await sql`
          UPDATE workflow_version SET definition = ${JSON.stringify(definition)}::jsonb
           WHERE workflow_id = ${id} AND version = 1`.execute(trx);
        holding.open();
        await finish.opened;
      });
      await holding.opened;
      const repairing = repairWorkflowMoves(database.db, 1, { repair: true });
      await lockWaits(1);
      finish.open();
      await publisher;
      const run = await repairing;
      expect(run.found).toContain(id);
      expect(run.repaired).not.toContain(id);
      const after = await view(id);
      expect(after.published.version).toBe(1);
      expect(after.published.definition.transitions).toEqual([step]);
    });
  });

  describe("a board's change of its track's workflow reads it under the lock (T-238)", () => {
    it('[WF-010] a board takes its workflow over only as it stands once held: a check published meanwhile keeps the board out', async () => {
      const { workflowId, board } = await ordinaryTrackWorkflow('BRULE', ['Checked here']);
      // Another change of the status list is under way, so the board waits for it.
      const finish = await holdStatusList();
      // A column without a status, where nothing stood in the way: the board would take over.
      const takingOver = patch(`/api/v1/boards/${board.id}`, {
        version: board.version,
        columns: [...board.columns, { name: 'Signed off here', statusIds: [] }],
      });
      await lockWaits(1);
      // Meanwhile someone publishes a check: it stays in force (ADR-116), so the board must not
      // replace the workflow with its columns.
      await publishChanged(workflowId, (d) => ({
        ...d,
        transitions: d.transitions.map((t, i) =>
          i === 0 ? { ...t, checks: ASSIGNEE_REQUIRED } : t,
        ),
      }));
      await finish();
      const took = await takingOver;
      expect(took.statusCode, took.body).toBe(200);
      expect(took.json().board.managesWorkflow).toBe(false);
      expect(took.json().board.columns.at(-1)).toMatchObject({
        name: 'Signed off here',
        statusIds: [],
      });
      const after = (await view(workflowId)).published.definition;
      expect(after.board).toBeUndefined();
      expect(after.transitions[0]?.checks).toEqual(ASSIGNEE_REQUIRED);
    });

    it("[WF-010] a column's path is added to the workflow as it stands once held, keeping a version published meanwhile", async () => {
      const { workflowId, board } = await ordinaryTrackWorkflow('BPATH', []);
      // A check keeps the board from taking the workflow over: a new column stays without a status.
      await publishChanged(workflowId, (d) => ({
        ...d,
        transitions: d.transitions.map((t, i) =>
          i === 0 ? { ...t, checks: ASSIGNEE_REQUIRED } : t,
        ),
      }));
      const added = await patch(`/api/v1/boards/${board.id}`, {
        version: board.version,
        columns: [...board.columns, { name: 'Audited here', statusIds: [] }],
      });
      expect(added.statusCode, added.body).toBe(200);
      const column = (added.json().board.columns as Column[]).at(-1) as Column;
      expect(column.statusIds).toEqual([]);

      const finish = await holdStatusList();
      const pathing = post(`/api/v1/boards/${board.id}/columns/${column.id}/path`);
      await lockWaits(1);
      // Meanwhile someone publishes a new step.
      const [from, to] = board.columns.map((c) => c.statusIds[0] as number);
      await publishChanged(workflowId, (d) => ({
        ...d,
        transitions: [
          ...d.transitions,
          {
            id: Math.max(...d.transitions.map((t) => t.id)) + 1,
            name: 'Escalate',
            from: [from as number],
            to: to as number,
          },
        ],
      }));
      await finish();
      const pathed = await pathing;
      expect(pathed.statusCode, pathed.body).toBe(200);
      const made = (pathed.json().board.columns as Column[]).at(-1)?.statusIds[0] as number;
      const after = (await view(workflowId)).published.definition;
      expect(after.transitions.filter((t) => t.name === 'Escalate')).toHaveLength(1);
      expect(after.transitions[0]?.checks).toEqual(ASSIGNEE_REQUIRED);
      expect(into(after, made)?.from).toBe('any');
    });
  });

  describe('the reason free moves close with (T-234)', () => {
    it('[WF-008] while Completed exists, a default workflow that closes some steps with another reason does not decide it', async () => {
      // A site's own default workflow: its Close step asks for the reason and sets none, and a
      // "Won't do" step into a closing status sets Not planned.
      const workflowId = await defaultId();
      const before = (await view(workflowId)).published.definition;
      const calledOff = await newStatus('Called off', 'closed');
      const notPlanned = reason['Not planned'] as number;
      const next = Math.max(...before.transitions.map((t) => t.id)) + 1;
      await saveDraft(workflowId, {
        ...before,
        statuses: [...before.statuses, { statusId: calledOff }],
        transitions: [
          ...before.transitions.map(
            (t): Transition =>
              t.to === status.Closed
                ? { id: t.id, name: t.name, from: t.from, to: t.to, layout: ['close-reason'] }
                : t,
          ),
          { id: next, name: "Won't do", from: 'any', to: calledOff, effects: setting(notPlanned) },
        ],
      });
      const published = await post(`/api/v1/workflows/${workflowId}/publish`, {});
      expect(published.statusCode, published.body).toBe(200);

      // Done work is still recorded as Completed, on every path that makes a free move.
      const asked = await post(`/api/v1/workflows/${workflowId}/completed-reason`);
      expect(asked.json()).toEqual({ closeReasonId: reason.Completed });
      const created = await freeWorkflow('Closes as Completed', [
        status.New as number,
        status.Closed as number,
      ]);
      expect(
        into((await view(created)).published.definition, status.Closed as number)?.effects,
      ).toEqual(setting(reason.Completed as number));
      const someday = await newStatus('Someday', 'active');
      const later = await freeWorkflow('Made closing later', [status.New as number, someday]);
      const closing = await patch(`/api/v1/statuses/${someday}`, { stage: 'closed' });
      expect(closing.statusCode, closing.body).toBe(200);
      expect(into((await view(later)).published.definition, someday)?.effects).toEqual(
        setting(reason.Completed as number),
      );

      // The default workflow as it was, for what follows.
      await saveDraft(workflowId, before);
      const restored = await post(`/api/v1/workflows/${workflowId}/publish`, {});
      expect(restored.statusCode, restored.body).toBe(200);
      expect((await view(workflowId)).published.definition.transitions).toEqual(before.transitions);
    });

    // From here on Completed is replaced: nothing after this may count on it.
    it('[WF-008] after Completed was replaced, a reason named Completed made afterwards takes the free moves made from then on', async () => {
      const done = await post('/api/v1/close-reasons', { name: 'Done' });
      expect(done.statusCode, done.body).toBe(201);
      const doneId = done.json().closeReason.id as number;
      const replaced = await as({
        method: 'DELETE',
        url: `/api/v1/close-reasons/${reason.Completed}?replacementId=${doneId}`,
      });
      expect(replaced.statusCode, replaced.body).toBe(204);
      const again = await post('/api/v1/close-reasons', { name: 'Completed' });
      expect(again.statusCode, again.body).toBe(201);
      const completed = again.json().closeReason.id as number;
      expect(await reasonOf('Completed')).toBe(completed);

      // The replacement took the moves that were there: the default workflow closes as Done.
      const workflowId = await defaultId();
      expect(
        into((await view(workflowId)).published.definition, status.Closed as number)?.effects,
      ).toEqual(setting(doneId));
      // The name decides what free moves made from now on close with. Whether the replacement
      // should win instead, or the new Completed take the old moves too, is the user's to decide
      // (T-234); until then this is the rule as it was.
      const asked = await post(`/api/v1/workflows/${workflowId}/completed-reason`);
      expect(asked.json()).toEqual({ closeReasonId: completed });
      const created = await freeWorkflow('Closes after the new Completed', [
        status.New as number,
        status.Closed as number,
      ]);
      expect(
        into((await view(created)).published.definition, status.Closed as number)?.effects,
      ).toEqual(setting(completed));
      const shipped = await newStatus('Shipped', 'active');
      const draft = await saveDraft(created, {
        ...(await view(created)).published.definition,
        statuses: [...(await view(created)).published.definition.statuses, { statusId: shipped }],
      });
      expect(draft.draft).not.toBeNull();
      const closing = await patch(`/api/v1/statuses/${shipped}`, { stage: 'closed' });
      expect(closing.statusCode, closing.body).toBe(200);
      expect(into(draftOf(await view(created)), shipped)?.effects).toEqual(setting(completed));
    });

    it('[WF-008] once the default workflow closes with the new Completed, free moves follow it', async () => {
      const workflowId = await defaultId();
      const completed = await reasonOf('Completed');
      const published = (await view(workflowId)).published.definition;
      await saveDraft(workflowId, {
        ...published,
        transitions: published.transitions.map((t) =>
          t.to === status.Closed ? { ...t, effects: setting(completed) } : t,
        ),
      });
      const done = await post(`/api/v1/workflows/${workflowId}/publish`, {});
      expect(done.statusCode, done.body).toBe(200);
      const asked = await post(`/api/v1/workflows/${workflowId}/completed-reason`);
      expect(asked.json()).toEqual({ closeReasonId: completed });
    });
  });
});
