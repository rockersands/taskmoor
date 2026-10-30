---
title: "Your account"
audience: users
sources: apps/web/src/account/AccountPage.tsx, apps/web/src/account/ProfileSection.tsx, apps/web/src/account/AppearanceSection.tsx, apps/web/src/account/PasswordSection.tsx, apps/web/src/account/TwoFactorSection.tsx, apps/web/src/account/SessionsSection.tsx, apps/web/src/account/options.ts, apps/web/src/twofactor/TotpSetupForm.tsx, apps/web/src/twofactor/RecoveryCodes.tsx, apps/web/src/session/UserMenu.tsx, apps/web/src/session/SecondFactorStep.tsx, apps/web/src/tokens/TokensSection.tsx, apps/web/src/tokens/TokenForm.tsx, apps/web/src/tokens/format.ts, apps/web/src/skins/skins.ts, apps/web/src/i18n/locale.ts, apps/web/src/i18n/messages.en.ts, apps/web/src/App.tsx, apps/server/src/routes/search.ts, apps/server/src/email/deliver.ts, docs/adr/0024-i18n-and-accessibility.md, docs/adr/0035-api-tokens-and-service-accounts.md, docs/adr/0036-skins-and-soft-visual-language.md, docs/specs/05a-administration-security-and-self-hosting.md
accessed: 2026-10-30
attestation: own-words
---
# Your account

Your account page holds your own settings: your profile, how Taskmoor looks, your
notifications, your password, two-factor authentication, the devices where you are signed in
and your API tokens.

## Opening your account

Open the menu with your name at the right of the top bar. It says **Signed in as** your email
and offers **Account** and **Sign out**. You also reach the page from **Settings**, under
**Personal**, and from the command palette (**Account**).

## Profile

| Field | What it does |
|---|---|
| **Name** | How others see you |
| **Email** | Shown only; it cannot be changed here |
| **Time zone** | **Automatic** follows the device you are using, or pick a zone |
| **Language and region** | **Automatic** follows your browser's language setting, or pick one |

Press **Save profile**. Searches read dates on the time zone saved here, and digests and quiet
hours follow it too; with **Automatic**, the server uses UTC for them. **Language and region**
is kept with your account; the words of the web app do not change with it (see
[Language](#language)).

## Appearance

Taskmoor has two skins:

- **Light**: soft daylight, cream, peach and powder blue on a warm canvas;
- **Dark**: the same pastels on a deep plum canvas.

**System** follows the light or dark setting of your device. The choice applies at once and is
saved with your account, so it follows you to every device. The command palette offers the same
three choices: **Use the light skin**, **Use the dark skin** and **Follow the device for light or
dark**.

## Language

The web app is in English. A Spanish translation is included as a draft: to use it, add
`?locale=es` to the address and load the page. Reloading without it brings English back.
Taskmoor never picks the draft from your browser's language.

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

## Sessions

**Sessions** lists the browsers and devices where you are signed in: the browser and system, the
IP address, when it was last active and when it signed in. The one you are using says **This
device**.

- **Sign out** next to a session ends it.
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

## Signing out

**Sign out** in the menu at the right of the top bar, or in the command palette, ends this
session. Other sessions stay signed in; end them from [Sessions](#sessions).
