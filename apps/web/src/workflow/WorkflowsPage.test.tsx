import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { type Handler, noContent, stubBackend, untranslated, visibleTexts } from '../test/backend';
import { jsonResponse } from '../test/setup';
import type { WorkflowSummary } from './client';
import type { Status } from './definition';
import { DEFAULT_WORKFLOW, S, STATUSES, SUPPORT_WORKFLOW } from './fixtures';

const SUMMARIES: WorkflowSummary[] = [
  {
    id: 1,
    name: 'Default workflow',
    description: 'New, Active, In Review, Closed',
    isDefault: true,
    publishedVersion: 1,
    draftVersion: null,
    trackCount: 2,
  },
  {
    id: 2,
    name: 'Support',
    description: '',
    isDefault: false,
    publishedVersion: 2,
    draftVersion: 3,
    trackCount: 0,
  },
];

function openPage(handlers: Record<string, Handler> = {}, session = ADMIN) {
  const calls = stubBackend({
    'GET /workflows': () => jsonResponse(200, { workflows: SUMMARIES }),
    'GET /statuses': () => jsonResponse(200, { statuses: STATUSES }),
    ...handlers,
  });
  window.location.hash = '#/settings';
  render(<App session={session} />);
  return calls;
}

const workflowItem = async (name: string) => {
  const list = await screen.findByRole('list', { name: 'Workflows in this workspace' });
  const item = within(list)
    .getAllByRole('listitem')
    .find((li) => within(li).queryByRole('link', { name }));
  if (!item) throw new Error(`no workflow named ${name}`);
  return item;
};

