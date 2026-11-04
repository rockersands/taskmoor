---
title: "Your account"
audience: users
sources: apps/web/src/account/AccountPage.tsx, apps/server/src/oauth/tokens.ts, apps/web/src/account/ProfileSection.tsx, apps/web/src/account/AppearanceSection.tsx, apps/web/src/account/PasswordSection.tsx, apps/web/src/account/TwoFactorSection.tsx, apps/web/src/account/SessionsSection.tsx, apps/web/src/account/options.ts, apps/web/src/twofactor/TotpSetupForm.tsx, apps/web/src/twofactor/RecoveryCodes.tsx, apps/web/src/session/UserMenu.tsx, apps/web/src/session/SecondFactorStep.tsx, apps/web/src/tokens/TokensSection.tsx, apps/web/src/tokens/TokenForm.tsx, apps/web/src/tokens/format.ts, apps/web/src/skins/skins.ts, apps/web/src/i18n/locale.ts, apps/web/src/i18n/messages.en.ts, apps/web/src/App.tsx, apps/server/src/routes/search.ts, apps/server/src/email/deliver.ts, docs/adr/0024-i18n-and-accessibility.md, docs/adr/0035-api-tokens-and-service-accounts.md, docs/adr/0036-skins-and-soft-visual-language.md, docs/specs/05a-administration-security-and-self-hosting.md, apps/server/src/security/notices.ts, apps/server/src/security/mail.ts, docs/adr/0109-security-notices-and-alerts.md, apps/web/src/account/PersonalDataSection.tsx, apps/server/src/privacy/export.ts, apps/server/src/routes/personal-data.ts, docs/adr/0111-personal-data-and-database-tls.md, apps/web/src/shell/ThemeToggle.tsx, apps/web/src/tutorial/TutorialsPage.tsx, apps/web/src/tutorial/sections.ts, docs/adr/0114-glass-interface-and-clear-sections.md, docs/adr/0115-guided-tutorial.md, apps/web/src/styles/motion.css, apps/server/src/trackgroups/privacy.ts, docs/adr/0121-personal-track-groups.md
accessed: 2026-11-03
attestation: own-words
---
# Your account

Your account page holds your own settings: your profile, how Taskmoor looks, your
notifications, your password, two-factor authentication, the devices where you are signed in
and your API tokens.

## Opening your account

Open the menu with your name at the right of the top bar. It says **Signed in as** your email
and offers **Account** and **Sign out**. You also reach the page from **Settings**
and from the command palette (**Account**).

## Profile

| Field | What it does |
|---|---|
| **Name** | How others see you |
| **Email** | Shown only; it cannot be changed here |
| **Time zone** | **Automatic** follows the device you are using, or pick a zone |
| **Language and region** | **Automatic** follows your browser's language setting, or pick one |

