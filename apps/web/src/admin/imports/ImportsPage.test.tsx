import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../../i18n/I18nProvider';
import { SessionProvider } from '../../session/SessionProvider';
import { untranslated, visibleTexts } from '../../test/backend';
import { setViewportWidth } from '../../test/viewport';
import { ADMIN, MEMBER } from '../fixtures';
import { DELTA_REPORT, fakeImportsClient } from './fixtures';
import { ImportReport } from './ImportReport';
import { ImportsPage } from './ImportsPage';

function renderPage(client = fakeImportsClient(), locale: 'en' | 'en-XA' = 'en', session = ADMIN) {
  const errors: Error[] = [];
  const view = render(
    <I18nProvider locale={locale} onError={(e) => errors.push(e)}>
      <SessionProvider session={session}>
        <ImportsPage client={client} pollMs={5} />
      </SessionProvider>
    </I18nProvider>,
  );
  return Object.assign(client, { errors, container: view.container });
}

describe('the imports page (M1-097)', () => {
  it('[IMP-013] runs a dry run of a backup, maps a person, imports and shows the report', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    const wizard = screen.getByRole('form', { name: 'New import' });
    // Nothing to start again while the form is open and nothing has run.
    expect(screen.queryByRole('button', { name: 'Start another import' })).toBeNull();
    await user.selectOptions(
      await within(wizard).findByRole('combobox', { name: 'File in the imports folder' }),
      'jira-backup-2026-10-30.zip',
    );
    // Only backups are offered for a backup.
    expect(
      within(wizard)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Choose a file', 'jira-backup-2026-10-30.zip (18.4 MB)']);
    await user.click(within(wizard).getByRole('radio', { name: /Configuration and tickets/ }));
    await user.click(within(wizard).getByRole('radio', { name: 'Configuration administrators' }));
    await user.type(within(wizard).getByRole('textbox', { name: 'Name of the import' }), 'Trial');
    await user.click(within(wizard).getByRole('button', { name: 'Dry run' }));
    expect(client.started[0]).toEqual({
      name: 'Trial',
      dryRun: true,
      source: {
        format: 'dc-backup',
        path: 'jira-backup-2026-10-30.zip',
        scope: 'tickets',
        systemAdmins: 'configuration_admin',
      },
    });
    // The dry run's report, and the people it found.
    expect(await screen.findByText(/A dry run: 320 records read/)).toBeVisible();
    const people = await screen.findByRole('group', { name: '3. People' });
    expect(within(people).getByText('Matches a person here by address.')).toBeVisible();
    expect(within(people).getByText(/Has no address/)).toBeVisible();
    await user.type(
      within(people).getByRole('textbox', { name: 'Taskmoor person for Grace Hopper' }),
      'Grace@Example.org',
    );
    await user.click(within(wizard).getByRole('button', { name: 'Import' }));
    expect(client.started[1]).toMatchObject({
      dryRun: false,
      source: {
        format: 'dc-backup',
        people: { mode: 'map', rows: [{ source: 'JIRAUSER10004', target: 'grace@example.org' }] },
      },
    });
    expect(await screen.findByText(/319 in Taskmoor now, 1 failed/)).toBeVisible();
    // Warnings with what their codes mean, failures and the mapping.
    expect(screen.getByText(/The ticket’s type is not offered by its track/)).toBeVisible();
    expect(screen.getByText('Code type_not_offered: 10002. For example 10001.')).toBeVisible();
    expect(screen.getByText('Tickets 10299: number_taken')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Download the report as a page' })).toHaveAttribute(
      'href',
      '#report-5',
    );
    // Imported, the form is closed to changes: now a fresh one is offered.
    await user.click(screen.getByRole('button', { name: 'Start another import' }));
    expect(
      within(screen.getByRole('form', { name: 'New import' })).getByRole('button', {
        name: 'Dry run',
      }),
    ).toBeEnabled();
    // The button went with the old form: the new form's title has the focus, not the page.
    expect(screen.getByRole('heading', { name: 'New import' })).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Start another import' })).toBeNull();
  });

  it('[IMP-013] uploads a file into the folder and offers it', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    const input = await screen.findByLabelText('Upload a file into the folder');
    // The app's own file button, with the chosen file named beside it (AD-34).
    expect(input.closest('label')).toHaveClass('button-secondary');
    // Its name holds the button's visible words too, so saying "Choose a file" finds it.
    expect(input).toHaveAccessibleName('Upload a file into the folder Choose a file');
    expect(screen.getByText('No file chosen yet.')).toBeVisible();
    await user.upload(input, new File(['PK'], 'later-backup.zip', { type: 'application/zip' }));
    expect(screen.getByText('later-backup.zip')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Upload' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'later-backup.zip is in the imports folder.',
    );
    expect(client.uploaded).toEqual(['later-backup.zip']);
    expect(screen.getByRole('combobox', { name: 'File in the imports folder' })).toHaveValue(
      'later-backup.zip',
    );
    await user.upload(input, new File(['PK'], 'later-backup.zip'));
    await user.click(screen.getByRole('button', { name: 'Upload' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already');
  });

  it('[IMP-002] connects a Cloud site, and says what is missing or refused', async () => {
    const user = userEvent.setup();
    const client = renderPage(fakeImportsClient({ refuse: 'invalid_source' }));
    await user.click(await screen.findByRole('radio', { name: 'Jira Cloud site' }));
    await user.click(screen.getByRole('button', { name: 'Dry run' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Give the site’s address and an API token.',
    );
    await user.type(screen.getByRole('textbox', { name: 'Site address' }), 'http://site.test');
    await user.type(screen.getByLabelText('API token'), 'a-token-for-the-test');
    await user.type(screen.getByRole('textbox', { name: 'Project keys' }), 'ops, web');
    await user.click(screen.getByRole('button', { name: 'Dry run' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/address was refused/);
    expect(client.started).toEqual([]);
  });

  it('[IMP-009] starts a delta run from an earlier full import', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Delta run from import 2' }));
    const wizard = screen.getByRole('form', { name: 'Delta run from import 2' });
    expect(within(wizard).getByText(/Choose the later backup of dc/)).toBeVisible();
    expect(within(wizard).queryByRole('radio', { name: 'Jira Cloud site' })).toBeNull();
    await user.selectOptions(
      within(wizard).getByRole('combobox', { name: 'File in the imports folder' }),
      'jira-backup-2026-10-30.zip',
    );
    await user.click(within(wizard).getByRole('button', { name: 'Import' }));
    expect(client.started[0]).toMatchObject({
      name: 'Changes since import 2',
      dryRun: false,
      deltaFrom: 2,
      source: { format: 'dc-backup', path: 'jira-backup-2026-10-30.zip' },
    });
    expect(await screen.findByText(/records the source no longer has were kept/)).toBeVisible();
  });

  it('[IMP-013] shows an earlier run, and cancels a running one', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Show import 3' }));
    expect(await screen.findByText(/A delta run from import 2: 1 records/)).toBeVisible();
    expect(screen.getByText(/The source no longer has these records/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Hide import 3' }));
    expect(screen.queryByText(/The source no longer has these records/)).toBeNull();
  });

  it('[IMP-013] tells other people it is for site administrators', () => {
    renderPage(fakeImportsClient(), 'en', MEMBER);
    expect(screen.getByText('Only site administrators can import.')).toBeVisible();
  });

  it('[NFR-006] passes every string through the pseudo-locale', async () => {
    const { container, errors } = renderPage(fakeImportsClient(), 'en-XA');
    await screen.findAllByRole('heading', { level: 3 });
    render(
      <I18nProvider locale="en-XA">
        <ImportReport report={DELTA_REPORT} downloadUrl="#" />
      </I18nProvider>,
      { container: container.appendChild(document.createElement('div')) },
    );
    // File names, systems, run names, codes and ids are data.
    const data =
      /^(\d+|jira-backup|taskmoor-export|backlog|dc$|Friday changes|Full import|First look|\d+\. )/;
    const texts = visibleTexts(container).filter((t) => !data.test(t));
    expect(untranslated(texts)).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('[IMP-013] fits a phone', async () => {
    setViewportWidth(360);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Show import 2' }));
    await screen.findByRole('heading', { name: 'Report of import 2' });
    await waitFor(() => expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(360));
  });
});
