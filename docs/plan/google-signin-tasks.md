# Google sign-in: tasks

Workstream `claude/google-signin`, for 1.0, based on `claude/track-invites`. Decisions in
`docs/adr/0119-google-sign-in.md`; requirements IAM-031 and IAM-032 in
`docs/specs/05a-administration-security-and-self-hosting.md`; guide in
`docs/manual/admin/sso.md#signing-in-with-google`. Numbers used: ADR-119, IAM-031, IAM-032. No
migration (0089 stays free).

| Task | State |
|---|---|
| The Google choice on the Single sign-on page, with the redirect URI and the guide's link | Done |
| Warnings for a public domain with account creation or enforcement, on any provider | Done |
| Check the flow against Google's discovery shape; the fake provider in that shape | Done against the fake |
| Google believed only for Gmail and hosted domains; `prompt=select_account` | Done |
| The sign-in page's wording; an invitation's page leads with the provider that serves the address | Done |
| Break-glass rules checked and tested | Done |
| Operator guide, ADR, spec, strings in English and Spanish, stories with axe, phone layout, tests | Done |
| The real test against Google | **Waits for the user, below** |

## Handoff

### What the user must do for the real test

Nobody else can do this: it needs the user's own Google account, and the secret must be entered by the
user alone. Never paste the secret into a chat, a commit or a log.

1. Have the demo run this branch's code, or the merged code. Its address is `http://localhost:8080`,
   which Google accepts over plain HTTP because it is `localhost`. Any other address needs HTTPS on a
   public name, and `PUBLIC_URL` set to it.
2. In [Google Cloud](https://console.cloud.google.com/auth/clients), on the user's own account:
   1. Create a project, for example "Taskmoor demo".
   2. **Branding**: an app name and a support email.
   3. **Audience**: **External**. Leave it in **Testing** first, because that answers an open question
      (step 8); publish it afterwards.
   4. **Clients** > **Create client** > **Web application**. Authorized redirect URI, exactly:
      `http://localhost:8080/api/v1/auth/oidc/callback`
   5. Copy the client ID and secret. Google shows the secret once.
3. Sign in to the demo as a site administrator. **Settings** > **Single sign-on** >
   **Add an identity provider** > **Google**. Check that the Redirect URI shown matches what was
   registered. Paste the client ID and secret, and select **Add provider**. Google may take a few minutes
   to a few hours to apply a new client.
4. Invite a Gmail address the user can sign in with: a track's **Manage** page > **Invite people**, a
   role, **I copy a link and pass it on**.
5. In a private window, open the link. The page should open at signing in, with **Sign in with Google**
   emphasised. Choose the account, and consent. It should land in the track with the role.
6. In a new private window, go to the sign-in page, and sign in with Google using a Gmail address that
   was **not** invited. It should say there is no account.
7. In a new private window, sign in with a password as the site administrator, with Google set up. It
   should work.
8. Note what the consent screen showed, and whether the Gmail address in step 5 worked while the app was
   in **Testing** without being listed as a test user.
9. Publish the app to **In production** if the demo should keep working for others.

### What will be checked afterwards

With the audit log and the server log of the demo, no secret needed:

- `sso.signed_in` for step 5, with `userCreated: true`, then `track_invitation.accepted` with the role.
- `sso.sign_in_refused` with `no_account` for step 6, and no new account.
- `session` sign-in for step 7.
- No warning `OIDC discovery failed` or `OIDC sign-in failed`. If step 5 fails as `provider_error`, the
  first suspect is the ID token's `iss`: Google documents two forms, and only the one in its discovery
  document passes. Second, the guard: the warning names a refused host.
- The client secret appears in no log, and only sealed in the database.
- The account chooser appeared (`prompt=select_account`).

Then the guide's "What we could not confirm" can be updated, and this section's test marked done.

### Not run or not done here

Per the brief: not the full gate, the import or fuzzing, and tests only one file at a time. Nothing has
talked to Google: everything is against the fake provider, which says what Google's documents say. The
end-to-end suite was not run, and `apps/web/e2e/setup.spec.ts` had one sentence changed to the new
wording without being run.

### Open questions for the user

- **Google's logo on the button.** Google's branding guidelines ask for its "G" and tie this to
  verification. The button is plain text, and no Google asset is in the repository.
- **Gmail spellings.** An invitation to `first.last@gmail.com` is refused when the Google account shows
  `firstlast@gmail.com`. Refusal is safe, and the guide explains it. Matching them would be a rule only
  for Gmail.
- **The guide's link.** The form links to the manual on GitHub, as no address serves the manual yet
  (ADR-074). It works once the repository is public and this is on `main`.
- **A live invitation without the link.** Someone invited who signs in at the sign-in page rather than
  through the link gets an account and no role until they follow the link (ADR-118).

Loose ends named in ADR-119: `@googlemail.com` addresses are refused, since Google's guidance names only
`@gmail.com`; turning enforcement on with no break-glass account is warned about, not refused.
