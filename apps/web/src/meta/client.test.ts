import { describe, expect, it } from 'vitest';
import { WEB_VERSION } from '../runtime/version';
import { metaQuery } from './client';

describe('the meta request (M1-106, M1-108)', () => {
  it('[OPS-017] a frontend on another origin says which version it runs', () => {
    expect(metaQuery(undefined, 'https://api.example.com')).toBe(
      `?frontend=${encodeURIComponent(WEB_VERSION)}`,
    );
    expect(metaQuery('n0nce-n0nce-n0nce', 'https://api.example.com')).toBe(
      `?nonce=n0nce-n0nce-n0nce&frontend=${encodeURIComponent(WEB_VERSION)}`,
    );
    // The backend's own pages: it serves them and knows their version.
    expect(metaQuery(undefined, '')).toBe('');
    expect(metaQuery('n0nce-n0nce-n0nce', '')).toBe('?nonce=n0nce-n0nce-n0nce');
  });
});
