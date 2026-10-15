import { describe, expect, it } from 'vitest';
import type { IdentityProvider } from './client';
import { changesOf, DEFAULT_SCOPES, draftOf, emptyDraft, inputOf, mappingRow } from './draft';

const SAVED: IdentityProvider = {
  id: 4,
  name: 'Staff accounts',
  issuer: 'https://id.example/realms/staff',
  clientId: 'taskmoor',
  hasClientSecret: true,
  scopes: 'openid email profile',
  groupClaim: 'groups',
  domains: ['corp.example', 'corp.example.org'],
  enforceSso: false,
  jit: true,
  enabled: true,
  groupMap: [
    { claimValue: 'finance', groupId: 3 },
    { claimValue: 'platform', groupId: 7 },
  ],
};

describe('identity provider drafts (M1-080)', () => {
  it("[IAM-003] a new provider starts with the backend's defaults", () => {
    expect(emptyDraft()).toMatchObject({
      scopes: DEFAULT_SCOPES,
      domains: [],
      enforceSso: false,
      jit: true,
      enabled: true,
      groupMap: [],
    });
  });

  it('[IAM-003] sends a new provider trimmed, without a blank secret and with complete mappings only', () => {
    const draft = {
      ...emptyDraft(),
      name: '  Staff accounts ',
      issuer: ' https://id.example ',
      clientId: ' taskmoor ',
      scopes: '  openid   email ',
      groupClaim: '  ',
      groupMap: [
        mappingRow(' platform ', 7),
        mappingRow('finance', 3),
        mappingRow('', 3),
        mappingRow('half-filled', null),
        mappingRow('platform', 7),
      ],
    };
    expect(inputOf(draft)).toEqual({
      name: 'Staff accounts',
      issuer: 'https://id.example',
      clientId: 'taskmoor',
      scopes: 'openid email',
      groupClaim: null,
      domains: [],
      enforceSso: false,
      jit: true,
      enabled: true,
      // Sorted and without the duplicate, so an unchanged map compares equal.
      groupMap: [
        { claimValue: 'finance', groupId: 3 },
        { claimValue: 'platform', groupId: 7 },
      ],
    });
    expect(inputOf({ ...draft, clientSecret: 's3cret' }).clientSecret).toBe('s3cret');
    // Blank scopes fall back to the defaults rather than failing at the backend.
    expect(inputOf({ ...draft, scopes: '   ' }).scopes).toBe(DEFAULT_SCOPES);
  });

  it('[IAM-003] an unchanged edit sends nothing; the saved secret is never part of the draft', () => {
    const draft = draftOf(SAVED);
    expect(draft.clientSecret).toBe('');
    expect(changesOf(SAVED, draft)).toEqual({});
    // A reordered but equal map is no change either.
    expect(changesOf(SAVED, { ...draft, groupMap: [...draft.groupMap].reverse() })).toEqual({});
  });

  it('[IAM-003] an edit names only what changed, so the audit log records real changes', () => {
    const draft = draftOf(SAVED);
    expect(
      changesOf(SAVED, {
        ...draft,
        name: 'Staff',
        clientSecret: 'rotated',
        groupClaim: '',
        domains: ['corp.example'],
        enforceSso: true,
        groupMap: [mappingRow('finance', 3)],
      }),
    ).toEqual({
      name: 'Staff',
      clientSecret: 'rotated',
      groupClaim: null,
      domains: ['corp.example'],
      enforceSso: true,
      groupMap: [{ claimValue: 'finance', groupId: 3 }],
    });
  });

  it('[IAM-003] leaves the group map alone when the groups could not be read', () => {
    const draft = { ...draftOf(SAVED), groupMap: [] };
    expect(changesOf(SAVED, draft, false)).toEqual({});
    expect(changesOf(SAVED, draft, true)).toEqual({ groupMap: [] });
  });
});
