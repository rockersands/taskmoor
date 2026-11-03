import type { Database } from '@taskmoor/db';
import { compareReleases, parseRelease } from '@taskmoor/webconfig';
import type { Kysely } from 'kysely';
import { enqueue, type JobRunner } from '../events/queue';
import { readSetting, writeSetting } from '../setup';
import { defaultWorkspaceId } from '../workspace';

/**
 * The new-version notice (OPS-026, ADR-117). The worker asks the project's public releases for
 * the newest version at most once a day and stores the answer; site administrators read it
 * through `GET /api/v1/admin/update-check`, and nobody else ever sees it.
 *
 * - The request goes through the outbound guard (ADR-110) and says nothing about the install:
 *   no version, no instance id, no query string, no cookie, a plain user agent.
 * - A failed check is quiet: no error, no warning, no notice. It only records when it tried, so
 *   the next try comes a day later. Air-gapped installs turn the check off, and an install with
 *   no route out only ever fails quietly.
 * - It depends on no service the project runs: GitHub's public releases, and a fork can change
 *   the address in this file. A development build asks nothing, having no version to compare.
 *
 * The answer is treated as untrusted text: only a plain x.y.z version is kept, and the command
 * and the link are built from that version here, never taken from the answer.
 */
type Db = Kysely<Database>;

export const RELEASES_URL = 'https://api.github.com/repos/Rockersands/taskmoor/releases/latest';
export const RELEASE_PAGE = 'https://github.com/Rockersands/taskmoor/releases/tag';
export const UPDATE_TASK = 'update_check';
/** The site administrator's switch, `{ enabled: boolean }`; on until they turn it off. */
export const UPDATE_SETTING_KEY = 'update_check';
const UPDATE_RESULT_KEY = 'update_check_result';
/** What the kits run; `{version}` becomes the new version. TASKMOOR_UPDATE_COMMAND replaces it. */
export const DEFAULT_UPDATE_COMMAND = 'bash update.sh {version}';
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 15_000;
const MAX_ANSWER_BYTES = 2 * 1024 * 1024;
const PLAIN_RELEASE = /^v?(\d{1,6}\.\d{1,6}\.\d{1,6})$/;

/** The newest published version, or null when none is published; throws when it cannot tell. */
export type ReleaseSource = () => Promise<string | null>;

export interface UpdateCheckConfig {
  /** This backend's version. */
  version: string;
  /** TASKMOOR_UPDATE_CHECK=off: no request is made, and the setting cannot turn it back on. */
  environmentOff: boolean;
  /** TASKMOOR_UPDATE_COMMAND, for a kit that updates some other way. */
  command?: string | undefined;
}

interface StoredResult {
  /** When the last request was made, however it went. */
  attemptedAt: string;
  /** When the last request succeeded; null until one has. */
  checkedAt: string | null;
  latest: string | null;
}

/** What the administrators' page and notice read. */
export interface UpdateStatus {
  version: string;
  /** The site administrator's setting. */
  enabled: boolean;
  /** TASKMOOR_UPDATE_CHECK=off overrules the setting. */
  environmentOff: boolean;
  /** A development build compares with nothing and asks nothing. */
  developmentBuild: boolean;
  checkedAt: string | null;
  latest: string | null;
  updateAvailable: boolean;
  /** The exact command, once there is something to update to. */
  command: string | null;
  releaseUrl: string | null;
}

/** A released backend: x.y.z without a prerelease. */
function releaseOf(version: string) {
  const release = parseRelease(version);
  return release && release.prerelease === '' ? release : null;
}

/** Reads an answer up to a limit; the source is on the other side of the internet. */
async function boundedText(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error('the release answer is too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The project's public releases on GitHub, through the given `fetch` (the outbound guard). */
export function githubReleases(fetchFn: typeof fetch, url = RELEASES_URL): ReleaseSource {
  return async () => {
    const response = await fetchFn(url, {
      method: 'GET',
      // A renamed repository answers with a redirect; the guard checks each hop.
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // GitHub refuses a request without a user agent; this one names the product and no more.
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'taskmoor' },
    });
    // No published release yet (or a private repository): nothing to tell, and nothing wrong.
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`the release source answered ${response.status}`);
    const answer = JSON.parse(await boundedText(response, MAX_ANSWER_BYTES)) as {
      tag_name?: unknown;
      draft?: unknown;
      prerelease?: unknown;
    };
    if (answer.draft === true || answer.prerelease === true) return null;
    if (typeof answer.tag_name !== 'string') throw new Error('the release answer has no tag');
    const version = PLAIN_RELEASE.exec(answer.tag_name)?.[1];
    if (!version) throw new Error('the release tag is not a plain version');
    return version;
  };
}