Press **Save profile**. Searches read dates on the time zone saved here, and digests and quiet
hours follow it too; with **Automatic**, the server uses UTC for them. **Language and region**
also chooses the language of the web app, on every device you sign in on (see
[Language](#language)).

## Appearance

Taskmoor has two skins:

- **Light**: soft daylight, cream, peach and powder blue on a warm canvas;
- **Dark**: the same pastels on a deep plum canvas.

Panels are translucent glass over the canvas. Where your browser cannot blur, or you have asked
your system for less transparency, they are solid instead, with the same contrast.

Things move in a quick, watery way: menus and dialogs swell open and settle, and a card you move
drops into place. If you have asked your system for reduced motion, nothing animates and everything
works the same.

The sun or moon button in the top bar switches between light and dark in one press.

**System** follows the light or dark setting of your device. The choice applies at once and is
saved with your account, so it follows you to every device. The command palette offers the same
three choices: **Use the light skin**, **Use the dark skin** and **Follow the device for light or
dark**.

## Tutorials

**Settings, Tutorials** lists the sections of the guided tutorial: tracks and tickets,
workflows, boards and sprints, search and saved searches, dashboards, releases, administration
and import (the last three for site administrators). Each walks you through making one real
thing in this instance. Tick the sections you want, or start one on its own. The guided steps
and saved progress are still being built; for now the page lists the sections.

## Language

The web app is in English. A Spanish translation is included as a draft: choose a Spanish
**Language and region** on your account to use it, and the app switches as soon as you save,
and on every device once you sign in there. Languages without a translation show English.
To try it without changing your account, add `?locale=es` to the address; a `?locale=` in the
address always wins. Taskmoor never picks the draft from your browser's language alone.

## Notifications

The **Notifications** section sets how email reaches you and which events reach your inbox. See
[Notifications and your inbox](notifications.md#your-notification-settings).

## Password

Enter your **Current password**, a **New password** and **Confirm new password**, then press
**Change password**. A new password must have at least the length the page names and must not be
too common, too predictable (such as `abcabc` or `123456`), or contain your name, your email
address or the product name. A passphrase of several words works well.

Changing your password signs you out everywhere else; the page says how many other sessions
ended. If you forget your password, ask a site administrator for a password link: Taskmoor has no
self-service reset yet.

## Two-factor authentication

Two-factor authentication adds a second step after your password. The section says whether it
is on. If your administrator requires it, you cannot remove your last method; add another one
first.

### Authenticator app

1. Press **Set up authenticator app**.
2. Scan the QR code with an authenticator app on your phone or in your password manager. If you
   cannot scan it, enter the setup key shown below it.
3. Type the 6-digit **Code from the app** and press **Turn on**. Finish within 10 minutes.

**Switch off the app** asks for your password.

### Security keys

Hardware keys and passkeys saved on your devices or in your password manager both work. Press
**Add a security key**, give it a **Name of the key** (such as "Work laptop"), press **Register
key** and follow your browser. **Remove** takes a key away after asking for your password.

### Recovery codes

When you first turn on two-factor authentication, Taskmoor shows your recovery codes once. Each
signs you in one time when your phone or key is not at hand. **Copy all** or **Download as a text
file**, keep them somewhere safe, tick **I have saved these codes** and continue. The section
says how many codes you have left. **Generate new codes** asks for your password and replaces
the old codes.

### Signing in with a second factor

After your password, Taskmoor asks for the code from your app. **Use a security key** and **Use
a recovery code** switch to the other methods. If your administrator requires two-factor
authentication and you have not set it up, you set up an authenticator app before you can
continue.

## Security emails

Taskmoor emails you when something about how you sign in changes, so you notice a change you
did not make:

- your password changed (on this page, or with a reset link from an administrator);
- a second factor was added or removed, or new recovery codes were made;
- an administrator removed your second factors;
- your email address changed: that email goes to your **old** address, with the new one partly
  hidden.

Each email says what changed, when, from which IP address and browser or program, and whether you
or an administrator did it. These emails are not notifications: your notification settings,
digests and quiet hours do not hold them, and they cannot be turned off. They contain no link that
signs you in. If you did not make the change, tell your Taskmoor administrator straight away and
change your password.

## Sessions

**Sessions** lists the browsers and devices where you are signed in: the browser and system, the
IP address, when it was last active and when it signed in. The one you are using says **This
device**.

- **Sign out** next to a session ends it.
- Where the app runs on another site than its server, signing in there shows two sessions: the
  server's own page, where you signed in, and the app. Ending the first ends the second too.
- **Sign out all other sessions** ends every session but this one.

## API tokens

Programs and scripts use an API token to call the [REST API](../admin/rest-api.md) as you. A
token never does more than you may, and stops working when it expires or you revoke it.

1. Under **New token**, enter a **Token name** that says where it is used.
2. Choose its **Scopes**: **Read** (read everything you can see) and **Write** (create, change and
   delete what you may change). Site administrators can also give **Administration**.
3. Choose when it **Expires after**: 7, 30, 60, 90, 180 or 365 days, up to the longest your
   instance allows.
4. Press **Create token**. The token is shown once: **Copy** it into a password manager or the
   program's secret store, then press **Done**.

The list shows each token's state (**Active**, **Expired**, **Revoked** or **Replaced**), its
scopes, when it was created, last used and expires. **Revoke** stops a token at once.
Administrators manage every token and service accounts on their own pages: see [API tokens and
service accounts](../admin/api-tokens.md).

## Your data

**Your data**, at the end of the page, downloads everything Taskmoor keeps about you: your
profile and settings, your sessions and the names of your API tokens, your groups of tracks
and the groups shared with you, the tickets you reported, created or are assigned, your comments
and time entries, the files you uploaded, and the audit records about you. **Prepare a download** makes it in the background; it shows **Ready** in the
list after a short while, and **Download** saves it as a ZIP file of JSON files, with
`manifest.json` listing what is inside. The download is kept for seven days and only you can
fetch it. It shows the content of tickets you can see now; a ticket you no longer have access
to appears only with its number and your role on it.

`track-groups.json` lists your [groups of tracks](../admin/tracks.md#groups-of-tracks), with
their tracks by key and the people you shared each with and the role, and the groups others
shared with you, with their owner, the role and the roles that share gave you. Like your
**Tracks** page, it lists only the tracks you can see now.

To have your data erased, ask a site administrator (see [People, groups and
teams](../admin/people-and-groups.md#erasing-a-person)).

## Signing out

**Sign out** in the menu at the right of the top bar, or in the command palette, ends this
session. Other sessions stay signed in; end them from [Sessions](#sessions).
