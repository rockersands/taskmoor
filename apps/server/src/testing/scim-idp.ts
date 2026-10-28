/**
 * How two identity providers talk to a SCIM service, as request sequences (M1-083 done-when:
 * IdP payload fixtures; IAM-006 (1)). The payloads are synthetic: made-up people and
 * organisations, in the shapes each provider documents and sends (the op letter case, the
 * filters, the string booleans, the member updates). `routes/scim.idp.test.ts` replays them.
 *
 * In a step, `{name}` in a path or a string value is replaced by a value an earlier step
 * captured; `capture` reads a value from the response body by a dotted path.
 */
export interface ScimStep {
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  status: number;
  /** Values to read from the response for later steps: variable name to dotted path. */
  capture?: Record<string, string>;
  /** What the response body must contain (a subset). */
  expect?: Record<string, unknown>;
  /** Attributes the response must not have. */
  absent?: string[];
}

const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const ENTERPRISE = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const PATCH_OP = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';

/**
 * Microsoft Entra ID: probes with a filter on a random userName, looks a person up by userName
 * before creating them, sends capitalised ops, string booleans, value paths for emails, the
 * manager as a bare id, and adds or removes group members with the members as the value.
 */
export const ENTRA_ID: readonly ScimStep[] = [
  {
    name: 'connection test with a random userName',
    method: 'GET',
    path: '/Users?filter=userName eq "4f1b7d2c-0e86-4c0b-9a4f-2d1e8f3b6a90"',
    status: 200,
    expect: { schemas: [LIST], totalResults: 0, Resources: [] },
  },
  {
    name: 'look up the manager before creating',
    method: 'GET',
    path: '/Users?filter=userName eq "bo.manager@contoso.example"',
    status: 200,
    expect: { totalResults: 0 },
  },
  {
    name: 'create the manager',
    method: 'POST',
    path: '/Users',
    body: {
      schemas: [USER, ENTERPRISE],
      externalId: 'b5d1e7a0-6c1f-4f1e-8a2b-0c9d8e7f6a51',
      userName: 'bo.manager@contoso.example',
      active: true,
      displayName: 'Bo Manager',
      emails: [{ primary: true, type: 'work', value: 'bo.manager@contoso.example' }],
      meta: { resourceType: 'User' },
      name: { formatted: 'Bo Manager', familyName: 'Manager', givenName: 'Bo' },
      roles: [],
    },
    status: 201,
    capture: { managerId: 'id' },
  },
  {
    name: 'create a person with the enterprise extension',
    method: 'POST',
    path: '/Users',
    body: {
      schemas: [USER, ENTERPRISE],
      externalId: '0a21f0f2-8d2a-4f8f-a9c3-3f1d2b4c5e60',
      userName: 'alice@contoso.example',
      active: true,
      displayName: 'Alice Example',
      title: 'Researcher',
      emails: [{ primary: true, type: 'work', value: 'alice@contoso.example' }],
      preferredLanguage: 'en-US',
      name: { formatted: 'Alice Example', familyName: 'Example', givenName: 'Alice' },
      phoneNumbers: [{ type: 'mobile', value: '+1 555 0142' }],
      addresses: [{ type: 'work', formatted: '1 Lab Road', locality: 'Redmond', country: 'US' }],
      [ENTERPRISE]: {
        department: 'Research',
        employeeNumber: '42',
        manager: { value: '{managerId}' },
      },
    },
    status: 201,
    capture: { aliceId: 'id' },
    expect: {
      userName: 'alice@contoso.example',
      active: true,
      [ENTERPRISE]: { department: 'Research', manager: { value: '{managerId}' } },
    },
  },
  {
    name: 'read the person back',
    method: 'GET',
    path: '/Users/{aliceId}',
    status: 200,
    expect: { id: '{aliceId}', externalId: '0a21f0f2-8d2a-4f8f-a9c3-3f1d2b4c5e60' },
  },
  {
    name: 'update attributes with capitalised ops and a value path',
    method: 'PATCH',
    path: '/Users/{aliceId}',
    body: {
      schemas: [PATCH_OP],
      Operations: [
        { op: 'Replace', path: 'displayName', value: 'Alice E.' },
        { op: 'Add', path: 'phoneNumbers[type eq "work"].value', value: '+1 555 0100' },
        { op: 'Replace', path: `${ENTERPRISE}:department`, value: 'Applied Research' },
        { op: 'Add', path: `${ENTERPRISE}:manager`, value: '{managerId}' },
      ],
    },
    status: 200,
    expect: {
      displayName: 'Alice E.',
      phoneNumbers: [
        { type: 'mobile', value: '+1 555 0142' },
        { type: 'work', value: '+1 555 0100' },
      ],
      [ENTERPRISE]: { department: 'Applied Research', manager: { value: '{managerId}' } },
    },
  },
  {
    name: 'change the work email with a value path',
    method: 'PATCH',
    path: '/Users/{aliceId}',
    body: {
      schemas: [PATCH_OP],
      Operations: [
        {
          op: 'Replace',
          path: 'emails[type eq "work"].value',
          value: 'alice.example@contoso.example',
        },
      ],
    },
    status: 200,
    expect: { emails: [{ primary: true, type: 'work', value: 'alice.example@contoso.example' }] },
  },
  {
    name: 'create a group without members',
    method: 'POST',
    path: '/Groups',
    body: {
      schemas: [GROUP],
      externalId: '9c0d1e2f-3a4b-4c5d-8e6f-7a8b9c0d1e2f',
      displayName: 'Research',
      members: [],
    },
    status: 201,
    capture: { groupId: 'id' },
  },
  {
    name: 'look the group up without members',
    method: 'GET',
    path: '/Groups?excludedAttributes=members&filter=displayName eq "Research"',
    status: 200,
    expect: { totalResults: 1, Resources: [{ id: '{groupId}', displayName: 'Research' }] },
  },
  {
    name: 'add members with the members as the value',
    method: 'PATCH',
    path: '/Groups/{groupId}',
    body: {
      schemas: [PATCH_OP],
      Operations: [
        { op: 'Add', path: 'members', value: [{ value: '{aliceId}' }, { value: '{managerId}' }] },
      ],
    },
    status: 200,
  },
  {
    name: 'remove a member with the member as the value',
    method: 'PATCH',
    path: '/Groups/{groupId}',
    body: {
      schemas: [PATCH_OP],
      Operations: [{ op: 'Remove', path: 'members', value: [{ value: '{managerId}' }] }],
    },
    status: 200,
    expect: { members: [{ value: '{aliceId}' }] },
  },
  {
    name: 'rename the group',
    method: 'PATCH',
    path: '/Groups/{groupId}',
    body: {
      schemas: [PATCH_OP],
      Operations: [{ op: 'Replace', path: 'displayName', value: 'Research Lab' }],
    },
    status: 200,
    expect: { displayName: 'Research Lab' },
  },
  {
    name: 'disable the person with a string boolean',
    method: 'PATCH',
    path: '/Users/{aliceId}',
    body: { schemas: [PATCH_OP], Operations: [{ op: 'Replace', path: 'active', value: 'False' }] },
    status: 200,
    expect: { active: false },
  },
  {
    name: 'delete the person after the soft-delete period',
    method: 'DELETE',
    path: '/Users/{aliceId}',
    status: 204,
  },
  {
    name: 'the deleted person is gone',
    method: 'GET',
    path: '/Users/{aliceId}',
    status: 404,
  },
];

