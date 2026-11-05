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
  window.location.hash = '#/admin';
  render(<App session={session} />);
  return calls;
}

/** A workflow file as a Taskmoor server writes it (M1-127); every name is made up. */
const FILE = {
  format: 'taskmoor-workflow',
  version: 1,
  workflow: { name: 'Support copy', description: '' },
  statuses: [
    { id: 1, name: 'Open', stage: 'new', description: '' },
    { id: 2, name: 'Waiting', stage: 'active', description: '' },
    { id: 3, name: 'Approved', stage: 'active', description: '' },
  ],
  groups: [{ id: 1, name: 'Agents' }],
  definition: {
    initialStatusId: 1,
    statuses: [{ statusId: 1 }, { statusId: 2 }, { statusId: 3 }],
    transitions: [
      { id: 1, name: 'Wait', from: [1], to: 2, guards: { type: 'user-in-group', group: '1' } },
    ],
  },
};
const REPORT = {
  statuses: [
    { name: 'Open', stage: 'new', statusId: S.Open, outcome: 'matched' },
    { name: 'Waiting', stage: 'active', statusId: 77, outcome: 'created' },
    {
      name: 'Approved',
      stage: 'active',
      statusId: S.Approved,
      outcome: 'matched',
      stageHere: 'closed',
    },
  ],
  problems: [
    {
      kind: 'group',
      name: 'Agents',
      rule: 'user-in-group',
      outcome: 'guard_never_passes',
      transition: { id: 1, name: 'Wait' },
    },
    { kind: 'role', name: 'Leads', rule: 'edit', outcome: 'narrowed', status: 'Waiting' },
  ],
};
const fileOf = (content: unknown, name = 'support.workflow.json') =>
  new File([typeof content === 'string' ? content : JSON.stringify(content)], name, {
    type: 'application/json',
  });

const workflowItem = async (name: string) => {
  const list = await screen.findByRole('list', { name: 'Workflows in this workspace' });
  const item = within(list)
    .getAllByRole('listitem')
    .find((li) => within(li).queryByRole('link', { name }));
  if (!item) throw new Error(`no workflow named ${name}`);
  return item;
};

/** The list's buttons that open a form, once it has loaded; the header's help button is not one. */
const formButtons = (main: HTMLElement) =>
  waitFor(() => {
    const found = within(main)
      .getAllByRole('button', { expanded: false })
      .filter((button) => !button.closest('.page-header'));
    expect(found.length).toBeGreaterThan(0);
    return found;
  });

