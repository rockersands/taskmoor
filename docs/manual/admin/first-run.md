---
title: "First-run setup"
audience: admins
sources: apps/server/src/setup.ts, apps/server/src/routes/setup.ts, apps/server/src/authz/create-tracks.ts, apps/server/src/main.ts, apps/server/src/config.ts, apps/server/src/cli.ts, apps/web/src/setup/SetupPage.tsx, apps/web/src/admin/SettingsPage.tsx, apps/web/src/i18n/messages.en.ts, packages/iam/src/policy.ts, deploy/README.md, deploy/compose/install.sh, deploy/helm/taskmoor/values.yaml, deploy/helm/taskmoor/templates/NOTES.txt, packages/builder-core/src/backend.ts, docs/specs/05b-administration-security-and-self-hosting.md, apps/server/src/email/smtp.ts
accessed: 2026-11-01
attestation: own-words
---
# First-run setup

A new Taskmoor server has no accounts. The first person in is the one who opens the setup
link: a one-time link that creates the first site administrator. This page explains where to
find the link, what the setup form asks and what to do next.

## The setup link

While setup is not done, every server process that runs the API role makes a setup token when
it starts, keeps only a hash of it, and writes the link to its log once:

```json
{"msg":"first-run setup","link":"http://localhost:8080/#/setup?token=..."}
```

| Install | Where the link is |
|---|---|
| Compose kit | `install.sh` prints it; later, `docker compose logs taskmoor` in the kit's folder |
| All-in-one image | `docker logs taskmoor` (the container's name) |
| Helm | `kubectl logs deploy/taskmoor-app \| grep first-run` |
| The Builder's backend kit | `install.sh` prints it, made from the kit's own setup token |

The token works once, and for 24 hours at most. Every start of the backend makes a new one and
the previous link stops working, so after a restart use the newest line of the log. With
several app pods on Kubernetes, that is the line of the pod that started last.

The link starts with `PUBLIC_URL`, or `http://localhost:8080` when it is not set. If you reach
the server at another address, open the same `/#/setup?token=...` there, and set `PUBLIC_URL`
afterwards: the links in emails and the secure cookies follow it
([installing Taskmoor](install.md#public-address-and-reverse-proxies)).

### Choosing the token yourself

Installers and scripts may fix the token with `TASKMOOR_SETUP_TOKEN` (at least 16 characters;
in Helm, `setupToken.existingSecret`). Each start then sets the same token with a fresh 24 hours.
Treat it like a password: until setup is done, whoever has it can make themselves the
administrator. Once setup is done, no token is made and the variable has no effect. The
Builder's backend kit sets one for you in its `.env`.

## Creating the first administrator

The link opens **Set up Taskmoor**. Fill in:

| Section | Field | Notes |
|---|---|---|
| **Instance** | **Instance name** | Required, up to 100 characters; it leads the page title |
| **Administrator** | **Name**, **Email** | Your own account |
| | **Password**, **Confirm password** | At least 12 characters and at most 128; refused when it is common, predictable, or contains your name, your email address or the product name |
| **Outgoing mail (optional)** | **Configure outgoing mail now** | Shows **SMTP host**, **SMTP port** (587), **Use TLS from the start (SMTPS)**, **SMTP user name** and **Sender address** |

**Finish setup** creates the account as a site administrator, records the instance name, marks
setup as done, deletes the token, signs you in and opens **Home**. On the new site only site
administrators may create tracks, until they give that permission to someone
([Tracks](tracks.md#who-may-create-one)). Taskmoor does not yet let you
change the instance name after setup.

The mail fields are stored with the instance, and the server sends email through that server
from then on, without a restart. The password always comes from the environment: when you
give an SMTP user name, set `TASKMOOR_SMTP_PASSWORD` too. When the environment names a server
with `TASKMOOR_SMTP_URL` ([mail settings](configuration.md#mail)), that one wins over the form.

### When the link does not work

| Message | What to do |
|---|---|
| The setup token is invalid or has expired | Restart the backend and use the new link from the log |
| This instance is already set up | Setup is done: **Sign in** with the administrator's account |
| This page needs the setup link the installer printed | You opened `/#/setup` without a token: use the whole link |
| Choose a different password | The password broke one of the rules above |

### Setting up without the browser

The form calls one endpoint, which a script can call too. `GET /api/v1/setup` answers
`{"needed": true}` until setup is done. Then:

```http
POST /api/v1/setup HTTP/1.1
Content-Type: application/json

{"token": "the setup token", "instanceName": "Acme",
 "admin": {"name": "Ada Admin", "email": "admin@example.com", "password": "a long passphrase here"}}
```

An optional `smtp` object takes `host`, `port`, `secure`, `user` and `from`. The answer is
`201` with the new account and a session cookie; `400` with `invalid_request` or
`weak_password` and a list of problems; `403` with `invalid_setup_token`; or `409` with
`setup_completed`.

## Locked out after setup

If the administrator's password is lost, make a one-time password link from the server with the
operator CLI, for example on the Compose kit:

```bash
docker compose exec taskmoor node cli.mjs password-link admin@example.com
```

See [the operator CLI](cli.md).

## What to do next

Everything below lives under **Administration**, the section that site
administrators see.

1. **Check the server.** **System status** shows the version and roles, the database, the data
   directory and free space, the last backup and the backup schedule. Scheduled backups are on
   by default once setup is done ([backups](backups.md)).
2. **Turn on email.** Fill in the mail fields of the setup form, or set the SMTP variables and
   restart. Until then, notifications reach each
   person's inbox in the app and email waits unsent ([email and notification
   policies](notifications.md)).
3. **Decide how people sign in.** **Security** sets who must use two-factor authentication
   (site administrators from the start, so you set one up at your next sign-in) and how long a
   sign-in lasts.
   **Single sign-on**, **LDAP and Active Directory** and SCIM provisioning connect your
   directory ([single sign-on](sso.md), [LDAP directories](ldap.md), [SCIM
   provisioning](scim.md)).
4. **Add people.** On **People**, **Add a person** with a name and an email, and tick **Site
   administrator** for another administrator. Taskmoor then shows a one-time link to set a
   password, only once; send it to the person yourself. **Groups** gathers people for
   permissions ([people and groups](people-and-groups.md)).
5. **Make the first track.** On **Tracks**, **Add a track** with a key and a name, then choose
   its workflow map and who does what in it ([tracks](tracks.md)).
6. **Review permissions.** **Permissions** holds the roles, access policies and the permissions
   that apply everywhere ([permissions and access](permissions.md)).

Before the server holds real work, take a backup and try a restore drill, so you know both work
on your machine.
