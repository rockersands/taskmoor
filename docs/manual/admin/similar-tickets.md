---
title: "Similar tickets and the local embedding model"
audience: admins
sources: packages/ai/src/embed/local.ts, packages/ai/src/embed/wordpiece.ts, packages/ai/src/embed/endpoint.ts, packages/ai/src/embed/ort-worker.mjs, packages/ai/models/all-MiniLM-L6-v2/SOURCE.md, apps/server/src/embeddings/service.ts, apps/server/src/embeddings/indexer.ts, apps/server/src/embeddings/jobs.ts, apps/server/src/embeddings/similar.ts, apps/server/src/embeddings/vector.ts, apps/server/src/embeddings/backfill.ts, apps/server/src/routes/similar.ts, apps/server/src/config.ts, apps/server/src/cli.ts, packages/db/src/migrations/0079_embeddings.ts, deploy/compose/docker-compose.yml, packages/builder-core/src/backend.ts, tools/build/server.mjs, docs/adr/0106-local-embeddings-and-vector-search.md, docs/specs/02c-platform-api-and-integrations.md, docs/specs/05b-administration-security-and-self-hosting.md
accessed: 2026-11-01
attestation: own-words
---
# Similar tickets and the local embedding model

Taskmoor finds tickets that mean the same thing even when they use other words: "Login fails
after password reset" and "Cannot sign in following credential change" are neighbours. It does
this with a small language model that ships inside the Taskmoor image, all-MiniLM-L6-v2, which
turns each text into a list of 384 numbers (an embedding). Texts with close embeddings are
close in meaning.

This needs **no AI provider, no key and no internet**. The model runs on the Taskmoor server
itself and sends nothing anywhere, so it works on an air-gapped install and on one that never
set AI up. It does not follow the [AI settings](ai.md) switch, which is about sending content to
a provider.

## What gets embedded

- Every ticket: its summary and the text of its description (the first 2,000 characters).
- Every comment: its text.

The worker embeds a ticket or a comment a moment after it is created or its text changes, in
the background. Changing anything else (a label, the status) does not embed it again. Tickets
in the trash and deleted comments lose their embeddings; a restored ticket gets them back.
Imports write many tickets at once, so the worker embeds an import's tickets after it finishes.

The model reads about 40 ticket-sized texts a second on one processor core, so a first pass
over 100,000 tickets takes roughly 45 minutes. The rest of the server is not slowed by it:
the model runs on its own thread.

## Who sees what

Similar tickets are only ever tickets the person may see: the same rules as search, including
track permissions, visibility levels and archived tracks. A comment counts towards a match only
if the person may read it; a match through a comment names the comment, never shows its text.

## Asking for similar tickets

The REST API has two read operations (see the [REST API](rest-api.md) reference):

- `GET /api/v1/tickets/{id}/similar`: the tickets most similar to one ticket, best first, each
  with a score from -1 to 1 and whether its own text or one of its comments matched.
  `limit` (up to 50) and `minScore` narrow the list.
- `POST /api/v1/tickets/similar` with `{"text": "...", "track": "PAY"}`: the tickets most
  similar to a text being written, for duplicate suggestions while a ticket is created.
  `track` (optional) keeps to one track; `excludeTicket` leaves one ticket out.

Both need only a read token. The create dialog uses the second for its duplicate suggestions,
with no AI provider needed. With `"reasons": true` and an AI provider set up for the track, the
first eight are re-ordered by the AI with a reason each (`likely`, `reason`, `reranked: true`),
within 2 seconds of the request; when the AI is slower, off or not set up, the answer is the
embedding order with `reranked: false`. A similar-ticket panel on the ticket page comes later.

## The vector index (pgvector)

Lookups are fastest with the **pgvector** extension in PostgreSQL. At start the server installs
it when the database server has it and the database user may, and builds an index over the
embeddings. The log says which way lookups run: `similar tickets: pgvector with an HNSW index`
or `similar tickets: exact scan (no pgvector)` with the reason.

Without pgvector everything still works: the server compares the embeddings of the tickets the
person may see one by one. That takes about a quarter of a second at 3,000 tickets and grows
with the number of tickets, so above roughly 20,000 tickets use a PostgreSQL with pgvector.

| Install | PostgreSQL | Lookups |
|---|---|---|
| Compose kit, bundled database | `pgvector/pgvector:0.8.1-pg16-trixie` (PostgreSQL 16 with pgvector) | pgvector |
| Builder backend kit | the same | pgvector |
| Compose kit with `POSTGRES_IMAGE=postgres:16` | no pgvector | exact |
| All-in-one image, air-gap bundle, Helm's demo database | Alpine's PostgreSQL 16, which has no pgvector package | exact |
| Your own PostgreSQL server | pgvector if it is installed there (many managed services offer it) | either |

The Compose kit's image is the official `postgres:16` image with pgvector added, on the same
Debian release, so an existing install takes it over at the next `docker compose up -d` with
its data as it is. On your own server, install pgvector and either let a superuser run
`CREATE EXTENSION vector` in Taskmoor's database or let Taskmoor's user do it; then restart
Taskmoor or run `cli.mjs embeddings`.

A backup of a database with pgvector restores only onto a server that has pgvector too.

## The backfill command

The worker embeds what is missing on its own, including everything that was there before an
upgrade. To do it at once and watch it, run the [operator CLI](cli.md#embeddings):

```sh
docker compose exec taskmoor node cli.mjs embeddings
```

It prints progress, then one JSON line per workspace with what it embedded and how many tickets
and comments have an embedding. `--rebuild` deletes every embedding first and makes them all
again.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `TASKMOOR_EMBEDDINGS` | `local` | `local` (the bundled model), `endpoint` (a server of your own, below) or `off` |
| `TASKMOOR_EMBEDDINGS_URL` | none | For `endpoint`: the address of a server with the OpenAI-compatible embeddings API, such as `http://ollama:11434/v1` |
| `TASKMOOR_EMBEDDINGS_MODEL` | none | For `endpoint`: the model it serves |
| `TASKMOOR_EMBEDDINGS_KEY` | none | For `endpoint`, if it needs a key; only ever from the environment |
| `TASKMOOR_EMBEDDINGS_DIMENSIONS` | from the first answer | For `endpoint`: the length of its embeddings, so the index can be built at start |
| `TASKMOOR_VECTOR_SEARCH` | `auto` | `exact` never uses pgvector, even where it is installed |

With `endpoint`, ticket and comment texts are sent to that server: choose one you trust with
them. Changing the model (or switching between `local` and `endpoint`) makes every embedding
out of date; the worker makes them again with the new model on its first start.

With `off`, the server embeds nothing and the similar-ticket operations answer an empty list.
