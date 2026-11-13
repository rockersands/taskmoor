---
title: "Single sign-on"
audience: admins
sources: apps/server/src/outbound/guard.ts, docs/adr/0110-outbound-guard-archive-limits-storage-quotas.md, apps/server/src/routes/sso.ts, apps/server/src/routes/saml.ts, apps/server/src/routes/session.ts, apps/server/src/routes/users.ts, apps/server/src/sso/oidc.ts, apps/server/src/sso/saml.ts, apps/server/src/sso/saml-provider.ts, apps/server/src/sso/sign-in.ts, apps/server/src/audit/record.ts, apps/server/src/config.ts, packages/db/src/migrations/0010_identity_providers.ts, packages/db/src/migrations/0020_saml.ts, apps/web/src/sso/IdentityProvidersPage.tsx, apps/web/src/sso/ProviderForm.tsx, apps/web/src/session/SignInForm.tsx, apps/web/src/i18n/messages.en.ts, docs/adr/0019-identity.md, docs/specs/05a-administration-security-and-self-hosting.md, apps/web/src/sso/draft.ts, apps/web/src/trackpeople/InvitationPage.tsx, docs/adr/0119-google-sign-in.md, apps/web/src/sso/RedirectUriField.tsx
accessed: 2026-11-13
attestation: own-words
---
# Single sign-on

