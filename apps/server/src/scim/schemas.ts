/**
 * The SCIM schemas Taskmoor serves (RFC 7643): the core User schema with the enterprise
 * extension, and the core Group schema. Attribute names, types and characteristics are the
 * interoperable surface the RFC defines; the descriptions are our own words. Handlers use the
 * same definitions to resolve attribute names (case-insensitively, RFC 7643 2.1), coerce
 * values, and answer `/Schemas`.
 */
export const USER_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const ENTERPRISE_USER_SCHEMA = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
export const GROUP_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const LIST_RESPONSE_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const PATCH_OP_SCHEMA = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const SERVICE_PROVIDER_CONFIG_SCHEMA =
  'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig';
export const RESOURCE_TYPE_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:ResourceType';
export const SCHEMA_SCHEMA = 'urn:ietf:params:scim:schemas:core:2.0:Schema';

/** Where the SCIM service lives; identity providers are given `<public URL>/api/v1/scim/v2`. */
export const SCIM_PREFIX = '/api/v1/scim/v2';

/** The largest page a list answers (ServiceProviderConfig `filter.maxResults`). */
export const MAX_RESULTS = 200;
export const DEFAULT_COUNT = 100;

export type AttributeType =
  | 'string'
  | 'boolean'
  | 'decimal'
  | 'integer'
  | 'dateTime'
  | 'reference'
  | 'complex';
export type Mutability = 'readOnly' | 'readWrite' | 'immutable' | 'writeOnly';
export type Returned = 'always' | 'never' | 'default' | 'request';

export interface AttributeDef {
  name: string;
  type: AttributeType;
  multiValued: boolean;
  description: string;
  required: boolean;
  caseExact: boolean;
  mutability: Mutability;
  returned: Returned;
  uniqueness: 'none' | 'server' | 'global';
  canonicalValues?: string[];
  referenceTypes?: string[];
  subAttributes?: AttributeDef[];
}

type Options = Partial<Omit<AttributeDef, 'name' | 'type' | 'description'>>;

function attr(
  name: string,
  type: AttributeType,
  description: string,
  options: Options = {},
): AttributeDef {
  return {
    name,
    type,
    multiValued: false,
    description,
    required: false,
    caseExact: false,
    mutability: 'readWrite',
    returned: 'default',
    uniqueness: 'none',
    ...options,
  };
}

const text = (name: string, description: string, options: Options = {}) =>
  attr(name, 'string', description, options);

/** The sub-attributes most multi-valued attributes share (RFC 7643 2.4). */
function multi(
  name: string,
  description: string,
  value: AttributeDef,
  types: string[],
  extra: AttributeDef[] = [],
): AttributeDef {
  return attr(name, 'complex', description, {
    multiValued: true,
    subAttributes: [
      value,
      ...extra,
      text('display', 'A label for showing the value; it is not used to compare.'),
      text('type', 'What kind of value this is.', { canonicalValues: types }),
      attr('primary', 'boolean', 'Whether this is the preferred value; at most one is.'),
    ],
  });
}

/** Common attributes every resource has (RFC 7643 3.1); not listed under /Schemas. */
export const COMMON_ATTRIBUTES: AttributeDef[] = [
  text('id', 'The identifier Taskmoor gives the resource.', {
    caseExact: true,
    mutability: 'readOnly',
    returned: 'always',
    uniqueness: 'server',
  }),
  text('externalId', "The provisioning client's own identifier for the resource.", {
    caseExact: true,
  }),
  attr('meta', 'complex', 'Facts about the resource kept by Taskmoor.', {
    mutability: 'readOnly',
    subAttributes: [
      text('resourceType', 'User or Group.', { caseExact: true, mutability: 'readOnly' }),
      attr('created', 'dateTime', 'When the resource was added.', { mutability: 'readOnly' }),
      attr('lastModified', 'dateTime', 'When the resource last changed.', {
        mutability: 'readOnly',
      }),
      attr('location', 'reference', 'The address of the resource.', {
        caseExact: true,
        mutability: 'readOnly',
        referenceTypes: ['uri'],
      }),
    ],
  }),
];

