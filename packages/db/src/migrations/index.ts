import type { Migration } from 'kysely';
import * as m0001 from './0001_foundation';
import * as m0002 from './0002_users_and_sessions';
import * as m0003 from './0003_identity';
import * as m0004 from './0004_authorization';
import * as m0005 from './0005_events';
import * as m0006 from './0006_audit';
import * as m0007 from './0007_tokens';
import * as m0008 from './0008_tracks';
import * as m0009 from './0009_two_factor';
import * as m0010 from './0010_identity_providers';
import * as m0011 from './0011_ticket_types';
import * as m0012 from './0012_scim';
import * as m0013 from './0013_appearance';
import * as m0014 from './0014_tickets';
import * as m0015 from './0015_ticket_history';
import * as m0018 from './0018_ticket_fields';
import * as m0019 from './0019_links';
import * as m0020 from './0020_saml';
import * as m0022 from './0022_trash_backups';
import * as m0023 from './0023_time_tracking';
import * as m0024 from './0024_workflows';
import * as m0025 from './0025_transition_history';

/**
 * Every migration, in order. Migrations are forward-only: never edit or remove one that has
 * shipped; add a new one instead (expand, migrate data, then contract in a later release).
 * A test fails if a file in this folder is missing from the list.
 */
export const migrations: Record<string, Migration> = {
  '0001_foundation': m0001,
  '0002_users_and_sessions': m0002,
  '0003_identity': m0003,
  '0004_authorization': m0004,
  '0005_events': m0005,
  '0006_audit': m0006,
  '0007_tokens': m0007,
  '0008_tracks': m0008,
  '0009_two_factor': m0009,
  '0010_identity_providers': m0010,
  '0011_ticket_types': m0011,
  '0012_scim': m0012,
  '0013_appearance': m0013,
  '0014_tickets': m0014,
  '0015_ticket_history': m0015,
  '0018_ticket_fields': m0018,
  '0019_links': m0019,
  '0020_saml': m0020,
  '0022_trash_backups': m0022,
  '0023_time_tracking': m0023,
  '0024_workflows': m0024,
  '0025_transition_history': m0025,
};
