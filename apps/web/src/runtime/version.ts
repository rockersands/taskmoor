declare const __TASKMOOR_WEB_VERSION__: string | undefined;

/**
 * This frontend's version (M1-106), stamped by the build from TASKMOOR_VERSION as in
 * version.json; the development version where nothing stamped it (tests, Storybook).
 */
export const WEB_VERSION: string =
  typeof __TASKMOOR_WEB_VERSION__ === 'string' ? __TASKMOOR_WEB_VERSION__ : '0.0.0-dev';
