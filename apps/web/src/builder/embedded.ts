import { fromBase64url, type WebFiles, webBuildVersion } from '@taskmoor/builder-core';
import { DEV_VERSION } from '@taskmoor/webconfig';
import { WEB_BUILD_ELEMENT_ID, WEB_BUILD_FORMAT } from './web-build-format';

/**
 * The web build the Builder page carries (M1-112, ADR-088). The page's build writes the
 * frontend build it was made with into a data block of the page itself, so the page needs no
 * other file and fetches nothing: a JSON object of file paths to their bytes in base64url.
 * The data block is not a script and never runs; the content security policy allows nothing
 * to load.
 */
export { WEB_BUILD_ELEMENT_ID, WEB_BUILD_FORMAT };

export interface EmbeddedWebBuild {
  format: typeof WEB_BUILD_FORMAT;
  files: Record<string, string>;
}

export interface CarriedBuild {
  web: WebFiles;
  /** The version the build was stamped with: the kits are for that version. */
  version: string;
}

/** The web build from the data block's text; null when it is missing or not one. */
export function decodeWebBuild(text: string): CarriedBuild | null {
  let parsed: EmbeddedWebBuild;
  try {
    parsed = JSON.parse(text) as EmbeddedWebBuild;
  } catch {
    return null;
  }
  if (parsed?.format !== WEB_BUILD_FORMAT || typeof parsed.files !== 'object') return null;
  const web: WebFiles = Object.fromEntries(
    Object.entries(parsed.files).map(([path, data]) => [path, fromBase64url(data)]),
  );
  if (!web['index.html']) return null;
  return { web, version: webBuildVersion(web) ?? DEV_VERSION };
}

/** The build in this page, read once at start. */
export function carriedBuild(doc: Document = document): CarriedBuild | null {
  const element = doc.getElementById(WEB_BUILD_ELEMENT_ID);
  return element ? decodeWebBuild(element.textContent ?? '') : null;
}
