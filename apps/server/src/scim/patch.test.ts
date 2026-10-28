import { describe, expect, it } from 'vitest';
import { ScimError } from './errors';
import { applyPatch, type PatchOperation } from './patch';
import type { Resource } from './resource';
import { ENTERPRISE_USER_SCHEMA, GROUP_TYPE, USER_TYPE } from './schemas';

const user = (): Resource => ({
  id: '7',
  userName: 'ada@example.com',
  displayName: 'Ada Lovelace',
  name: { givenName: 'Ada', familyName: 'Lovelace' },
  active: true,
  emails: [{ value: 'ada@example.com', type: 'work', primary: true }],
  groups: [{ value: '4', display: 'Analysts' }],
  meta: { resourceType: 'User' },
});

const patch = (resource: Resource, ...operations: PatchOperation[]) =>
  applyPatch(resource, operations, USER_TYPE);

function failure(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof ScimError) return `${error.status} ${error.scimType ?? ''}`.trim();
    throw error;
  }
  return undefined;
}

describe('SCIM PATCH (IAM-006, RFC 7644 3.5.2)', () => {
  it('[IAM-006] sets, merges and removes simple and complex attributes', () => {
    const out = patch(
      user(),
      { op: 'replace', path: 'displayName', value: 'Countess of Lovelace' },
      { op: 'add', path: 'name', value: { middleName: 'King' } },
      { op: 'replace', path: 'name.givenName', value: 'Augusta Ada' },
      { op: 'add', path: 'title', value: 'Analyst' },
      { op: 'remove', path: 'name.familyName' },
    );
    expect(out).toMatchObject({
      displayName: 'Countess of Lovelace',
      name: { givenName: 'Augusta Ada', middleName: 'King' },
      title: 'Analyst',
    });
    expect((out.name as Resource).familyName).toBeUndefined();
  });

  it('[IAM-006] adds values to multi-valued attributes, picks them by filter, and keeps one primary', () => {
    const out = patch(
      user(),
      {
        op: 'add',
        path: 'emails',
        value: [{ value: 'ada@home.example', type: 'home', primary: true }],
      },
      { op: 'add', path: 'phoneNumbers', value: [{ value: '+44 20 0000 0000', type: 'work' }] },
    );
    expect(out.emails).toEqual([
      { value: 'ada@example.com', type: 'work' },
      { value: 'ada@home.example', type: 'home', primary: true },
    ]);
    // A value that is there already is merged, not repeated.
    const again = patch(out, {
      op: 'add',
      path: 'emails',
      value: [{ value: 'ADA@home.example', display: 'Home' }],
    });
    expect((again.emails as unknown[]).length).toBe(2);
    const replaced = patch(out, {
      op: 'replace',
      path: 'emails[type eq "home"].value',
      value: 'ada@new.example',
    });
    expect((replaced.emails as Resource[])[1]?.value).toBe('ada@new.example');
    const removed = patch(out, { op: 'remove', path: 'emails[type eq "home"]' });
    expect(removed.emails).toEqual([{ value: 'ada@example.com', type: 'work' }]);
  });

  it('[IAM-006] creates the value a filter describes when none matches, as Entra ID expects', () => {
    const out = patch(user(), {
      op: 'add',
      path: 'phoneNumbers[type eq "mobile"].value',
      value: '+1 555 0100',
    });
    expect(out.phoneNumbers).toEqual([{ type: 'mobile', value: '+1 555 0100' }]);
    expect(
      failure(() =>
        patch(user(), { op: 'replace', path: 'phoneNumbers[value co "5"].type', value: 'work' }),
      ),
    ).toBe('400 noTarget');
  });

  it('[IAM-006] takes a path-less object, ignoring read-only attributes in it, as Okta sends', () => {
    const out = patch(user(), {
      op: 'replace',
      value: {
        id: '7',
        meta: { x: 1 },
        active: false,
        displayName: 'Ada L.',
        'name.familyName': 'King',
      },
    });
    expect(out).toMatchObject({
      id: '7',
      active: false,
      displayName: 'Ada L.',
      name: { familyName: 'King' },
    });
    expect(out.meta).toEqual({ resourceType: 'User' });
  });

  it('[IAM-006] coerces the string booleans and bare ids identity providers send', () => {
    expect(patch(user(), { op: 'replace', path: 'active', value: 'False' }).active).toBe(false);
    const manager = patch(user(), {
      op: 'add',
      path: `${ENTERPRISE_USER_SCHEMA}:manager`,
      value: '3',
    });
    expect(manager[ENTERPRISE_USER_SCHEMA]).toEqual({ manager: { value: '3' } });
    const whole = patch(user(), {
      op: 'add',
      path: ENTERPRISE_USER_SCHEMA,
      value: { department: 'Engines', employeeNumber: 42 },
    });
    expect(whole[ENTERPRISE_USER_SCHEMA]).toEqual({ department: 'Engines', employeeNumber: '42' });
    expect(
      patch(whole, { op: 'remove', path: `${ENTERPRISE_USER_SCHEMA}:department` })[
        ENTERPRISE_USER_SCHEMA
      ],
    ).toEqual({
      employeeNumber: '42',
    });
  });

  it('[IAM-006] refuses read-only targets, a remove without a path and values of the wrong type', () => {
    expect(failure(() => patch(user(), { op: 'replace', path: 'groups', value: [] }))).toBe(
      '400 mutability',
    );
    expect(failure(() => patch(user(), { op: 'replace', path: 'id', value: '8' }))).toBe(
      '400 mutability',
    );
    expect(failure(() => patch(user(), { op: 'remove' }))).toBe('400 noTarget');
    expect(failure(() => patch(user(), { op: 'replace', path: 'active', value: 'perhaps' }))).toBe(
      '400 invalidValue',
    );
    expect(failure(() => patch(user(), { op: 'add', path: 'title' }))).toBe('400 invalidValue');
    expect(failure(() => patch(user(), { op: 'add', path: 'nonsense', value: 1 }))).toBe(
      '400 invalidPath',
    );
    // A password is accepted and never kept.
    expect(
      patch(user(), { op: 'replace', path: 'password', value: 'secret' }).password,
    ).toBeUndefined();
  });

  it('[IAM-006] applies all operations or none', () => {
    const before = user();
    expect(
      failure(() =>
        patch(
          before,
          { op: 'replace', path: 'displayName', value: 'Changed' },
          { op: 'replace', path: 'id', value: 'x' },
        ),
      ),
    ).toBe('400 mutability');
    expect(before.displayName).toBe('Ada Lovelace');
  });

  it('[IAM-006] adds and removes group members the ways Entra ID and Okta do', () => {
    const group: Resource = {
      id: '4',
      displayName: 'Analysts',
      members: [{ value: '7' }, { value: '8' }],
    };
    const added = applyPatch(
      group,
      [{ op: 'add', path: 'members', value: [{ value: '9', display: 'Mary' }] }],
      GROUP_TYPE,
    );
    expect((added.members as Resource[]).map((m) => m.value)).toEqual(['7', '8', '9']);
    // Entra ID: remove with the members to remove as the value.
    const entra = applyPatch(
      added,
      [{ op: 'remove', path: 'members', value: [{ value: '8' }] }],
      GROUP_TYPE,
    );
    expect((entra.members as Resource[]).map((m) => m.value)).toEqual(['7', '9']);
    // Okta: remove by a value filter.
    const okta = applyPatch(added, [{ op: 'remove', path: 'members[value eq "7"]' }], GROUP_TYPE);
    expect((okta.members as Resource[]).map((m) => m.value)).toEqual(['8', '9']);
    const emptied = applyPatch(added, [{ op: 'remove', path: 'members' }], GROUP_TYPE);
    expect(emptied.members).toBeUndefined();
    const renamed = applyPatch(
      group,
      [{ op: 'replace', value: { id: '4', displayName: 'Analysis' } }],
      GROUP_TYPE,
    );
    expect(renamed.displayName).toBe('Analysis');
  });
});
