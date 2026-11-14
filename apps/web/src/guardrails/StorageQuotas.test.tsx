import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { fakeStorageClient, STORAGE } from './fixtures';
import { StorageQuotas } from './StorageQuotas';
import type { StorageSettings } from './storage-client';

const GIB = 1024 ** 3;

function renderSection(settings: StorageSettings = STORAGE, locale: Locale = 'en') {
  const client = fakeStorageClient(settings);
  render(
    <I18nProvider locale={locale}>
      <main>
        <StorageQuotas client={client} />
      </main>
    </I18nProvider>,
  );
  return client;
}

describe('storage quotas on the usage page (M1-118, ASVS 12.1.3)', () => {
  it('[CORE-021] shows what the site and its heaviest uploader hold against the quotas', async () => {
    renderSection();
    expect(await screen.findByText('42 GB of 100 GB, in 1,234 files')).toBeVisible();
    expect(screen.getByText('Most used: 9.5 GB of 10 GB, by Sam Rivera')).toBeVisible();
    expect(
      screen.getByRole('meter', { name: 'The site: 42 percent of its quota used' }),
    ).toBeVisible();
    expect(
      screen.getByRole('meter', { name: 'Sam Rivera: 95 percent of the quota per person used' }),
    ).toBeVisible();
  });

  it('[CORE-021] shows usage alone when no quota is set (the default)', async () => {
    renderSection({ ...STORAGE, workspaceQuota: null, personQuota: null });
    expect(await screen.findByText('42 GB in 1,234 files; no quota')).toBeVisible();
    expect(screen.getByText('Most used: 9.5 GB, by Sam Rivera; no quota')).toBeVisible();
    expect(screen.queryByRole('meter')).toBeNull();
    expect(screen.getByLabelText('Site quota (GiB)')).toHaveValue(null);
  });

  it('[CORE-021] saves quotas in bytes; an empty field takes a quota off; a bad one is refused', async () => {
    const user = userEvent.setup();
    const client = renderSection();
    const form = await screen.findByRole('form', { name: 'Change the storage quotas' });
    const workspace = within(form).getByLabelText('Site quota (GiB)');
    const person = within(form).getByLabelText('Quota per person (GiB)');
    expect(workspace).toHaveValue(100);
    await user.clear(workspace);
    await user.type(workspace, '250');
    await user.clear(person);
    await user.click(within(form).getByRole('button', { name: 'Save the quotas' }));
    expect(await screen.findByText('The storage quotas are saved.')).toBeInTheDocument();
    expect(client.calls).toEqual([{ workspaceQuota: 250 * GIB, personQuota: null }]);
    expect(await screen.findByText('Most used: 9.5 GB, by Sam Rivera; no quota')).toBeVisible();

    await user.clear(workspace);
    await user.type(workspace, '0');
    await user.click(within(form).getByRole('button', { name: 'Save the quotas' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A quota is a size above zero in GiB, or empty for none.',
    );
    expect(client.calls).toHaveLength(1);
  });

  it('fits a small phone', async () => {
    setViewportWidth(375);
    renderSection();
    expect(await screen.findByRole('button', { name: 'Save the quotas' })).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    renderSection(STORAGE, 'en-XA');
    const main = screen.getByRole('main');
    await within(main).findAllByRole('listitem');
    const texts = visibleTexts(main).filter((t) => !t.includes('Sam Rivera'));
    expect(untranslated(texts)).toEqual([]);
  });
});
