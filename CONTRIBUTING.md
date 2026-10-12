# Contributing

Taskmoor is licensed under [AGPL-3.0-only](LICENSE). By contributing you agree that your
contribution is licensed under the same terms.

## Developer Certificate of Origin

Every commit must be signed off under the
[Developer Certificate of Origin 1.1](https://developercertificate.org/). The sign-off is your
statement that you wrote the change, or otherwise have the right to submit it under the
project's licence, and that you understand the contribution and your sign-off are public record.

Sign off by adding a trailer that matches the commit author:

```text
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it for you. To have it added automatically, enable the repository's hooks
once per clone:

```bash
git config core.hooksPath .githooks
```

The `pre-push` hook and CI run `pnpm dco` and reject commits without a matching sign-off. To fix
commits you have not pushed yet, run `git rebase --signoff origin/main`.

## Before you open a pull request

1. `pnpm verify` passes, and `pnpm verify --e2e` passes for UI changes.
2. Behaviour follows the spec in `docs/specs`; tests cite requirement IDs such as `[CORE-028]`.
3. Nothing is copied from another product's code, documentation or assets
   (see [docs/legal/clean-room.md](docs/legal/clean-room.md)).

See [CLAUDE.md](CLAUDE.md) for commands, layout and conventions.
