import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../../i18n/I18nProvider';
import type { Locale } from '../../i18n/locale';
import { untranslated, visibleTexts } from '../../test/backend';
import { setViewportWidth } from '../../test/viewport';
import { bodyOf, draftOf } from './draft';
import {
  EVERY_TRACK_OPTIONS,
  fakeTemplateClient,
  INCIDENT_TEMPLATE,
  RELEASE_TEMPLATE,
  TEMPLATE_OPTIONS,
} from './fixtures';
import { TicketTemplatesPage } from './TicketTemplatesPage';

function renderPage(
  client = fakeTemplateClient(),
  { trackKey = 'SHOP' as string | null, locale = 'en' as Locale } = {},
) {
  render(
    <I18nProvider locale={locale}>
      <main>
        <TicketTemplatesPage client={client} {...(trackKey ? { trackKey } : {})} />
      </main>
    </I18nProvider>,
  );
  return client;
}

describe('ticket templates page (CORE-029)', () => {
  it('[CORE-029] lists a track’s templates and those for every track, which it only reads', async () => {
    renderPage();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Ticket templates' }),
    ).toBeVisible();
    const own = screen.getByText('Release checklist').closest('li') as HTMLElement;
    expect(within(own).getByText('Everything a release needs')).toBeVisible();
    expect(within(own).getByText('Bug')).toBeVisible();
    expect(within(own).getByText('2 subtickets')).toBeVisible();
    expect(
      within(own).getByRole('button', { name: 'Edit template Release checklist' }),
    ).toBeVisible();
    const shared = screen.getByText('Incident report').closest('li') as HTMLElement;
    expect(within(shared).getByText('Every track')).toBeVisible();
    expect(within(shared).getByText('Every ticket type')).toBeVisible();
    expect(within(shared).queryByRole('button')).toBeNull();
  });

  it('[CORE-029] titles a track’s templates like its other pages, the track above and no way back that repeats a tab (TR-27, D7, D26)', async () => {
    renderPage();
    const heading = await screen.findByRole('heading', { level: 1, name: 'Ticket templates' });
    const header = heading.closest('header') as HTMLElement;
    expect(within(header).getByText('Shop')).toBeVisible();
    expect(
      within(header).getByText(
        'Templates offered when a ticket is created in this track, those for every track included.',
      ),
    ).toBeVisible();
    expect(within(header).queryByRole('link')).toBeNull();
  });

  it('[CORE-029] (1) shows those who may not change them no way to', async () => {
    renderPage(fakeTemplateClient([{ ...RELEASE_TEMPLATE, mayEdit: false }], { mayCreate: false }));
    expect(
      await screen.findByText('Only the administrators of this track can change its templates.'),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'New template' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Edit template/ })).toBeNull();
  });

  it('[CORE-029] adds a template with its pattern, values and subtickets', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'New template' }));
    const form = screen.getByRole('form', { name: 'New template' });
    await user.type(within(form).getByRole('textbox', { name: 'Name' }), 'Bug report');
    await user.type(within(form).getByRole('textbox', { name: 'What it is for' }), 'For bugs');
    await user.click(within(form).getByRole('checkbox', { name: 'Bug' }));
    await user.type(within(form).getByRole('textbox', { name: 'Summary' }), 'Bug on ');
    await user.selectOptions(within(form).getByRole('combobox', { name: 'Priority' }), 'High');
    await user.type(within(form).getByRole('textbox', { name: 'Labels' }), 'bug triage');
    await user.type(
      within(form).getByRole('spinbutton', { name: 'Due date, in days from today' }),
      '3',
    );
    await user.type(within(form).getByRole('searchbox', { name: 'Assignee' }), 'sam');
    await user.click(await within(form).findByRole('button', { name: 'Sam Rivera' }));
    await user.selectOptions(
      within(form).getByRole('combobox', { name: 'Add a value for a field' }),
      'Severity',
    );
    await user.click(within(form).getByRole('button', { name: 'Add the field' }));
    const severity = within(form).getByRole('combobox', { name: 'Severity' });
    await within(severity).findByRole('option', { name: 'Blocker' });
    await user.selectOptions(severity, 'Blocker');
    await user.click(within(form).getByRole('button', { name: 'Add a subticket' }));
    await user.type(
      within(form).getByRole('textbox', { name: 'Subticket 1: summary' }),
      'Reproduce it',
    );
    await user.selectOptions(
      within(form).getByRole('combobox', { name: 'Subticket 1: type' }),
      'Checklist item',
    );
    await user.click(within(form).getByRole('button', { name: 'Save the template' }));
    expect(await screen.findByText('Template Bug report was saved.')).toBeInTheDocument();
    expect(client.saved[0]?.body).toMatchObject({
      track: 'SHOP',
      name: 'Bug report',
      purpose: 'For bugs',
      ticketTypeIds: [3],
      summary: 'Bug on ',
      defaults: {
        priorityId: 1,
        labels: ['bug', 'triage'],
        dueInDays: 3,
        assigneeId: 21,
        fields: { '7': 70 },
      },
      subtickets: [{ summary: 'Reproduce it', ticketTypeId: 6 }],
    });
    expect(screen.queryByRole('form', { name: 'New template' })).toBeNull();
    expect(screen.getByText('Bug report')).toBeVisible();
    // The form closed with the focus in it: the New button has it back (D11).
    expect(screen.getByRole('button', { name: 'New template' })).toHaveFocus();
  });

  it('[CORE-029] says why a name is refused and keeps the form', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'New template' }));
    const form = screen.getByRole('form', { name: 'New template' });
    expect(within(form).getByRole('button', { name: 'Save the template' })).toBeDisabled();
    await user.type(within(form).getByRole('textbox', { name: 'Name' }), 'Incident report');
    await user.click(within(form).getByRole('button', { name: 'Save the template' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'Another template here already has that name.',
    );
  });

  it('[CORE-029] edits a template and keeps the values the form does not show', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(
      await screen.findByRole('button', { name: 'Edit template Release checklist' }),
    );
    const form = screen.getByRole('form', { name: 'Edit template Release checklist' });
    expect(within(form).getByText('Sam Rivera')).toBeVisible();
    expect(
      within(form).getByText('1 value of a field this form cannot show stays as it is.'),
    ).toBeVisible();
    await user.click(within(form).getByRole('button', { name: 'Remove Sam Rivera as assignee' }));
    await user.click(within(form).getByRole('button', { name: 'Remove subticket 1' }));
    await user.click(within(form).getByRole('button', { name: 'Save the template' }));
    await screen.findByText('Template Release checklist was saved.');
    const body = client.saved[0]?.body;
    expect(client.saved[0]?.id).toBe(RELEASE_TEMPLATE.id);
    expect(body?.version).toBe(RELEASE_TEMPLATE.version);
    expect(body?.defaults.assigneeId).toBeUndefined();
    expect(body?.defaults.fields).toEqual({ '7': 70, '99': 'kept' });
    expect(body?.subtickets).toEqual([{ summary: 'Announce it' }]);
  });

  it('[CORE-029] deletes only after asking', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    const trigger = await screen.findByRole('button', {
      name: 'Delete template Release checklist',
    });
    expect(trigger).toHaveClass('button-danger-quiet');
    await user.click(trigger);
    expect(client.removed).toEqual([]);
    // Asks first, saying what will happen (D13); Escape gives the focus back.
    const question = screen.getByRole('group', {
      name: 'Delete template Release checklist? Tickets already made from it stay as they are.',
    });
    expect(within(question).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: 'Delete template Release checklist' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Delete template Release checklist' }));
    await user.click(
      within(screen.getByRole('group')).getByRole('button', {
        name: 'Delete template Release checklist',
      }),
    );
    await waitFor(() => expect(client.removed).toEqual([RELEASE_TEMPLATE.id]));
    expect(await screen.findByText('Template Release checklist was deleted.')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText('Release checklist')).toBeNull());
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
  });

  it('[CORE-029] (2) keeps templates for every track without areas, releases or an assignee', async () => {
    const user = userEvent.setup();
    const client = renderPage(
      fakeTemplateClient([INCIDENT_TEMPLATE], { options: EVERY_TRACK_OPTIONS }),
      { trackKey: null },
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Ticket templates for every track' }),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Edit template Incident report' }));
    const form = screen.getByRole('form', { name: 'Edit template Incident report' });
    expect(within(form).queryByRole('searchbox', { name: 'Assignee' })).toBeNull();
    expect(within(form).queryByRole('listbox', { name: 'Areas' })).toBeNull();
    expect(within(form).queryByRole('listbox', { name: 'Target releases' })).toBeNull();
    await user.click(within(form).getByRole('button', { name: 'Save the template' }));
    await screen.findByText('Template Incident report was saved.');
    expect(client.saved[0]?.body.defaults).toEqual({ labels: ['incident'] });
  });

  it('says when the track cannot be read', async () => {
    const client = fakeTemplateClient();
    client.list = async () => {
      throw new Error('gone');
    };
    renderPage(client);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The templates could not be loaded.',
    );
  });

  it('[CORE-029] a draft of a saved template saves as it was', () => {
    const fields = TEMPLATE_OPTIONS.fields;
    const body = bodyOf(draftOf(RELEASE_TEMPLATE, fields), RELEASE_TEMPLATE, fields, 'SHOP');
    expect(body.defaults).toEqual(RELEASE_TEMPLATE.defaults);
    expect(body.subtickets).toEqual(RELEASE_TEMPLATE.subtickets);
    expect(body.summary).toBe(RELEASE_TEMPLATE.summary);
  });

  it('fits a small phone', async () => {
    setViewportWidth(375);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'New template' }));
    expect(screen.getByRole('form', { name: 'New template' })).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    const user = userEvent.setup();
    renderPage(fakeTemplateClient(), { locale: 'en-XA' });
    const main = screen.getByRole('main');
    const edit = await waitFor(() => {
      const found = main.querySelector<HTMLElement>('.people-action');
      expect(found).not.toBeNull();
      return found as HTMLElement;
    });
    await user.click(edit);
    const data = [
      'Release checklist',
      'Everything a release needs',
      'Incident report',
      'For anything that broke',
      'Bug',
      'Chore',
      'Subticket',
      'Checklist item',
      'High',
      'Low',
      'Checkout',
      'Payments',
      '1.0',
      '1.1',
      'Fixed in',
      'Owning area',
      // Person, group and team fields offered to add (T-350).
      'Reviewer',
      'Owners',
      'Squad',
      'Severity',
      'Customer',
      'Secret formula',
      'Blocker',
      'Minor',
      'Sam Rivera',
      'Shop',
      'Write the notes',
      'Announce it',
    ];
    const texts = visibleTexts(main).filter(
      (t) => !data.includes(t) && !data.some((d) => t === `[${d}]`),
    );
    expect(untranslated(texts)).toEqual([]);
  });
});
