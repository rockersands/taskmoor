# ADR-106: Local embeddings on ONNX Runtime WebAssembly, `real[]` vectors and optional pgvector

- Status: Accepted
- Date: 2026-11-01
- Backlog: M1-078

## Context

AI-012 asks for embeddings of tickets and comments (and, from M2, knowledge articles) made by a
bundled local model, kept in PostgreSQL with a vector index and filtered by permissions when
they are read. Its done-when: with no cloud key and no internet, embeddings are computed and
similar-ticket lookups work; a similar-ticket result is never a ticket the person cannot
browse. NFR-011 adds that an install with no AI key keeps duplicate suggestions and similar
tickets (AI-016 builds on them: a likely duplicate within 2 s of typing). NFR-012 keeps AI work
off the path of everything else.

The model is already in the repository: all-MiniLM-L6-v2 in int8 ONNX (23 MB, 384 dimensions,
mean pooling, Apache 2.0; `packages/ai/models/all-MiniLM-L6-v2/SOURCE.md`). What was open:

- **A runtime.** The image is `node:22-alpine` (musl) for amd64 and arm64 and must stay under
  400 MB. `onnxruntime-node` ships glibc binaries only, a 300 MB package, and its install script
  downloads GPU libraries, which an offline build cannot do. `onnxruntime-web` is WebAssembly:
  one 14.8 MB file runs on both architectures and on musl, with no install script.
- **Where the vectors live.** pgvector is in this session's PostgreSQL 16 (0.6.0) and in the
  `pgvector/pgvector` images, but not in the embedded PostgreSQL the tests use on a Mac, not in
  `postgres:16` or `postgres:16.10-alpine` (the Compose kit, the air-gap bundle, Helm's demo
  database), not for Alpine's PostgreSQL 16 (Alpine 3.24 builds pgvector for PostgreSQL 18
  only), and not necessarily on an external or managed server. One schema has to serve both,
  and the upgrade check compares databases with one reviewed schema.

## Decision

**Runtime (`packages/ai/src/embed`).**
- `WordPieceTokenizer`, our own code from the published description of BERT's uncased
  tokenizer: control characters dropped, white space normalised, CJK ideographs split, lower
  case, accents stripped (NFD without combining marks), punctuation and ASCII symbols split,
  greedy longest-match WordPiece with `##` for inner pieces, `[UNK]` for a word with an unknown
  part or over 100 characters, `[CLS]` and `[SEP]` around at most 256 tokens. It gives the
  vocabulary's ids (`hello world` is 101 7592 2088 102).
- `LocalEmbedder` tokenizes on the calling thread and runs the model on a **worker thread**
  (`ort-worker.mjs`, plain JavaScript so it runs from source and bundles as is), so inference
  (about 25 ms for a ticket-sized text, 8 ms for a typed summary) never blocks the event loop.
  The thread mean-pools under the attention mask and scales to unit length. **One text per run**
  by default: the int8 model quantises activations over the whole batch, so a batched text's
  vector shifts slightly with its neighbours; one at a time a text always gets the same bits,
  for 10% less throughput. The thread is unref'd while idle, so an idle CLI exits.
- `EndpointEmbedder` for the optional external endpoint (AI-012 "optionally"): any
  OpenAI-compatible `POST /embeddings` (Ollama, vLLM, a text embeddings server, a cloud API),
  configured only by an operator (`TASKMOOR_EMBEDDINGS=endpoint`, `_URL`, `_MODEL`, `_KEY` from
  the environment only, `_DIMENSIONS`), since texts then leave the server.
- The build (`tools/build/server.mjs`) writes `dist/embed-worker.mjs` (97 KB, the runtime
  inlined), copies the runtime's two files to `dist/ort/` (14.9 MB) and the weights,
  vocabulary, licence and provenance to `dist/models/` (23.3 MB). Nothing else of the 150 MB
  package ships, and nothing is fetched at build, test or run time.

**Storage (migration 0079).** `ticket_embedding` (per ticket: summary, a line break, the
description's text, at most 2,000 characters) and `comment_embedding` (per comment; its ticket
for the filter), each with the model id, the MD5 of the embedded text and the vector as a plain
`real[]`. The text is the SQL function `taskmoor_embedding_text`, so staleness ("another model,
or the text changed") is one SQL condition and an unchanged text is never embedded again.

**Vector search: pgvector when the database has it, exact otherwise.**
- At start (API and worker), `ensureVectorIndex` installs `vector` if the server offers it and
  the role may, and adds partial HNSW indexes over `(embedding::vector(384))` with
  `vector_cosine_ops` (`ticket_embedding_hnsw_384`, `comment_embedding_hnsw_384`, only rows of
  that length). These live **outside the migrations**: the reviewed schema is the same on every
  server, and the upgrade check reports them as extras, which it allows. A refused extension is
  logged and lookups scan exactly; a process re-reads the state once a minute, so an API started
  before the worker installed pgvector catches up.
- With pgvector: `ORDER BY embedding::vector(384) <=> q` under the person's filter, with
  `hnsw.ef_search` raised and, from pgvector 0.8, `hnsw.iterative_scan = relaxed_order`; when
  the index returns fewer than asked (a narrow filter), the same filter is scanned exactly over
  a materialised set.
- Without: the permitted rows are read 2,000 at a time as `array_send(embedding)` and scored
  in the server.
- `TASKMOOR_VECTOR_SEARCH=exact` forces the scan (tests force it to cover that path).

**Permissions.** A lookup's tickets pass `TicketFilter.sql`, the predicate search uses (track
browsing, ticket-level grants, visibility levels, archived tracks); a comment counts only where
`commentReadableSql` lets the person read it. A ticket scores by its own vector or its best
readable comment's; an answer names a matching comment's id, never its text. Trashed tickets
and deleted comments lose their rows, and lookups skip them anyway.

