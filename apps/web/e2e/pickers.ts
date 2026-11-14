import type { Locator, Page } from '@playwright/test';

/**
 * Chooses a track in a Track picker (T-255): the create form's and the clone dialog's are icon
 * selects, a combobox named Track whose options read "KEY Name" (or "KEY: Name" in the clone
 * dialog). `scope` is the page or the dialog that holds it.
 */
export async function chooseTrack(scope: Page | Locator, key: string): Promise<void> {
  const box = scope.getByRole('combobox', { name: 'Track', exact: true });
  await box.click();
  await scope.getByRole('option', { name: new RegExp(`^${key}:? `) }).click();
}