describe('workflows administration (M1-030)', () => {
  it('[WF-001] [WF-002] Settings leads to the workflows, with their versions, drafts and tracks', async () => {
    const user = userEvent.setup();
    openPage();
    await user.click(await screen.findByRole('link', { name: 'Workflows' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Workflows' })).toBeVisible();
    expect(window.location.hash).toBe('#/admin/workflows');
    const standard = await workflowItem('Default workflow');
    for (const text of ['Default', 'Version 1 published', 'Used by 2 tracks']) {
      expect(within(standard).getByText(text)).toBeVisible();
    }
    expect(within(standard).queryByRole('button', { name: 'Delete Default workflow' })).toBeNull();
    const support = await workflowItem('Support');
    expect(within(support).getByText('Draft version 3')).toBeVisible();
    expect(within(support).getByRole('link', { name: 'Edit Support' })).toHaveAttribute(
      'href',
      '#/admin/workflows/2',
    );
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('aria-current', 'page');
  });

  it('[WF-001] creates an empty workflow with an initial status and opens it', async () => {
    const user = userEvent.setup();
    const calls = openPage({
      'POST /workflows': (body) =>
        jsonResponse(201, {
          workflow: { ...SUPPORT_WORKFLOW, id: 9, name: (body as { name: string }).name },
        }),
      'GET /workflows/9': () => jsonResponse(200, { workflow: { ...SUPPORT_WORKFLOW, id: 9 } }),
    });
    window.location.hash = '#/admin/workflows';
    await user.click(await screen.findByRole('button', { name: 'Create a workflow' }));
    const form = screen.getByRole('form', { name: 'New workflow' });
    expect(within(form).getByLabelText('Name')).toHaveFocus();
    await user.click(within(form).getByRole('button', { name: 'Create workflow' }));
    expect(within(form).getByRole('alert')).toHaveTextContent('Enter a name.');
    await user.type(within(form).getByLabelText('Name'), 'Releases');
    expect(within(form).getByLabelText('Initial status')).toHaveValue(String(S.Open));
    await user.selectOptions(within(form).getByLabelText('Initial status'), String(S.Backlog));
    await user.click(within(form).getByRole('button', { name: 'Create workflow' }));
    await waitFor(() => expect(window.location.hash).toBe('#/admin/workflows/9'));
    expect(calls.find((c) => c.method === 'POST' && c.path === '/workflows')?.body).toEqual({
      name: 'Releases',
      definition: {
        initialStatusId: S.Backlog,
        statuses: [{ statusId: S.Backlog }],
        transitions: [],
      },
    });
  });

  it('[WF-001] creates a copy of another workflow', async () => {
    const user = userEvent.setup();
    const calls = openPage({
      'GET /workflows/1': () => jsonResponse(200, { workflow: DEFAULT_WORKFLOW }),
      'POST /workflows': () => jsonResponse(409, { error: 'name_taken' }),
    });
    window.location.hash = '#/admin/workflows';
    await user.click(await screen.findByRole('button', { name: 'Create a workflow' }));
    const form = screen.getByRole('form', { name: 'New workflow' });
    await user.type(within(form).getByLabelText('Name'), 'Support');
    await user.selectOptions(within(form).getByLabelText('Start from'), '1');
    expect(within(form).queryByLabelText('Initial status')).toBeNull();
    await user.click(within(form).getByRole('button', { name: 'Create workflow' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'A workflow with this name exists already.',
    );
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      name: 'Support',
      definition: DEFAULT_WORKFLOW.published.definition,
    });
  });

  it('[WF-002] deletes an unused workflow after asking', async () => {
    const user = userEvent.setup();
    let workflows = SUMMARIES;
    const calls = openPage({
      'GET /workflows': () => jsonResponse(200, { workflows }),
      'DELETE /workflows/2': () => {
        workflows = SUMMARIES.slice(0, 1);
        return noContent();
      },
    });
    window.location.hash = '#/admin/workflows';
    const support = await workflowItem('Support');
    await user.click(within(support).getByRole('button', { name: 'Delete Support' }));
    const confirm = within(support).getByRole('button', { name: 'Delete workflow' });
    expect(confirm).toHaveFocus();
    await user.click(confirm);
    expect(await screen.findByText('Deleted Support.')).toBeVisible();
    expect(calls.some((c) => c.method === 'DELETE' && c.path === '/workflows/2')).toBe(true);
    expect(screen.getByRole('heading', { name: 'Workflows in this workspace' })).toHaveFocus();
  });

  it('[CORE-014] adds, renames and orders statuses, and explains why one in use stays', async () => {
    const user = userEvent.setup();
    let statuses: Status[] = STATUSES.slice(0, 3);
    const calls = openPage({
      'GET /statuses': () => jsonResponse(200, { statuses }),
      'POST /statuses': (body) => {
        const created = { ...(body as Status), id: 40, order: 4 };
        statuses = [...statuses, created];
        return jsonResponse(201, { status: created });
      },
      'PATCH /statuses/2': (body) => {
        statuses = statuses.map((s) => (s.id === 2 ? { ...s, ...(body as object) } : s));
        return jsonResponse(200, { status: statuses[1] });
      },
      'PUT /statuses/order': (body) => {
        const ids = (body as { statusIds: number[] }).statusIds;
        statuses = ids.map((id) => statuses.find((s) => s.id === id) as Status);
        return jsonResponse(200, { statuses });
      },
      'DELETE /statuses/1': () =>
        jsonResponse(409, { error: 'status_in_use', workflows: [{ id: 1 }], ticketCount: 4 }),
    });
    window.location.hash = '#/admin/workflows';
    const section = await screen.findByRole('region', { name: 'Statuses' });
    const list = await within(section).findByRole('list', { name: 'Statuses' });
    expect(within(list).getAllByText('New stage', { selector: '.stage-badge' })).toHaveLength(3);

    await user.click(within(section).getByRole('button', { name: 'Add a status' }));
    const form = within(section).getByRole('form', { name: 'New status' });
    await user.keyboard('Waiting for parts');
    await user.click(within(form).getByRole('radio', { name: 'Closed' }));
    await user.click(within(form).getByRole('button', { name: 'Add status' }));
    expect(await within(section).findByText('Added Waiting for parts.')).toBeVisible();
    expect(calls.find((c) => c.method === 'POST' && c.path === '/statuses')?.body).toEqual({
      name: 'Waiting for parts',
      stage: 'closed',
      description: '',
    });

    await user.click(within(section).getByRole('button', { name: 'Edit New' }));
    const edit = within(section).getByRole('form', { name: 'Edit New' });
    await user.clear(within(edit).getByLabelText('Name'));
    await user.type(within(edit).getByLabelText('Name'), 'Fresh');
    await user.click(within(edit).getByRole('button', { name: 'Save status' }));
    expect(await within(section).findByText('Saved Fresh.')).toBeVisible();

    await user.click(within(section).getByRole('button', { name: 'Move Fresh up' }));
    expect(await within(section).findByText('Moved Fresh.')).toBeVisible();
    expect(calls.find((c) => c.path === '/statuses/order')?.body).toEqual({
      statusIds: [2, 1, 3, 40],
    });

    await user.click(within(section).getByRole('button', { name: 'Delete Open' }));
    await user.click(within(section).getByRole('button', { name: 'Delete status' }));
    expect(await within(section).findByRole('alert')).toHaveTextContent(
      'Remove Open from every workflow and move its tickets first (4 tickets, 1 workflow).',
    );
  });

  it('[WF-002] is not offered to people who are not administrators', async () => {
    openPage({ 'GET /workflows': () => jsonResponse(403, { error: 'forbidden' }) }, MEMBER);
    expect(screen.queryByRole('link', { name: 'Workflows' })).toBeNull();
    window.location.hash = '#/admin/workflows';
    expect(
      await screen.findByText('Only site and configuration administrators manage workflows.'),
    ).toBeVisible();
  });

  it('[WF-002] passes the pseudo-locale check', async () => {
    const user = userEvent.setup();
    const errors: Error[] = [];
    stubBackend({
      'GET /workflows': () => jsonResponse(200, { workflows: SUMMARIES }),
      'GET /statuses': () => jsonResponse(200, { statuses: STATUSES }),
    });
    window.location.hash = '#/admin/workflows';
    render(<App session={ADMIN} locale="en-XA" onI18nError={(e) => errors.push(e)} />);
    const main = screen.getByRole('main');
    const buttons = await within(main).findAllByRole('button', { expanded: false });
    for (const button of buttons) await user.click(button);
    await waitFor(() => expect(within(main).getAllByRole('form')).toHaveLength(2));
    const texts = visibleTexts(main);
    expect(texts.length).toBeGreaterThan(40);
    expect(untranslated(texts)).toEqual([]);
    expect(errors).toEqual([]);
  });
});