describe('workflows administration (M1-030)', () => {
  it('[WF-001] [WF-002] Administration leads to the workflows, with their versions, drafts and tracks', async () => {
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
    expect(
      within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', {
        name: 'Administration',
      }),
    ).toHaveAttribute('aria-current', 'page');
  });

  it('[WF-001] [WF-008] starts a workflow with an initial status, moving freely unless told otherwise, and opens it', async () => {
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
    expect(within(form).getByLabelText('Start from')).toHaveDisplayValue(
      'A workflow that moves freely',
    );
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

  it("[WF-011] downloads each workflow as a file in Taskmoor's own format", async () => {
    openPage();
    window.location.hash = '#/admin/workflows';
    const support = await workflowItem('Support');
    const download = within(support).getByRole('link', {
      name: 'Download Support as a workflow file',
    });
    expect(download).toHaveAttribute('href', '/api/v1/admin/workflows/2/export');
    expect(download).toHaveAttribute('download');
  });

  it('[WF-011] imports a file as a new workflow and reports what was not found here', async () => {
    const user = userEvent.setup();
    const calls = openPage({
      'POST /admin/workflows/import': () =>
        jsonResponse(201, {
          workflow: { ...SUPPORT_WORKFLOW, id: 9, name: 'Support copy', draft: null },
          report: REPORT,
        }),
    });
    window.location.hash = '#/admin/workflows';
    await user.click(await screen.findByRole('button', { name: 'Import a workflow' }));
    const form = screen.getByRole('form', { name: 'Import a workflow file' });
    const input = within(form).getByLabelText('Workflow file');
    expect(input).toHaveFocus();
    await user.click(within(form).getByRole('button', { name: 'Import' }));
    expect(within(form).getByRole('alert')).toHaveTextContent('Choose a workflow file.');
    await user.upload(input, fileOf(FILE));
    // The name comes from the file, and can be changed.
    await waitFor(() => expect(within(form).getByLabelText('Name')).toHaveValue('Support copy'));
    await user.click(within(form).getByRole('button', { name: 'Import' }));
    const report = await screen.findByRole('region', { name: 'Imported Support copy' });
    expect(within(report).getByRole('heading', { name: 'Imported Support copy' })).toHaveFocus();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      document: FILE,
      name: 'Support copy',
    });
    const lines = within(report)
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(lines).toEqual([
      'Open: found here by name',
      'Waiting: created, in the Active stage',
      'Approved: found here by name, but it is in the Closed stage here and in the Active stage in the file',
      'Group Agents, in the transition Wait: the guard that names it never passes.',
      'Role Leads, in the edit lock of the status Waiting: left out of the list.',
    ]);
    expect(within(report).getByRole('link', { name: 'Open Support copy' })).toHaveAttribute(
      'href',
      '#/admin/workflows/9',
    );
  });

  it('[WF-011] imports a file as the next draft of a workflow, and says why a file is refused', async () => {
    const user = userEvent.setup();
    let answer = jsonResponse(400, { error: 'unsupported_version' });
    const calls = openPage({ 'POST /admin/workflows/2/import': () => answer });
    window.location.hash = '#/admin/workflows';
    await user.click(await screen.findByRole('button', { name: 'Import a workflow' }));
    const form = screen.getByRole('form', { name: 'Import a workflow file' });
    await user.upload(within(form).getByLabelText('Workflow file'), fileOf('not json'));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'This file is not JSON. Choose a workflow file downloaded from Taskmoor.',
    );
    await user.upload(within(form).getByLabelText('Workflow file'), fileOf(FILE));
    await user.selectOptions(within(form).getByLabelText('Import as'), '2');
    expect(within(form).queryByLabelText('Name')).toBeNull();
    await user.click(within(form).getByRole('button', { name: 'Import' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'This workflow file comes from a newer version of Taskmoor. Update this server to import it.',
    );
    answer = jsonResponse(400, {
      error: 'invalid_request',
      detail: { document: [{ path: 'statuses.0.stage', message: 'Invalid option' }] },
    });
    await user.click(within(form).getByRole('button', { name: 'Import' }));
    await waitFor(() =>
      expect(within(form).getByRole('alert')).toHaveTextContent(
        'The workflow file is damaged at statuses.0.stage, so nothing was imported.',
      ),
    );
    answer = jsonResponse(200, {
      workflow: { ...SUPPORT_WORKFLOW, draft: { ...SUPPORT_WORKFLOW.published, version: 3 } },
      report: { statuses: REPORT.statuses.slice(0, 1), problems: [] },
    });
    await user.click(within(form).getByRole('button', { name: 'Import' }));
    const report = await screen.findByRole('region', { name: 'Imported Support' });
    expect(report).toHaveTextContent(
      'It is the draft, version 3: check it in the editor and publish it when it is right.',
    );
    expect(report).toHaveTextContent('Everything else the file names was found here.');
    expect(calls.filter((c) => c.path === '/admin/workflows/2/import')).toHaveLength(3);
  });

  it('[WF-011] words the import report through the catalogue (pseudo-locale)', async () => {
    const user = userEvent.setup();
    const errors: Error[] = [];
    stubBackend({
      'GET /workflows': () => jsonResponse(200, { workflows: SUMMARIES }),
      'GET /statuses': () => jsonResponse(200, { statuses: STATUSES }),
      'POST /admin/workflows/import': () =>
        jsonResponse(201, { workflow: { ...SUPPORT_WORKFLOW, id: 9 }, report: REPORT }),
    });
    window.location.hash = '#/admin/workflows';
    render(<App session={ADMIN} locale="en-XA" onI18nError={(e) => errors.push(e)} />);
    const main = screen.getByRole('main');
    const buttons = await formButtons(main);
    await user.click(buttons[0] as HTMLElement);
    const form = within(main).getByRole('form');
    const [input] = within(form).getAllByLabelText(/.+/);
    await user.upload(input as HTMLElement, fileOf(FILE));
    await user.click(within(form).getAllByRole('button')[0] as HTMLElement);
    await waitFor(() => expect(main.querySelector('.workflow-import-report')).not.toBeNull());
    const texts = visibleTexts(main.querySelector('.workflow-import-report') as HTMLElement);
    expect(texts.length).toBeGreaterThan(8);
    expect(untranslated(texts)).toEqual([]);
    expect(errors).toEqual([]);
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
    const buttons = await formButtons(main);
    for (const button of buttons) await user.click(button);
    await waitFor(() => expect(within(main).getAllByRole('form')).toHaveLength(2));
    const texts = visibleTexts(main);
    expect(texts.length).toBeGreaterThan(40);
    expect(untranslated(texts)).toEqual([]);
    expect(errors).toEqual([]);
  });
});