/**
 * Okta: pages with startIndex and count, sends a password it expects to be ignored, replaces
 * whole profiles with PUT, flips active with a path-less replace, renames groups with a
 * path-less value that includes the id, and removes members with a value filter.
 */
export const OKTA: readonly ScimStep[] = [
  {
    name: 'list users page by page',
    method: 'GET',
    path: '/Users?startIndex=1&count=100',
    status: 200,
    expect: { schemas: [LIST], startIndex: 1 },
  },
  {
    name: 'look the person up by userName',
    method: 'GET',
    path: '/Users?filter=userName eq "dana@acme.example"&startIndex=1&count=100',
    status: 200,
    expect: { totalResults: 0 },
  },
  {
    name: 'create the person, password included',
    method: 'POST',
    path: '/Users',
    body: {
      schemas: [USER],
      userName: 'dana@acme.example',
      name: { givenName: 'Dana', familyName: 'Okafor' },
      emails: [{ primary: true, value: 'dana@acme.example', type: 'work' }],
      displayName: 'Dana Okafor',
      locale: 'en-US',
      externalId: '00u1abcdEFGH2345ijkl',
      groups: [],
      password: 'Temporary-Pass-1',
      active: true,
    },
    status: 201,
    capture: { danaId: 'id' },
    absent: ['password'],
    expect: { userName: 'dana@acme.example', displayName: 'Dana Okafor', locale: 'en-US' },
  },
  {
    name: 'read the person back',
    method: 'GET',
    path: '/Users/{danaId}',
    status: 200,
    expect: { id: '{danaId}', active: true },
  },
  {
    name: 'push a changed profile with PUT',
    method: 'PUT',
    path: '/Users/{danaId}',
    body: {
      schemas: [USER],
      id: '{danaId}',
      userName: 'dana@acme.example',
      name: { givenName: 'Dana', familyName: 'Okafor-Reyes' },
      emails: [{ primary: true, value: 'dana@acme.example', type: 'work' }],
      displayName: 'Dana Okafor-Reyes',
      locale: 'en-GB',
      externalId: '00u1abcdEFGH2345ijkl',
      groups: [],
      active: true,
    },
    status: 200,
    expect: {
      displayName: 'Dana Okafor-Reyes',
      locale: 'en-GB',
      name: { familyName: 'Okafor-Reyes' },
    },
  },
  {
    name: 'deactivate with a path-less replace',
    method: 'PATCH',
    path: '/Users/{danaId}',
    body: { schemas: [PATCH_OP], Operations: [{ op: 'replace', value: { active: false } }] },
    status: 200,
    expect: { active: false },
  },
  {
    name: 'reactivate the same way',
    method: 'PATCH',
    path: '/Users/{danaId}',
    body: { schemas: [PATCH_OP], Operations: [{ op: 'replace', value: { active: true } }] },
    status: 200,
    expect: { active: true },
  },
  {
    name: 'push a group',
    method: 'POST',
    path: '/Groups',
    body: { schemas: [GROUP], displayName: 'Engineering', members: [] },
    status: 201,
    capture: { groupId: 'id' },
  },
  {
    name: 'rename the group with a path-less value carrying its id',
    method: 'PATCH',
    path: '/Groups/{groupId}',
    body: {
      schemas: [PATCH_OP],
      Operations: [{ op: 'replace', value: { id: '{groupId}', displayName: 'Engineering Team' } }],
    },
    status: 200,
    expect: { displayName: 'Engineering Team' },
  },
  {
    name: 'add a member',
    method: 'PATCH',
    path: '/Groups/{groupId}',
    body: {
      schemas: [PATCH_OP],
      Operations: [
        {
          op: 'add',
          path: 'members',
          value: [{ value: '{danaId}', display: 'dana@acme.example' }],
        },
      ],
    },
    status: 200,
    expect: { members: [{ value: '{danaId}' }] },
  },
  {
    name: 'find the group by name, page by page',
    method: 'GET',
    path: '/Groups?filter=displayName eq "Engineering Team"&startIndex=1&count=100',
    status: 200,
    expect: { totalResults: 1, Resources: [{ id: '{groupId}' }] },
  },
  {
    name: 'remove the member with a value filter',
    method: 'PATCH',
    path: '/Groups/{groupId}',
    body: {
      schemas: [PATCH_OP],
      Operations: [{ op: 'remove', path: 'members[value eq "{danaId}"]' }],
    },
    status: 200,
    absent: ['members'],
  },
  {
    name: 'delete the group',
    method: 'DELETE',
    path: '/Groups/{groupId}',
    status: 204,
  },
];
