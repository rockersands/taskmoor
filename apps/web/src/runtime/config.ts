import { CONFIG_ELEMENT_ID, parseSlotText, type RuntimeConfig } from '@taskmoor/webconfig';

/**
 * The page's public runtime configuration (M1-105, ADR-066), read once from the slot in
 * index.html before the app renders. A page without the slot (tests, Storybook) runs on the
 * defaults; a value that does not check out is left at its default with a console warning.
 */
export function readRuntimeConfig(doc: Pick<Document, 'getElementById'> = document): RuntimeConfig {
  const { config, problems } = parseSlotText(
    doc.getElementById(CONFIG_ELEMENT_ID)?.textContent ?? '',
  );
  for (const problem of problems) console.warn(`Taskmoor configuration: ${problem}`);
  return config;
}

export const runtimeConfig: RuntimeConfig = readRuntimeConfig();
