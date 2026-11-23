# Secret scan of the whole history

T-032, before the repository goes public (T-031). Run on 2026-11-05 on the Mac, locally and
without any account or token.

**Result: no real secret in any commit.** Every finding is either a test value made for the
repository or a false positive. Each one is allowed in `.gitleaks.toml` by its file together
with its exact value or shape, so `pnpm secrets` comes back clean and fails on anything new. The
history was not rewritten.

## What ran

| | |
|---|---|
| Tool | gitleaks 8.30.1 (MIT), installed with Homebrew on this machine. It is a local tool, not a repository dependency. trufflehog was not needed |
| Rules | gitleaks' default rules, plus three Taskmoor rules in `.gitleaks.toml` that the defaults lack: API tokens (`tmk_`, IAM-007), OAuth access and refresh tokens (`tma_`, `tmr_`), and passwords inside URLs such as database connection strings |
| Commits | 788 commits, reachable from every ref: all local branches (`main`, the coordinator branch, `claude/*`, `wave*`, the worktree branches), the remote-tracking branches, the stash, and every ref on GitHub as `git ls-remote origin` listed it, pull request refs included. gitleaks read 684 of them, because merges add no lines of their own |
| Rewritten commits | The run was repeated with `--reflog` to add 28 commits that only the local reflogs reach (amended or reset work, which GitHub may still hold if it was ever pushed). That made 816 commits, 694 read, with the same findings |

A normal clone does not fetch the pull request refs (`refs/pull/1` to `refs/pull/13`: Dependabot's
branches and the merge previews GitHub makes), and 11 of their commits were not on this machine.
These refs become public along with the repository, and a history rewrite leaves them unchanged.
So they were fetched by commit, with `git fetch --no-write-fetch-head origin refs/pull/N/head ...`
so that no ref was created, and scanned with the rest.

The scans, with the reports kept outside the repository:

```sh
git ls-remote origin                 # every ref GitHub has; fetch the commits missing here
gitleaks git --config defaults-only.toml --log-opts="--all <every commit ls-remote listed>" \
  --report-format json --report-path <outside the repository>/raw.json .
gitleaks git --config .gitleaks.toml --log-opts="--all <same>" \
  --report-format json --report-path <outside the repository>/final.json .
```

## Findings

With the rules above and no allowlist, the scan reports 32 findings. The default rules alone find
11 of them, the same 11 that the M1-118 scan of 2026-10-31 found (`scan-triage.md`).

### Real secrets: none

No key, token, password, private key or connection string that works or ever worked.

### Test values made for the repository: 21

These are passwords of throwaway databases and placeholders in tests and examples, all found by
the `url-credentials` rule. Each was typed for a test, for a container that lives for one run, or
for an example, and none of them ever guarded anything real. The exact values are in
`.gitleaks.toml` and are not repeated here.

| File (findings) | Commits | What it is |
|---|---|---|
| `.github/workflows/ci.yml` (5) | `9b084b9b`, `9499e6a4`, `7fdc4a18`, `9914634c` (2026-10-12) | The default password of the CI job's Postgres service container, reachable only inside the job |
| `apps/server/src/config.test.ts` (3) | `9b084b9b`, `9914634c` (2026-10-12) | Connection strings that `loadConfig` must accept, and one it must reject without repeating the password |
| `apps/server/src/backups/schedule.test.ts` (1) | `1b156fb8` (2026-10-28) | A failed `pg_dump` line whose password the backup record must never keep (OPS-008) |
| `apps/server/src/email/smtp.test.ts` (1) | `e797aa3a` (2026-10-30) | The placeholder database URL of the mail server tests |
| `apps/server/src/fuzz/targets.test.ts` (1) | `b2be3f16` (2026-11-01) | An address with a user and password in the OAuth address checks |
| `apps/server/src/webhooks/webhooks.test.ts` (1) | `3568a60c` (2026-10-29) | A webhook URL with credentials, which the webhook form must refuse |
| `deploy/compose/.env.example` (2), `deploy/compose/docker-compose.external.yml` (2) | `016d46f4`, `9914634c` (2026-10-12) | The placeholder in the Compose kit's external-database example |
| `docs/manual/admin/install.md` (2) | `dadc9550` (2026-10-30) | The example connection string on the installation page |
| `tools/helm/postgres.yaml` (2) | `251a877f`, `9914634c` (2026-10-12) | The password of the Postgres in the kind cluster that tests the Helm chart |
| `tools/image/smoke.sh` (1) | `d99b3b7b` (2026-10-12) | The password of the image smoke test's throwaway Postgres container |
| `tools/sweep/plan.test.mjs` (1), `tools/sweep/redact.mjs` (1) | `6b7fc678` (2026-11-13) | A made-up token the sweep must never repeat from its command line, and the word "password" in a comment's example address (the comment no longer has one). Found after the table above was counted |

