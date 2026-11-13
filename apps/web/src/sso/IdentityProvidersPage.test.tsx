import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { type Handler, noContent, stubBackend, untranslated, visibleTexts } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import type { IdentityProvider, OidcProvider, SamlProvider } from './client';

const REDIRECT_URI = 'https://tasks.example/api/v1/auth/oidc/callback';
const GROUPS = [
  { id: 3, name: 'Finance', description: '', memberCount: 4, childCount: 0 },
  { id: 7, name: 'Platform team', description: '', memberCount: 9, childCount: 1 },
];
const STAFF: IdentityProvider = {
  id: 1,
  name: 'Staff accounts',
  issuer: 'https://id.example/realms/staff',
  clientId: 'taskmoor',
  hasClientSecret: true,
  scopes: 'openid email profile',
  groupClaim: 'groups',
  domains: ['corp.example', 'corp.example.org'],
  enforceSso: true,
  jit: true,
  enabled: true,
  groupMap: [
    { claimValue: 'finance', groupId: 3 },
    { claimValue: 'platform', groupId: 7 },
  ],
};
const PARTNERS: IdentityProvider = {
  id: 2,
  name: 'Partners',
  issuer: 'https://partners.example',
  clientId: 'tm-partners',
  hasClientSecret: false,
  scopes: 'openid email',
  groupClaim: null,
  domains: [],
  enforceSso: false,
  jit: false,
  enabled: false,
  groupMap: [],
};

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBplaceholder\n-----END CERTIFICATE-----';
const CONTRACTORS: SamlProvider = {
  id: 4,
  name: 'Contractors',
  protocol: 'saml',
  entityId: 'https://id.contractors.example/saml',
  ssoUrl: 'https://id.contractors.example/saml/sso',
  certificates: [
    {
      fingerprint: 'AB:CD:EF',
      subject: 'CN=id.contractors.example',
      notAfter: '2028-03-31T00:00:00.000Z',
      pem: PEM,
    },
  ],
  spEntityId: null,
  emailAttribute: null,
  idpInitiated: true,
  serviceProvider: {
    spEntityId: 'https://tasks.example/api/v1/auth/saml/4/metadata',
    acsUrl: 'https://tasks.example/api/v1/auth/saml/4/acs',
    metadataUrl: 'https://tasks.example/api/v1/auth/saml/4/metadata',
  },
  groupClaim: 'memberOf',
  domains: ['contractors.example'],
  enforceSso: false,
  jit: true,
  enabled: true,
  groupMap: [{ claimValue: 'finance', groupId: 3 }],
};
const METADATA = '<md:EntityDescriptor entityID="https://id.pasted.example"/>';

function openPage(handlers: Record<string, Handler> = {}, session = ADMIN) {
  const calls = stubBackend({
    'GET /identity-providers': () =>
      jsonResponse(200, { providers: [PARTNERS, STAFF], redirectUri: REDIRECT_URI }),
    'GET /groups': () => jsonResponse(200, { groups: GROUPS }),
    ...handlers,
  });
  window.location.hash = '#/admin/identity-providers';
  render(<App session={session} />);
  return calls;
}

const providerItem = async (name: string) => {
  const list = await screen.findByRole('list', { name: 'Identity providers' });
  const item = within(list)
    .getAllByRole('listitem')
    .find((li) => within(li).queryByText(name, { exact: true }));
  if (!item) throw new Error(`no provider named ${name}`);
  return item;
};

