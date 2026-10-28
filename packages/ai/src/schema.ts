import { transformJSONSchema } from '@anthropic-ai/sdk/lib/transform-json-schema';
import { z } from 'zod';

/**
 * The strict JSON schema for a Zod schema: every object closed (`additionalProperties:
 * false`) and every property required, as structured outputs and strict tools need. These are
 * the SDK's own steps (`zodOutputFormat`), minus the `$schema` marker, which the transform
 * would otherwise copy into the description the model reads. Constraints strict mode cannot
 * enforce (lengths, ranges) become description hints, and Zod still checks them on the answer.
 */
export function strictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _marker, ...json } = z.toJSONSchema(schema, { reused: 'ref' });
  return transformJSONSchema(json);
}

export type Checked<T> = { ok: true; data: T } | { ok: false; problem: string };

/** Validates a value against a Zod schema and describes what is wrong, briefly. */
export function check<T>(schema: z.ZodType<T>, value: unknown): Checked<T> {
  const result = schema.safeParse(value);
  if (result.success) return { ok: true, data: result.data };
  const problem = result.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
  return { ok: false, problem };
}

/** Parses a structured answer: JSON first, then the schema. */
export function checkJsonAnswer<T>(schema: z.ZodType<T>, text: string): Checked<T> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'the answer is not JSON' };
  }
  return check(schema, json);
}
