# ADR-119: Google sign-in is a preset of OpenID Connect, on each operator's own client

- Status: Accepted
- Date: 2026-11-03
- Backlog: Google sign-in (workstream `claude/google-signin`); requirements IAM-031, IAM-032

## Context

People have personal Gmail addresses, and ADR-118 lets anyone with an address be invited. Single
sign-on through OpenID Connect already exists (ADR-019), so signing in with Google needs no new
protocol. Three things make it different from a company's identity provider: the domain is public,
so a domain says nothing about who someone is; a personal Google account may have no second factor;
and nobody runs a hosted service for a self-hosted project.

The user decided on 2026-11-03:

1. Google sign-in with personal Gmail is in 1.0, with precautions.
2. Nothing may depend on a service the project runs, so each operator uses their own Google client.
3. A person who signs in through a provider does not need Taskmoor's second factor, even when they
   count as external: "Google is enough".

## Decision

### A preset, not a provider type

The Single sign-on page gains a **Google** choice next to OpenID Connect and SAML 2.0. It stores an
ordinary OpenID Connect provider and fills these values, which all stay visible and editable:

| Setting | Value | Why |
|---|---|---|
| Issuer | `https://accounts.google.com` | Discovery reads the rest |
| Email domains | `gmail.com` | The administrator adds or changes domains |
| Create accounts at a first sign-in | Off | Only invited people and existing accounts get in |
| Enforce single sign-on | Off | Passwords keep working |
| Scopes | `openid email profile` | All Taskmoor needs |

The administrator brings a client ID and a secret of their own Google client, and the form shows the
redirect URI and links to the guide. The database has no new column and no migration: nothing records
that a provider came from the preset.

The form warns, on **any** provider and on edits too, when a public email domain is combined with
account creation (anyone with such an address could join) or with enforcement (it blocks passwords
for all those addresses). These are warnings, not refusals: the user asked for a warning, and an
operator who runs a public site may mean it.

### Two rules that name Google in the shared code, and why

Everything else in the flow is unchanged. Exactly two lines of `sso/oidc.ts` depend on the issuer:

1. **Whom Google speaks for** (`addressVouched`). Anyone can open a Google account with an address at
   someone else's domain. Google reports it as `email_verified: true`, and keeps doing so after the
   person loses that mailbox, for instance on leaving a company. Google's own guidance is that it is
   authoritative only for `@gmail.com` and for accounts with an `hd` claim. Without this rule a
   company domain on the provider would let a former employee take over `person@example.com` at a
   first sign-in. So, for Google's issuer alone, an address that is neither is treated as not
   verified (`email_unverified`). `hd` being set is what Google documents, so it is not compared with
   the address's domain: an organization's secondary domains would fail, and the provider's domain
   list already limits which addresses count. Linked identities are found by subject and are not
   asked again.
2. **Which account** (`prompt=select_account`). Without it Google goes on with the account the browser
   last used, and someone refused because of the wrong account is refused again at every try with no
   way to choose another. `prompt` is standard OpenID Connect; only the choice to send it is Google's.

### What was checked and needed no change

Against Google's discovery document as published, through the real `openid-client` and the fake
provider in Google's shape (`FakeIdp` with `shape: 'google'`, `routedOutbound`):

- Discovery with a bare-origin issuer; endpoints on four different hosts; `plain` and `S256` PKCE
  (`S256` is what is sent); `client_secret_post`, the client's default, is accepted.
- `email_verified` is read as a boolean or a string, and required at a first sign-in.
- No group claim and no group data at user info: with no group claim set, user info is never called.
  A group claim set by mistake does no harm; its mapped groups simply stay empty.
- The way back carries `scope`, `authuser`, `prompt` and `hd` and no `iss`; the ID token carries `azp`
  and `at_hash`.
- The outbound guard lets Google's public hosts through and still judges every address they resolve
  to.

The fake says what Google's documents say, which is not proof of what Google answers. Google also
documents `accounts.google.com` without a scheme as a possible `iss`; `openid-client` compares it
with the discovery document exactly, so such a token would fail as `provider_error`. The real test
(`docs/plan/google-signin-tasks.md`) settles this.

### No second factor, in plain words

The rule of ADR-019 and ADR-118 stands, by the user's decision: a sign-in through a provider gets no
Taskmoor second factor. That includes people who count as external (IAM-004, M1-085) and people who
enrolled a second factor for their password. **A personal Google account may have no second factor
of its own**, so whoever holds that account's password holds the Taskmoor account. A site
administrator's Gmail address on the provider's domain is linked the same way at the first sign-in.
The guide tells operators to keep this in mind, and suggests a site administrator uses an address
outside the provider's domains.

