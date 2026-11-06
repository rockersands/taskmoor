import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { EVENT_TYPES } from '../events/catalogue';

/**
 * The edges of free moving the T-207 review found (WF-008 (1), (4); ADR-116): a status whose stage
 * changes (T-209), a status added through the draft API and a workflow left with no transitions
 * (T-210), and the reason free moves close with, before and after Completed is replaced (T-234).
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
    it('[WF-008] a stage change leaves a board-managed workflow unheld, so a board sync that holds the status first goes on', async () => {
      // A board that manages its track's workflow, with a column whose status only it uses.
      const track = await post('/api/v1/tracks', { key: 'BSYNC', name: 'Synced', mode: 'local' });
      expect(track.statusCode, track.body).toBe(201);
      const trackId = track.json().track.id as number;
      const made = await post('/api/v1/boards', {
        name: 'Synced board',
        kind: 'kanban',
        trackId,
        source: { query: 'track = BSYNC' },
      });
      expect(made.statusCode, made.body).toBe(201);
      const managed = await put(`/api/v1/boards/${made.json().board.id}/workflow`, {
        managed: true,
      });
      expect(managed.statusCode, managed.body).toBe(200);
      const board = managed.json().board as {
        id: number;
        version: number;
        columns: { id: string; name: string; statusIds: number[] }[];
      };
      const added = await patch(`/api/v1/boards/${board.id}`, {
        version: board.version,
        columns: [
          ...board.columns.slice(0, 1),
          { name: 'On hold', statusIds: [] },
          ...board.columns.slice(1),
        ],
      });
      expect(added.statusCode, added.body).toBe(200);
      const onHold = added.json().board.columns[1].statusIds[0] as number;
      const workflowId = (
        await database.db
          .selectFrom('workflow')
          .select('id')
          .where('owner_track_id', '=', trackId)
          .executeTakeFirstOrThrow()
      ).id;
      const before = await view(workflowId);

      // A board's sync renames the column's status, then publishes the workflow (for update).
      const renamed = gate();
      const reaching = gate();
      const sync = database.db.transaction().execute(async (trx) => {
        await sql`UPDATE status SET name = 'Paused' WHERE id = ${onHold}`.execute(trx);
        renamed.open();
        await reaching.opened;
        await sql`SELECT id FROM workflow WHERE id = ${workflowId} FOR UPDATE`.execute(trx);
      });
      await renamed.opened;
      const changing = patch(`/api/v1/statuses/${onHold}`, { stage: 'closed' });
      await lockWaits(1);
      reaching.open();
      await expect(sync).resolves.toBeUndefined();
      const changed = await changing;
      expect(changed.statusCode, changed.body).toBe(200);
      // The board's workflow is as its board made it, and the status's one event names none.
      expect((await view(workflowId)).published).toEqual(before.published);
      const [event] = (await events('status.updated')).slice(-1);
      expect(event?.payload).toEqual({ changes: { stage: { from: 'active', to: 'closed' } } });
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
