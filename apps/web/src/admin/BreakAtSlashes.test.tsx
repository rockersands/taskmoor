import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BreakAtSlashes, slashPieces } from './BreakAtSlashes';

describe('breaks only after a slash (AD-35)', () => {
  it('[OPS-010] cuts a path after each folder, and keeps the folder names whole', () => {
    expect(slashPieces('/srv/taskmoor/.cache/demo/data')).toEqual([
      '/',
      'srv/',
      'taskmoor/',
      '.cache/',
      'demo/',
      'data',
    ]);
  });

  it('[API-012] keeps a run of slashes and a host with its port whole', () => {
    expect(slashPieces('TASKMOOR_URL=http://localhost:8090 node cli.mjs')).toEqual([
      'TASKMOOR_URL=http://',
      'localhost:8090 node cli.mjs',
    ]);
  });

  it('[OPS-010] offers a break after each slash and keeps the text as it was', () => {
    const { container } = render(<BreakAtSlashes text="/data/backups/nightly" />);
    expect(container.textContent).toBe('/data/backups/nightly');
    expect(container.querySelectorAll('wbr')).toHaveLength(3);
  });
});
