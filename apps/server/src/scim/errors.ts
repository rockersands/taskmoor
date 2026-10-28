/**
 * SCIM error responses (RFC 7644 3.12): a JSON body with the error message schema, the HTTP
 * status as a string, an optional `scimType` keyword for 400s and a human-readable detail.
 * Every SCIM endpoint answers its failures this way, authentication failures included.
 */
export const SCIM_ERROR_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:Error';

/** Media type of SCIM messages (RFC 7644 3.1); plain JSON is accepted on input too. */
export const SCIM_CONTENT_TYPE = 'application/scim+json; charset=utf-8';

/** The `scimType` keywords of RFC 7644 3.12, all for status 400 except `tooMany`, `uniqueness`. */
export type ScimType =
  | 'invalidFilter'
  | 'tooMany'
  | 'uniqueness'
  | 'mutability'
  | 'invalidSyntax'
  | 'invalidPath'
  | 'noTarget'
  | 'invalidValue'
  | 'invalidVers'
  | 'sensitive';

export interface ScimErrorBody {
  schemas: [typeof SCIM_ERROR_SCHEMA];
  status: string;
  scimType?: ScimType;
  detail: string;
}

/** A failure a SCIM handler throws; the route answers it with `scimErrorBody`. */
export class ScimError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly scimType?: ScimType,
  ) {
    super(detail);
    this.name = 'ScimError';
  }
}

export function scimErrorBody(status: number, detail: string, scimType?: ScimType): ScimErrorBody {
  return {
    schemas: [SCIM_ERROR_SCHEMA],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  };
}

export const invalidValue = (detail: string) => new ScimError(400, detail, 'invalidValue');
export const invalidSyntax = (detail: string) => new ScimError(400, detail, 'invalidSyntax');
export const invalidFilter = (detail: string) => new ScimError(400, detail, 'invalidFilter');
export const invalidPath = (detail: string) => new ScimError(400, detail, 'invalidPath');
export const noTarget = (detail: string) => new ScimError(400, detail, 'noTarget');
export const mutability = (detail: string) => new ScimError(400, detail, 'mutability');
export const uniqueness = (detail: string) => new ScimError(409, detail, 'uniqueness');
export const notFound = (detail = 'No such resource') => new ScimError(404, detail);
