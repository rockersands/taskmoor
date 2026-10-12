# @taskmoor/query

The query language: lexer, parser, canonical printer, field resolution and SQL compilation, with
a Jira-compatible dialect (spec `docs/specs/01b-core-work-tracking.md`, section 1).

## Conformance suite (M1-033)

`src/conformance` holds 2,220 data cases that state what the spec says about the language:

| Kind | What it states |
|---|---|
| `parse` | the text parses, prints back as a canonical form, and that form parses to the same tree |
| `parse-error` | the text is refused with the error at a given offset and a hint |
| `resolve` | the text resolves against a catalogue (or is refused with a given message) |
| `equivalent` | several texts resolve to the same plan, for example both vocabularies |

Sections follow the spec: grammar, operators (every operator on every value type), fields
(every identifier and alias of section 1.5), functions (every function under both names),
history, dates, text search syntax, ordering, filters and sprint tokens. Every case cites its
QRY requirement and spec section; a `verify` note marks a detail the public description leaves
open.

```
pnpm conformance query                 # pass rate per section on this package's parser and resolver
pnpm conformance query --failures=50   # with the first 50 failures
pnpm conformance query --json          # the full report
```

A failing case is a gap in the implementation, not a wrong case: the per-section pass rates are
a golden (`src/conformance/__golden__/pass-rates.json`) that the parser (M1-034) and compiler
(M1-035) work raises, and every change of a rate is reviewed with `pnpm verify --update`.
