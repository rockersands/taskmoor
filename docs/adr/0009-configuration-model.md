# ADR-009: One configuration model

- Status: Accepted
- Date: 2026-10-12
- Backlog: M0-024

## Context

Jira configures a project through a hierarchy of schemes: issue type schemes, field
configuration schemes, screen schemes, issue type screen schemes, workflow schemes, permission
schemes and notification schemes, each an indirection between projects and the objects they
use. Administrators find it the hardest part of Jira; imports must preserve it. The spec asks
for shared and space-local configuration on one model (CORE-003), unified field schemes and
layouts (CORE-013) and space templates (CORE-004).

## Decision

- **A space's configuration is one object graph:** work types and hierarchy levels; fields
  with contexts, layouts (create, edit, view, transition; with tabs) and validation; workflows
  with statuses, transitions and rules; permission policy; notification policy; boards,
  automation rules and SLA definitions where the module applies. The same graph serves
  company-managed and team-managed styles: a space either references shared objects or owns
  local copies, element by element.
- **Sharing is explicit and visible.** A shared object lists the spaces that use it; saving it
  shows that list before commit. Converting between shared and local is a copy or a link, not
  a scheme swap.
- **Templates are serialised configuration graphs** (CORE-004), with optional sample items,
  exportable as files.
- **Jira's scheme hierarchy is mapped by the importer** (IMP-004): each project's effective
  configuration is resolved through its schemes and written as shared objects where several
  projects resolve to the same one, local otherwise. The native model never exposes scheme
  objects, and the Jira-compatible API shim (ADR-016) synthesises them where clients ask.

## Options considered

| Option | For | Against |
|---|---|---|
| One configuration graph with explicit sharing (chosen) | Understandable admin UI; templates and export fall out of it; one model for the query engine and API | Importer does the resolution work |
| Replicate Jira's schemes one to one | Lossless import | Reproduces the main administration complaint; the shim can still present schemes |
| Per-space configuration with no sharing | Simplest | Large sites need one change to reach many spaces; the spec requires shared configuration |

## Consequences

Admin pages are organised around objects (fields, workflows, policies) and their users, not
around schemes. The importer carries a golden test suite of resolved configurations so scheme
mapping is verified, not assumed.
