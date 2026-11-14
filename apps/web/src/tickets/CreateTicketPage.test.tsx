import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { MEMBER } from '../admin/fixtures';
import { type Handler, stubBackend, untranslated, visibleTexts } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import { BUG_FORM, CHORE_FORM, LOCKED_FORM, PRIORITIES, TRACKS, TYPES } from './fixtures';
import type { FormField, TicketForm } from './form';

function openCreate(handlers: Record<string, Handler> = {}, locale?: 'en-XA') {
  const calls = stubBackend({
    'GET /tracks?limit=500': () => jsonResponse(200, { tracks: TRACKS }),
    'GET /priorities': () => jsonResponse(200, { priorities: PRIORITIES }),
    'GET /tracks/SHOP/ticket-types': () =>
      jsonResponse(200, { typeSetId: 1, defaultTypeId: 3, ticketTypes: TYPES }),
    'GET /tracks/SHOP/layout?ticketTypeId=3&operation=create': () => jsonResponse(200, BUG_FORM),
    'GET /tracks/SHOP/layout?ticketTypeId=4&operation=create': () => jsonResponse(200, CHORE_FORM),
    ...handlers,
  });
  window.location.hash = '#/create';
  render(<App session={MEMBER} {...(locale ? { locale } : {})} />);
  return calls;
}

/** A form with more fields at the end of its first section. */
function withFields(form: TicketForm, fields: FormField[]): TicketForm {
  const [first, ...rest] = form.layout.tabs;
  if (!first) return form;
  const [section, ...others] = first.sections;
  if (!section) return form;
  return {
    ...form,
    layout: {
      ...form.layout,
      tabs: [
        { ...first, sections: [{ ...section, fields: [...section.fields, ...fields] }, ...others] },
        ...rest,
      ],
    },
  };
}

/** A form with one of its fields made required. */
function required(form: TicketForm, key: string): TicketForm {
  return {
    ...form,
    layout: {
      ...form.layout,
      tabs: form.layout.tabs.map((tab) => ({
        ...tab,
        sections: tab.sections.map((section) => ({
          ...section,
          fields: section.fields.map((field) =>
            field.key === key ? { ...field, required: true } : field,
          ),
        })),
      })),
    },
  };
}

async function chooseType(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(screen.getByRole('combobox', { name: 'Ticket type' }));
  await user.click(screen.getByRole('option', { name }));
}

