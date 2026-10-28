# ADR-040: Attachment storage: random keys, streamed uploads, signed URLs, a scan hook

- Status: Accepted
- Date: 2026-10-28
- Backlog: M1-016

## Context

CORE-021 asks for uploads by drag, paste and API; previews of images, PDF, video and text;
browsing and downloading ZIP contents; download-all as ZIP; an administrator's maximum file size
(default 1 GB, no fixed ceiling); local or S3-compatible storage; no quota. Its acceptance
criteria: with a 3 GB limit a 2.5 GB file uploads and with a 1 GB limit it is refused with a
clear message; S3 objects are served only through short-lived signed URLs to people who may
browse the ticket; deletion follows the own/all permissions. CORE-022 makes adding and removing
an attachment ticket history, CORE-025 (3) brings attachments back with a restored ticket and
lets the trash purge delete them for good.

ADR-020 sketched the design before any code: one interface in `packages/storage`, local disk by
default, S3 through `@aws-sdk/client-s3`, metadata in Postgres, content addressing with
deduplication per workspace, scanning in M2. Building it showed where the sketch had to change,
and the server's delivery (one esbuild bundle in an image built on the build machine for amd64
and arm64, ADR-021) rules out native modules.

## Decision

**One interface, two stores** (`@taskmoor/storage`): `put` from a stream with a byte limit,
`read` whole or by range, `size`, `delete` (idempotent), `signedUrl` (null for local disk) and
`sweepIncomplete`. Every attachment row records its store (`local` or `s3`), so files stay
readable after a site moves new files to a bucket, as long as both stores are configured.

**Keys are random, never derived from input.** A key is `w<workspace>/<aa>/<bb>/<32 hex>` from 128
random bits; both stores refuse anything else, and the local store also checks that the resolved
path sits under its root. A file name is display text in the database and nothing else. There
is no content addressing and no deduplication: a shared object would need reference counting
for every delete and purge, and deduplication across a workspace tells an uploader whether
someone else already holds a file (a known side channel). The SHA-256 is still measured and
stored, for integrity checks, ETags and a later deduplication if one is ever wanted.

