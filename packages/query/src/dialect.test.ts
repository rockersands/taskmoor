import { describe, expect, it } from 'vitest';
import { FIELDS, FUNCTIONS } from './conformance/cases/fixtures';
import { FIELD_NAMES, FUNCTION_NAMES, toJira, toNative } from './dialect';
import { parseQuery } from './parser';
import { printQuery } from './print';

const native = (text: string) => printQuery(toNative(parseQuery(text)));
const jira = (text: string) => printQuery(toJira(parseQuery(text)));

describe('Jira-compatible dialect', () => {
  it('[QRY-003] reads both vocabularies into the native names', () => {
    expect(native('project = ABC AND issuetype = Bug ORDER BY createdDate DESC')).toBe(
      'track = ABC AND type = Bug ORDER BY created DESC',
    );
    expect(native('issueKey IN linkedIssues(ABC-1, "blocks") AND "Epic link" = ABC-9')).toBe(
      'key IN linkedTickets(ABC-1, "blocks") AND parent = ABC-9',
    );
    expect(native('track IN projectsWhereUserHasRole("Developers")')).toBe(
      'track IN tracksWhereUserHasRole("Developers")',
    );
  });

  it('[QRY-003] writes the Jira-compatible names', () => {
    expect(jira('track = ABC AND type = Bug ORDER BY created DESC')).toBe(
      'project = ABC AND issuetype = Bug ORDER BY createdDate DESC',
    );
    expect(jira('key IN linkedTickets(ABC-1) OR key IN followedTickets()')).toBe(
      'issuekey IN linkedIssues(ABC-1) OR issuekey IN watchedIssues()',
    );
  });

  it('[QRY-003] normalises the case of known names and leaves the rest alone', () => {
    expect(
      native('STATUS = Done AND ASSIGNEE = CURRENTUSER() AND created >= STARTOFWEEK(-1w)'),
    ).toBe('status = Done AND assignee = currentUser() AND created >= startOfWeek(-1w)');
    expect(native('"Story Points" > 3 AND cf[10016] < 8 AND myOwnField = x AND x = f()')).toBe(
      '"Story Points" > 3 AND cf[10016] < 8 AND myOwnField = x AND x = f()',
    );
  });

  it('[QRY-003] renames inside every clause form, predicates, nested calls and ORDER BY', () => {
    expect(
      native(
        'NOT (issuetype WAS Bug BY membersOf("qa") DURING (startOfMonth(), now()) OR project CHANGED) ' +
          'AND issuetype NOT IN standardIssueTypes() AND project IS NOT EMPTY ' +
          'AND issue IN updatedBy(CURRENTUSER(), startOfDay(-1d)) ORDER BY project ASC, issuetype DESC',
      ),
    ).toBe(
      'NOT (type WAS Bug BY membersOf("qa") DURING (startOfMonth(), now()) OR track CHANGED) ' +
        'AND type NOT IN standardTicketTypes() AND track IS NOT EMPTY ' +
        'AND key IN updatedBy(currentUser(), startOfDay(-1d)) ORDER BY track ASC, type DESC',
    );
  });

  it('[QRY-003] keeps spans so editor positions still point at the source text', () => {
    const query = parseQuery('project = ABC');
    const mapped = toNative(query);
    expect(mapped.where).toMatchObject({ field: { name: 'track', span: { start: 0, end: 7 } } });
  });

  it('[QRY-003] maps every alias of the spec field table and every legacy function name', () => {
    const fieldTable = new Map(FIELD_NAMES.map(([n, ...j]) => [n, j]));
    for (const f of FIELDS) {
      for (const alias of f.aliases) {
        const name = alias.replace(/^"|"$/g, '');
        expect(native(`${alias} IS EMPTY`), alias).toBe(`${f.canonical} IS EMPTY`);
        expect(fieldTable.has(f.canonical) || name === f.canonical, f.canonical).toBe(true);
      }
    }
    const functionTable = new Map(FUNCTION_NAMES.map(([native, jira]) => [native, jira]));
    for (const f of FUNCTIONS) {
      expect(functionTable.has(f.name), f.name).toBe(true);
      if (f.legacy) {
        expect(native(`assignee IN ${f.legacy}()`)).toBe(`assignee IN ${f.name}()`);
        expect(jira(`assignee IN ${f.name}()`)).toBe(`assignee IN ${f.legacy}()`);
      }
    }
  });

  it('[QRY-003] is idempotent and round-trips through the other vocabulary', () => {
    const samples = [
      'project = ABC AND issuetype IN (Bug, Story) ORDER BY createdDate DESC',
      'track = ABC AND key IN linkedTickets(ABC-1) AND due < endOfWeek()',
      'resolutionDate >= -1w OR filter = 10001 OR savedFilter = "Mine"',
      'parentProject = ABC AND projectType = software AND issueLinkType = blocks',
    ];
    for (const text of samples) {
      const q = parseQuery(text);
      expect(printQuery(toNative(toNative(q)))).toBe(printQuery(toNative(q)));
      expect(printQuery(toJira(toJira(q)))).toBe(printQuery(toJira(q)));
      expect(printQuery(toNative(toJira(q)))).toBe(printQuery(toNative(q)));
    }
  });
});
