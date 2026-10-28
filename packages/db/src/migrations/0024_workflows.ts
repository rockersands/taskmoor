import { type Kysely, sql } from 'kysely';

/**
 * Statuses and workflows (M1-023; CORE-014, WF-001, WF-002, WF-008; spec 01a sections 1.6
 * and 3).
 *
 * - `status`: the workspace's ordered list of statuses, each in one of three stages (new,
 *   active, closed) that give it its colour and tell reports whether work is done. Shipped
 *   with the defaults of section 1.6.
 * - `workflow` and `workflow_version`: a workflow is versioned data. A version's definition
 *   (JSON) lists its statuses, its initial status and its transitions; the published version
 *   is the one tickets move through, and at most one later version is a draft being edited.
 *   Publishing makes the draft current at once (the next transition uses it); a status the
 *   draft drops takes its tickets to a mapped status first. Old versions stay, to compare
 *   and restore.
 * - `track.workflow_id` names a track's workflow; null means the workspace's default
 *   workflow. Workflows per ticket type (workflow maps) and local-mode workflows join in
 *   M1-028.
 * - `ticket.status_id`: every ticket has a status of its workflow; existing tickets start in
 *   the default workflow's initial status.
 */
const STATUSES = [
  ['Open', 'new'],
  ['New', 'new'],
  ['Backlog', 'new'],
  ['Selected for Development', 'new'],
  ['Active', 'active'],
  ['In Review', 'active'],
  ['Under review', 'active'],
  ['Approved', 'closed'],
  ['Rejected', 'closed'],
  ['Cancelled', 'closed'],
  ['Draft', 'new'],
  ['Published', 'closed'],
  ['Closed', 'closed'],
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE status (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      stage text NOT NULL CHECK (stage IN ('new', 'active', 'closed')),
      sort_order integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT status_order_key UNIQUE (workspace_id, sort_order) DEFERRABLE INITIALLY DEFERRED
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX status_name_idx ON status (workspace_id, lower(name))`.execute(db);

  await sql`
    CREATE TABLE workflow (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      is_default boolean NOT NULL DEFAULT false,
      published_version integer NOT NULL DEFAULT 1,
      draft_version integer,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (draft_version IS NULL OR draft_version > published_version)
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX workflow_name_idx ON workflow (workspace_id, lower(name))`.execute(
    db,
  );
  await sql`CREATE UNIQUE INDEX workflow_default_idx ON workflow (workspace_id) WHERE is_default`.execute(
    db,
  );
  await sql`
    CREATE TABLE workflow_version (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      workflow_id integer NOT NULL REFERENCES workflow (id) ON DELETE CASCADE,
      version integer NOT NULL CHECK (version > 0),
      definition jsonb NOT NULL,
      created_by integer REFERENCES app_user (id),
      created_at timestamptz NOT NULL DEFAULT now(),
      published_at timestamptz,
      published_by integer REFERENCES app_user (id),
      PRIMARY KEY (workflow_id, version)
    )`.execute(db);
  // Which statuses each version uses, so a status in use anywhere is found by index.
  await sql`
    CREATE TABLE workflow_version_status (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      workflow_id integer NOT NULL,
      version integer NOT NULL,
      status_id integer NOT NULL REFERENCES status (id),
      PRIMARY KEY (workflow_id, version, status_id),
      FOREIGN KEY (workflow_id, version) REFERENCES workflow_version (workflow_id, version)
        ON DELETE CASCADE
    )`.execute(db);
  await sql`CREATE INDEX workflow_version_status_idx ON workflow_version_status (status_id)`.execute(
    db,
  );

  await sql`ALTER TABLE track ADD COLUMN workflow_id integer REFERENCES workflow (id)`.execute(db);
  await sql`CREATE INDEX track_workflow_idx ON track (workflow_id) WHERE workflow_id IS NOT NULL`.execute(
    db,
  );
  await sql`ALTER TABLE ticket ADD COLUMN status_id integer REFERENCES status (id)`.execute(db);

  const { rows } = await sql<{ id: number }>`SELECT id FROM workspace ORDER BY id`.execute(db);
  for (const { id: ws } of rows) {
    for (const [i, [name, stage]] of STATUSES.entries()) {
      await sql`
        INSERT INTO status (workspace_id, name, stage, sort_order)
        VALUES (${ws}, ${name}, ${stage}, ${i + 1})`.execute(db);
    }
    const ids = await sql<{ id: number; name: string }>`
      SELECT id, name FROM status WHERE workspace_id = ${ws}`.execute(db);
    const of = (name: string) => ids.rows.find((r) => r.name === name)?.id as number;
    const [fresh, active, review, closed] = [
      of('New'),
      of('Active'),
      of('In Review'),
      of('Closed'),
    ];
    const definition = {
      initialStatusId: fresh,
      statuses: [fresh, active, review, closed].map((statusId) => ({ statusId })),
      transitions: [
        { id: 1, name: 'Start', from: [fresh], to: active },
        { id: 2, name: 'Send to review', from: [active], to: review },
        { id: 3, name: 'Back to active', from: [review], to: active },
        { id: 4, name: 'Close', from: 'any', to: closed },
        { id: 5, name: 'Reopen', from: [closed], to: fresh },
      ],
    };
    const workflow = await sql<{ id: number }>`
      INSERT INTO workflow (workspace_id, name, description, is_default)
      VALUES (${ws}, 'Default workflow', 'New, Active, In Review, Closed', true)
      RETURNING id`.execute(db);
    const workflowId = workflow.rows[0]?.id as number;
    await sql`
      INSERT INTO workflow_version (workspace_id, workflow_id, version, definition, published_at)
      VALUES (${ws}, ${workflowId}, 1, ${JSON.stringify(definition)}, now())`.execute(db);
    await sql`
      INSERT INTO workflow_version_status (workspace_id, workflow_id, version, status_id)
      SELECT ${ws}, ${workflowId}, 1, unnest(${[fresh, active, review, closed]}::int[])`.execute(
      db,
    );
    await sql`UPDATE ticket SET status_id = ${fresh} WHERE workspace_id = ${ws}`.execute(db);
  }
  await sql`ALTER TABLE ticket ALTER COLUMN status_id SET NOT NULL`.execute(db);
  await sql`CREATE INDEX ticket_status_idx ON ticket (status_id)`.execute(db);
  // A ticket written without a status (an import, a bulk load) starts in the initial status
  // of its track's workflow, as the API's creates do.
  await sql`
    CREATE FUNCTION ticket_initial_status() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status_id IS NULL THEN
        SELECT (v.definition ->> 'initialStatusId')::int INTO NEW.status_id
          FROM workflow w
          JOIN workflow_version v ON v.workflow_id = w.id AND v.version = w.published_version
         WHERE w.id = coalesce(
                 (SELECT workflow_id FROM track WHERE id = NEW.track_id),
                 (SELECT id FROM workflow WHERE workspace_id = NEW.workspace_id AND is_default));
      END IF;
      RETURN NEW;
    END $$`.execute(db);
  await sql`
    CREATE TRIGGER ticket_initial_status BEFORE INSERT ON ticket
      FOR EACH ROW EXECUTE FUNCTION ticket_initial_status()`.execute(db);
}
