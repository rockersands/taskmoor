// Test helpers other packages' tests may use; never imported by the server itself.

// A provider on a local port that answers like the Anthropic API from recorded fixtures (M1-076).
export { FakeProviderServer } from '@taskmoor/ai/testing';
export { FakeIdp, type FakePerson } from './testing/fake-idp';
export { FakeLdap, type FakeLdapOptions, type FakeUser } from './testing/fake-ldap';
export {
  FakeSamlIdp,
  type SamlPerson,
  type SamlResponseOptions,
} from './testing/fake-saml-idp';