/** The site administrator's setting: on unless they turned it off. */
export async function updateCheckEnabled(db: Db): Promise<boolean> {
  return (await readSetting<{ enabled?: boolean }>(db, UPDATE_SETTING_KEY))?.enabled !== false;
}

export const setUpdateCheckEnabled = (db: Db, enabled: boolean) =>
  writeSetting(db, UPDATE_SETTING_KEY, { enabled });

/** Whether this process may ask at all, by what it was started with. */
const mayAsk = (config: UpdateCheckConfig) =>
  !config.environmentOff && releaseOf(config.version) !== null;

export async function updateStatus(db: Db, config: UpdateCheckConfig): Promise<UpdateStatus> {
  const [enabled, stored] = await Promise.all([
    updateCheckEnabled(db),
    readSetting<StoredResult>(db, UPDATE_RESULT_KEY),
  ]);
  const current = releaseOf(config.version);
  const developmentBuild = current === null;
  // Switched off, nothing is shown, whatever an earlier check stored.
  const shown = enabled && !config.environmentOff && !developmentBuild;
  const latest = shown ? (stored?.latest ?? null) : null;
  const newest = latest ? releaseOf(latest) : null;
  const updateAvailable =
    current !== null && newest !== null && compareReleases(newest, current) > 0;
  const template = config.command ?? DEFAULT_UPDATE_COMMAND;
  return {
    version: config.version,
    enabled,
    environmentOff: config.environmentOff,
    developmentBuild,
    checkedAt: shown ? (stored?.checkedAt ?? null) : null,
    latest,
    updateAvailable,
    command: updateAvailable && latest ? template.replaceAll('{version}', latest) : null,
    releaseUrl: updateAvailable && latest ? `${RELEASE_PAGE}/v${latest}` : null,
  };
}

/**
 * One check: asks the source and stores the answer. It never throws for the source's sake: a
 * failure keeps the last answer, records the attempt and says so only at debug level.
 */
export async function runUpdateCheck(
  db: Db,
  source: ReleaseSource,
  config: UpdateCheckConfig,
  options: { now?: Date; debug?: (message: string) => void } = {},
): Promise<'checked' | 'failed' | 'off'> {
  if (!mayAsk(config) || !(await updateCheckEnabled(db))) return 'off';
  const now = (options.now ?? new Date()).toISOString();
  const stored = await readSetting<StoredResult>(db, UPDATE_RESULT_KEY);
  try {
    const latest = await source();
    await writeSetting(db, UPDATE_RESULT_KEY, {
      attemptedAt: now,
      checkedAt: now,
      latest,
    } satisfies StoredResult);
    return 'checked';
  } catch (error) {
    options.debug?.(`new-version check failed: ${(error as Error).message}`);
    await writeSetting(db, UPDATE_RESULT_KEY, {
      attemptedAt: now,
      checkedAt: stored?.checkedAt ?? null,
      latest: stored?.latest ?? null,
    } satisfies StoredResult);
    return 'failed';
  }
}

/**
 * Queues the check when a day has passed since the last attempt. Keyed by the date, so several
 * workers queue one; the attempt's time keeps two checks from falling either side of midnight.
 */
export async function scheduleUpdateCheck(
  db: Kysely<Database>,
  config: UpdateCheckConfig,
  now = new Date(),
): Promise<number> {
  if (!mayAsk(config) || !(await updateCheckEnabled(db))) return 0;
  const stored = await readSetting<StoredResult>(db, UPDATE_RESULT_KEY);
  if (stored && now.getTime() - Date.parse(stored.attemptedAt) < CHECK_INTERVAL_MS) return 0;
  return enqueue(db, [
    {
      workspaceId: await defaultWorkspaceId(db),
      task: UPDATE_TASK,
      key: `${UPDATE_TASK}:${now.toISOString().slice(0, 10)}`,
      // Tomorrow's check is the retry: a queue's backoff would ask again within the day.
      maxAttempts: 1,
    },
  ]);
}

/**
 * The frontends an update does not reach (OPS-025): every registered or listed origin other than
 * the backend's own. `update.sh` asks through `node cli.mjs frontends`.
 */
export async function otherFrontends(
  db: Db,
  publicUrl: string,
  environment: readonly string[],
): Promise<string[]> {
  const own = new URL(publicUrl).origin;
  const rows = await db.selectFrom('frontend_origin').select('origin').execute();
  return [...new Set([...environment, ...rows.map((row) => row.origin)])]
    .filter((origin) => origin !== own)
    .sort();
}

export function registerUpdateCheckJobs(
  runner: JobRunner,
  db: Kysely<Database>,
  source: ReleaseSource,
  config: UpdateCheckConfig,
  debug?: (message: string) => void,
): void {
  runner.handle(UPDATE_TASK, async () => {
    await runUpdateCheck(db, source, config, debug ? { debug } : {});
  });
}
