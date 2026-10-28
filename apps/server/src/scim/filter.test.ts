import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { ScimError } from './errors';
import { equalityTerms, matches, parseFilter, parsePath } from './filter';
import { ENTERPRISE_USER_SCHEMA, GROUP_TYPE, USER_TYPE } from './schemas';

/** A user resource as the service shows it. */
const ada = {
  schemas: ['urn:ietf:params:scim:schemas:core:2.0:User', ENTERPRISE_USER_SCHEMA],
  id: '7',
  externalId: 'E-007',
  userName: 'ada@example.com',
  name: { givenName: 'Ada', familyName: 'Lovelace' },
  displayName: 'Ada Lovelace',
  title: 'Analyst',
  active: true,
  emails: [
    { value: 'ada@example.com', type: 'work', primary: true },
    { value: 'ada@home.example', type: 'home' },
  ],
  [ENTERPRISE_USER_SCHEMA]: { department: 'Engines', manager: { value: '3' } },
  meta: {
    resourceType: 'User',
    created: '2026-01-02T03:04:05Z',
    lastModified: '2026-10-01T00:00:00Z',
  },
};

const userMatches = (filter: string) => matches(ada, parseFilter(filter, USER_TYPE));

function scimType(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    if (error instanceof ScimError) return `${error.status} ${error.scimType}`;
    throw error;
  }
  return undefined;
}

describe('SCIM filters (IAM-006, RFC 7644 3.4.2.2)', () => {
  it('[IAM-006] compares with every operator, ignoring case where the attribute does', () => {
    const cases: [string, boolean][] = [
      ['userName eq "ADA@example.com"', true],
      ['userName ne "ada@example.com"', false],
      ['userName co "example"', true],
      ['userName sw "ada@"', true],
      ['userName ew ".com"', true],
      ['externalId eq "e-007"', false],
      ['externalId eq "E-007"', true],
      ['id eq "7"', true],
      ['active eq true', true],
      ['active eq false', false],
      ['title pr', true],
      ['nickName pr', false],
      ['nickName eq null', true],
      ['meta.created lt "2026-02-01T00:00:00Z"', true],
      ['meta.lastModified gt "2026-10-01T00:00:00Z"', false],
      ['meta.lastModified ge "2026-10-01T00:00:00Z"', true],
      ['name.familyName eq "lovelace"', true],
      ['USERNAME Eq "ada@example.com"', true],
    ];
    for (const [filter, expected] of cases) expect(userMatches(filter), filter).toBe(expected);
  });

  it('[IAM-006] combines with and, or, not and parentheses, and binds and tighter than or', () => {
    expect(userMatches('title eq "Analyst" and active eq true')).toBe(true);
    expect(userMatches('title eq "Nobody" or active eq true')).toBe(true);
    expect(userMatches('not (title eq "Analyst")')).toBe(false);
    // and before or: true or (false and false)
    expect(userMatches('active eq true or title eq "x" and title eq "y"')).toBe(true);
    expect(userMatches('(active eq true or title eq "x") and title eq "y"')).toBe(false);
  });

  it('[IAM-006] filters multi-valued attributes by value and by value path', () => {
    expect(userMatches('emails eq "ada@home.example"')).toBe(true);
    expect(userMatches('emails.value eq "ada@home.example"')).toBe(true);
    expect(userMatches('emails[type eq "work" and value co "example.com"]')).toBe(true);
    expect(userMatches('emails[type eq "home" and primary eq true]')).toBe(false);
    // The sub-attribute of the matching values only, as identity providers send it.
    expect(userMatches('emails[type eq "work"].value eq "ada@example.com"')).toBe(true);
    expect(userMatches('emails[type eq "home"].value eq "ada@example.com"')).toBe(false);
  });

  it('[IAM-006] reaches extension attributes by their full name', () => {
    expect(userMatches(`${ENTERPRISE_USER_SCHEMA}:department eq "engines"`)).toBe(true);
    expect(userMatches(`${ENTERPRISE_USER_SCHEMA}:manager.value eq "3"`)).toBe(true);
  });

  it('[IAM-006] refuses malformed filters and unknown attributes with invalidFilter', () => {
    for (const bad of [
      '',
      'userName',
      'userName eq',
      'userName equals "x"',
      'nonsense eq "x"',
      'userName eq "unterminated',
      'userName eq "x" and',
      '(userName eq "x"',
      'emails[type eq "work"',
      'title[value eq "x"]',
      'urn:example:unknown:attr eq "x"',
      `userName eq "x" ${'and title pr '.repeat(400)}`,
    ]) {
      expect(
        scimType(() => parseFilter(bad, USER_TYPE)),
        bad,
      ).toBe('400 invalidFilter');
    }
    expect(scimType(() => parseFilter('members.display eq "x"', GROUP_TYPE))).toBeUndefined();
  });

  it('[IAM-006] lists the equality terms that SQL can narrow by', () => {
    const filter = parseFilter(
      'userName eq "a" and (title eq "b" or active eq true) and externalId eq "c"',
      USER_TYPE,
    );
    expect(equalityTerms(filter)).toEqual([
      { attribute: 'userName', value: 'a' },
      { attribute: 'externalId', value: 'c' },
    ]);
    expect(equalityTerms(parseFilter('emails[type eq "work"].value eq "x"', USER_TYPE))).toEqual([
      { attribute: 'emails', value: 'x' },
    ]);
  });
});