describe('the create form (M1-012)', () => {
  it('[CORE-014] starts on the priority a new ticket would take, with no empty choice', async () => {
    openCreate({
      'GET /tracks/SHOP/layout?ticketTypeId=3&operation=create': () =>
        jsonResponse(200, { ...BUG_FORM, priorities: { defaultId: 2, offered: [1, 2, 3] } }),
    });
    const user = userEvent.setup();
    const priority = await screen.findByRole('combobox', { name: 'Priority' });
    await within(priority).findByText('Normal');
    await user.click(priority);
    expect(
      within(screen.getByRole('listbox'))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Urgent', 'Normal', 'Very low']);
  });

  it("[CORE-008] lays out the type's form: tabs, the context column, required marks, help", async () => {
    openCreate();
    expect(await screen.findByRole('heading', { level: 1, name: 'Create ticket' })).toBeVisible();
    const report = await screen.findByRole('region', { name: 'Report' });
    expect(within(report).getByLabelText('Summary (required)')).toHaveAttribute(
      'aria-required',
      'true',
    );
    expect(within(report).getByLabelText('Severity (required)')).toBeVisible();
    expect(within(report).getByText('What happened, step by step')).toBeVisible();
    // A cascade offers its second level once the first is chosen.
    expect(within(report).getByLabelText('Component')).toBeVisible();
    // The assignee is chosen here now, by name (T-253).
    expect(within(report).getByRole('searchbox', { name: 'Assignee' })).toBeVisible();
    expect(within(report).queryByText(/once it is created/)).toBeNull();
    // The required field the layout left out has a section of its own.
    const more = screen.getByRole('region', { name: 'More fields' });
    expect(within(more).getByLabelText('Due date (required)')).toBeVisible();
  });

  it('[CORE-008] says what the estimates and a number field expect, as Labels does', async () => {
    const form = withFields(CHORE_FORM, [
      { key: 'originalEstimate', required: false, description: null },
      { key: 'remainingEstimate', required: false, description: null },
      { key: 'cf[13]', required: false, description: null },
    ]);
    form.customFields = [
      { id: 13, name: 'Points', description: '', type: 'number', multiple: false },
    ];
    openCreate({
      'GET /tracks/SHOP/ticket-types': () =>
        jsonResponse(200, { typeSetId: 1, defaultTypeId: 4, ticketTypes: TYPES }),
      'GET /tracks/SHOP/layout?ticketTypeId=4&operation=create': () => jsonResponse(200, form),
    });
    expect(await screen.findByLabelText('Original estimate')).toHaveAccessibleDescription(
      'For example 2h 30m, or 1d.',
    );
    expect(screen.getByLabelText('Remaining estimate')).toHaveAccessibleDescription(
      'For example 2h 30m, or 1d.',
    );
    expect(screen.getByLabelText('Points')).toHaveAccessibleDescription('A number, for example 3.');
  });

  it("[CORE-013] shows the backend's refusals at each field, then creates the ticket", async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const calls = openCreate({
      'POST /tickets': () =>
        ++attempts === 1
          ? jsonResponse(400, {
              error: 'invalid_fields',
              fields: { dueDate: 'required', 'fields.7': 'required' },
            })
          : jsonResponse(201, { ticket: { id: 9, key: 'SHOP-9' } }),
    });
    await user.type(await screen.findByLabelText('Summary (required)'), 'Checkout fails');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(
      await screen.findByText('Some fields need attention before the ticket can be created.'),
    ).toHaveAttribute('role', 'alert');
    const due = screen.getByLabelText('Due date (required)');
    expect(due).toHaveAttribute('aria-invalid', 'true');
    expect(due).toHaveAccessibleDescription('This field is required.');
    expect(screen.getByLabelText('Severity (required)')).toHaveAccessibleDescription(
      'This field is required.',
    );
    await user.type(due, '2026-12-01');
    await user.selectOptions(screen.getByLabelText('Severity (required)'), 'Blocker');
    await user.selectOptions(screen.getByLabelText('Component'), 'Backend');
    await user.selectOptions(screen.getByLabelText('Component: second level'), 'Queue');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('SHOP-9 was created.')).toHaveAttribute('role', 'status');
    const sent = calls.filter((c) => c.method === 'POST' && c.path === '/tickets').pop();
    expect(sent?.body).toMatchObject({
      track: 'SHOP',
      ticketTypeId: 3,
      summary: 'Checkout fails',
      dueDate: '2026-12-01',
      fields: { 7: 70, 8: { parent: 80, child: 81 } },
    });
  });

  it('[CORE-013] keeps a field required at create that it cannot set, so its refusal has a place (D30)', async () => {
    const user = userEvent.setup();
    // An administrator put a formula, required, and Close reason on the create layout.
    const required = withFields(BUG_FORM, [
      { key: 'cf[30]', required: true, description: null },
      { key: 'closeReason', required: false, description: null },
    ]);
    required.customFields = [
      ...BUG_FORM.customFields,
      { id: 30, name: 'Score', description: '', type: 'formula', multiple: false },
    ];
    openCreate({
      'GET /tracks/SHOP/layout?ticketTypeId=3&operation=create': () => jsonResponse(200, required),
      'POST /tickets': () =>
        jsonResponse(400, {
          error: 'invalid_fields',
          // Close reason is never on this form, so it has no row (PL-20, D30).
          fields: { 'fields.30': 'required', closeReasonId: 'required' },
        }),
    });
    const score = await screen.findByRole('group', { name: 'Score (required)' });
    expect(score).toHaveAccessibleDescription(/^This form cannot set this field yet\./);
    expect(screen.queryByText('Close reason')).toBeNull();
    await user.type(screen.getByLabelText('Summary (required)'), 'Checkout fails');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    const alert = await screen.findByText(
      'Some fields need attention before the ticket can be created.',
    );
    expect(alert).toHaveAttribute('role', 'alert');
    // The refusal shows at the row; the one with no row is named in the alert.
    expect(score).toHaveAccessibleDescription(/This field is required\.$/);
    expect(alert).toHaveTextContent(
      'Some fields need attention before the ticket can be created. Close reason: This field is required.',
    );
    expect(alert).not.toHaveTextContent('Score');
  });

  it('[CORE-008] [IAM-010] a layout requiring Assignee creates the ticket with the person chosen', async () => {
    const user = userEvent.setup();
    let attempts = 0;
    const calls = openCreate({
      'GET /tracks/SHOP/layout?ticketTypeId=3&operation=create': () =>
        jsonResponse(200, required(BUG_FORM, 'assignee')),
      'GET /people/mentionable?track=SHOP&q=sa&limit=8&assignable=true': () =>
        jsonResponse(200, {
          people: [
            { id: 21, name: 'Sam Rivera', canView: true },
            { id: 22, name: 'Sasha Lee', canView: true },
          ],
        }),
      'POST /tickets': () =>
        ++attempts === 1
          ? jsonResponse(400, { error: 'invalid_fields', fields: { assigneeId: 'not_assignable' } })
          : jsonResponse(201, { ticket: { id: 9, key: 'SHOP-9' } }),
    });
    const search = await screen.findByRole('searchbox', { name: 'Assignee (required)' });
    expect(search).toHaveAttribute('aria-required', 'true');
    await user.type(screen.getByLabelText('Summary (required)'), 'Checkout fails');
    await user.type(screen.getByLabelText('Due date (required)'), '2026-12-01');
    await user.selectOptions(screen.getByLabelText('Severity (required)'), 'Blocker');
    await user.type(search, 'sa');
    // Only people who may be given tickets in the track are offered.
    expect(await screen.findByText('2 people found')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sasha Lee' }));
    expect(screen.queryByRole('searchbox', { name: 'Assignee (required)' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Remove Sasha Lee' }));
    await user.type(screen.getByRole('searchbox', { name: 'Assignee (required)' }), 'sa');
    await user.click(await screen.findByRole('button', { name: 'Sam Rivera' }));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    // A refusal shows at the picker, in words.
    const group = await screen.findByRole('list', { name: 'Assignee (required)' });
    await waitFor(() =>
      expect(group).toHaveAccessibleDescription(
        'This person cannot be given tickets in this track.',
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('SHOP-9 was created.')).toBeVisible();
    const sent = calls.filter((c) => c.method === 'POST' && c.path === '/tickets').pop();
    expect(sent?.body).toMatchObject({ track: 'SHOP', ticketTypeId: 3, assigneeId: 21 });
    // The form is empty again.
    expect(screen.getByRole('searchbox', { name: 'Assignee (required)' })).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Remove Sam Rivera' })).toBeNull();
  });

  it('[CORE-015] [CORE-016] [CORE-006] [CORE-010] sets releases, areas, the parent and a custom person field at create', async () => {
    const user = userEvent.setup();
    const form = withFields(CHORE_FORM, [
      { key: 'targetRelease', required: false, description: null },
      { key: 'area', required: false, description: null },
      { key: 'parent', required: false, description: null },
      { key: 'cf[12]', required: false, description: null },
    ]);
    form.customFields = [
      { id: 12, name: 'Reviewers', description: '', type: 'user', multiple: true },
    ];
    const calls = openCreate({
      'GET /tracks/SHOP/ticket-types': () =>
        jsonResponse(200, { typeSetId: 1, defaultTypeId: 4, ticketTypes: TYPES }),
      'GET /tracks/SHOP/layout?ticketTypeId=4&operation=create': () => jsonResponse(200, form),
      'GET /tracks/1/releases': () =>
        jsonResponse(200, {
          releases: [
            { id: 5, name: 'Spring' },
            { id: 6, name: 'Summer' },
          ],
        }),
      'GET /tracks/1/areas': () => jsonResponse(200, { areas: [{ id: 7, name: 'Checkout' }] }),
      'POST /search': () =>
        jsonResponse(200, {
          tickets: [{ id: 40, key: 'SHOP-4', summary: 'Payments', status: { name: 'Open' } }],
        }),
      'GET /people/mentionable*': () =>
        jsonResponse(200, {
          people: [
            { id: 21, name: 'Sam Rivera', canView: true },
            { id: 22, name: 'Sasha Lee', canView: true },
          ],
        }),
      'POST /tickets': () => jsonResponse(201, { ticket: { id: 9, key: 'SHOP-9' } }),
    });
    await user.type(await screen.findByLabelText('Summary (required)'), 'Card declined');
    const target = await screen.findByRole('group', { name: 'Target releases' });
    await user.click(await within(target).findByRole('checkbox', { name: 'Summer' }));
    const area = screen.getByRole('group', { name: 'Areas' });
    await user.click(await within(area).findByRole('checkbox', { name: 'Checkout' }));
    await user.type(screen.getByRole('combobox', { name: 'Parent' }), 'pay');
    await user.click(await screen.findByRole('option', { name: /SHOP-4/ }));
    expect(screen.getByRole('button', { name: 'Remove SHOP-4 as parent' })).toBeVisible();
    // A person field that holds several keeps its search field for the next one.
    const reviewers = screen.getByRole('searchbox', { name: 'Reviewers' });
    await user.type(reviewers, 'sa');
    await user.click(await screen.findByRole('button', { name: 'Sam Rivera' }));
    await user.type(reviewers, 'sa');
    await user.click(await screen.findByRole('button', { name: 'Sasha Lee' }));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('SHOP-9 was created.')).toBeVisible();
    const sent = calls.filter((c) => c.method === 'POST' && c.path === '/tickets').pop();
    expect(sent?.body).toMatchObject({
      ticketTypeId: 4,
      summary: 'Card declined',
      targetReleaseIds: [6],
      areaIds: [7],
      parent: 40,
      fields: { 12: [21, 22] },
    });
    // People for a custom field are anyone found, not only those who may be assigned.
    const asked = calls.filter((c) => c.path.startsWith('/people/mentionable'));
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((c) => !c.path.includes('assignable=true'))).toBe(true);
  });

  it('[CORE-015] [CORE-013] says so when a release chosen was archived meanwhile (T-276)', async () => {
    const user = userEvent.setup();
    const form = withFields(CHORE_FORM, [
      { key: 'targetRelease', required: false, description: null },
    ]);
    openCreate({
      'GET /tracks/SHOP/ticket-types': () =>
        jsonResponse(200, { typeSetId: 1, defaultTypeId: 4, ticketTypes: TYPES }),
      'GET /tracks/SHOP/layout?ticketTypeId=4&operation=create': () => jsonResponse(200, form),
      'GET /tracks/1/releases': () => jsonResponse(200, { releases: [{ id: 5, name: 'Spring' }] }),
      // Spring was archived after the form loaded: the create route refuses it by name.
      'POST /tickets': () =>
        jsonResponse(400, { error: 'invalid_fields', fields: { targetReleaseIds: 'archived' } }),
    });
    await user.type(await screen.findByLabelText('Summary (required)'), 'Card declined');
    const target = await screen.findByRole('group', { name: 'Target releases' });
    await user.click(await within(target).findByRole('checkbox', { name: 'Spring' }));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(
      await screen.findByText('This release or area is archived. Choose another.'),
    ).toBeVisible();
    expect(screen.getByRole('group', { name: 'Target releases' })).toHaveAccessibleDescription(
      'This release or area is archived. Choose another.',
    );
    expect(screen.queryByText('This value was refused.')).toBeNull();
  });

  it('[CORE-015] [CORE-013] [CORE-010] says so when an area or a custom release is not the track’s own (T-282)', async () => {
    const user = userEvent.setup();
    const form = withFields(CHORE_FORM, [
      { key: 'area', required: false, description: null },
      { key: 'cf[33]', required: false, description: null },
    ]);
    form.customFields = [
      { id: 33, name: 'Fixed in', description: '', type: 'release', multiple: false },
    ];
    openCreate({
      'GET /tracks/SHOP/ticket-types': () =>
        jsonResponse(200, { typeSetId: 1, defaultTypeId: 4, ticketTypes: TYPES }),
      'GET /tracks/SHOP/layout?ticketTypeId=4&operation=create': () => jsonResponse(200, form),
      'GET /tracks/1/releases': () => jsonResponse(200, { releases: [{ id: 5, name: 'Spring' }] }),
      'GET /tracks/1/areas': () => jsonResponse(200, { areas: [{ id: 7, name: 'Checkout' }] }),
      // Both moved to another track after the form loaded: the create route refuses them.
      'POST /tickets': () =>
        jsonResponse(400, {
          error: 'invalid_fields',
          fields: { areaIds: 'not_in_track', 'fields.33': 'not_in_track' },
        }),
    });
    await user.type(await screen.findByLabelText('Summary (required)'), 'Card declined');
    const areas = await screen.findByRole('group', { name: 'Areas' });
    await user.click(await within(areas).findByRole('checkbox', { name: 'Checkout' }));
    const release = screen.getByRole('combobox', { name: 'Fixed in' });
    await within(release).findByRole('option', { name: 'Spring' });
    await user.selectOptions(release, 'Spring');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    const words = 'This track does not offer this choice. Choose one of its own.';
    expect(await screen.findAllByText(words)).toHaveLength(2);
    expect(screen.getByRole('group', { name: 'Areas' })).toHaveAccessibleDescription(words);
    expect(screen.getByRole('combobox', { name: 'Fixed in' })).toHaveAccessibleDescription(words);
    expect(screen.queryByText('This value was refused.')).toBeNull();
  });

  it('[CORE-008] [CORE-010] [CORE-006] keeps focus on the pickers as people and the parent are taken and removed', async () => {
    const user = userEvent.setup();
    const form = withFields(CHORE_FORM, [
      { key: 'assignee', required: true, description: null },
      { key: 'parent', required: false, description: null },
      { key: 'cf[12]', required: false, description: null },
    ]);
    form.customFields = [
      { id: 12, name: 'Reviewers', description: '', type: 'user', multiple: true },
    ];
    openCreate({
      'GET /tracks/SHOP/ticket-types': () =>
        jsonResponse(200, { typeSetId: 1, defaultTypeId: 4, ticketTypes: TYPES }),
      'GET /tracks/SHOP/layout?ticketTypeId=4&operation=create': () => jsonResponse(200, form),
      'POST /search': () =>
        jsonResponse(200, {
          tickets: [{ id: 40, key: 'SHOP-4', summary: 'Payments', status: { name: 'Open' } }],
        }),
      'GET /people/mentionable*': () =>
        jsonResponse(200, {
          people: [
            { id: 21, name: 'Sam Rivera', canView: true },
            { id: 22, name: 'Sasha Lee', canView: true },
          ],
        }),
    });
    // One person: the search field gives way, and focus goes to the Remove button.
    const assignee = await screen.findByRole('searchbox', { name: 'Assignee (required)' });
    await user.type(assignee, 'sa');
    await screen.findByRole('button', { name: 'Sam Rivera' });
    await user.tab();
    expect(screen.getByRole('button', { name: 'Sam Rivera' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Remove Sam Rivera' })).toHaveFocus();
    expect(screen.getByText('Sam Rivera chosen.')).toBeInTheDocument();
    // Removing brings the search field back, with focus in it.
    await user.keyboard('{Enter}');
    expect(screen.getByRole('searchbox', { name: 'Assignee (required)' })).toHaveFocus();
    expect(screen.getByText('Sam Rivera removed.')).toBeInTheDocument();
    // Several people: focus goes back to the search field for the next one.
    const reviewers = screen.getByRole('searchbox', { name: 'Reviewers' });
    await user.type(reviewers, 'sa');
    await screen.findByRole('button', { name: 'Sasha Lee' });
    await user.tab();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Sasha Lee' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(reviewers).toHaveFocus();
    // The parent: picking moves focus to its Remove button, removing back to the field.
    await user.type(screen.getByRole('combobox', { name: 'Parent' }), 'pay');
    await screen.findByRole('option', { name: /SHOP-4/ });
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Remove SHOP-4 as parent' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('combobox', { name: 'Parent' })).toHaveFocus();
  });

  it('[CORE-008] [IAM-010] sets the requester with the Change the requester permission, and leaves it out without (T-265)', async () => {
    const user = userEvent.setup();
    const form = withFields(CHORE_FORM, [{ key: 'requester', required: false, description: null }]);
    let withheld: string[] = [];
    const calls = openCreate({
      'GET /tracks/SHOP/ticket-types': () =>
        jsonResponse(200, { typeSetId: 1, defaultTypeId: 4, ticketTypes: TYPES }),
      'GET /tracks/SHOP/layout?ticketTypeId=4&operation=create': () =>
        jsonResponse(200, { ...form, withheld }),
      'GET /people/mentionable*': () =>
        jsonResponse(200, { people: [{ id: 23, name: 'Robin Okafor', canView: true }] }),
      'POST /tickets': () => jsonResponse(201, { ticket: { id: 9, key: 'SHOP-9' } }),
    });
    const requester = await screen.findByRole('searchbox', { name: 'Requester' });
    expect(requester).toHaveAccessibleDescription(
      'Type a name to find someone. Left empty, you are the requester.',
    );
    await user.type(screen.getByLabelText('Summary (required)'), 'Card declined');
    await user.type(requester, 'rob');
    await user.click(await screen.findByRole('button', { name: 'Robin Okafor' }));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('SHOP-9 was created.')).toBeVisible();
    const sent = calls.filter((c) => c.method === 'POST' && c.path === '/tickets').pop();
    expect(sent?.body).toMatchObject({ summary: 'Card declined', requesterId: 23 });
    // Anyone may be the requester, not only those who may be given tickets.
    const asked = calls.filter((c) => c.path.startsWith('/people/mentionable'));
    expect(asked.every((c) => !c.path.includes('assignable=true'))).toBe(true);
    // Without the permission the row is left out, as the create route would refuse it.
    withheld = ['requester'];
    await chooseType(user, 'Bug');
    await screen.findByRole('region', { name: 'Report' });
    await chooseType(user, 'Chore');
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Report' })).toBeNull());
    await screen.findByLabelText('Summary (required)');
    expect(screen.queryByRole('searchbox', { name: 'Requester' })).toBeNull();
  });

  it('[CORE-010] sets custom group, team, release and area fields with the pickers the form has (T-265)', async () => {
    const user = userEvent.setup();
    const form = withFields(CHORE_FORM, [
      { key: 'cf[31]', required: false, description: null },
      { key: 'cf[32]', required: true, description: null },
      { key: 'cf[33]', required: false, description: null },
      { key: 'cf[34]', required: false, description: null },
    ]);
    form.customFields = [
      { id: 31, name: 'Owning groups', description: '', type: 'group', multiple: true },
      { id: 32, name: 'Team', description: '', type: 'team', multiple: false },
      { id: 33, name: 'Fixed in', description: '', type: 'release', multiple: false },
      { id: 34, name: 'Parts', description: '', type: 'area', multiple: true },
    ];
    const calls = openCreate({
      'GET /tracks/SHOP/ticket-types': () =>
        jsonResponse(200, { typeSetId: 1, defaultTypeId: 4, ticketTypes: TYPES }),
      'GET /tracks/SHOP/layout?ticketTypeId=4&operation=create': () => jsonResponse(200, form),
      'GET /fields/31/groups?q=op&limit=8': () =>
        jsonResponse(200, {
          groups: [
            { id: 41, name: 'Operations' },
            { id: 42, name: 'Ops leads' },
          ],
        }),
      'GET /teams?query=pay&limit=8': () =>
        jsonResponse(200, {
          teams: [{ id: 51, name: 'Payments', description: '', lead: null, memberCount: 3 }],
        }),
      'GET /tracks/1/releases': () => jsonResponse(200, { releases: [{ id: 5, name: 'Spring' }] }),
      'GET /tracks/1/areas': () =>
        jsonResponse(200, {
          areas: [
            { id: 7, name: 'Checkout' },
            { id: 8, name: 'Search' },
          ],
        }),
      'POST /tickets': () => jsonResponse(201, { ticket: { id: 9, key: 'SHOP-9' } }),
    });
    await user.type(await screen.findByLabelText('Summary (required)'), 'Card declined');
    // Groups are found by name, several kept.
    const groups = screen.getByRole('searchbox', { name: 'Owning groups' });
    expect(groups).toHaveAccessibleDescription('Type a name to find a group.');
    await user.type(groups, 'op');
    expect(await screen.findByText('2 groups found')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ops leads' }));
    await user.type(groups, 'op');
    await user.click(await screen.findByRole('button', { name: 'Operations' }));
    // Teams are found by name too (T-276); one release: a list to choose one from; areas a
    // checkbox each.
    const team = screen.getByRole('searchbox', { name: 'Team (required)' });
    expect(team).toHaveAttribute('aria-required', 'true');
    expect(team).toHaveAccessibleDescription('Type a name to find a team.');
    await user.type(team, 'pay');
    expect(await screen.findByText('1 team found')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Payments' }));
    const release = screen.getByRole('combobox', { name: 'Fixed in' });
    await within(release).findByRole('option', { name: 'Spring' });
    await user.selectOptions(release, 'Spring');
    const parts = screen.getByRole('group', { name: 'Parts' });
    await user.click(await within(parts).findByRole('checkbox', { name: 'Search' }));
    expect(screen.queryByText(/cannot set this field/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('SHOP-9 was created.')).toBeVisible();
    const sent = calls.filter((c) => c.method === 'POST' && c.path === '/tickets').pop();
    expect(sent?.body).toMatchObject({ fields: { 31: [42, 41], 32: 51, 33: 5, 34: [8] } });
    // The site's teams are never all loaded at once: only the first eight whose name holds the
    // text, which the server picks (T-282).
    expect(calls.filter((c) => c.path.startsWith('/teams')).map((c) => c.path)).toEqual([
      '/teams?query=pay&limit=8',
    ]);
  });

  it('[CORE-009] a person field restricted to a group offers only the people it allows (T-265)', async () => {
    const user = userEvent.setup();
    const form = withFields(CHORE_FORM, [{ key: 'cf[12]', required: false, description: null }]);
    form.customFields = [
      {
        id: 12,
        name: 'Approver',
        description: '',
        type: 'user',
        multiple: false,
        restricted: true,
      },
    ];
    const calls = openCreate({
      'GET /tracks/SHOP/ticket-types': () =>
        jsonResponse(200, { typeSetId: 1, defaultTypeId: 4, ticketTypes: TYPES }),
      'GET /tracks/SHOP/layout?ticketTypeId=4&operation=create': () => jsonResponse(200, form),
      'GET /fields/12/people?track=SHOP&ticketTypeId=4&q=sa&limit=8': () =>
        jsonResponse(200, { people: [{ id: 22, name: 'Sasha Lee' }] }),
      'GET /people/mentionable*': () =>
        jsonResponse(200, {
          people: [
            { id: 21, name: 'Sam Rivera', canView: true },
            { id: 22, name: 'Sasha Lee', canView: true },
          ],
        }),
      'POST /tickets': () => jsonResponse(201, { ticket: { id: 9, key: 'SHOP-9' } }),
    });
    await user.type(await screen.findByLabelText('Summary (required)'), 'Refund');
    const approver = screen.getByRole('searchbox', { name: 'Approver' });
    expect(approver).toHaveAccessibleDescription(
      'Type a name. Only the people this field allows are offered.',
    );
    await user.type(approver, 'sa');
    expect(await screen.findByText('1 person found')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sam Rivera' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Sasha Lee' }));
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('SHOP-9 was created.')).toBeVisible();
    const sent = calls.filter((c) => c.method === 'POST' && c.path === '/tickets').pop();
    expect(sent?.body).toMatchObject({ fields: { 12: 22 } });
    expect(calls.some((c) => c.path.startsWith('/people/mentionable'))).toBe(false);
  });

  it('[CORE-006] offers as parent only tickets one level up, and for a subticket only in its track (T-265)', async () => {
    const user = userEvent.setup();
    const leveled = [
      { id: 3, name: 'Bug', level: { rank: 0 } },
      { id: 4, name: 'Chore', level: { rank: 0 } },
      { id: 5, name: 'Subticket', level: { rank: -1 } },
    ];
    const form = withFields(CHORE_FORM, [{ key: 'parent', required: false, description: null }]);
    const calls = openCreate({
      'GET /tracks/SHOP/ticket-types': () =>
        jsonResponse(200, { typeSetId: 1, defaultTypeId: 4, ticketTypes: leveled }),
      'GET /tracks/SHOP/layout?ticketTypeId=4&operation=create': () => jsonResponse(200, form),
      'GET /tracks/SHOP/layout?ticketTypeId=5&operation=create': () => jsonResponse(200, form),
      'POST /search': () =>
        jsonResponse(200, {
          tickets: [{ id: 40, key: 'SHOP-4', summary: 'Payments', status: { name: 'Open' } }],
        }),
    });
    const parent = await screen.findByRole('combobox', { name: 'Parent' });
    expect(parent).toHaveAccessibleDescription(
      'Type a ticket’s key or words from its summary. Only tickets one level up are offered.',
    );
    await user.type(parent, 'pay');
    await user.click(await screen.findByRole('option', { name: /SHOP-4/ }));
    const queries = () =>
      calls
        .filter((c) => c.method === 'POST' && c.path === '/search')
        .map((c) => (c.body as { q: string }).q);
    expect(queries().pop()).toBe('hierarchyLevel = 1 AND (summary ~ "pay*") ORDER BY updated DESC');
    // A subticket sits under a ticket one level up in its own track; the parent chosen for a
    // Chore cannot hold it, so it is let go.
    await chooseType(user, 'Subticket');
    const again = await screen.findByRole('combobox', { name: 'Parent' });
    expect(screen.queryByRole('button', { name: 'Remove SHOP-4 as parent' })).toBeNull();
    expect(again).toHaveAccessibleDescription(
      'Type a ticket’s key or words from its summary. Only tickets one level up in this track are offered.',
    );
    await user.type(again, 'pay');
    await screen.findByRole('option', { name: /SHOP-4/ });
    expect(queries().pop()).toBe(
      'track = "SHOP" AND hierarchyLevel = 0 AND (summary ~ "pay*") ORDER BY updated DESC',
    );
  });

  it('[CORE-015] [CORE-016] a track with no releases or areas offers none, and says so where one is required', async () => {
    const form = withFields(CHORE_FORM, [
      { key: 'targetRelease', required: true, description: null },
      { key: 'area', required: false, description: null },
    ]);
    openCreate({
      'GET /tracks/SHOP/ticket-types': () =>
        jsonResponse(200, { typeSetId: 1, defaultTypeId: 4, ticketTypes: TYPES }),
      'GET /tracks/SHOP/layout?ticketTypeId=4&operation=create': () => jsonResponse(200, form),
      'GET /tracks/1/releases': () => jsonResponse(200, { releases: [] }),
      'GET /tracks/1/areas': () => jsonResponse(200, { areas: [] }),
    });
    const target = await screen.findByRole('group', { name: 'Target releases (required)' });
    await waitFor(() =>
      expect(target).toHaveAccessibleDescription('This track has no releases to choose.'),
    );
    await waitFor(() => expect(screen.queryByRole('group', { name: 'Areas' })).toBeNull());
  });

  it('[IAM-010] leaves out what the person may not set at create, and says so where it is required', async () => {
    openCreate({
      'GET /tracks/SHOP/layout?ticketTypeId=3&operation=create': () =>
        jsonResponse(200, { ...BUG_FORM, withheld: ['assignee', 'dueDate'] }),
    });
    await screen.findByLabelText('Summary (required)');
    // Not required: left out, as the create route would refuse it.
    expect(screen.queryByRole('searchbox', { name: 'Assignee' })).toBeNull();
    // Required: it stays, saying why.
    const due = screen.getByRole('group', { name: 'Due date (required)' });
    expect(due).toHaveAccessibleDescription(/^You may not set this field on a new ticket\./);
    expect(screen.queryByLabelText('Due date (required)')).toBeNull();
  });

  it('[CORE-001] the Track picker is a labelled combobox with each track’s mark, key and name (T-255)', async () => {
    const user = userEvent.setup();
    openCreate({
      'GET /tracks?limit=500': () =>
        jsonResponse(200, {
          tracks: [...TRACKS, { id: 2, key: 'OPS', name: 'Operations', color: '#2f6fdb' }],
        }),
      'GET /tracks/OPS/ticket-types': () =>
        jsonResponse(200, { typeSetId: 1, defaultTypeId: 4, ticketTypes: TYPES }),
      'GET /tracks/OPS/layout?ticketTypeId=4&operation=create': () => jsonResponse(200, CHORE_FORM),
    });
    await screen.findByLabelText('Severity (required)');
    const track = screen.getByRole('combobox', { name: 'Track' });
    expect(track).toHaveTextContent('SHOP Shop');
    await user.click(track);
    const listbox = screen.getByRole('listbox');
    const ops = within(listbox).getByRole('option', { name: 'OPS Operations' });
    expect(within(listbox).getByRole('option', { name: 'SHOP Shop' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // Each track's mark: the first letter of its key, beside the words that name it.
    expect(ops.querySelector('.track-glyph')).toHaveTextContent('O');
    expect(ops.querySelector('.track-glyph')).toHaveAttribute('aria-hidden', 'true');
    await user.click(ops);
    expect(track).toHaveTextContent('OPS Operations');
    // The other track's form, its type chosen.
    expect(await screen.findByLabelText('Due date')).toBeVisible();
    expect(screen.queryByLabelText('Severity (required)')).toBeNull();
  });

  it('[CORE-013] another ticket type brings its own form', async () => {
    const user = userEvent.setup();
    openCreate();
    await screen.findByLabelText('Severity (required)');
    await chooseType(user, 'Chore');
    expect(await screen.findByLabelText('Due date')).toBeVisible();
    expect(screen.queryByLabelText('Severity (required)')).toBeNull();
    // One generated tab needs no heading.
    expect(screen.queryByRole('region', { name: 'More fields' })).toBeNull();
  });

  it('[CORE-013] choosing the track already chosen keeps its ticket types', async () => {
    const user = userEvent.setup();
    openCreate();
    await screen.findByLabelText('Severity (required)');
    await user.click(screen.getByRole('combobox', { name: 'Track' }));
    await user.click(screen.getByRole('option', { name: 'SHOP Shop' }));
    // The list stays filled and a type stays chosen: found by the fresh-install run (M1-113).
    const type = screen.getByRole('combobox', { name: 'Ticket type' });
    expect(type).toHaveTextContent('Bug');
    await user.click(type);
    expect(screen.getAllByRole('option').length).toBeGreaterThan(0);
    await user.keyboard('{Escape}');
    expect(await screen.findByLabelText('Severity (required)')).toBeVisible();
  });

  it('[WF-007] [CORE-013] shows the fields a person may not set read-only, and says who may', async () => {
    const user = userEvent.setup();
    const calls = openCreate({
      'GET /tracks/SHOP/layout?ticketTypeId=4&operation=create': () =>
        jsonResponse(200, LOCKED_FORM),
      'POST /tickets': () => jsonResponse(201, { ticket: { id: 10, key: 'SHOP-10' } }),
    });
    await screen.findByLabelText('Severity (required)');
    await chooseType(user, 'Chore');
    const due = await screen.findByLabelText('Due date');
    expect(due).toBeDisabled();
    expect(due).toHaveAccessibleDescription('Only the Approvers group can set this field.');
    const labels = screen.getByLabelText('Labels');
    expect(labels).toBeDisabled();
    expect(labels).toHaveAccessibleDescription(
      'Separate labels with spaces or commas. Only the Administrators role or the Leads group can set this field.',
    );
    await user.type(screen.getByLabelText('Summary (required)'), 'Tidy up');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByText('SHOP-10 was created.')).toBeVisible();
    const sent = calls.filter((c) => c.method === 'POST' && c.path === '/tickets').pop();
    expect(sent?.body).not.toHaveProperty('dueDate');
    expect(sent?.body).not.toHaveProperty('labels');
  });

  it('[CORE-013] a late answer for the type chosen before does not replace the form of this one', async () => {
    const user = userEvent.setup();
    let answerBug: () => void = () => {};
    openCreate({
      // The Bug form answers only after the Chore form has arrived.
      'GET /tracks/SHOP/layout?ticketTypeId=3&operation=create': () =>
        new Promise<Response>((resolve) => {
          answerBug = () => resolve(jsonResponse(200, BUG_FORM));
        }),
    });
    await within(await screen.findByRole('combobox', { name: 'Ticket type' })).findByText('Bug');
    await chooseType(user, 'Chore');
    expect(await screen.findByLabelText('Due date')).toBeVisible();
    answerBug();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByLabelText('Due date')).toBeVisible();
    expect(screen.queryByLabelText('Severity (required)')).toBeNull();
  });

  it('[CORE-008] fits a small phone', async () => {
    setViewportWidth(360);
    openCreate();
    expect(await screen.findByLabelText('Summary (required)')).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(360);
  });

  it('[CORE-008] reads every string from the catalogue', async () => {
    openCreate({}, 'en-XA');
    const main = screen.getByRole('main');
    // The form itself, not only the template field above it.
    await within(main).findByRole('region', { name: 'Report' });
    // Names administrators gave (types, tabs, options, help) are data, not interface text.
    const data = new Set([
      // The track's mark: the first letter of its key.
      'S',
      'Bug',
      'Chore',
      'Report',
      'Blocker',
      'Minor',
      'Backend',
      'Urgent',
      'Normal',
      'What happened, step by step',
      'Where it lives',
      'Component',
    ]);
    const texts = visibleTexts(main);
    expect(texts.length).toBeGreaterThan(10);
    expect(untranslated(texts).filter((t) => !data.has(t))).toEqual([]);
  });
});