const USER_ATTRIBUTES: AttributeDef[] = [
  text('userName', 'The name the person is known by to the provisioning client; unique.', {
    required: true,
    uniqueness: 'server',
  }),
  attr('name', 'complex', "The parts of the person's name.", {
    subAttributes: [
      text('formatted', 'The whole name as it should be shown.'),
      text('familyName', 'The family name.'),
      text('givenName', 'The given name.'),
      text('middleName', 'The middle name.'),
      text('honorificPrefix', 'A title before the name.'),
      text('honorificSuffix', 'A suffix after the name.'),
    ],
  }),
  text('displayName', 'The name shown for the person in Taskmoor.'),
  text('nickName', 'An informal name.'),
  attr('profileUrl', 'reference', 'A page about the person.', { referenceTypes: ['external'] }),
  text('title', 'Job title.'),
  text('userType', 'How the organisation classifies the person.'),
  text('preferredLanguage', 'Preferred language, as a language tag.'),
  text('locale', 'Locale for dates and numbers, as a language tag.'),
  text('timezone', 'Time zone, as an IANA name.'),
  attr('active', 'boolean', 'Whether the account may sign in; false deactivates it.'),
  text('password', 'Never stored: accounts provisioned here sign in through single sign-on.', {
    mutability: 'writeOnly',
    returned: 'never',
  }),
  multi(
    'emails',
    'Email addresses; the primary or work one is the account email.',
    text('value', 'The address.'),
    ['work', 'home', 'other'],
  ),
  multi('phoneNumbers', 'Phone numbers.', text('value', 'The number.'), [
    'work',
    'home',
    'mobile',
    'fax',
    'pager',
    'other',
  ]),
  multi('ims', 'Instant messaging handles.', text('value', 'The handle.'), [
    'work',
    'home',
    'other',
  ]),
  multi(
    'photos',
    'Pictures of the person.',
    attr('value', 'reference', 'Where the picture is.', { referenceTypes: ['external'] }),
    ['photo', 'thumbnail'],
  ),
  attr('addresses', 'complex', 'Postal addresses.', {
    multiValued: true,
    subAttributes: [
      text('formatted', 'The whole address as it should be shown.'),
      text('streetAddress', 'Street, house number and the like.'),
      text('locality', 'City or locality.'),
      text('region', 'State or region.'),
      text('postalCode', 'Postal code.'),
      text('country', 'Country, as a two-letter code.'),
      text('type', 'What kind of address this is.', { canonicalValues: ['work', 'home', 'other'] }),
      attr('primary', 'boolean', 'Whether this is the preferred address; at most one is.'),
    ],
  }),
  attr('groups', 'complex', 'Groups the person is a direct member of; change them on the group.', {
    multiValued: true,
    mutability: 'readOnly',
    subAttributes: [
      text('value', 'The id of the group.', { mutability: 'readOnly' }),
      attr('$ref', 'reference', 'The address of the group.', {
        mutability: 'readOnly',
        referenceTypes: ['Group'],
      }),
      text('display', 'The name of the group.', { mutability: 'readOnly' }),
      text('type', 'direct, or indirect through a nested group.', {
        mutability: 'readOnly',
        canonicalValues: ['direct', 'indirect'],
      }),
    ],
  }),
  multi(
    'entitlements',
    'Entitlements the client records for the person.',
    text('value', 'The entitlement.'),
    [],
  ),
  multi(
    'roles',
    'Roles the client records for the person; they grant nothing in Taskmoor.',
    text('value', 'The role.'),
    [],
  ),
];

const ENTERPRISE_ATTRIBUTES: AttributeDef[] = [
  text('employeeNumber', 'The number the organisation gives the person.'),
  text('costCenter', 'Cost centre.'),
  text('organization', 'Organisation.'),
  text('division', 'Division.'),
  text('department', 'Department.'),
  attr('manager', 'complex', "The person's manager.", {
    subAttributes: [
      text('value', 'The id of the manager as a SCIM user.'),
      attr('$ref', 'reference', 'The address of the manager.', { referenceTypes: ['User'] }),
      text('displayName', 'The name of the manager.', { mutability: 'readOnly' }),
    ],
  }),
];

const GROUP_ATTRIBUTES: AttributeDef[] = [
  text('displayName', 'The name of the group; unique on the site, ignoring case.', {
    required: true,
    uniqueness: 'server',
  }),
  attr('members', 'complex', 'People who are direct members of the group.', {
    multiValued: true,
    subAttributes: [
      text('value', 'The id of the member.', { caseExact: true, mutability: 'immutable' }),
      attr('$ref', 'reference', 'The address of the member.', {
        mutability: 'immutable',
        referenceTypes: ['User'],
      }),
      text('display', 'The name of the member.', { mutability: 'readOnly' }),
      text('type', 'User; groups inside groups are managed in Taskmoor.', {
        mutability: 'immutable',
        canonicalValues: ['User'],
      }),
    ],
  }),
];

export interface SchemaDef {
  id: string;
  name: string;
  description: string;
  attributes: AttributeDef[];
}

export const SCHEMAS: readonly SchemaDef[] = [
  {
    id: USER_SCHEMA,
    name: 'User',
    description: 'A person with an account.',
    attributes: USER_ATTRIBUTES,
  },
  {
    id: ENTERPRISE_USER_SCHEMA,
    name: 'EnterpriseUser',
    description: 'Organisational facts about a person.',
    attributes: ENTERPRISE_ATTRIBUTES,
  },
  {
    id: GROUP_SCHEMA,
    name: 'Group',
    description: 'A group of people.',
    attributes: GROUP_ATTRIBUTES,
  },
];

