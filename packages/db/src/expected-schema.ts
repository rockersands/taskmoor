import golden from './__golden__/schema.json' with { type: 'json' };
import type { SchemaSnapshot } from './snapshot';

/**
 * The schema this build's migrations produce, as reviewed in `__golden__/schema.json` (the
 * schema test keeps the two equal). The upgrade command checks a database against it after
 * migrating and before the commit (OPS-006).
 */
export const EXPECTED_SCHEMA: SchemaSnapshot = golden as SchemaSnapshot;
