import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { DownloadMenu } from './DownloadMenu';

const src = join(import.meta.dirname, '..');

describe('the download menu (PLN-014)', () => {
  it('[PLN-014] keeps its status line where a screen reader listens, even with nothing to say', () => {
    // A rule like this takes the line out of the tree while it is empty, so its first words make it
    // appear rather than change, which is not reliably read out. jsdom loads no CSS: read from disk.
    const css = readFileSync(join(src, 'styles/plans.css'), 'utf8');
    expect(css).not.toMatch(/\.plan-download-note:empty\s*\{[^}]*display:\s*none/);
  });

  it('[PLN-014] says it again when the same file is downloaded again, so it is read out again', async () => {
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en">
        <DownloadMenu items={[{ key: 'csv', label: 'CSV', href: '#file' }]} />
      </I18nProvider>,
    );
    const status = screen.getByRole('status');
    expect(status).toBeEmptyDOMElement();
    const fetchIt = async () => {
      await user.click(screen.getByRole('button', { name: 'Download' }));
      await user.click(await screen.findByRole('menuitem', { name: 'CSV' }));
    };
    await fetchIt();
    const first = status.textContent;
    expect(first).toMatch(/CSV/);
    await fetchIt();
    expect(status.textContent).not.toBe(first);
    expect(status.textContent?.trim()).toBe(first);
    expect(screen.getByRole('status')).toBe(status);
  });
});