Taskmoor signs people in through the identity provider your organisation already runs, or through
[Google](#signing-in-with-google) for personal Gmail addresses. It speaks [OpenID Connect](https://openid.net/specs/openid-connect-core-1_0.html) and
[SAML 2.0](https://docs.oasis-open.org/security/saml/v2.0/saml-core-2.0-os.pdf). You can add
several providers, of either protocol, and each serves the email domains you give it. Every
part of this is included in Taskmoor; nothing needs a separate licence.

## Before you start

- Set `PUBLIC_URL` to the address people use to reach Taskmoor (see
  [the configuration reference](configuration.md)). The addresses you register at a provider
  are built from it.
- A provider's issuer URL or sign-in URL must use HTTPS. Plain HTTP is accepted only on the
  loopback interface (`localhost`, `127.0.0.1`, `[::1]`), or anywhere when
  `TASKMOOR_OIDC_ALLOW_HTTP=true`, which is meant for tests.
- Taskmoor refuses to reach an OpenID Connect provider at a private, loopback or link-local
  address. A provider on your own network needs its host in `TASKMOOR_OUTBOUND_ALLOW` (see
  [requests to other servers](configuration.md#requests-to-other-servers)); until then signing in
  through it answers that the provider is unavailable, and the server log says why.
- To keep group memberships in step with the provider, create the groups first (see
  [People and groups](people-and-groups.md)).
- Make sure at least one site administrator can still sign in if the provider fails (see
  [the break-glass fallback](#the-break-glass-fallback)).

## The Single sign-on page

Open **Administration** > **Single sign-on** (`#/admin/identity-providers`). Only site
administrators see it. The page lists the **Identity providers** with a summary of each:
protocol, issuer or entity ID, domains, whether it creates accounts, the group mapping, and a
**Disabled** or **Single sign-on enforced** note. **Add an identity provider** opens the form;
each provider has **Edit** and **Delete**. With no provider yet the list says so: everyone signs in
with a password until you add one.

An edit sends only what you changed. Secrets are never shown again: leave the field blank to
keep the saved one.

## Settings every provider has

| Field | Meaning |
|---|---|
| **Type of provider** | **OpenID Connect**, **SAML 2.0** or **Google** (OpenID Connect with its settings filled in), chosen when the provider is added |
| **Name** | Shown on the sign-in button, such as "Staff accounts" |
| **Email domains** | The domains this provider serves; press Enter after each one |
| **Enforce single sign-on for these domains** | People with these addresses cannot sign in with a password |
| **Create accounts at a first sign-in** | On by default; off means only people who already have an account can sign in |
| **Enabled** | On by default; a disabled provider is not offered and serves none of its domains |
| **Group claim** (OpenID Connect) or **Group attribute** (SAML) | Where the provider lists the person's groups; blank leaves memberships alone |
| **Group mapping** | Pairs of **Claim value** and Taskmoor **Group** |

A domain belongs to at most one enabled provider, whatever its protocol. Saving a second one
for the same domain is refused: "A domain can belong to one enabled provider."

For a public email domain, such as `gmail.com`, the form warns next to the option, on any provider:
with **Create accounts at a first sign-in** on, anyone with such an address could join; with
**Enforce single sign-on for these domains** on, password sign-in stops for all those addresses.

## Adding an OpenID Connect provider

1. At the provider, create a client (an application) using the authorization code flow.
   Register the **Redirect URI** shown at the top of the Single sign-on page; on a phone the
   address wraps so all of it shows, and **Copy** copies it. It is the same
   for every OpenID Connect provider:

   ```text
   https://taskmoor.example.com/api/v1/auth/oidc/callback
   ```

2. In Taskmoor, **Add an identity provider** and choose **OpenID Connect**.
3. Fill in **Name**, **Issuer URL** (such as `https://id.example.com/realms/staff`; Taskmoor
   reads the rest of the provider's settings from there), **Client ID** and
   **Client secret** (leave it blank if the client has none).
4. Keep **Scopes** at `openid email profile` unless you need more. `openid` is required.
5. Add the **Email domains**, choose the sign-in policy and the group mapping, and select
   **Add provider**.

Taskmoor stores the client secret encrypted and never returns it. It uses the authorization
code flow with PKCE, state and nonce. A sign-in must finish within ten minutes in the browser
that started it. The provider's discovery document is cached for an hour, or until you edit
the provider.

From the provider Taskmoor reads `sub` (the person's stable identifier), `email`,
`email_verified`, `name` and the group claim. When the ID token lacks the group claim, it asks
the provider's user info endpoint.

## Signing in with Google

People can sign in with a Gmail address, or with a Google Workspace address of a company you name.
You use a Google client of your own: your site talks to Google directly, and no service run by the
Taskmoor project stands between. Taskmoor treats Google as one more OpenID Connect provider; the
**Google** choice only fills in safe settings.

### Create the client at Google

Do this in [Google Cloud](https://console.cloud.google.com/auth/clients), on your own account. Google
calls this area the Google Auth Platform and moves its pages now and then; its
[guide to OAuth clients](https://support.google.com/cloud/answer/15549257) has the current steps.

1. Create or choose a project.
2. Under **Branding**, enter the app name people will see when they consent, and a support email.
3. Under **Audience**, choose **External**, which lets any Google account in. **Internal** is only for
   the members of your own Google organization. Then publish the app so its status is **In production**
   (see [the limits](#what-google-limits)).
4. Under **Clients**, **Create client** with the type **Web application**.
5. Under **Authorized redirect URIs**, add the **Redirect URI** that Taskmoor shows on the Single
   sign-on page and in the Google form. It must match exactly:

   ```text
   https://taskmoor.example.com/api/v1/auth/oidc/callback
   ```

6. Copy the client ID and the secret. Google shows the whole secret only once.

Taskmoor asks only for the scopes `openid`, `email` and `profile`.

Google accepts a redirect URI only over HTTPS on a public domain name, or on `localhost` for a trial.
It refuses raw IP addresses. Changes at Google can take from five minutes to a few hours to apply.

### Add it to Taskmoor

1. **Add an identity provider** and choose **Google**.
2. Paste the **Client ID** and **Client secret**, and select **Add provider**.

The choice fills in these settings, and you can change any of them:

| Setting | Filled in as | What it means |
|---|---|---|
| **Issuer URL** | `https://accounts.google.com` | Taskmoor reads the rest from Google |
| **Email domains** | `gmail.com` | Whose addresses this provider serves. Add or change domains; for a company on Google Workspace, its domain |
| **Create accounts at a first sign-in** | Off | Only invited people and existing accounts get in |
| **Enforce single sign-on for these domains** | Off | Passwords keep working |

Then [invite people](invitations.md) by their Gmail address, and try it from a private window.

### Who gets in

| Who | What happens |
|---|---|
| Someone invited, at an address in the domains | Gets in, and lands in the track with the role |
| Someone with an account at that address | Gets in; that Google account is linked to the account from then on |
| Anyone else, with account creation off | Refused: no account |
| An address Google has not verified | Refused |
| An address outside the domains | Refused, even with an invitation |
| A withdrawn or expired invitation | Counts as no invitation |

**Invite the address the Google account shows.** Google treats `first.last@gmail.com` and
`firstlast@gmail.com` as one mailbox, and ignores anything after a `+`. Taskmoor compares addresses
exactly, so an invitation to another spelling is refused. If that happens, withdraw it and invite the
address Google shows.

**Google is believed only about Gmail and its hosted domains.** Anyone can open a Google account with
an address at someone else's domain, and Google goes on calling it verified after that person loses
the mailbox, for instance on leaving a company. So Taskmoor accepts only `@gmail.com` addresses, and
accounts that Google says belong to a hosted domain (Google Workspace). A personal Google account made
with `person@example.com` is refused as unverified, even with `example.com` on the provider. Other
providers are not affected.

### Taskmoor asks no second factor here

**Signing in through Google is enough.** Taskmoor does not ask for its own second factor, even for
someone who counts as external, and even for someone who set up a second factor for their password.
A personal Google account **may have no second factor of its own**, so whoever gets into that Google
account gets into Taskmoor as that person.

This matters most for site administrators. An administrator whose address is in the provider's domains
can sign in through Google once it is set up. If that is not what you want, give site administrators an
address outside those domains, and ask them to turn on Google's two-step verification.

### If Google is down or set up wrongly

With the settings above, passwords work as before: password sign-in never contacts Google. People who
came in through Google have no password, so they need a
[password link](people-and-groups.md#password-links) until Google is back.

Keep at least one site administrator with a password. If you turn on enforcement for a domain, only
[break-glass accounts](#the-break-glass-fallback) of that domain may still use a password, and turning
it on for `gmail.com` blocks passwords for every Gmail address. Nothing stops you turning it on with no
such account; the form only warns. As a last resort, a password link made on the server works even
where enforcement is on.

A sign-in that fails at Google's side comes back as `provider_error` or `provider_unavailable`, and
the server log has the reason. A wrong redirect URI shows Google's own `redirect_uri_mismatch` page.

### What Google limits

From Google's pages on [audience settings](https://support.google.com/cloud/answer/15549945),
[verification](https://support.google.com/cloud/answer/13463073) and
[when it is not needed](https://support.google.com/cloud/answer/13464323), read when this was written:

- **Testing status** is limited to 100 test users, whose sign-ins expire after seven days. Google says
  requests for only name, email address and profile skip the test-user list, the warning and the
  expiry, which is all Taskmoor asks for. Publishing to **In production** avoids the question.
- **An unused client is deleted** after six months without activity, with an email 30 days before.
- **Google gives no group data** here. Leave **Group claim** blank.

What we could not confirm from Google's pages, so check it on your own account:

- **Whether there is a cap on users.** The audience page ties its limit of 100 new users before
  verification to apps asking for sensitive or restricted scopes, and Taskmoor asks for none. The page
  on when verification is not needed speaks of a 100-user cap and an "unverified app" warning for
  unverified apps in general, without saying whether that covers sign-in alone. A site expecting more
  than 100 people should find this out early.
- **Whether a client in Testing admits any Google account** with these scopes: one page limits Testing
  to test users, and the same page exempts these scopes from the list.
- **Whether verification is needed at all.** One page says apps using only non-sensitive scopes do not
  have to verify, and another says all apps must verify who they are, with listed exceptions that do not
  mention sign-in. What an unverified client's consent screen shows in place of your app's name is not
  stated either.

Taskmoor's button says "Sign in with Google" in plain text. Google's
[branding guidelines](https://developers.google.com/identity/branding-guidelines) ask for its "G" logo
and tie this to verification, so an operator who goes through verification may be asked about it.

Google's [OpenID Connect documentation](https://developers.google.com/identity/openid-connect/openid-connect)
and its page on [what it speaks for](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token)
describe the rest.

### Other limits

- Your server must reach Google's hosts over HTTPS. If it only reaches the internet through a proxy
  that resolves names to private addresses, the [outbound rules](configuration.md#requests-to-other-servers)
  apply.
- Once linked, a person is found by Google's identifier for them. Taking a domain off the provider stops
  new people, not those already linked: deactivate a person to stop them.
- Taskmoor does not hear when someone leaves Google or a Workspace. Their session ends as usual, and the
  next sign-in fails.

## Adding a SAML 2.0 provider

1. **Add an identity provider** and choose **SAML 2.0**.
2. Paste the provider's **Identity provider metadata** XML. Taskmoor reads the entity ID, the
   sign-in URL (HTTP-Redirect binding) and the signing certificates from it. Or fill in
   **Entity ID**, **Sign-in URL** and **Signing certificates** (PEM, up to ten) yourself; what
   you fill in wins over the metadata. Taskmoor does not fetch metadata from a URL.
3. Optionally set **Email attribute**, **Group attribute** and **Taskmoor entity ID** (blank
   uses the metadata address below; fill it in to keep an existing registration).
4. Add the **Email domains**, the policy and the mapping, then **Add provider**.
5. The provider's entry now lists the addresses to register at the identity provider:

| Shown as | Address |
|---|---|
| **Entity ID to register** | `PUBLIC_URL/api/v1/auth/saml/<id>/metadata`, unless you fixed another |
| **Assertion consumer service URL (HTTP-POST)** | `PUBLIC_URL/api/v1/auth/saml/<id>/acs` |
| **Metadata to import** | `PUBLIC_URL/api/v1/auth/saml/<id>/metadata` |

Each provider has its own addresses, so an answer meant for one provider is never accepted by
another, even when both trust the same key.

To change keys at the provider, add the next certificate before the switch; Taskmoor accepts
answers signed by any saved certificate. The list shows each one's subject, expiry and SHA-256
fingerprint.

### What Taskmoor accepts from a SAML provider

- The response or the assertion must be signed with RSA-SHA-256 or RSA-SHA-512, by a key of a
  saved certificate. A certificate inside the response is never trusted.
- Exactly one assertion, not encrypted. Encrypted assertions are refused.
- The issuer, audience, recipient and destination must match the provider and its addresses.
  Time conditions hold with two minutes of clock difference allowed.
- Each assertion is used once.
- Sign-ins started at the provider are refused unless **Accept sign-ins started at the
  identity provider** is on. Leave it off unless an app portal needs it: such answers are not
  tied to the browser that brings them.
- Taskmoor does not sign its requests to the provider yet.

The person's email comes from **Email attribute**, else a usual attribute (`email`, `mail`,
and their URI and OID forms), else a NameID that is an address. The name comes from a display
name attribute, or the given name and surname. Persistent NameIDs work best: a transient
NameID changes at every sign-in, so Taskmoor follows the email address instead.

## Accounts and just-in-time creation

After a person's first sign-in, the provider's identifier for them leads to their account, so a
changed address at the provider changes nothing. At a first sign-in Taskmoor:

1. Requires an email address the provider vouches for (OpenID Connect: `email_verified`; SAML:
   any valid address).
2. Requires the address to be in one of the provider's domains.
3. Links the account with that address, or, when **Create accounts at a first sign-in** is on,
   creates one. Created accounts have no password. With that option off, an address with a live
   [invitation](invitations.md) still gets an account.

Deactivated accounts and service accounts never sign in this way. When a sign-in is refused,
the sign-in page explains why:

| Code in `#/sign-in?sso_error=` | What the person reads, in short |
|---|---|
| `email_unverified` | The provider did not confirm the email address |
| `domain_not_allowed` | The address is in a domain this provider does not serve |
| `no_account` | No account yet, and the provider does not create them |
| `account_deactivated` | The account is deactivated |
| `invalid_state` | The sign-in took too long, or started in another browser |
| `provider_error` | The provider did not complete the sign-in |
| `provider_unavailable` | The provider is disabled or cannot be reached |

## Group mapping

At every sign-in, the person joins each mapped group whose claim value the provider lists, and
leaves each mapped group whose value it no longer lists. Groups without a mapping are left
alone, so groups you manage by hand are safe.

## Enforcing single sign-on

With **Enforce single sign-on for these domains** on, password sign-in for any address in
those domains answers that the person must use the provider. The answer is the same whether or
not the account exists or the password was right, and wrong passwords still count towards the
lockout. The sign-in page asks for the email first, names the domain's provider, and hides the
password field where single sign-on is enforced.

## The break-glass fallback

An account marked break-glass may still sign in with its password in an enforced domain, so a
provider outage cannot lock everyone out.

- Mark an account with `PATCH /api/v1/users/:id` and `{"breakGlass": true}` (the People page
  does not offer it yet). Give it a password with a password link.
- The person signs in at the sign-in page address ending in `#/sign-in?method=password`.
- Accounts a directory manages cannot be break-glass. Directory syncs and SCIM never
  deactivate a break-glass account.
- Taskmoor's two-factor policy still applies to its password sign-in.

If nobody can sign in at all, make a password link on the server with
`node cli.mjs password-link <email>` (see [the operator CLI](cli.md)).

## Two-factor authentication

The provider's own multi-factor checks apply to single sign-on. Taskmoor's second factor
applies to password sign-in only (see [People and groups](people-and-groups.md)). A person who signs
in through a provider is not asked for it, even when they count as external. With
[Google](#taskmoor-asks-no-second-factor-here) that can mean no second factor at all.

## Testing a provider

There is no test button. Keep your administrator session open, and sign in through the new
provider from a private window or another browser. A refusal returns to the sign-in page with
one of the messages above. The audit log records each refusal as `sso.sign_in_refused` with
its reason (SAML adds reasons such as `response_expired`, `response_audience` and
`response_replayed`). For OpenID Connect, the server log also has a warning when discovery or
the code exchange fails. Successful sign-ins are `sso.signed_in`, with any account creation and
group changes.

## Disabling and deleting a provider

Turn off **Enabled** to stop offering a provider while you keep its settings. **Delete**
removes it: nobody can sign in with it any more. Accounts stay; people without a password need
a password link to sign in.

## API reference

| Method and path | Who | What it does |
|---|---|---|
| `GET /api/v1/identity-providers` | Site administrator | Providers, and the redirect URI |
| `POST /api/v1/identity-providers` | Site administrator | Add a provider (`protocol`: `oidc` or `saml`) |
| `PATCH`, `DELETE /api/v1/identity-providers/:id` | Site administrator | Change or delete |
| `GET /api/v1/auth/providers` | Anyone | Enabled providers for the sign-in page |
| `POST /api/v1/auth/discover` | Anyone | Which methods an email's domain uses |
| `GET /api/v1/auth/oidc/:id/start`, `GET /api/v1/auth/saml/:id/start` | Anyone | Start a sign-in |
