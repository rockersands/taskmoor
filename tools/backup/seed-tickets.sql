-- Synthetic tickets for the restore benchmark (M1-101, tools/backup/bench-restore.sh): ten
-- tracks with :per_track tickets each, half of them with a description, five history rows,
-- one follower each and a link from every fifth ticket. Run on a freshly migrated database.
\set ON_ERROR_STOP on
\timing on

INSERT INTO app_user (workspace_id, email, name) VALUES (1, 'bench@example.com', 'Bench');

INSERT INTO track (workspace_id, key, name, access_policy_id, type_set_id, owner_id)
SELECT 1, 'BENCH' || i, 'Bench ' || i,
       (SELECT id FROM access_policy WHERE workspace_id = 1 AND is_default),
       (SELECT type_set_id FROM type_set_default WHERE workspace_id = 1 AND track_type = 'software'),
       (SELECT id FROM app_user WHERE email = 'bench@example.com')
  FROM generate_series(1, 10) AS i;

INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, summary, description,
                    creator_id, requester_id, rank, labels)
SELECT 1, t.id, g.n,
       (SELECT id FROM ticket_type WHERE workspace_id = 1 AND name = 'Feature' AND owner_track_id IS NULL),
       'Synthetic ticket ' || g.n || ' in ' || t.key || ' ' || md5(t.id::text || '-' || g.n::text),
       CASE WHEN g.n % 2 = 0 THEN jsonb_build_object('type', 'doc', 'content', jsonb_build_array(
         jsonb_build_object('type', 'paragraph', 'content', jsonb_build_array(
           jsonb_build_object('type', 'text', 'text', repeat('Synthetic description text. ', 8))))))
       END,
       u.id, u.id, 'b' || lpad((t.rn * 10000000 + g.n)::text, 12, '0'), ARRAY['bench']
  FROM (SELECT id, key, row_number() OVER (ORDER BY id) AS rn FROM track WHERE key LIKE 'BENCH%') t
 CROSS JOIN generate_series(1, :per_track) AS g(n)
 CROSS JOIN (SELECT id FROM app_user WHERE email = 'bench@example.com') u;

INSERT INTO ticket_counter (track_id, workspace_id, last_number)
SELECT id, 1, :per_track FROM track WHERE key LIKE 'BENCH%';

INSERT INTO ticket_change (workspace_id, ticket_id, change_set, at, actor_id, field, from_value,
                           to_value, from_display, to_display)
SELECT 1, k.id, k.id, k.created_at, k.creator_id, f.field,
       CASE WHEN f.field = 'summary' THEN 'An earlier summary of ' || k.id END,
       CASE f.field WHEN 'track' THEN k.track_id::text WHEN 'key' THEN 'BENCH-' || k.number
                    WHEN 'type' THEN k.ticket_type_id::text WHEN 'rank' THEN k.rank
                    ELSE k.summary END,
       NULL,
       CASE f.field WHEN 'type' THEN 'Feature' WHEN 'track' THEN 'BENCH' END
  FROM ticket k
 CROSS JOIN (VALUES ('track'), ('key'), ('type'), ('rank'), ('summary')) AS f(field);

INSERT INTO ticket_follower (workspace_id, ticket_id, user_id)
SELECT 1, id, creator_id FROM ticket;

INSERT INTO ticket_link (workspace_id, link_type_id, source_id, target_id)
SELECT 1, (SELECT id FROM link_type WHERE workspace_id = 1 AND name = 'Blocks'), k.id, k.id + 1
  FROM ticket k WHERE k.id % 5 = 0 AND EXISTS (SELECT 1 FROM ticket n WHERE n.id = k.id + 1);

ANALYZE;
SELECT (SELECT count(*) FROM ticket) AS tickets,
       (SELECT count(*) FROM ticket_change) AS changes,
       pg_size_pretty(pg_database_size(current_database())) AS size;
