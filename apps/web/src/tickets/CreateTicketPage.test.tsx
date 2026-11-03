import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { MEMBER } from '../admin/fixtures';
import { type Handler, stubBackend, untranslated, visibleTexts } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import { BUG_FORM, CHORE_FORM, LOCKED_FORM, PRIORITIES, TRACKS, TYPES } from './fixtures';

function openCreate(handlers: Record<string, Handler> = {}, locale?: 'en-XA') {
  const calls = stubBackend({
    'GET /tracks': () => jsonResponse(200, { tracks: TRACKS }),
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
    // Fields this form cannot edit yet say where they are set.
    expect(within(report).getByText('Set on the ticket once it is created.')).toBeVisible();
    // The required field the layout left out has a section of its own.
    const more = screen.getByRole('region', { name: 'More fields' });
    expect(within(more).getByLabelText('Due date (required)')).toBeVisible();
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
    const track = screen.getByLabelText('Track') as HTMLSelectElement;
    await user.selectOptions(track, track.value);
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
