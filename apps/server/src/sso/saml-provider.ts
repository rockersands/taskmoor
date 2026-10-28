import { certificateSummary, NAME_ID_FORMAT, type SamlAssertion } from './saml';
import type { SsoIdentity } from './sign-in';

/**
 * How a SAML provider row meets the SAML protocol (M1-081, IAM-002): the addresses Taskmoor
 * publishes for it, and the person an assertion names.
 */
export interface SamlProviderFields {
  id: number;
  saml_sp_entity_id: string | null;
  saml_email_attribute: string | null;
  group_claim: string | null;
}

export interface SamlEndpoints {
  /** Taskmoor's entity ID towards this provider: the audience its assertions must name. */
  spEntityId: string;
  /** Where the provider posts responses (HTTP-POST binding). */
  acsUrl: string;
  /** Taskmoor's metadata for this provider, which the provider can import. */
  metadataUrl: string;
}

/**
 * Each provider has its own addresses and, unless an administrator fixes one, its own entity
 * ID (the metadata address), so an assertion for one provider is never accepted by another,
 * even when both trust the same signing key.
 */
export function samlEndpoints(base: string, provider: SamlProviderFields): SamlEndpoints {
  const root = `${base}/api/v1/auth/saml/${provider.id}`;
  return {
    spEntityId: provider.saml_sp_entity_id ?? `${root}/metadata`,
    acsUrl: `${root}/acs`,
    metadataUrl: `${root}/metadata`,
  };
}

/** Attributes identity providers commonly use, by name, friendly name or OID. */
const EMAIL_ATTRIBUTES = [
  'email',
  'mail',
  'emailAddress',
  'Email',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress',
  'urn:oid:0.9.2342.19200300.100.1.3',
];
const NAME_ATTRIBUTES = [
  'displayName',
  'http://schemas.microsoft.com/identity/claims/displayname',
  'urn:oid:2.16.840.1.113730.3.1.241',
  'name',
  'cn',
  'urn:oid:2.5.4.3',
];
const GIVEN_NAME_ATTRIBUTES = [
  'givenName',
  'firstName',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname',
  'urn:oid:2.5.4.42',
];
const SURNAME_ATTRIBUTES = [
  'sn',
  'surname',
  'lastName',
  'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname',
  'urn:oid:2.5.4.4',
];

const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/;

function firstOf(attributes: Map<string, string[]>, names: readonly string[]): string | null {
  for (const name of names) {
    const value = attributes.get(name)?.[0];
    if (value) return value;
  }
  return null;
}

/**
 * The person an assertion names. The email comes from the configured attribute, else a usual
 * one, else a NameID that is an address. SAML has no "verified" flag: the provider is trusted
 * for the domains an administrator assigned it, and the sign-in still refuses an address
 * outside them. A transient NameID changes at every sign-in, so the address identifies the
 * person then.
 */
export function samlIdentity(provider: SamlProviderFields, assertion: SamlAssertion): SsoIdentity {
  const { attributes } = assertion;
  const nameIdIsEmail =
    assertion.nameIdFormat === NAME_ID_FORMAT.email ||
    assertion.nameIdFormat === null ||
    assertion.nameIdFormat === NAME_ID_FORMAT.unspecified;
  const candidate = provider.saml_email_attribute
    ? (attributes.get(provider.saml_email_attribute)?.[0] ?? null)
    : (firstOf(attributes, EMAIL_ATTRIBUTES) ?? (nameIdIsEmail ? assertion.nameId : null));
  const email =
    candidate && candidate.length <= 320 && EMAIL.test(candidate) ? candidate.toLowerCase() : null;
  const given = firstOf(attributes, GIVEN_NAME_ATTRIBUTES);
  const surname = firstOf(attributes, SURNAME_ATTRIBUTES);
  const name =
    firstOf(attributes, NAME_ATTRIBUTES) ?? ([given, surname].filter(Boolean).join(' ') || null);
  const transient = assertion.nameIdFormat === NAME_ID_FORMAT.transient;
  return {
    subject: transient ? (email ? `email:${email}` : '') : assertion.nameId,
    email,
    emailVerified: email !== null,
    name: name ? name.slice(0, 200) : null,
    groups: provider.group_claim ? (attributes.get(provider.group_claim) ?? []) : [],
  };
}

/** A certificate as administrators see it; one that cannot be read says so. */
export function certificateView(pem: string) {
  try {
    return { ...certificateSummary(pem), pem };
  } catch {
    return { fingerprint: null, subject: null, notAfter: null, pem };
  }
}
