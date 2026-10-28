import { describe, expect, it } from 'vitest';
import type { IdentityProvider, OidcProviderInput, SamlProvider } from './client';
import {
  certificatesOf,
  changesOf,
  DEFAULT_SCOPES,
  draftOf,
  emptyDraft,
  inputOf,
  mappingRow,
  samlComplete,
} from './draft';

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
    const oidc = (d: typeof draft) => inputOf(d) as OidcProviderInput;
    expect(oidc({ ...draft, clientSecret: 's3cret' }).clientSecret).toBe('s3cret');
    // Blank scopes fall back to the defaults rather than failing at the backend.
    expect(oidc({ ...draft, scopes: '   ' }).scopes).toBe(DEFAULT_SCOPES);
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

const PEM_A = '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----';
const PEM_B = '-----BEGIN CERTIFICATE-----\nBBBB\n-----END CERTIFICATE-----';
const SAML: SamlProvider = {
  id: 6,
  name: 'Agency',
  protocol: 'saml',
  entityId: 'https://id.agency.example/saml',
  ssoUrl: 'https://id.agency.example/sso',
  certificates: [
    { fingerprint: 'AA', subject: 'CN=a', notAfter: '2030-01-01T00:00:00Z', pem: PEM_A },
  ],
  spEntityId: null,
  emailAttribute: 'mail',
  idpInitiated: false,
  serviceProvider: {
    spEntityId: 'https://tasks.example/api/v1/auth/saml/6/metadata',
    acsUrl: 'https://tasks.example/api/v1/auth/saml/6/acs',
    metadataUrl: 'https://tasks.example/api/v1/auth/saml/6/metadata',
  },
  groupClaim: null,
  domains: ['agency.example'],
  enforceSso: false,
  jit: true,
  enabled: true,
  groupMap: [],
};

describe('SAML provider drafts (M1-081)', () => {
  it('[IAM-002] a new SAML provider sends its protocol and only the settings filled in', () => {
    const draft = {
      ...emptyDraft('saml'),
      name: ' Agency ',
      metadataXml: '  <md:EntityDescriptor/>  ',
      emailAttribute: '  ',
      spEntityId: ' taskmoor-agency ',
    };
    expect(inputOf(draft)).toEqual({
      protocol: 'saml',
      name: 'Agency',
      metadataXml: '<md:EntityDescriptor/>',
      spEntityId: 'taskmoor-agency',
      emailAttribute: null,
      idpInitiated: false,
      groupClaim: null,
      domains: [],
      enforceSso: false,
      jit: true,
      enabled: true,
      groupMap: [],
    });
    expect(samlComplete(draft)).toBe(true);
    expect(samlComplete({ ...draft, metadataXml: '' })).toBe(false);
    expect(
      samlComplete({
        ...draft,
        metadataXml: '',
        entityId: 'urn:x',
        ssoUrl: 'https://x.example/sso',
        certificates: PEM_A,
      }),
    ).toBe(true);
  });

  it('[IAM-002] reads PEM blocks, or one bare certificate, from the certificate box', () => {
    expect(certificatesOf(`${PEM_A}\n\n${PEM_B}\n`)).toEqual([PEM_A, PEM_B]);
    expect(certificatesOf('  MIIB AAAA\nBBBB ')).toEqual(['MIIBAAAABBBB']);
    expect(certificatesOf('   ')).toEqual([]);
  });

  it('[IAM-002] an unchanged SAML edit sends nothing; changes are named one by one', () => {
    const draft = draftOf(SAML);
    expect(draft).toMatchObject({ protocol: 'saml', certificates: PEM_A, emailAttribute: 'mail' });
    expect(changesOf(SAML, draft)).toEqual({});
    expect(
      changesOf(SAML, {
        ...draft,
        certificates: `${PEM_A}\n${PEM_B}`,
        idpInitiated: true,
        emailAttribute: '',
        ssoUrl: 'https://id.agency.example/sso2',
      }),
    ).toEqual({
      certificates: [PEM_A, PEM_B],
      idpInitiated: true,
      emailAttribute: null,
      ssoUrl: 'https://id.agency.example/sso2',
    });
    // New metadata goes as pasted; the fields it fills stay out unless edited.
    expect(changesOf(SAML, { ...draft, metadataXml: '<md:EntityDescriptor/>' })).toEqual({
      metadataXml: '<md:EntityDescriptor/>',
    });
    // A cleared field keeps the saved value rather than sending nothing useful.
    expect(changesOf(SAML, { ...draft, entityId: '', certificates: '' })).toEqual({});
  });
});
