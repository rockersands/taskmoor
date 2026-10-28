import { describe, expect, it } from 'vitest';
import {
  changesOf,
  draftOf,
  emptyDraft,
  inputOf,
  testInputOf,
  wholeNumber,
  withKind,
} from './draft';
import { HEAD_OFFICE, LAB, PRESETS } from './fixtures';

describe('directory drafts (M1-082)', () => {
  it("[IAM-005] a new directory starts with its kind's filters, read-only, enabled and hourly", () => {
    const draft = emptyDraft('active_directory', PRESETS.active_directory);
    expect(draft).toMatchObject({
      userFilter: PRESETS.active_directory.userFilter,
      groupFilter: PRESETS.active_directory.groupFilter,
      mode: 'read_only',
      enabled: true,
      syncIntervalMinutes: '60',
      fullSyncHours: '24',
      startTls: false,
    });
  });

  it('[IAM-005] another kind brings its filters unless the administrator changed them', () => {
    const fresh = emptyDraft('active_directory', PRESETS.active_directory);
    expect(withKind(fresh, 'openldap', PRESETS)).toMatchObject({
      kind: 'openldap',
      userFilter: PRESETS.openldap.userFilter,
      groupFilter: PRESETS.openldap.groupFilter,
    });
    const typed = { ...fresh, userFilter: '(objectClass=person)' };
    expect(withKind(typed, 'openldap', PRESETS)).toMatchObject({
      userFilter: '(objectClass=person)',
      groupFilter: PRESETS.openldap.groupFilter,
    });
  });

  it('[IAM-005] sends a new directory with its overrides only, blank DNs as none', () => {
    const draft = {
      ...emptyDraft('openldap', PRESETS.openldap),
      name: ' Lab ',
      url: 'ldap://ldap.lab.example',
      startTls: true,
      bindDn: 'cn=taskmoor,dc=lab,dc=example',
      bindPassword: 'typed in the form',
      baseDn: 'dc=lab,dc=example',
      groupBaseDn: ' ou=groups,dc=lab,dc=example ',
      attributes: {
        ...emptyDraft('openldap', PRESETS.openldap).attributes,
        email: ' mailPrimaryAddress ',
      },
      syncIntervalMinutes: '15',
    };
    expect(inputOf(draft)).toEqual({
      name: 'Lab',
      kind: 'openldap',
      url: 'ldap://ldap.lab.example',
      startTls: true,
      bindDn: 'cn=taskmoor,dc=lab,dc=example',
      bindPassword: 'typed in the form',
      baseDn: 'dc=lab,dc=example',
      userBaseDn: null,
      userFilter: PRESETS.openldap.userFilter,
      groupBaseDn: 'ou=groups,dc=lab,dc=example',
      groupFilter: PRESETS.openldap.groupFilter,
      attributes: { email: 'mailPrimaryAddress' },
      mode: 'read_only',
      enabled: true,
      syncIntervalMinutes: 15,
      fullSyncHours: 24,
    });
  });

  it('[IAM-005] an edit names only what changed, and leaves the password and certificates alone when blank', () => {
    expect(changesOf(HEAD_OFFICE, draftOf(HEAD_OFFICE))).toEqual({});
    const draft = {
      ...draftOf(LAB),
      userBaseDn: '',
      mode: 'read_only' as const,
      bindPassword: 'new one',
    };
    expect(changesOf(LAB, draft)).toEqual({ mode: 'read_only', bindPassword: 'new one' });
    const cleared = { ...draftOf(LAB), attributes: { ...draftOf(LAB).attributes, email: '' } };
    expect(changesOf(LAB, cleared)).toEqual({ attributes: {} });
    const pasted = { ...draftOf(HEAD_OFFICE), caCertificates: '-----BEGIN CERTIFICATE-----x' };
    expect(changesOf(HEAD_OFFICE, pasted)).toEqual({
      caCertificates: ['-----BEGIN CERTIFICATE-----x'],
    });
  });

  it('[IAM-005] tests a saved directory with its own password unless another is typed', () => {
    expect(testInputOf(draftOf(HEAD_OFFICE), HEAD_OFFICE)).toMatchObject({ id: HEAD_OFFICE.id });
    expect(testInputOf(draftOf(HEAD_OFFICE), HEAD_OFFICE)).not.toHaveProperty('bindPassword');
  });

  it('[IAM-005] reads whole numbers within bounds only', () => {
    expect(wholeNumber('60', 5, 1440)).toBe(60);
    expect(wholeNumber(' 5 ', 5, 1440)).toBe(5);
    for (const bad of ['4', '1441', '7.5', '', 'ten', '-10']) {
      expect(wholeNumber(bad, 5, 1440)).toBeNull();
    }
  });
});
