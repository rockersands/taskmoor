import { stableJson } from '@taskmoor/testkit/golden';
import { describe, expect, it } from 'vitest';
import { checksum } from './load';
import {
  type FidelityReport,
  fidelityReport,
  fidelityReportJsonSchema,
  reportHtml,
} from './report';
import { kindOrder } from './run';
import {
  mapSynthetic,
  parseSynthetic,
  SyntheticFormatError,
  SyntheticSource,
  syntheticFixture,
} from './synthetic';

const sum = checksum({ example: true });

const example = (): FidelityReport => ({
  version: 1,
  run: {
    id: 7,
    importSource: 'synthetic',
    sourceSystem: 'synthetic-1',
    name: 'Example',
    dryRun: false,
    status: 'done',
    startedAt: '2026-10-29T08:00:00.000Z',
    finishedAt: '2026-10-29T08:01:00.000Z',
    batches: 3,
  },
  entities: [
    {
      kind: 'ticket',
      source: 10,
      outcomes: { created: 8, updated: 0, unchanged: 0, linked: 0, failed: 1, skipped: 1 },
      target: 8,
      fidelity: 8 / 9,
    },
  ],
  totals: { source: 10, target: 8, failed: 1, fidelity: 8 / 9 },
  samples: [
    {
      kind: 'ticket',
      sourceId: 'i1',
      targetId: 41,
      sourceChecksum: sum,
      targetChecksum: sum,
      match: true,
    },
  ],
  sampleSummary: { compared: 1, matched: 1, mismatched: 0 },
  warnings: [
    { kind: 'ticket', code: 'unknown_priority', detail: 'Blocker', count: 2, examples: ['i3'] },
  ],
  unsupported: [{ kind: 'board', count: 2, reason: 'no_importer_for_kind' }],
  failures: [{ kind: 'ticket', sourceId: 'i9', error: 'number_taken' }],
  failuresTruncated: false,
});

describe('the fidelity report (M1-086, IMP-010)', () => {
  it('[IMP-010] publishes its JSON Schema, changed only on purpose', async () => {
    await expect(stableJson(fidelityReportJsonSchema())).toMatchFileSnapshot(
      './__golden__/fidelity-report.schema.json',
    );
  });

  it('[IMP-010] accepts a well-formed report', () => {
    expect(fidelityReport.parse(example())).toEqual(example());
  });

  it.each([
    ['an unknown version', (r: FidelityReport) => Object.assign(r, { version: 2 })],
    ['a negative count', (r: FidelityReport) => Object.assign(r.totals, { source: -1 })],
    ['a fidelity above 1', (r: FidelityReport) => Object.assign(r.totals, { fidelity: 1.5 })],
    [
      'an unknown entity kind',
      (r: FidelityReport) => Object.assign(r.entities[0] ?? {}, { kind: 'board' }),
    ],
    [
      'a checksum that is not SHA-256',
      (r: FidelityReport) => Object.assign(r.samples[0] ?? {}, { sourceChecksum: 'abc' }),
    ],
    ['an extra field', (r: FidelityReport) => Object.assign(r, { extra: true })],
    [
      'a missing section',
      (r: FidelityReport) => {
        delete (r as Partial<FidelityReport>).warnings;
        return r;
      },
    ],
    [
      'more than five examples',
      (r: FidelityReport) =>
        Object.assign(r.warnings[0] ?? {}, { examples: ['a', 'b', 'c', 'd', 'e', 'f'] }),
    ],
    [
      'a warning counted zero times',
      (r: FidelityReport) => Object.assign(r.warnings[0] ?? {}, { count: 0 }),
    ],
  ])('[IMP-010] refuses %s', (_name, spoil) => {
    const report = example();
    spoil(report);
    expect(fidelityReport.safeParse(report).success).toBe(false);
  });

  it('[IMP-010] renders as HTML with every value escaped and nothing loaded', () => {
    const report = example();
    report.run.name = '<script>alert(1)</script>';
    (report.warnings[0] as { detail: string }).detail = '<img src=x onerror=alert(1)>';
    const html = reportHtml(report);
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('88.89%');
  });
});