describe('SCIM paths (RFC 7644 3.5.2)', () => {
  it('[IAM-006] parses plain, sub-attribute, value-path and extension paths', () => {
    expect(parsePath('displayName', USER_TYPE).attr.name).toBe('displayName');
    expect(parsePath('name.givenName', USER_TYPE).sub?.name).toBe('givenName');
    const valuePath = parsePath('emails[type eq "work"].value', USER_TYPE);
    expect([valuePath.attr.name, valuePath.sub?.name, valuePath.filter?.op]).toEqual([
      'emails',
      'value',
      'eq',
    ]);
    const extension = parsePath(`${ENTERPRISE_USER_SCHEMA}:department`, USER_TYPE);
    expect([extension.urn, extension.attr.name]).toEqual([ENTERPRISE_USER_SCHEMA, 'department']);
    expect(parsePath('members[value eq "12"]', GROUP_TYPE).filter).toBeDefined();
    for (const bad of [
      '',
      'nonsense',
      'name.nonsense',
      'title[value eq "x"]',
      'emails[type eq "work"',
      'emails[type eq "work"]x',
    ]) {
      expect(
        scimType(() => parsePath(bad, USER_TYPE)),
        bad,
      ).toBe('400 invalidPath');
    }
  });
});

describe('SCIM filter robustness', () => {
  it('[IAM-006] answers any input with a filter or a SCIM error, never a crash', () => {
    const pieces = fc.constantFrom(
      'userName',
      'emails',
      'emails[',
      ']',
      '.value',
      'type',
      'eq',
      'ne',
      'co',
      'pr',
      'gt',
      'and',
      'or',
      'not',
      '(',
      ')',
      '"x"',
      '"',
      '\\',
      '42',
      '-1.5e3',
      'true',
      'null',
      ' ',
      'meta.created',
      `${ENTERPRISE_USER_SCHEMA}:manager.value`,
      'urn:',
      'é',
      '[',
      '.',
    );
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.array(pieces, { maxLength: 30 }).map((p) => p.join(' ')),
        ),
        (input) => {
          for (const type of [USER_TYPE, GROUP_TYPE]) {
            for (const parse of [parseFilter, parsePath]) {
              try {
                const parsed = parse(input, type);
                if (parse === parseFilter) matches(ada, parsed as ReturnType<typeof parseFilter>);
              } catch (error) {
                expect(error).toBeInstanceOf(ScimError);
              }
            }
          }
        },
      ),
      { numRuns: 2_000 },
    );
  });
});