describe('identity provider administration (M1-080)', () => {
  it('[IAM-003] lists the providers with their domains and policy, and the redirect URI', async () => {
    openPage();
    expect(await screen.findByRole('heading', { level: 1, name: 'Single sign-on' })).toBeVisible();
    // From the backend's public URL, not the browser's address.
    expect(await screen.findByRole('textbox', { name: 'Redirect URI to register' })).toHaveValue(
      REDIRECT_URI,
    );
    const staff = await providerItem('Staff accounts');
    for (const text of [
      'Single sign-on enforced',
      'Issuer https://id.example/realms/staff',
      'Client ID taskmoor',
      'Client secret saved',
      'Domains: corp.example and corp.example.org',
      'Creates accounts at a first sign-in',
      'Group claim groups, 2 mappings',
    ]) {
      expect(within(staff).getByText(text)).toBeVisible();
    }
    const partners = await providerItem('Partners');
    for (const text of [
      'Disabled',
      'No client secret',
      'No email domains',
      'Only existing accounts sign in',
      'No group mapping',
    ]) {
      expect(within(partners).getByText(text)).toBeVisible();
    }
    expect(
      within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', {
        name: 'Administration',
      }),
    ).toHaveAttribute('aria-current', 'page');
  });

  it('[IAM-003] copies the redirect URI, or selects it when copying is not possible', async () => {
    const user = userEvent.setup();
    openPage();
    const field = await screen.findByRole('textbox', { name: 'Redirect URI to register' });
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await navigator.clipboard.readText()).toBe(REDIRECT_URI);
    expect(screen.getByText('Redirect URI copied.')).toHaveAttribute('role', 'status');

    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Copying did not work. Select the address and copy it yourself.',
    );
    expect(field).toHaveFocus();
    expect((field as HTMLInputElement).selectionEnd).toBe(REDIRECT_URI.length);
  });

  it('[IAM-003] shows the whole redirect URI on a phone, wrapping instead of cut at the edge (AD-9)', async () => {
    setViewportWidth(375);
    openPage();
    const field = await screen.findByRole('textbox', { name: 'Redirect URI to register' });
    expect(field.tagName).toBe('TEXTAREA');
    expect(field).toHaveAttribute('rows', '2');
    expect(field).toHaveClass('redirect-uri-value');
  });

  it('[IAM-003] grows the redirect URI field to its whole address, without field-sizing (AD-9)', async () => {
    // The height the address needs, as a browser without `field-sizing: content` measures it.
    const scrollHeight = vi
      .spyOn(HTMLTextAreaElement.prototype, 'scrollHeight', 'get')
      .mockReturnValue(96);
    try {
      setViewportWidth(375);
      openPage();
      const field = await screen.findByRole('textbox', { name: 'Redirect URI to register' });
      expect((field as HTMLTextAreaElement).style.height).toBe('96px');
    } finally {
      scrollHeight.mockRestore();
    }
  });

  it('[IAM-003] adds a provider with its domains, policy and group mapping', async () => {
    const user = userEvent.setup();
    let providers = [STAFF];
    const calls = openPage({
      'GET /identity-providers': () => jsonResponse(200, { providers, redirectUri: REDIRECT_URI }),
      'POST /identity-providers': (body) => {
        const created = { ...(body as OidcProvider), id: 9, hasClientSecret: true };
        providers = [...providers, created];
        return jsonResponse(201, { provider: created });
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Add an identity provider' }));
    const form = screen.getByRole('form', { name: 'New identity provider' });
    expect(within(form).getByLabelText('Name')).toHaveFocus();
    await user.keyboard('Contractors');
    await user.type(within(form).getByLabelText('Issuer URL'), 'https://login.contractors.example');
    await user.type(within(form).getByLabelText('Client ID'), 'taskmoor-web');
    await user.type(within(form).getByLabelText('Client secret'), 'a secret from the provider');
    // Enter or a comma adds a domain; typed domains are stored as the backend stores them.
    await user.type(
      within(form).getByLabelText('Domain'),
      'contractors.example, @Agency.Example.ORG{Enter}',
    );
    const domains = within(form).getByRole('list', { name: 'Domains this provider serves' });
    expect(
      within(domains)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['contractors.example', 'agency.example.org']);
    const policy = within(form).getByRole('group', { name: 'Sign-in policy' });
    await user.click(
      within(policy).getByRole('checkbox', { name: 'Enforce single sign-on for these domains' }),
    );
    await user.click(
      within(policy).getByRole('checkbox', { name: 'Create accounts at a first sign-in' }),
    );
    await user.type(within(form).getByLabelText('Group claim'), 'groups');
    await user.click(within(form).getByRole('button', { name: 'Add mapping' }));
    const mapping = within(form).getByRole('group', { name: 'Mapping 1' });
    expect(within(mapping).getByLabelText('Claim value')).toHaveFocus();
    await user.keyboard('finance');
    await user.selectOptions(within(mapping).getByLabelText('Group'), 'Finance');
    await user.click(within(form).getByRole('button', { name: 'Add provider' }));

    expect(await screen.findByText('Added Contractors.')).toHaveAttribute('role', 'status');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'Contractors',
      issuer: 'https://login.contractors.example',
      clientId: 'taskmoor-web',
      clientSecret: 'a secret from the provider',
      scopes: 'openid email profile',
      groupClaim: 'groups',
      domains: ['contractors.example', 'agency.example.org'],
      enforceSso: true,
      jit: false,
      enabled: true,
      groupMap: [{ claimValue: 'finance', groupId: 3 }],
    });
    expect(screen.queryByRole('form', { name: 'New identity provider' })).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Identity providers' })).toHaveFocus();
    expect(await providerItem('Contractors')).toBeVisible();
  });

  it('[IAM-003] an edit sends only what changed and keeps the saved secret when left blank', async () => {
    const user = userEvent.setup();
    const calls = openPage({
      'PATCH /identity-providers/1': (body) =>
        jsonResponse(200, { provider: { ...STAFF, ...(body as object) } }),
    });
    const staff = await providerItem('Staff accounts');
    await user.click(within(staff).getByRole('button', { name: 'Edit Staff accounts' }));
    const form = within(staff).getByRole('form', { name: 'Edit Staff accounts' });
    expect(within(form).getByLabelText('Client secret')).toHaveValue('');
    expect(
      within(form).getByText('A secret is saved and is never shown again. Leave blank to keep it.'),
    ).toBeVisible();
    // The saved mapping is there to change.
    expect(within(form).getByRole('group', { name: 'Mapping 2' })).toBeVisible();
    await user.click(
      within(form).getByRole('checkbox', { name: 'Enforce single sign-on for these domains' }),
    );
    await user.click(within(form).getByRole('button', { name: 'Remove corp.example.org' }));
    // The removed chip's button is gone; the cursor waits in the domain field.
    expect(within(form).getByLabelText('Domain')).toHaveFocus();
    await user.click(within(form).getByRole('button', { name: 'Remove mapping 2' }));
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Saved Staff accounts.')).toBeVisible();
    expect(calls.find((c) => c.method === 'PATCH')).toEqual({
      method: 'PATCH',
      path: '/identity-providers/1',
      body: {
        domains: ['corp.example'],
        enforceSso: false,
        groupMap: [{ claimValue: 'finance', groupId: 3 }],
      },
    });
  });

  it('[IAM-003] saving an unchanged form says so without asking the backend', async () => {
    const user = userEvent.setup();
    const calls = openPage();
    const partners = await providerItem('Partners');
    await user.click(within(partners).getByRole('button', { name: 'Edit Partners' }));
    expect(
      within(partners).getByText('No secret is saved. Leave blank to keep it that way.'),
    ).toBeVisible();
    await user.click(within(partners).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Nothing changed.')).toBeVisible();
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('[IAM-003] explains a refusal next to the field it is about', async () => {
    const user = userEvent.setup();
    let answer = jsonResponse(409, { error: 'domain_taken', domains: ['corp.example'] });
    openPage({ 'PATCH /identity-providers/2': () => answer });
    const partners = await providerItem('Partners');
    await user.click(within(partners).getByRole('button', { name: 'Edit Partners' }));
    const form = within(partners).getByRole('form', { name: 'Edit Partners' });
    await user.type(within(form).getByLabelText('Domain'), 'corp.example{Enter}');
    await user.click(within(form).getByRole('checkbox', { name: 'Enabled' }));
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'Another enabled provider already serves corp.example. A domain can belong to one enabled provider.',
    );
    expect(within(form).getByLabelText('Domain')).toHaveAttribute('aria-invalid', 'true');

    answer = jsonResponse(400, { error: 'insecure_issuer', detail: 'The issuer must use HTTPS' });
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(await within(form).findByText('The issuer URL must start with https://.')).toBeVisible();
    expect(within(form).getByLabelText('Issuer URL')).toHaveAttribute('aria-invalid', 'true');
    expect(within(form).getByLabelText('Issuer URL')).toHaveAccessibleDescription(
      /must start with https/,
    );

    answer = jsonResponse(409, { error: 'name_taken' });
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(await within(form).findByText('Another provider already has this name.')).toBeVisible();
    expect(within(form).getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
  });

  it('[IAM-003] keeps a typed text that is not a domain in the field, with the reason', async () => {
    const user = userEvent.setup();
    const calls = openPage();
    await user.click(await screen.findByRole('button', { name: 'Add an identity provider' }));
    const form = screen.getByRole('form', { name: 'New identity provider' });
    await user.type(within(form).getByLabelText('Domain'), 'good.example corp_example{Enter}');
    expect(within(form).getByRole('alert')).toHaveTextContent(
      'corp_example is not a domain name. Enter one such as example.com.',
    );
    expect(within(form).getByLabelText('Domain')).toHaveValue('corp_example');
    expect(within(form).getByLabelText('Domain')).toHaveAttribute('aria-invalid', 'true');
    expect(within(form).getByText('good.example')).toBeVisible();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('[IAM-003] deletes a provider only after confirmation', async () => {
    const user = userEvent.setup();
    let providers = [PARTNERS, STAFF];
    const calls = openPage({
      'GET /identity-providers': () => jsonResponse(200, { providers, redirectUri: REDIRECT_URI }),
      'DELETE /identity-providers/2': () => {
        providers = [STAFF];
        return noContent();
      },
    });
    const partners = await providerItem('Partners');
    const remove = within(partners).getByRole('button', { name: 'Delete Partners' });
    await user.click(remove);
    expect(
      within(partners).getByText(/^Delete Partners\? Nobody can sign in with it any more\./),
    ).toBeVisible();
    expect(within(partners).getByRole('button', { name: 'Delete provider' })).toHaveFocus();
    await user.click(within(partners).getByRole('button', { name: 'Cancel' }));
    expect(remove).toHaveFocus();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

    await user.click(remove);
    await user.click(within(partners).getByRole('button', { name: 'Delete provider' }));
    expect(await screen.findByText('Deleted Partners.')).toBeVisible();
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([
      '/identity-providers/2',
    ]);
    const list = screen.getByRole('list', { name: 'Identity providers' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
  });

  it('[IAM-003] says when there are no providers yet', async () => {
    openPage({
      'GET /identity-providers': () =>
        jsonResponse(200, { providers: [], redirectUri: REDIRECT_URI }),
    });
    expect(await screen.findByText('No identity providers yet')).toBeVisible();
    expect(screen.getByText('Everyone signs in with a password until you add one.')).toBeVisible();
  });

  it('[IAM-003] still edits providers when the groups cannot be read, leaving the mapping alone', async () => {
    const user = userEvent.setup();
    const calls = openPage({
      'GET /groups': () => jsonResponse(500, { error: 'boom' }),
      'PATCH /identity-providers/1': (body) =>
        jsonResponse(200, { provider: { ...STAFF, ...(body as object) } }),
    });
    const staff = await providerItem('Staff accounts');
    await user.click(within(staff).getByRole('button', { name: 'Edit Staff accounts' }));
    const form = within(staff).getByRole('form', { name: 'Edit Staff accounts' });
    expect(
      within(form).getByText('The groups could not be read, so the mapping cannot be changed now.'),
    ).toBeVisible();
    await user.click(within(form).getByRole('checkbox', { name: 'Enabled' }));
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Saved Staff accounts.')).toBeVisible();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ enabled: false });
  });

  it('[IAM-003] is listed in Administration for site administrators only', async () => {
    stubBackend({});
    window.location.hash = '#/admin';
    const { unmount } = render(<App session={ADMIN} />);
    expect(await screen.findByRole('link', { name: 'Single sign-on' })).toHaveAttribute(
      'href',
      '#/admin/identity-providers',
    );
    unmount();
    render(<App session={MEMBER} />);
    await screen.findByRole('heading', { level: 1, name: 'Administration' });
    expect(screen.queryByRole('link', { name: 'Single sign-on' })).toBeNull();
  });

  it('[IAM-003] tells other people the page is for administrators, without asking the backend', async () => {
    const calls = openPage({}, MEMBER);
    expect(
      await screen.findByText('Only site administrators can manage single sign-on.'),
    ).toBeVisible();
    expect(calls.some((c) => c.path.startsWith('/identity-providers'))).toBe(false);
  });

  it('[IAM-003] treats a refusal from the backend the same way', async () => {
    openPage({ 'GET /identity-providers': () => jsonResponse(403, { error: 'forbidden' }) });
    expect(
      await screen.findByText('Only site administrators can manage single sign-on.'),
    ).toBeVisible();
  });

  it('[IAM-003] reports providers that could not be read', async () => {
    openPage({ 'GET /identity-providers': () => jsonResponse(500, { error: 'boom' }) });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The identity providers could not be read. Try again in a moment.',
    );
    expect(screen.queryByRole('button', { name: 'Add an identity provider' })).toBeNull();
  });

  it('[IAM-001] an ended session leads to the sign-in prompt', async () => {
    openPage({
      'GET /identity-providers': () => jsonResponse(401, { error: 'not_signed_in' }),
      'GET /session': () => jsonResponse(401, { error: 'not_signed_in' }),
    });
    expect(await screen.findByRole('form', { name: 'Sign in' })).toBeVisible();
  });

  it('[IAM-003] works on a phone-sized screen', async () => {
    setViewportWidth(375);
    const user = userEvent.setup();
    openPage();
    const staff = await providerItem('Staff accounts');
    await user.click(within(staff).getByRole('button', { name: 'Edit Staff accounts' }));
    const form = within(staff).getByRole('form', { name: 'Edit Staff accounts' });
    expect(within(form).getByRole('group', { name: 'Mapping 1' })).toBeVisible();
    expect(within(form).getByRole('button', { name: 'Save changes' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Open navigation' })).toBeVisible();
  });

  it('[IAM-002] lists a SAML provider with its entity ID, certificates and the addresses to register', async () => {
    openPage({
      'GET /identity-providers': () =>
        jsonResponse(200, { providers: [STAFF, CONTRACTORS], redirectUri: REDIRECT_URI }),
    });
    const item = await providerItem('Contractors');
    for (const text of [
      'SAML 2.0',
      'Entity ID https://id.contractors.example/saml',
      '1 signing certificate',
      'Accepts sign-ins started at the provider',
      'Domains: contractors.example',
      'Group attribute memberOf, 1 mapping',
      'Entity ID to register',
      CONTRACTORS.serviceProvider.acsUrl,
    ]) {
      expect(within(item).getByText(text)).toBeVisible();
    }
    expect(
      within(item).getByRole('link', { name: 'Taskmoor metadata for Contractors' }),
    ).toHaveAttribute('href', CONTRACTORS.serviceProvider.metadataUrl);
    // OpenID Connect providers keep their own details.
    expect(within(await providerItem('Staff accounts')).queryByText('SAML 2.0')).toBeNull();
  });

  it('[IAM-002] adds a SAML provider from pasted metadata', async () => {
    const user = userEvent.setup();
    let providers: IdentityProvider[] = [STAFF];
    const calls = openPage({
      'GET /identity-providers': () => jsonResponse(200, { providers, redirectUri: REDIRECT_URI }),
      'POST /identity-providers': () => {
        const created = { ...CONTRACTORS, id: 9, name: 'Agency' };
        providers = [...providers, created];
        return jsonResponse(201, { provider: created });
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Add an identity provider' }));
    const form = screen.getByRole('form', { name: 'New identity provider' });
    await user.keyboard('Agency');
    const protocol = within(form).getByRole('group', { name: 'Type of provider' });
    expect(within(protocol).getByRole('radio', { name: 'OpenID Connect' })).toBeChecked();
    await user.click(within(protocol).getByRole('radio', { name: 'SAML 2.0' }));
    // The OpenID Connect fields give way to the SAML ones; the name stays.
    expect(within(form).queryByLabelText('Issuer URL')).toBeNull();
    expect(within(form).getByLabelText('Name')).toHaveValue('Agency');
    await user.click(within(form).getByLabelText('Identity provider metadata'));
    await user.paste(METADATA);
    await user.type(within(form).getByLabelText('Domain'), 'agency.example{Enter}');
    await user.type(within(form).getByLabelText('Group attribute'), 'memberOf');
    const policy = within(form).getByRole('group', { name: 'Sign-in policy' });
    expect(
      within(policy).getByRole('checkbox', {
        name: 'Accept sign-ins started at the identity provider',
      }),
    ).not.toBeChecked();
    await user.click(within(form).getByRole('button', { name: 'Add provider' }));

    expect(await screen.findByText('Added Agency.')).toHaveAttribute('role', 'status');
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      protocol: 'saml',
      name: 'Agency',
      metadataXml: METADATA,
      spEntityId: null,
      emailAttribute: null,
      idpInitiated: false,
      groupClaim: 'memberOf',
      domains: ['agency.example'],
      enforceSso: false,
      jit: true,
      enabled: true,
      groupMap: [],
    });
    expect(await providerItem('Agency')).toBeVisible();
  });

  it('[IAM-002] asks for metadata or the settings before sending a new SAML provider', async () => {
    const user = userEvent.setup();
    const calls = openPage();
    await user.click(await screen.findByRole('button', { name: 'Add an identity provider' }));
    const form = screen.getByRole('form', { name: 'New identity provider' });
    await user.keyboard('Agency');
    await user.click(within(form).getByRole('radio', { name: 'SAML 2.0' }));
    await user.type(within(form).getByLabelText('Entity ID'), 'urn:agency');
    await user.click(within(form).getByRole('button', { name: 'Add provider' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'Paste the metadata, or fill in the entity ID, the sign-in URL and at least one certificate.',
    );
    expect(within(form).getByLabelText('Identity provider metadata')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    // By hand: the three settings are enough.
    await user.type(within(form).getByLabelText('Sign-in URL'), 'https://agency.example/sso');
    await user.click(within(form).getByLabelText('Signing certificates'));
    await user.paste(PEM);
    await user.click(within(form).getByRole('button', { name: 'Add provider' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      protocol: 'saml',
      entityId: 'urn:agency',
      ssoUrl: 'https://agency.example/sso',
      certificates: [PEM],
    });
  });

  it('[IAM-002] explains metadata and certificates the backend could not read', async () => {
    const user = userEvent.setup();
    let answer = 'invalid_metadata';
    openPage({
      'GET /identity-providers': () =>
        jsonResponse(200, { providers: [CONTRACTORS], redirectUri: REDIRECT_URI }),
      'PATCH /identity-providers/4': () => jsonResponse(400, { error: answer }),
    });
    const item = await providerItem('Contractors');
    await user.click(within(item).getByRole('button', { name: 'Edit Contractors' }));
    const form = within(item).getByRole('form', { name: 'Edit Contractors' });
    await user.click(within(form).getByLabelText('Identity provider metadata'));
    await user.paste('<not-metadata/>');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'The metadata could not be read.',
    );
    answer = 'invalid_certificate';
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(within(form).getByLabelText('Signing certificates')).toHaveAttribute(
        'aria-invalid',
        'true',
      ),
    );
    answer = 'insecure_sso_url';
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(within(form).getByLabelText('Sign-in URL')).toHaveAttribute('aria-invalid', 'true'),
    );
  });

  it('[IAM-002] an edit of a SAML provider sends only what changed', async () => {
    const user = userEvent.setup();
    const calls = openPage({
      'GET /identity-providers': () =>
        jsonResponse(200, { providers: [CONTRACTORS], redirectUri: REDIRECT_URI }),
      'PATCH /identity-providers/4': (body) =>
        jsonResponse(200, { provider: { ...CONTRACTORS, ...(body as object) } }),
    });
    const item = await providerItem('Contractors');
    await user.click(within(item).getByRole('button', { name: 'Edit Contractors' }));
    const form = within(item).getByRole('form', { name: 'Edit Contractors' });
    // The saved settings are there to change; the protocol is not.
    expect(within(form).queryByRole('group', { name: 'Type of provider' })).toBeNull();
    expect(within(form).getByLabelText('Entity ID')).toHaveValue(CONTRACTORS.entityId);
    expect(within(form).getByLabelText('Signing certificates')).toHaveValue(PEM);
    expect(within(form).getByText(/Saved: CN=id\.contractors\.example, valid until/)).toBeVisible();
    await user.click(
      within(form).getByRole('checkbox', {
        name: 'Accept sign-ins started at the identity provider',
      }),
    );
    await user.type(within(form).getByLabelText('Email attribute'), 'mail');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Saved Contractors.')).toBeVisible();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({
      idpInitiated: false,
      emailAttribute: 'mail',
    });
  });

  it('[IAM-002] passes every SAML string through the pseudo-locale', async () => {
    const user = userEvent.setup();
    stubBackend({
      'GET /identity-providers': () =>
        jsonResponse(200, { providers: [CONTRACTORS], redirectUri: REDIRECT_URI }),
      'GET /groups': () => jsonResponse(200, { groups: GROUPS }),
    });
    window.location.hash = '#/admin/identity-providers';
    const errors: Error[] = [];
    render(<App session={ADMIN} locale="en-XA" onI18nError={(e) => errors.push(e)} />);
    const main = screen.getByRole('main');
    await within(main).findAllByText(/Contractors/);
    const add = within(main)
      .getAllByRole('button')
      .find(
        (b) =>
          b.getAttribute('aria-expanded') === 'false' && !b.closest('.page-header, .admin-nav'),
      ) as HTMLElement;
    await user.click(add);
    await user.click(within(main).getAllByRole('radio')[1] as HTMLElement);
    await user.click(
      within(main)
        .getAllByRole('button')
        .filter((b) => b.getAttribute('aria-controls'))[0] as HTMLElement,
    );
    const data = [
      REDIRECT_URI,
      PEM,
      CONTRACTORS.serviceProvider.spEntityId,
      CONTRACTORS.serviceProvider.acsUrl,
      CONTRACTORS.serviceProvider.metadataUrl,
      CONTRACTORS.entityId,
      CONTRACTORS.ssoUrl,
    ];
    const texts = visibleTexts(main).filter((text) => !data.includes(text));
    expect(texts.length).toBeGreaterThan(40);
    expect(untranslated(texts)).toEqual([]);
    expect(errors).toEqual([]);
  });

  describe('the Google choice (IAM-031)', () => {
    async function openGoogleForm(user: ReturnType<typeof userEvent.setup>) {
      await user.click(await screen.findByRole('button', { name: 'Add an identity provider' }));
      const form = screen.getByRole('form', { name: 'New identity provider' });
      await user.click(within(form).getByRole('radio', { name: 'Google' }));
      return form;
    }

    it('[IAM-031] fills visible, editable safe settings and shows what to register at Google', async () => {
      const user = userEvent.setup();
      let sent: unknown;
      const calls = openPage({
        'GET /identity-providers': () =>
          jsonResponse(200, { providers: [], redirectUri: REDIRECT_URI }),
        'POST /identity-providers': (body) => {
          sent = body;
          return jsonResponse(201, { provider: STAFF });
        },
      });
      const form = await openGoogleForm(user);
      expect(within(form).getByLabelText('Name')).toHaveValue('Google');
      expect(within(form).getByLabelText('Issuer URL')).toHaveValue('https://accounts.google.com');
      expect(within(form).getByLabelText('Issuer URL')).toBeEnabled();
      expect(within(form).getByText('gmail.com')).toBeVisible();
      const policy = within(form).getByRole('group', { name: 'Sign-in policy' });
      expect(
        within(policy).getByRole('checkbox', { name: 'Create accounts at a first sign-in' }),
      ).not.toBeChecked();
      expect(
        within(policy).getByRole('checkbox', { name: 'Enforce single sign-on for these domains' }),
      ).not.toBeChecked();
      expect(within(form).getByText(REDIRECT_URI)).toBeVisible();
      expect(
        within(form).getByRole('link', { name: 'How to set up the Google client (manual)' }),
      ).toHaveAttribute('href', expect.stringContaining('sso.md#signing-in-with-google'));
      expect(within(form).queryByRole('alert')).toBeNull();

      // The secret is asked for: a Google client always has one.
      expect(within(form).getByLabelText('Client secret')).toBeRequired();
      await user.type(within(form).getByLabelText('Client ID'), 'an-own-client');
      await user.type(within(form).getByLabelText('Client secret'), 'typed-in-the-test');
      await user.click(within(form).getByRole('button', { name: 'Add provider' }));
      await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
      expect(sent).toEqual({
        name: 'Google',
        issuer: 'https://accounts.google.com',
        clientId: 'an-own-client',
        clientSecret: 'typed-in-the-test',
        scopes: 'openid email profile',
        groupClaim: null,
        domains: ['gmail.com'],
        enforceSso: false,
        jit: false,
        enabled: true,
        groupMap: [],
      });
    });

    it('[IAM-031] warns when account creation or enforcement is turned on for a public domain', async () => {
      const user = userEvent.setup();
      openPage({
        'GET /identity-providers': () =>
          jsonResponse(200, { providers: [], redirectUri: REDIRECT_URI }),
      });
      const form = await openGoogleForm(user);
      const policy = within(form).getByRole('group', { name: 'Sign-in policy' });
      await user.click(
        within(policy).getByRole('checkbox', { name: 'Create accounts at a first sign-in' }),
      );
      expect(within(policy).getByRole('alert')).toHaveTextContent(
        'Anyone with an address at gmail.com could join this site',
      );
      await user.click(
        within(policy).getByRole('checkbox', { name: 'Create accounts at a first sign-in' }),
      );
      expect(within(policy).queryByRole('alert')).toBeNull();
      await user.click(
        within(policy).getByRole('checkbox', { name: 'Enforce single sign-on for these domains' }),
      );
      expect(within(policy).getByRole('alert')).toHaveTextContent(
        'This blocks password sign-in for every address at gmail.com',
      );
    });

    it('[IAM-031] a company domain alone draws no warning; any provider with a public domain does', async () => {
      const user = userEvent.setup();
      openPage({
        'GET /identity-providers': () =>
          jsonResponse(200, {
            providers: [{ ...STAFF, domains: ['gmail.com'], enforceSso: false, jit: false }],
            redirectUri: REDIRECT_URI,
          }),
      });
      const item = await providerItem('Staff accounts');
      await user.click(within(item).getByRole('button', { name: 'Edit Staff accounts' }));
      const form = within(item).getByRole('form', { name: 'Edit Staff accounts' });
      // Not Google, so no Google note.
      expect(within(form).queryByText(REDIRECT_URI)).toBeNull();
      const policy = within(form).getByRole('group', { name: 'Sign-in policy' });
      const create = within(policy).getByRole('checkbox', {
        name: 'Create accounts at a first sign-in',
      });
      await user.click(create);
      expect(within(policy).getByRole('alert')).toBeVisible();
      await user.click(within(form).getByRole('button', { name: 'Remove gmail.com' }));
      await user.type(within(form).getByLabelText('Domain'), 'company.example.com{Enter}');
      expect(within(policy).queryByRole('alert')).toBeNull();
    });

    it('[IAM-031] going back to OpenID Connect takes the filled settings away, at phone width too', async () => {
      const user = userEvent.setup();
      setViewportWidth(360);
      openPage({
        'GET /identity-providers': () =>
          jsonResponse(200, { providers: [], redirectUri: REDIRECT_URI }),
      });
      const form = await openGoogleForm(user);
      await user.click(within(form).getByRole('radio', { name: 'OpenID Connect' }));
      expect(within(form).getByLabelText('Issuer URL')).toHaveValue('');
      expect(within(form).getByLabelText('Name')).toHaveValue('');
      expect(within(form).queryByText('gmail.com')).toBeNull();
      expect(within(form).queryByText(REDIRECT_URI)).toBeNull();
      expect(
        within(form).getByRole('checkbox', { name: 'Create accounts at a first sign-in' }),
      ).toBeChecked();
    });

    it('passes the Google choice through the pseudo-locale', async () => {
      const user = userEvent.setup();
      stubBackend({
        'GET /identity-providers': () =>
          jsonResponse(200, { providers: [], redirectUri: REDIRECT_URI }),
        'GET /groups': () => jsonResponse(200, { groups: GROUPS }),
      });
      window.location.hash = '#/admin/identity-providers';
      const errors: Error[] = [];
      render(<App session={ADMIN} locale="en-XA" onI18nError={(e) => errors.push(e)} />);
      const main = screen.getByRole('main');
      const add = await waitFor(() => {
        const found = within(main)
          .getAllByRole('button', { expanded: false })
          .find((button) => !button.closest('.page-header, .admin-nav'));
        expect(found).toBeDefined();
        return found as HTMLElement;
      });
      await user.click(add);
      const radios = within(main).getAllByRole('radio');
      await user.click(radios[radios.length - 1] as HTMLElement);
      const boxes = within(main).getAllByRole('checkbox');
      for (const box of boxes.slice(0, 2)) await user.click(box);
      const texts = visibleTexts(main).filter(
        (text) => ![REDIRECT_URI, 'openid email profile', 'gmail.com', 'Google'].includes(text),
      );
      expect(texts.length).toBeGreaterThan(30);
      expect(untranslated(texts)).toEqual([]);
      expect(errors).toEqual([]);
    });
  });

  it('passes every string through the pseudo-locale', async () => {
    const user = userEvent.setup();
    stubBackend({
      'GET /identity-providers': () =>
        jsonResponse(200, { providers: [STAFF, PARTNERS], redirectUri: REDIRECT_URI }),
      'GET /groups': () => jsonResponse(200, { groups: GROUPS }),
    });
    window.location.hash = '#/admin/identity-providers';
    const errors: Error[] = [];
    render(<App session={ADMIN} locale="en-XA" onI18nError={(e) => errors.push(e)} />);
    const main = screen.getByRole('main');
    await within(main).findAllByText(/Staff accounts/);
    // Open both the new-provider form and an editor, so every field is on screen.
    const buttons = within(main).getAllByRole('button');
    await user.click(
      buttons.find(
        (b) =>
          b.getAttribute('aria-expanded') === 'false' && !b.closest('.page-header, .admin-nav'),
      ) as HTMLElement,
    );
    await user.click(
      within(main)
        .getAllByRole('button')
        .filter((b) => b.getAttribute('aria-controls'))[0] as HTMLElement,
    );
    const texts = visibleTexts(main).filter(
      // Values the administrator typed or the backend holds are data, not interface text.
      (text) => ![REDIRECT_URI, 'openid email profile'].includes(text),
    );
    expect(texts.length).toBeGreaterThan(40);
    expect(untranslated(texts)).toEqual([]);
    expect(errors).toEqual([]);
  });
});
