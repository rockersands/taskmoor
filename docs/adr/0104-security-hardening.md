# ADR-104: Security hardening for 1.0: threat model, ASVS level 2, fuzzing, prompt injection, scans

- Status: Accepted
- Date: 2026-10-31
- Backlog: M1-118

## Context

NFR-008 commits Taskmoor to OWASP ASVS level 2, scans on every build and an external pen test
before each major release (M2-021 for 2.0). M1-118 is the 1.0 share of that work: a threat
model, the ASVS 4.0.3 level 2 checklist with evidence, fuzzing of every parser that reads
untrusted input, a prompt-injection corpus for the AI features, and the triage of the SAST,
dependency, container and secret scans. Its bar: ASVS L2 complete, no high or critical finding
left, fuzzers clean for 24 hours, the injection corpus green.

Constraints of this task: GitHub Actions does not run until M1 is finished (decision of
2026-10-30), so every scan runs locally; the cloud container reaches registries through a proxy
that refuses some hosts (the Semgrep registry, GitHub release downloads, at times the Alpine
CDN); no scanner account or token is used. AI features (M1-079) are not built yet, so the
injection corpus can only exercise the defences that hold without a model.

## Decision

**Documents** in `docs/security/`: `threat-model.md` (assets, trust boundaries, threats per
boundary, mitigations with code and test paths, residual risks), `asvs-l2.md` (every level 2
requirement with its state and evidence; gaps with a fix or the task that closes them),
`scan-triage.md` (every scan, what ran where, every finding's disposition). Two machine-readable
records feed the gate: `scan-results.json` (per scan: ran or not, findings left open by
severity) and `fuzz-results.json` (per fuzz target: the longest clean run).

**Fuzzing.** One harness for every target (`@taskmoor/testkit/fuzz`): a target makes inputs
from seeds by mutation and states its invariants on each input; inputs are reproducible from
the run's seed and the input's index. `runWatched` (`@taskmoor/testkit/fuzz-run`) runs a
target in a worker thread and watches a heartbeat in shared memory, so a parser stuck in a
loop is stopped and reported with the input rebuilt from its index. Targets: `text`, `href`,
`wiki`, `markdown`, `adf` (shared packages, `packages/devtools/src/fuzz/targets.ts`) and
`csv`, `dc-xml`, `dc-stage`, `scim`, `addresses`, `rich-text` (server,
`apps/server/src/fuzz/targets.ts`), beside the existing `query` and `formula`. `pnpm fuzz
<target>|all --minutes N` runs them (`packages/devtools/src/fuzz/registry.ts` names each
target's file by path, since devtools may not import the server). Invariants are about safety:
no exception but the parser's own refusal, no hang, no input slower than a second (timed three
times), output the schema accepts, no unsafe link kept, no stored value that a reader cannot
write back. Round-trip fidelity of wiki markup is counted (`unstable`), not failed: the
property tests of `wiki.test.ts` guard it, and the fuzzer's job is safety.

**24 hours.** The gate (`pnpm gate M1`) waits until every target has a clean run of at least
24 hours recorded in `fuzz-results.json`. That run is a job for a machine that can spare one
CPU per lane for a day (the Mac, or the nightly once CI runs): `pnpm fuzz all --minutes 1440`
runs the targets one after another (13 days); for the gate, run lanes in parallel, one target
per lane, `pnpm fuzz <target> --minutes 1440 --seed <n>`, and copy each `.verify/fuzz-<target>.json`
summary into `fuzz-results.json`. M1-118 ran every target for ten minutes.

**Prompt injection.** `packages/ai/src/injection/corpus.ts`: synthetic cases in our own words,
per goal (reveal another ticket, call tools beyond the feature, write without confirmation,
carry data out through links or images, ignore the instructions, close the fence, get past
redaction) and per carrier (summary, description, comment, field, label), each with what an
obedient model would then try. Two harnesses play that model with the fake provider:
`packages/ai/src/injection/injection.test.ts` (fence, tools, writes, redaction, answer
screening) and `apps/server/src/ai/injection.test.ts` (the same through `AiContext` and the
real routes, as people with different rights). New defences, in `@taskmoor/ai`:
- `fenceUntrusted` / `neutraliseTags`: one fence the text cannot close or reopen. `AiContext`
  used to remove `<ticket>` tags, which `</tic<ticket>ket>` defeated; it now uses the fence.
- `AgentTool.effect: 'write'` and `AgentRunOptions.confirm`: a write tool runs only when the
  person's confirmation says yes; without a `confirm`, or when it fails, the model is told the
  call was not run (`NOT_CONFIRMED`).
- `screenAnswer`: removes images that would load from another origin (the content security
  policy refuses them too, ADR-080) and lists links to other origins for the interface to name.

**What M1-079 adds:** mark every write tool `effect: 'write'` and pass a `confirm` that asks
the person; wrap every ticket, comment and field it sends with `fenceUntrusted` (or
`AiContext`); screen every answer with `screenAnswer` before storing or showing it; and run the
corpus against a live model (each case's text in a real ticket, the feature's real prompt),
scoring that the model neither follows nor repeats the injection. The gate waits on that run.

**Scans**, all local and without accounts: Semgrep with the community rules cloned from their
repository (the registry is refused), osv-scanner with its offline database and `pnpm audit`
for dependencies, Trivy from its container image for the image and the deployment
configuration, gitleaks over the whole history and the working tree. Results and the triage are
in `scan-triage.md`. The repository keeps `.gitleaks.toml` with the reviewed false positives
of the history, so a rerun shows only new findings.

*Updated 2026-11-05 (T-032):* `.gitleaks.toml` adds rules for Taskmoor's own tokens (`tmk_`,
`tma_`, `tmr_`) and for passwords inside URLs, and every allowlist names one file and the exact
value or shape that was judged, never a path or rule alone. `pnpm secrets` runs gitleaks with it
over every local branch; gitleaks stays a local tool, not a dependency. The scan of the whole
history before going public, GitHub's pull request refs included, is in `secret-scan.md`.

