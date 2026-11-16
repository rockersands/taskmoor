import type { CsvSeparator } from '@taskmoor/webconfig';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { I18nProvider } from '../i18n/I18nProvider';
import { SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import type { AccountPreferences } from './client';
import { CsvStyleProvider, useCsvSeparator } from './csvStyle';
import { fakeAccountClient, KALO } from './fixtures';
import { ProfileSection } from './ProfileSection';

/** What the export links would use, shown beside the section. */
function Style() {
  return <output aria-label="CSV style">{useCsvSeparator()}</output>;
}

function renderSection(
  options: {
    preferences?: AccountPreferences;
    saved?: Partial<AccountPreferences>[];
    failSave?: boolean;
    locale?: 'en' | 'en-XA';
  } = {},
) {
  const saved = options.saved ?? [];
  const base = fakeAccountClient(
    {},
    { preferences: options.preferences ?? { autoFollow: true, csvSeparator: null } },
  );
  const client = {
    ...base,
    updatePreferences: async (changes: Partial<AccountPreferences>) => {
      saved.push(changes);
      if (options.failSave) throw new ApiError(500, { error: 'internal' });
      return base.updatePreferences(changes);
    },
  };
  const read = async (): Promise<CsvSeparator | null> => (await base.preferences()).csvSeparator;
  render(
    <I18nProvider locale={options.locale ?? 'en'}>
      <SessionProvider session={{ status: 'signed-in', user: KALO }}>
        <CsvStyleProvider read={read}>
          <ProfileSection user={KALO} client={client} />
          <Style />
        </CsvStyleProvider>
      </SessionProvider>
    </I18nProvider>,
  );
  // The profile's section, by its role: its name is bracketed in the pseudo-locale.
  return { saved, section: within(screen.getAllByRole('region')[0] as HTMLElement) };
}

describe('the spreadsheet files setting on Profile (T-263)', () => {
  it('[IAM-008] [NFR-006] sits beside Language and region, Automatic until chosen, with its three choices', async () => {
    const { section } = renderSection();
    const select = section.getByRole('combobox', { name: 'Spreadsheet files (CSV)' });
    expect(select).toHaveValue('');
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Automatic', 'Commas, numbers as 1.5', 'Semicolons, numbers as 1,5']);
    expect(select).toHaveAccessibleDescription(/Automatic follows your language and region/);
    // Right after Language and region in the form.
    const fields = section.getAllByRole('combobox').map((c) => c.getAttribute('id') ?? '');
    const locale = section.getByRole('combobox', { name: 'Language and region' });
    expect(fields.indexOf(select.id)).toBe(fields.indexOf(locale.id) + 1);
  });

  it('[IAM-008] [NFR-006] shows the saved choice and saves a new one with the profile, which every CSV control follows at once', async () => {
    const user = userEvent.setup();
    const { section, saved } = renderSection({
      preferences: { autoFollow: true, csvSeparator: 'comma' },
    });
    const select = section.getByRole('combobox', { name: 'Spreadsheet files (CSV)' });
    await expect.poll(() => (select as HTMLSelectElement).value).toBe('comma');
    expect(screen.getByRole('status', { name: 'CSV style' })).toHaveTextContent('comma');
    await user.selectOptions(select, 'Semicolons, numbers as 1,5');
    await user.click(section.getByRole('button', { name: 'Save profile' }));
    expect(await section.findByText('Profile saved.')).toBeVisible();
    expect(saved).toEqual([{ csvSeparator: 'semicolon' }]);
    expect(screen.getByRole('status', { name: 'CSV style' })).toHaveTextContent('semicolon');
    // Back to Automatic sends null; saving again unchanged sends nothing more.
    await user.selectOptions(select, 'Automatic');
    await user.click(section.getByRole('button', { name: 'Save profile' }));
    await expect.poll(() => saved.length).toBe(2);
    expect(saved[1]).toEqual({ csvSeparator: null });
    await user.click(section.getByRole('button', { name: 'Save profile' }));
    expect(await section.findByText('Profile saved.')).toBeVisible();
    expect(saved).toHaveLength(2);
  });

  it('[IAM-008] leaves the setting alone when only the rest of the profile changes', async () => {
    const user = userEvent.setup();
    const { section, saved } = renderSection();
    await user.selectOptions(section.getByRole('combobox', { name: 'Time zone' }), 'Europe/Madrid');
    await user.click(section.getByRole('button', { name: 'Save profile' }));
    expect(await section.findByText('Profile saved.')).toBeVisible();
    expect(saved).toEqual([]);
  });

  it('[IAM-008] says so when the choice cannot be saved', async () => {
    const user = userEvent.setup();
    const { section } = renderSection({ failSave: true });
    await user.selectOptions(
      section.getByRole('combobox', { name: 'Spreadsheet files (CSV)' }),
      'Commas, numbers as 1.5',
    );
    await user.click(section.getByRole('button', { name: 'Save profile' }));
    expect(await section.findByRole('alert')).toHaveTextContent('The profile could not be saved.');
  });

  it('[NFR-006] puts every word of the setting through the catalogue', async () => {
    renderSection({ locale: 'en-XA' });
    const region = screen.getAllByRole('region')[0] as HTMLElement;
    expect(untranslated(visibleTexts(region))).toEqual([]);
  });
});
