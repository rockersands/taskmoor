import { describe, expect, it } from 'vitest';
import { everyPage } from './seed.mjs';

describe('everyPage', () => {
  it('[CORE-027] reads every page of teams, so the seed finds its team past the first 100 (T-286)', async () => {
    const asked = [];
    const pages = {
      '/teams?query=Sweep%20team': {
        teams: Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name: `Sweep team ${i}` })),
        next: 'page two',
      },
      '/teams?query=Sweep%20team&after=page%20two': {
        teams: [{ id: 101, name: 'Sweep team' }],
        next: null,
      },
    };
    const get = async (path) => {
      asked.push(path);
      return pages[path];
    };
    const teams = await everyPage(get, '/teams?query=Sweep%20team', 'teams');
    expect(teams).toHaveLength(101);
    expect(teams.some((t) => t.name === 'Sweep team')).toBe(true);
    expect(asked).toEqual([
      '/teams?query=Sweep%20team',
      '/teams?query=Sweep%20team&after=page%20two',
    ]);
  });

  it('[CORE-027] stops when a page names the cursor it was read with (T-286)', async () => {
    let calls = 0;
    const get = async () => {
      calls += 1;
      return { teams: [{ id: calls }], next: 'same' };
    };
    expect(await everyPage(get, '/teams', 'teams')).toEqual([{ id: 1 }, { id: 2 }]);
    expect(calls).toBe(2);
  });
});