### The sign-in page

The email-first flow is unchanged. The wording stops assuming a company: "Your organisation signs in
with {name}" became "This address signs in with {name}" and "Or sign in through your organisation"
became "Other ways to sign in". An invitation's page asks at once whether a provider serves the
address, decided by its domain alone so that it says nothing about accounts; if so it opens at signing
in, with the provider emphasised and choosing a password one click away.

**The button is Google's own** (the user's decision of 2026-11-13, T-061, which differs from Claude's
recommendation of a plain button). A provider whose issuer is Google's (the same test the server
already uses for `prompt=select_account` and for believing Google only about Gmail and hosted domains)
is marked `brand: "google"` in the public provider list and in discovery, and the sign-in page draws
Google's button for it, as Google's sign-in branding guidelines describe: the four-colour "G" at the
left, "Sign in with Google" in the person's language whatever name the operator gave the provider,
Google's light or dark look with the skin, 40 px high and the pill shape, and a finger's height on
touch. Its colours are tokens of each skin (`--color-google-*`) and stay Google's. The "G" is an inline
SVG written from Google's published four-colour geometry, not a file downloaded from Google; it is to
be compared with Google's official asset before a release. The label asks for Roboto Medium, which
the page does not load: where Roboto is not installed the skin's own sans-serif stands in. Earlier
the button was text only and no logo shipped.

### Break-glass

Nothing changes, and nothing needed to: password sign-in never contacts a provider.

- With the safe settings a site administrator with a password signs in as usual, whatever Google does.
- With enforcement on for a domain, only break-glass accounts in that domain may use a password. Other
  domains are not touched.
- A password link (`node cli.mjs password-link <email>`) is not stopped by enforcement, so a site with
  no one left can still get in from the server.
- Nothing refuses to turn enforcement on while no break-glass account exists; the form's warning says
  what that means.
- An account a provider created has no password. A site administrator made from one needs a password
  link before Google goes down, not after.

## Options considered

| Option | For | Against |
|---|---|---|
| A preset over the existing provider (chosen) | No migration, no new protocol, settings stay visible, the audit log and API are unchanged | Two lines of the shared flow know Google's issuer |
| A `kind: 'google'` provider | The code would say what it is | A column and a migration for two rules; a second way to do the same thing |
| A shared Taskmoor Google client | Operators would need no Google account | A service the project runs, which the user ruled out; one client's reputation for everyone |
| A generic "require this claim" setting instead of the `hd` rule | No provider named in the code | Every Google operator must know to set it; the safe answer should not need configuring |
| Refuse public domains with account creation | Harder to get wrong | The user asked for a warning; a public site may want it |
| Treat Gmail's dots and `+` tags as the same address | Fewer refused invitations | Google-only rules on who an address is; a wrong rule merges two people. Refusal is safe, and the guide says to invite the address the Google account shows |

## Consequences

- An operator needs a Google Cloud account and a redirect URI Google accepts: HTTPS on a public name,
  or `localhost` for a trial. Raw addresses and private names do not work, by Google's rules.
- An invitation must name the address exactly as the Google account shows it. `first.last@gmail.com`
  and `firstlast@gmail.com` are one mailbox at Google and two addresses here, so the wrong spelling is
  refused as `no_account`. Same for `+` tags.
- Other Google-hosted addresses that are neither `@gmail.com` nor on a hosted domain are refused,
  including `@googlemail.com`, which Google's guidance does not name. A consumer Google account made
  with a company address cannot use this provider.
- Accounts stay linked by subject after the first sign-in, so removing a domain from the provider stops
  new people, not those already linked. To stop one, deactivate them. That is the existing rule.
- Taskmoor does not learn when a person leaves Google or is removed from a Workspace: a live session
  runs out as usual, and sign-in then fails.
- A person who has a live invitation and goes to the sign-in page rather than following the link gets
  an account and no role yet: the role still comes through the link, as ADR-118 says.
- Google's sign-in branding guidelines ask for its "G" on the button, and say an app must follow them
  to complete verification. The button now follows them (T-061), but its "G" is drawn here rather than
  taken from Google's download, and without Roboto loaded, so an operator seeking verification may be
  asked about either.
- Google's pages disagree on a user cap: one ties 100 new users before verification to sensitive or
  restricted scopes, which Taskmoor does not ask for; another speaks of a 100-user cap for unverified
  apps in general. Neither says what holds for sign-in alone, and no test can show it. The guide says
  so.

Revisit if the real test shows an `iss` without a scheme, or if sites want Gmail spellings matched.