describe('the synthetic source format (M1-086)', () => {
  it('[IMP-009] parses a file and refuses bad lines by number', () => {
    const header = '{"format":"taskmoor-synthetic","version":1,"system":"s"}';
    expect(parseSynthetic(`${header}\n{"kind":"user","id":"u1","name":"A"}\n`)).toEqual({
      system: 's',
      records: [{ kind: 'user', id: 'u1', data: { name: 'A' } }],
    });
    const line = (text: string) => {
      try {
        parseSynthetic(text);
      } catch (error) {
        return error instanceof SyntheticFormatError ? error.line : -1;
      }
      return 0;
    };
    expect(line('{"kind":"user","id":"u1"}\n')).toBe(1);
    expect(line(`${header}\nnot json\n`)).toBe(2);
    expect(line(`${header}\n{"kind":"user"}\n`)).toBe(2);
    expect(line(`${header}\n{"kind":"user","id":"u"}\n\n{"kind":"user","id":"u"}\n`)).toBe(4);
    expect(line('')).toBe(1);
  });

  it('[IMP-009] reads a kind a page at a time from any cursor, in file order', async () => {
    const source = new SyntheticSource(syntheticFixture({ seed: 1, tickets: 10 }));
    const all = await source.read('ticket', null, 1000);
    expect(all.map((r) => r.id)).toEqual(Array.from({ length: 10 }, (_, i) => `i${i + 1}`));
    const pages: string[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await source.read('ticket', after, 3);
      if (page.length === 0) break;
      pages.push(...page.map((r) => r.id));
      after = page[page.length - 1]?.cursor ?? null;
    }
    expect(pages).toEqual(all.map((r) => r.id));
  });

  it('[IMP-004] runs the framework kinds in dependency order and the others after', () => {
    expect(kindOrder(['dashboard', 'ticket', 'board', 'user', 'track', 'history'])).toEqual([
      'user',
      'track',
      'ticket',
      'history',
      'board',
      'dashboard',
    ]);
  });

  it('[IMP-010] maps records and reports what it leaves out', () => {
    expect(
      mapSynthetic({
        kind: 'user',
        id: 'u1',
        data: { email: null, name: 'Hidden', deleted: true, avatar: 'x', karma: 3 },
      }),
    ).toEqual({
      command: { kind: 'user', email: null, name: 'Hidden', active: false, timeZone: null },
      warnings: [
        { code: 'unsupported_field', detail: 'avatar' },
        { code: 'unsupported_field', detail: 'karma' },
      ],
    });
    expect(mapSynthetic({ kind: 'ticket', id: 'i1', data: { summary: 'No track' } })).toMatchObject(
      { fail: 'invalid:track' },
    );
    const history = mapSynthetic({
      kind: 'history',
      id: 'h1',
      data: {
        ticket: 'i1',
        at: '2024-01-01T00:00:00Z',
        items: [
          { field: 'status', from: 's1', to: 's2' },
          { field: 'sprint', from: null, to: 'Sprint 1' },
        ],
      },
    });
    expect(history).toMatchObject({
      command: {
        items: [
          {
            field: 'status',
            from: { ref: { kind: 'status', id: 's1' } },
            to: { ref: { kind: 'status', id: 's2' } },
          },
        ],
      },
      warnings: [{ code: 'unsupported_history_field', detail: 'sprint' }],
    });
    expect(
      mapSynthetic({
        kind: 'history',
        id: 'h2',
        data: {
          ticket: 'i1',
          at: '2024-01-01T00:00:00Z',
          items: [{ field: 'sprint', from: null, to: 'x' }],
        },
      }),
    ).toMatchObject({ fail: 'no_supported_history_items' });
  });

  it('[IMP-009] generates the same fixture from the same seed', () => {
    const a = syntheticFixture({ seed: 9, prefix: 'XY', tickets: 12 });
    expect(syntheticFixture({ seed: 9, prefix: 'XY', tickets: 12 })).toBe(a);
    expect(syntheticFixture({ seed: 10, prefix: 'XY', tickets: 12 })).not.toBe(a);
    expect(a).toContain('"key":"XYSYN"');
    for (const line of a.trim().split('\n').slice(1)) {
      const record = JSON.parse(line);
      if (record.kind === 'board' || record.kind === 'dashboard') continue;
      expect(
        mapSynthetic({ kind: record.kind, id: record.id, data: record }),
        line,
      ).not.toHaveProperty('fail');
    }
  });
});
