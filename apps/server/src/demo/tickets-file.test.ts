import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  descriptionFor,
  labelsFor,
  loadedId,
  parseTicketsFile,
  stageFor,
  summaryFor,
  trackFor,
} from './tickets-file';

const FILE = `# Tickets

States:

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-001 | Before any section | Done | ignored |

## Setup and repository

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-010 | Commit identity | Done | \`CLAUDE.md\` |
| T-011 | Release key | You | Waiting on the user |

## Tickets

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-020 | The create form | In progress | apps/web |

## Flutter app (stopped)

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-030 | Flutter sign-in | Later | stopped |

## Known gaps found along the way

| ID | Ticket | State | Where and notes |
|---|---|---|---|
| T-040 | The panel loses focus | To do | a | b in the notes |
| T-041 | A migration is slow | To do | server only |
| T-042 | No notes yet | To do | |
| T-197 | The board: shows something | To do | placed by hand |
| T-200 | Server thing | To do | placed by hand |
| T-089e | Drafts and scenarios | On branch | a letter after the number |
| T-040 | A repeated row | Done | dropped |
`;

/** tickets.md as the demo reads it (T-239): rows, sections and the three tracks. */
describe('the demo reads tickets.md', () => {
  const rows = parseTicketsFile(FILE);
  const byId = (id: string) => rows.find((r) => r.id === id);

  it('[CORE-001] reads one row per ticket under a section, with its cells trimmed', () => {
    expect(rows.map((r) => r.id)).toEqual([
      'T-010',
      'T-011',
      'T-020',
      'T-030',
      'T-040',
      'T-041',
      'T-042',
      'T-197',
      'T-200',
      'T-089e',
    ]);
    expect(byId('T-010')).toEqual({
      id: 'T-010',
      summary: 'Commit identity',
      state: 'Done',
      notes: '`CLAUDE.md`',
      section: 'Setup and repository',
      track: 'BE',
    });
    // A bar inside the notes stays in the notes.
    expect(byId('T-040')?.notes).toBe('a | b in the notes');
    expect(byId('T-040')?.state).toBe('To do');
    expect(byId('T-042')?.notes).toBe('');
  });

  it('[CORE-001] splits by section: Flutter, the front sections, the known gaps by their words', () => {
    expect(Object.fromEntries(rows.map((r) => [r.id, r.track]))).toEqual({
      'T-010': 'BE',
      'T-011': 'BE',
      'T-020': 'FE',
      'T-030': 'FL',
      'T-040': 'FE',
      'T-041': 'BE',
      'T-042': 'BE',
      // The hand-placed gaps win over their words.
      'T-197': 'BE',
      'T-200': 'FE',
      'T-089e': 'BE',
    });
    expect(
      trackFor({ id: 'T-999', summary: 'x', notes: 'see apps/web/src', section: 'Known gaps' }),
    ).toBe('FE');
    expect(
      trackFor({ id: 'T-999', summary: 'x', notes: 'see apps/web/src', section: 'Administration' }),
    ).toBe('BE');
  });

  it('[CORE-014] puts Done in the closed stage, In progress in the active one and the rest new', () => {
    expect(['Done', 'In progress', 'To do', 'You', 'Later', 'On branch'].map(stageFor)).toEqual([
      'closed',
      'active',
      'new',
      'new',
      'new',
      'new',
    ]);
  });

  it('[CORE-017] labels a ticket with its section, and You and Later with needs-you and later', () => {
    expect(labelsFor(byId('T-011') as never)).toEqual(['setup-and-repository', 'needs-you']);
    expect(labelsFor(byId('T-030') as never)).toEqual(['flutter-app-stopped', 'later']);
    expect(labelsFor(byId('T-020') as never)).toEqual(['tickets']);
  });

  it('[CORE-008] names a ticket "T-123 · summary" and keeps the notes as its description', () => {
    const row = byId('T-089e') as never;
    expect(summaryFor(row)).toBe('T-089e · Drafts and scenarios');
    expect(loadedId(summaryFor(row))).toBe('T-089e');
    expect(loadedId('T-12 without the dot')).toBeNull();
    expect(loadedId('A sample ticket')).toBeNull();
    expect(descriptionFor(byId('T-010') as never)).toBe(
      '`CLAUDE.md`\n\nFrom `docs/plan/tickets.md`, section *Setup and repository*.',
    );
    expect(summaryFor({ ...byId('T-010'), summary: 'x'.repeat(400) } as never)).toHaveLength(250);
  });

  it('[CORE-001] reads the repository’s own tickets.md into the three tracks', () => {
    const text = readFileSync(new URL('../../../../docs/plan/tickets.md', import.meta.url), 'utf8');
    const all = parseTicketsFile(text);
    expect(all.length).toBeGreaterThan(200);
    expect(new Set(all.map((r) => r.track))).toEqual(new Set(['BE', 'FE', 'FL']));
    expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
  });
});