The other test credentials never enter the history as values. FakeS3 creates its access key and
secret at run time (`packages/storage/src/fake-s3.ts`). The e2e seed's passphrases are ordinary
words, which the sweep below read. The AI adapters' recorded exchanges carry only placeholder keys.

### False positives: 11

All of these come from the default `generic-api-key` rule, which flags a high-entropy value near a
word like token or secret.

| File (findings) | Commit | What it is |
|---|---|---|
| `apps/server/src/import/cloud/__fixtures__/compat-source.json` (8) | `e7b7be0a` (2026-10-31) | `nextPageToken` page cursors recorded from Taskmoor's own synthetic server. Each of the 4 distinct values decodes to `{"s":...,"v":[...],"i":...}` (base64). The allowlist accepts only that shape, and only in this file |
| `packages/db/src/upgrade-fixtures.ts` (1) | `ca13c2c0` (2026-10-28) | A storage key of the upgrade seed: an object name made of hex digits in order |
| `apps/web/src/account/fixtures.ts` (1) | `b26d2520` (2026-10-12) | The synthetic authenticator setup of the account stories: ASCII text encoded in base32 |
| `apps/server/src/routes/identity.test.ts` (1) | `9c91bed2` (2026-10-12) | A common password that the password policy must refuse |

## The sweep beside gitleaks

gitleaks' generic rule skips values with low entropy, so a password a person chose could pass
it. For that reason the same history was also read with a script of known shapes, kept out of
the repository. It looked for:

- private key blocks;
- the key formats of AWS, GitHub, Anthropic, OpenAI, Slack, Google, Stripe, GitLab, npm and
  Hugging Face;
- JWTs, Bearer and Basic headers, and Azure connection strings;
- Taskmoor's own tokens;
- every environment assignment to a password, secret, token or key;
- every quoted value assigned to a name that contains password, passphrase, secret, token or
  key (308 distinct values, each one read).

What it found:

- No provider key, private key, JWT or Taskmoor token.
- The quoted values are test passphrases made of ordinary words, placeholders, interface
  strings in English and Spanish, and code.
- None of the 3,144 paths ever committed is an environment file (there is only
  `deploy/compose/.env.example`), a private key, a certificate or a keystore. The only key files
  hold the public half of the release signing key (`deploy/compose/taskmoor-release.pub`,
  `tools/airgap/taskmoor-release.pub`). Its private half was never committed.
- Commit messages: nothing.
- Not read: binary files, which gitleaks skips too. These are the app icons, the glass
  backgrounds and the bundled embedding model.

The sweep's password rule is not in `.gitleaks.toml`, because hundreds of test passphrases would
each need an allowlist. A future scan relies on the generic rule for high-entropy passwords and on
the URL rule for connection strings. The working tree is still checked on every `pnpm verify` by
`packages/devtools/src/secrets.ts` (ADR-029).

The configuration was also tested against a folder of invented credentials, built outside the
repository. It caught a `tmk_` token, `tma_` and `tmr_` tokens, a strong database password, a
reviewed test password placed in another file, and another password placed inside an allowlisted
file. The reviewed values in their own files and the `${POSTGRES_PASSWORD}` references passed.

## If a real secret is ever found

None was found this time, so nothing has to be rotated. If a later scan finds one:

1. **The user rotates or revokes it first**, with whoever issued it. Removing it from git does
   not make it safe again, and Claude cannot do this step.
2. A normal commit removes it from the working tree.
3. The history rewrite T-005 removes it from every commit: `git-filter-repo --replace-text`, with
   a backup first and one force-push, each step confirmed by the user. Reports name the secret by
   file, commit and rule only, never by its value.
4. Pull request refs on GitHub keep their commits after a force-push, and only GitHub Support can
   remove them. Rerun the scan with the pull request refs afterwards.

## Not secrets, but public with the history

- The user's old address in older commits, and old local paths: the history rewrite T-005
  replaces them.
- 221 commit messages carry a `Claude-Session:` link. These open only for the account that owns
  the session, so they are not secrets, but they will be readable once the repository is public.

## Running it again

```sh
brew install gitleaks        # once; a local tool, MIT licence
corepack pnpm secrets        # every commit of every local branch; exit 1 and redacted findings on a leak
```

Before T-031, scan GitHub's pull request refs as well:

```sh
git fetch origin '+refs/pull/*:refs/remotes/origin/pull/*'
corepack pnpm secrets
```

When there is a new finding, read the commit first. If it is a test value or a false positive, add
an allowlist to `.gitleaks.toml` with `targetRules`, `condition = "AND"`, its path and its exact
value or shape, and add a row here. Never allow a path alone or a rule alone. If it is real,
follow the steps above.