**Uploads stream.** `POST /api/v1/tickets/:id/attachments` takes one file part of
`multipart/form-data`. The part flows through a meter (count, SHA-256, the first 8 KiB for
sniffing) into the store; nothing holds the file. The meter fails the moment the count passes the
workspace's limit, the store removes what it wrote and the answer is 413 `file_too_large` with
the limit; a request whose Content-Length already exceeds it is refused before a byte is read,
and the connection closes so the rest is not uploaded. The limit is per workspace, at least one
byte, with no ceiling (`attachment_setting`, `/api/v1/admin/attachment-settings`). Busboy's own
size limit is set one byte over ours, because it silently truncates a file at its limit (the
plugin's default is 1 MiB). Local disk writes to `.incoming/` on the same file system, flushes,
then renames into place; S3 uses multipart uploads of 8 MiB parts (larger for limits over
70 GB, to stay under 10,000 parts), at most four in memory, aborted on any failure. The SDK
sends checksums only where required, because the trailing CRC checksums newer SDKs add by
default are refused by many S3-compatible stores.

**Nothing is left behind.** `storage_cleanup` lists objects to delete. An upload registers its
key before the first byte (due a day later) and takes it out in the transaction that creates the
attachment; a statement trigger adds the keys of every attachment row that is deleted, whoever
deletes it (a person, the purge of a ticket or a track). A sweep deletes due objects and then
their rows, holding the row's lock: an upload that outlives its day finds its key gone and fails
rather than keep a file the sweep removed. Deleting twice is harmless, a store that is down keeps
its rows for later with backoff. The sweep runs after a person's delete (at once), when a purge
removed attachments (a queued job), hourly in the worker, and every ten minutes in each API
process for the stores it can see. The worker also aborts multipart uploads and removes
`.incoming` files older than a day.

**Serving.** Only files the scan found clean are served. What a file is shown as comes from its
bytes: PNG, JPEG, GIF, WebP and AVIF images, PDF, MP4, WebM, Ogg and QuickTime video, and UTF-8
text may be shown inline (text always as `text/plain; charset=utf-8`, so HTML and SVG show their
source); everything else downloads, under its declared type unless that type could render as a
page (then `application/octet-stream`). Local files stream through the API with RFC 6266
`Content-Disposition` (an ASCII `filename` and the exact `filename*`), `nosniff`, a
`default-src 'none'` CSP that sandboxes everything but PDF (Chrome's viewer does not run
sandboxed), `Cross-Origin-Resource-Policy: same-origin`, ETags and single ranges for video. S3
objects are never streamed for a download: after the browse check the answer is a 302 to a GET
URL presigned for five minutes (`TASKMOOR_S3_URL_TTL`, at most an hour) that names the response's
type and disposition, signed for `TASKMOOR_S3_PUBLIC_ENDPOINT` when browsers reach the store
under another name. Derived views (a text preview's first 256 KiB, ZIP entries, the archive of
all files) are read by the server and streamed through the API, after the same check.

**Scan hook.** A `Scanner` turns a stream into clean or infected. Without one, files are clean
when they arrive. `TASKMOOR_SCAN_CLAMD` plugs in ClamAV's daemon over INSTREAM; new files then
wait as `pending` until the worker has scanned them. An infected file, or one the scanner could
not judge after twelve tries, is never served and leaves an audited `attachment.quarantined`.

**Thumbnails** of PNG and JPEG (400 px, EXIF orientation applied) are made by the worker after the
scan in pure JavaScript (`pngjs`, `jpeg-js`), bounded before decoding (64 MiB of file, 50
megapixels from the header). `sharp` was rejected: libvips is LGPL and allowed, but its native
binaries do not fit a bundle with no `node_modules` built for two architectures on one machine.
GIF, WebP and AVIF get no thumbnail; the browser shows the file itself in the preview.

**ZIP** archives are read by ranges through yauzl with a 1 MiB block cache (a 10,000-entry
listing on S3 takes a few GETs), never extracted to disk. At most 10,000 entries are listed; an
entry streams only when its declared size is within the file size limit, and yauzl stops it where
that size says it ends. Names with absolute paths or `..` are listed as unsafe, and a downloaded
entry is named by its last segment only. Download-all streams a yazl archive (ZIP64 when needed,
names made unique, compressed formats stored), opening each file when the archive reaches it.

**History and events.** Adding and removing are ticket history (`attachment`, the id with the
file name for display) and new ticket versions. Events: `attachment.created` and
`attachment.deleted` (ticket activity), `attachment.quarantined` and
`attachment_settings.updated` (audited).

## Options considered

| Option | For | Against |
|---|---|---|
| Random keys, no deduplication (chosen) | Deletion is one object per row; no cross-user side channel; keys never come from input | Two uploads of one file take twice the space |
| Content addressing with deduplication (ADR-020's sketch) | Saves space on repeated files and on clones | Reference counting on every delete and purge, races between upload and purge, leaks whether a file exists |
| Buffer an upload, then store it | Simple | A 2.5 GB file in memory or a temporary copy; fails CORE-021 (1) on small hosts |
| Stream S3 downloads through the API | One code path; works when browsers cannot reach the bucket | CORE-021 (2) asks for signed URLs; the API carries every byte |
| `sharp` for thumbnails | Fast, every format | Native per-platform binaries the single bundle cannot carry |
| Thumbnails in the browser at upload | No server work | Missing for files from the API and the importer |
| Scan inline during the upload | The verdict is known at once | Uploads wait on the scanner; clamd's stream limit fails large files; retries are harder |

## Consequences

Small installs need nothing new: files sit on the data volume and go into every backup. Larger
ones point the server at a bucket and keep it private. A file of any size uploads in constant
memory: measured 2026-10-28 in the cloud container, a 2.5 GiB upload over HTTP to local disk under
a 3 GiB limit took 24 s with the process's memory 34 MiB above where it started (client and server
in one process), and under a 1 GiB limit the same upload was refused after 1,035 MiB had been sent
(`attachments.large.test.ts`, run with `TASKMOOR_LARGE_UPLOAD=1`).

The S3 store is tested against an in-process fake that checks every Signature Version 4 and the
expiry of presigned URLs; the same tests against MinIO run in CI's storage workflow
(`tools/storage/minio-test.sh`, `s3.live.test.ts`), and any other store can be checked by
pointing that test at it. With local storage under Kubernetes the worker cannot see the app's
volume: the chart turns its local store off, the app pod sweeps its own files, and scanning and
thumbnails need S3 or a shared volume there. Clones (CORE-023 (1)) will copy objects (S3
CopyObject, a file copy) rather than share them. Revisit deduplication only if storage cost
becomes a real complaint, and then per ticket rather than per workspace.