export interface ResourceTypeDef {
  name: 'User' | 'Group';
  endpoint: '/Users' | '/Groups';
  description: string;
  schema: SchemaDef;
  extensions: SchemaDef[];
}

const schemaById = (id: string) => SCHEMAS.find((s) => s.id === id) as SchemaDef;

export const USER_TYPE: ResourceTypeDef = {
  name: 'User',
  endpoint: '/Users',
  description: 'People with a Taskmoor account.',
  schema: schemaById(USER_SCHEMA),
  extensions: [schemaById(ENTERPRISE_USER_SCHEMA)],
};

export const GROUP_TYPE: ResourceTypeDef = {
  name: 'Group',
  endpoint: '/Groups',
  description: 'Groups of people on the site.',
  schema: schemaById(GROUP_SCHEMA),
  extensions: [],
};

export const RESOURCE_TYPES: readonly ResourceTypeDef[] = [USER_TYPE, GROUP_TYPE];

/** An attribute definition by name, ignoring case (RFC 7643 2.1). */
export function findAttribute(
  attributes: readonly AttributeDef[] | undefined,
  name: string,
): AttributeDef | undefined {
  const lower = name.toLowerCase();
  return attributes?.find((a) => a.name.toLowerCase() === lower);
}

/** The schema a URN names for this resource type (its own or an extension), ignoring case. */
export function schemaFor(type: ResourceTypeDef, urn: string): SchemaDef | undefined {
  const lower = urn.toLowerCase();
  return [type.schema, ...type.extensions].find((s) => s.id.toLowerCase() === lower);
}

/** The extension whose URN starts `text` followed by a colon, for `urn:...:User:department`. */
export function extensionPrefix(
  type: ResourceTypeDef,
  text: string,
): { schema: SchemaDef; rest: string } | undefined {
  const lower = text.toLowerCase();
  for (const schema of [type.schema, ...type.extensions]) {
    const id = schema.id.toLowerCase();
    if (lower.startsWith(`${id}:`)) return { schema, rest: text.slice(id.length + 1) };
  }
  return undefined;
}

function attributeView(a: AttributeDef): Record<string, unknown> {
  return {
    name: a.name,
    type: a.type,
    multiValued: a.multiValued,
    description: a.description,
    required: a.required,
    caseExact: a.caseExact,
    mutability: a.mutability,
    returned: a.returned,
    uniqueness: a.uniqueness,
    ...(a.canonicalValues && a.canonicalValues.length > 0
      ? { canonicalValues: a.canonicalValues }
      : {}),
    ...(a.referenceTypes ? { referenceTypes: a.referenceTypes } : {}),
    ...(a.subAttributes ? { subAttributes: a.subAttributes.map(attributeView) } : {}),
  };
}

export function schemaView(schema: SchemaDef, base: string): Record<string, unknown> {
  return {
    schemas: [SCHEMA_SCHEMA],
    id: schema.id,
    name: schema.name,
    description: schema.description,
    attributes: schema.attributes.map(attributeView),
    meta: { resourceType: 'Schema', location: `${base}/Schemas/${schema.id}` },
  };
}

export function resourceTypeView(type: ResourceTypeDef, base: string): Record<string, unknown> {
  return {
    schemas: [RESOURCE_TYPE_SCHEMA],
    id: type.name,
    name: type.name,
    endpoint: type.endpoint,
    description: type.description,
    schema: type.schema.id,
    ...(type.extensions.length > 0
      ? { schemaExtensions: type.extensions.map((e) => ({ schema: e.id, required: false })) }
      : {}),
    meta: { resourceType: 'ResourceType', location: `${base}/ResourceTypes/${type.name}` },
  };
}

/**
 * What this service supports (RFC 7643 5): PATCH and filtering yes; bulk, sorting, password
 * changes and ETags no. Authentication is a bearer token of a service account with the `scim`
 * scope (ADR-038).
 */
export function serviceProviderConfig(base: string): Record<string, unknown> {
  return {
    schemas: [SERVICE_PROVIDER_CONFIG_SCHEMA],
    patch: { supported: true },
    bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: MAX_RESULTS },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [
      {
        type: 'oauthbearertoken',
        name: 'Bearer token',
        description:
          'A token of a Taskmoor service account with the scim scope, sent as Authorization: Bearer.',
        primary: true,
      },
    ],
    meta: {
      resourceType: 'ServiceProviderConfig',
      location: `${base}/ServiceProviderConfig`,
    },
  };
}
