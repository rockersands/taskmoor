import { type ZodType, z } from 'zod';

/**
 * The native API's contract (M1-065; API-001; ADR-067). Each stable operation is written here
 * first: its method and path, what it does in our own words, the request it takes and the
 * responses it gives, as zod schemas. The OpenAPI document, the reference pages and the SDK
 * are made from these; the contract tests hold the server to them. Routes not listed are
 * internal: they serve this web app and may change in any release.
 */
export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** The contract's version: its major number changes only with a breaking change (ADR-067). */
export const API_VERSION = '1.0.0';

export interface Response {
  description: string;
  /** The body; none for 204 and for the error responses, which share one shape. */
  schema?: ZodType;
}

export interface Operation {
  method: Method;
  /** As the server routes it: `/api/v1/tickets/:id`. */
  path: string;
  /** Unique, camelCase: the SDK's method name. */
  id: string;
  tag: string;
  summary: string;
  description?: string;
  /** Path parameters' meanings, by name. */
  params?: Record<string, string>;
  query?: ZodType;
  body?: ZodType;
  /** Success responses by status; the usual error statuses are added for every operation. */
  responses: Record<number, Response>;
  /** A list read a page at a time: `limit` and `cursor` in, the next cursor out. */
  paged?: boolean;
}

/** The answer of every refusal: a short code, and for bad input the fields at fault. */
export const errorBody = z
  .object({
    error: z
      .string()
      .meta({ description: 'A short code, such as `not_found` or `invalid_fields`.' }),
    fields: z.record(z.string(), z.string()).optional().meta({
      description: 'For `invalid_fields`: what is wrong with each field, by name.',
    }),
  })
  .loose()
  .meta({ id: 'Error' });

export const op = (operation: Operation): Operation => operation;
