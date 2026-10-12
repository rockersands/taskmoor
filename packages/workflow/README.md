# @taskmoor/workflow

The workflow behaviour model and its conformance suite (M1-022), with a reference model that
executes the suite today. The engine of M1-023 implements the same `WorkflowEngine` interface
and must pass every case; the reference model stays as the oracle it is compared with.

```
pnpm conformance workflow           # per-section pass, fail and unsupported counts on the reference model
pnpm conformance workflow --json    # the full report
```

## What a case is

A transition has guards (who may see or run it), checks (what must hold before it completes) and
effects (what happens after it); Jira calls these conditions, validators and post functions. The
sections of the suite follow spec 01a: model, guards, checks, effects, layouts, properties and
events, status permissions, close reason, rules, board, editor, import and export, and lint.

A case is data (`src/conformance/case.ts`): a workflow definition, a starting ticket and actor,
one action, and what spec `docs/specs/01a-core-work-tracking.md` says must come out. Kinds:

| Kind | Action | Compares |
|---|---|---|
| `available` | list the transitions offered to an actor through a channel | the ids, order-free |
| `transition` | run a transition with layout values and a comment | blocked by which guard, check, rule or permission (and that nothing changed), or the status, fields, assignee, close reason, closed stamp, history entries added, event, webhooks and the essential order |
| `create` | create a ticket | initial status, event, webhooks, history |
| `permission` | may the actor edit, comment, attach, assign or transition in this status | allowed, and the reason when not |
| `board-move` | move a card on a board-managed workflow | status and close reason |
| `publish` | publish an editor change with a status mapping | published or refused and why, tickets moved, version, impact panel |
| `import` | map Jira condition, validator and post function classes to guards, checks and effects | mapped types and the placeholder report |
| `export-roundtrip` | export then import | identical definition |
| `lint` | lint a workflow against its boards | the named warnings |

Only the keys an expectation names are compared; arrays are compared whole. Every case cites
the WF requirement it checks and the spec section its behaviour is restated from; the public
pages behind those sections are listed in `docs/research/sources.md`. A `verify` note marks a
detail the public description leaves open and the choice this suite makes.

## Running it against another implementation

Implement `WorkflowEngine` (`src/conformance/run.ts`); every method is optional and a missing one
counts its cases as unsupported rather than failed. Then:

```ts
import { runConformance, formatReport, WORKFLOW_CASES } from '@taskmoor/workflow';
console.log(formatReport(runConformance(myEngine, WORKFLOW_CASES)));
```
