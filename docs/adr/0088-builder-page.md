# ADR-088: The Builder page as a second entry of the web app, built into one offline file

- Status: Accepted
- Date: 2026-10-31
- Backlog: M1-112

## Context

ADR-031 decided on one Builder core with two faces: a static page that runs entirely in the
browser and the CLI. Both must give byte-identical kits from the same project file and seed
(OPS-016 (2)), and a network capture of a page run must show no outbound request (OPS-016 (1)).
M1-109 to M1-111 built the core (`packages/builder-core`) and the CLI (`pnpm builder`). This
decision covers the page.

The page has three needs that the app does not have:

- The frontend kit is the web build with its settings filled in. The page needs that build's
  files, and fetching them would be a network call. Opened from `file://`, the page cannot
  fetch anything at all.
- People should be able to keep the page and open it later without a server, for example from
  a USB stick on an air-gapped machine. So it should be one file.
- The page must not be part of the web build it carries. Otherwise the frontend kit would hold
  the Builder, and the Builder would hold itself.

ADR-031 named an `apps/builder` package. A separate app would need its own catalogue, Storybook,
axe run, i18n check and component test setup, all of which `apps/web` already has.

## Decision

- **Where it lives.** The page is a second entry of the web app:
  - code in `apps/web/src/builder/`;
  - its own HTML entry (`src/builder/index.html`) and Vite config (`vite.builder.config.ts`);
  - its own output folder, `apps/web/dist-builder/`.

  The page reuses the app's catalogue (`builder.*` IDs in English and Spanish), its design
  tokens and form styles, and its `PasswordField`. So the i18n check, the pseudo-locales,
  the stories with axe (light and dark) and the jsdom tests cover it with no new setup. The
  app's own build does not include it.
- **One file.** A Vite plugin (`apps/web/build/builder-page.ts`) rewrites the built
  `index.html`:
  - The script and the stylesheet go inline. `</script>` and `</style>` are escaped, and the
    build options inline every other asset as a data URL.
  - The plugin then deletes every other output file. It refuses a page that still names a
    file.
  - The web build to carry (`apps/web/dist`, or `TASKMOOR_BUILDER_WEB`) goes into a JSON data
    block, `<script id="taskmoor-web-build" type="application/json">`, with each file's
    bytes in base64url.

  The page decodes that block at start. The kits are for the version stamped in the carried
  build's `version.json`.
- **No network, enforced.** The page carries a content security policy in a meta element:
  - `default-src 'none'` and `connect-src 'none'`;
  - `script-src` and `style-src` allow only its own inline blocks, by their SHA-256;
  - images from `data:` and `blob:` only;
  - `form-action 'none'`, `base-uri 'none'` and `object-src 'none'`.

  Even a dependency that tried to send something could not. Downloads are Blob URLs on links
  with `download`, which this policy does not block.
- **One code path.** `builder-core/src/run.ts` holds the whole run, with no file system and no
  network:
  - `kitOutputs` makes the three files (backend zip, frontend zip, single file) from inputs,
    secrets and a web build;
  - `kitOutputsFromProject` does the same from a project file's text;
  - `runSecrets` picks the secrets: kept ones, else from the seed, else from the platform.

  The CLI (`runBuilder`) reads the build from disk, calls `kitOutputsFromProject` and writes
  the files. The page calls `kitOutputs` with the same rule for secrets. The CLI's
  `--version` now defaults to the web build's own `version.json`, as the page does. Before,
  it took `TASKMOOR_VERSION`, which remains the fallback.
- **Secrets on the page.** The page keeps the secrets of its first run for the rest of the
  session. Running it again after a change of settings keeps the same instance. Secrets that a
  project loads with its passphrase replace them. Changing the seed starts a new set.
  - Saving with a passphrase writes the secrets into the project file, encrypted. This is
    the CLI's `--passphrase-env` format.
  - Saving with no passphrase writes the settings only.
  - Loading a project that keeps secrets without its passphrase loads the settings and says
    so. The next kits then get new secrets.
- **Build.** `pnpm build` runs the web build, then `pnpm --filter @taskmoor/web build:builder`,
  then the server bundle. The image's Dockerfile does not build the page. Publishing it with
  a release is for the release task.

## Options considered

| Option | For | Against |
|---|---|---|
| A second entry of `apps/web`, built into one file (chosen) | Reuses the catalogue, stories, axe, i18n check and test setup; one file works offline and from `file://` | The app's package gains a second Vite config; the page is about 4 MB |
| A separate `apps/builder` package (ADR-031's name) | Clear boundary | Duplicates the i18n, Storybook and test setup, or reaches into `apps/web` for them |
| A route inside the main app (`#/builder`) | No new build | Needs a host to serve the app; the frontend kit would carry the Builder; the app's CSP allows calls to its backend |
| The page fetches the web build from beside it | A smaller HTML file | A network call, which `file://` forbids and OPS-016 (1) rules out |

## Consequences

- The page is about 4.0 MB: the carried web build is 2.3 MB, or 3.2 MB in base64url, and the
  page's own script is 0.8 MB. Making the kits takes about 0.3 s in Chromium.
- `apps/web/build/builder-page.test.ts` builds the page from a miniature web build. It checks
  that the output is one file that names no other, that the policy allows only the inline
  script's hash, and that the carried build matches byte for byte. It also checks that the
  page's own path (decoding the data block, then `generateKits`) gives the same bytes as
  `runBuilder` for one project file and seed.
- `e2e/builder-page.spec.ts` serves the real page alone on port 4183. It refuses every request
  that does not come from that origin and takes the browser offline once the page has loaded.
  Then it checks two runs on a desktop and on a phone:
  - a project file with a seed, compared by SHA-256 with `pnpm builder --seed`;
  - a filled form saved with a passphrase, loaded again and rebuilt, compared with the first
    run and with `pnpm builder --passphrase-env`.

  It finds no request beyond the page itself, no policy error, no sideways scrolling and
  44 px targets on the phone.
- The page has no control for branding. No kit uses the accent colour yet, so offering it
  would promise a change that does not happen. A loaded project keeps its colour. Logo,
  favicon and colours, and OPS-016 (3) (a rebrand changes only branding files), wait for
  branding in the kits.
- The page's language comes from `?locale=` or the browser, as in the app. It has no picker of
  its own.