**Indexing.** An event subscriber (`embeddings`) embeds what `ticket.created`, `.updated`,
`.cloned` and `.restored` and the comment events name, and drops rows on `ticket.deleted` and
`comment.deleted`. A sweep job catches up with the rest, five seconds at a time so the job
runner's other jobs keep their turn: once per workspace and model when a worker first runs
with it (an upgrade embeds what was there), after each import (`import_run.finished`: imports
emit no ticket events), and from `node cli.mjs embeddings [--rebuild]`.

**API.** `GET /api/v1/tickets/:id/similar` and `POST /api/v1/tickets/similar` (a text and an
optional track and ticket to leave out, for duplicate suggestions at create time). Both are
reads (the POST is in `READ_ONLY_ROUTES` and exempt from the event contract: it stores
nothing), stable operations `similarTickets` and `similarToText`, answering
`{ model, similar: [{ ticket, score, match, commentId? }] }`.

**Not tied to the AI switch.** Local embeddings do not follow the workspace's AI switch,
strict mode or track switches, and need no key: those govern sending content to a provider,
and the bundled model sends nothing anywhere. AI is off until a provider is set up, so tying
them would remove similar tickets from every install without a key, which NFR-011 forbids.
Operators who want no embedding work at all set `TASKMOOR_EMBEDDINGS=off` (the routes then
answer an empty list with `model: null`, and leftover jobs finish doing nothing).

**Kits.** The Compose kit and the Builder's backend kit move to `pgvector/pgvector:0.8.1-pg16-trixie`:
the official `postgres:16` image with the extension added, on the same Debian release as
today's `postgres:16`, so an existing data volume (and its glibc collations) is taken over as it
is. The tag is pinned (pgvector 0.8.1, PostgreSQL 16.12 when chosen; a minor release of the same
major reads the same data directory either way) and moves with releases, as `TASKMOOR_IMAGE`
does. `POSTGRES_IMAGE=postgres:16` still works, with exact lookups. The all-in-one image and
Helm's demo database stay on Alpine's PostgreSQL 16 with exact lookups: no Alpine package
exists for PostgreSQL 16, and moving an Alpine data directory to a Debian image changes the
collation library under its indexes. Operators of those who need the index at scale point
Taskmoor at a PostgreSQL with pgvector.

**Amended 2026-11-05 (T-023): the air-gap bundle ships the Compose kit's database image.** The
bundle first stayed on Alpine's PostgreSQL 16 too. Since ADR-111 the Compose kit it carries runs
a `postgres-tls` service with `openssl` in the database image, which Alpine's image does not
have, so every offline install stopped there (found by the first run of
`tools/airgap/test-offline.sh` on a Mac). `tools/airgap/bundle.sh` now takes the image the kit's
`docker-compose.yml` names (`pgvector/pgvector:0.8.1-pg16-trixie`), so an offline install runs
the kit exactly as the tested online one does, with pgvector. No bundle had been published, so
no Alpine data directory has to move.

## Options considered

| Option | For | Against |
|---|---|---|
| onnxruntime-web (WebAssembly) on a worker thread (chosen) | One file for amd64, arm64 and musl; no install script; 38 MB in the image with the model | Slower than native: about 40 ticket-sized texts a second per thread |
| onnxruntime-node | Native speed | glibc only (the image is Alpine), 300 MB package, downloads GPU libraries at install |
| Inference on the main thread | Simplest | 25 ms per text blocks every request in the `all` role (NFR-012) |
| `vector` column type chosen at migration | Native type | Two schemas; the schema check and the upgrade tests would differ by server; a later pgvector install needs a data migration |
| `real[]` with an expression HNSW index added at start (chosen) | One schema; pgvector used as soon as it is there; exact scan works anywhere | The index is outside the migrations (an extra in the schema check); `pg_dump` of a pgvector database restores only where pgvector is installed |
| Embeddings follow the workspace AI switch | One switch for "AI" | AI is off without a key, so no similar tickets without a key (NFR-011) |

## Consequences

- Measured on this shared four-CPU machine: 41 ticket-sized texts a second (24.5 ms each) and
  8 ms for one typed summary on one thread; 3,000 tickets: lookup p95 112 ms with pgvector's
  HNSW and 245 ms with the exact scan (both end to end, embedding the typed text included).
  The exact scan grows with what the person may see, about 80 ms per thousand tickets, so it
  stays inside AI-016's 2 s to roughly 20,000 visible tickets; beyond that, use pgvector.
- The image grows by about 38 MB (the model, the runtime and the worker).
- `pg_dump` of a database with pgvector carries the extension and the two indexes: restoring
  it needs pgvector on the target. Restoring onto a server without it fails on those objects
  only; `cli.mjs embeddings` sets things up again where pgvector is present.
- A change of model (or a switch to an endpoint) makes every row stale: the worker's first run
  with the new model sweeps them, or `cli.mjs embeddings --rebuild` does it at once. Rows of
  another length stay out of the HNSW index until rewritten.
- Knowledge articles (M2) add a table of the same shape and a source for the sweep; semantic
  search (AI-021, M2) and model re-ranking of duplicates (AI-016 with a provider, M1-079) read
  the same lookups.
- Revisit when pgvector ships for Alpine's PostgreSQL 16 (the all-in-one image could then
  index), or when the throughput limits the backfill of large imports (a pool of inference
  threads, or larger batches at the cost of bit-exact vectors).