## Consequences

- Fixed in this task (each with a regression test): a stored table span of `1e308` that made
  the Markdown and wiki writers exhaust memory and kill the server (high; spans are now
  1 to 1,000, refused otherwise and capped by the writers); link targets a browser reads as script
  (`java\tscript:`, a leading control character) passed `isSafeHref`; wiki markup misread
  macros after `İ` and kept code languages it could not write back; a mention id with a lone
  surrogate made Markdown output throw; ADF bodies and stored documents with non-object
  attributes, non-list content or deep nesting were stored and then failed every read (a 500
  on the ticket and its notification mail) or exhausted the stack; AES-GCM accepted truncated
  tags for sealed secrets; workflow regex validators ran administrators' patterns with nested
  repetition on anyone's ticket text (ReDoS; `unsafePattern` in `packages/workflow` refuses
  them on save and never runs a stored one); OAuth loopback redirects matched with a user name or a fragment;
  vulnerable dependencies (Storybook, Vitest, Fastify, Nodemailer, follow-redirects,
  fast-uri); the image shipped npm, corepack and yarn, whose own dependencies carried ten high
  findings; most answers lacked HSTS, `nosniff` and a referrer policy, and API JSON could be
  cached (`apps/server/src/security-headers.ts`).
- Left open, each with a reason and a task in the checklist: webhook delivery to private
  addresses (site administrators only, no answer body kept), the moderate glob and minimatch
  advisories (patterns are the code's own), the full image's PostgreSQL client layer and the
  GitHub Actions pinning (gate items).
- `pnpm gate M1` exists now with the security checks; M1-120 adds the rest of the M1 gate.

## Changes

- **2026-11-01, the user's decisions on the two gaps left to them.**
  - **Sessions (ASVS 3.3.2):** a workspace setting with today's values as the default (14 days,
    3 days idle). `session_policy` (migration 0080), `apps/server/src/session-policy.ts` (read on
    every use, cached 15 s per process, dropped on change), `GET`/`PUT /api/v1/security/sessions`
    (event `session_policy.updated`, audited), the Security page's Sign-in sessions form. The
    lifetime is checked against each session's start, so a shorter policy ends older sessions
    at once; the idle timeout covers frontends on another site too. 3.3.2 is recorded as
    accepted: 12 hours and 30 minutes meets level 2 when an administrator sets it.
  - **Second factor for site administrators (ASVS 4.3.1):** first-run setup writes the
    two-factor policy `site_admins`, so the administrator enrols at the next sign-in; an existing
    policy is kept. The e2e setup file turns it off after checking it, for the journeys that
    follow; the fresh-install run (`fresh-install.spec.ts`) enrols an authenticator through the
    frontend's sign-in and signs in with a code. 4.3.1 is met.
- 2026-11-02, the user's decision: the fuzzing bar for M1 is **8 hours clean per target**,
  reached in stages of 1, 2, 4 and 8 hours (all 13 targets in parallel, each stage clean
  before the next), instead of one 24-hour run: the cloud container restarted three times in a
  day. `FUZZ_GATE_SECONDS` is 8 hours. Runs under an hour found two real bugs (a crash staging a
  DC backup, quadratic wiki markup), fixed with regression tests.
