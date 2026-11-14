import { type RawBuilder, sql } from 'kysely';

/**
 * A plan ticket's sprints (ADR-122 stages 2 and 7), as SQL expressions over the ticket aliased
 * `k`. Only sprints of Scrum boards count, and never a deleted one.
 */

/**
 * The day a ticket is dated by through its sprint: the sprint's start or end, of an open sprint
 * it is in, else of the latest it was in. Null when it was never in one, or that sprint has no
 * such day. The Timeline draws a ticket without days of its own by it; the auto-scheduler ends a
 * blocker without days on it. A `date`: cast it to `text` to read `YYYY-MM-DD`.
 */
export const sprintDay = (column: 'start_at' | 'end_at'): RawBuilder<unknown> => sql`(
  SELECT (s.${sql.ref(column)} AT TIME ZONE 'UTC')::date FROM sprint_ticket st
    JOIN sprint s ON s.id = st.sprint_id JOIN board b ON b.id = s.board_id AND b.kind = 'scrum'
   WHERE st.ticket_id = k.id AND s.deleted_at IS NULL
   ORDER BY st.open DESC, s.sequence DESC LIMIT 1)`;

/**
 * Whether the ticket is in an active sprint: an open membership of a sprint that is active and
 * not deleted, on a Scrum board. The auto-scheduler keeps such a ticket's days when the run asks.
 */
export const inActiveSprint = (): RawBuilder<boolean> => sql<boolean>`EXISTS (
  SELECT 1 FROM sprint_ticket st
    JOIN sprint s ON s.id = st.sprint_id AND s.state = 'active' AND s.deleted_at IS NULL
    JOIN board b ON b.id = s.board_id AND b.kind = 'scrum'
   WHERE st.ticket_id = k.id AND st.open)`;
