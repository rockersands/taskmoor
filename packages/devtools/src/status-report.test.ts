import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseBacklog, parseProgress } from './backlog';
import { buildStatusReport, loadStatusInputs } from './status-report';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const BACKLOG = `Task ID,Milestone,Epic,Task,Depends on,Done when,Size,Modules
M0-001,M0,Repo,Set up the repository,None,main pushed,S,OPS
M0-002,M0,Repo,Write the governance files,M0-001,sections present,S,OPS
M0-003,M0,Spikes,Field storage spike,M0-002,ADR-008 Accepted,M,CORE
M0-004,M0,Spikes,Name screening,None,shortlist written,S,OPS
M1-001,M1,Core,Spaces,M0-003,tests green,M,CORE
`;
const PROGRESS = `Task ID,State,Date,Note
M0-001,done,2026-10-05,Pushed
M0-002,done,2026-10-11,Checked in verify
M0-003,in-progress,2026-10-12,1M run done
M0-004,waiting-on-user,2026-10-12,Pick a name
`;

const inputs = {
  date: '2026-10-12',
  tasks: parseBacklog(BACKLOG),
  progress: parseProgress(PROGRESS),
  decisions: [
    {
      Decision: 'Public name',
      Options: 'a; b',
      "Claude's recommendation": 'Shortlist written; pick one',
      'Needed by': 'M0',
      'Why it matters': 'Renaming later hurts',
    },
    {
      Decision: 'Licence',
      Options: 'AGPL; MIT',
      "Claude's recommendation": 'Decided by the user on 2026-10-12: AGPL',
      'Needed by': 'M0',
      'Why it matters': 'Public buyers',
    },
  ],
  risks: [
    { Risk: 'Drift', 'Evidence or cause': 'No memory', Mitigation: 'ADRs', Severity: 'High' },
  ],
  results: {
    'query-compiler': {
      items: 200000,
      queries: [
        { id: 'a', p95: 3.2 },
        { id: 'b', p95: 12.5 },
      ],
    },
    authz: { candidates: [{ id: 'inprocess-cold', check: { p95: 1.4 } }] },
  },
  ci: 'Last run green (2 min).',
};

describe('status report', () => {
  it('[NFR-001] summarises the week against the plan, the budgets and the open decisions', async () => {
    await expect(buildStatusReport(inputs)).toMatchFileSnapshot('./__golden__/status-report.md');
  });

  it('counts only the tasks closed in the last seven days', () => {
    const text = buildStatusReport(inputs);
    expect(text).toContain('1 this week');
    expect(text).toContain('- **M0-002**');
    expect(text).not.toContain('- **M0-001**');
    expect(text).not.toContain('Decided by the user');
    expect(text).toContain('**Public name**');
    expect(text).not.toContain('**Licence**');
  });

  it('reads the real plan files and the spike results without throwing', () => {
    const text = buildStatusReport(loadStatusInputs(ROOT, '2026-10-12'));
    expect(text).toMatch(/^# Weekly status: week ending 2026-10-12/);
    expect(text).toContain('## Next week');
  });
});
