import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { ADMIN } from '../admin/fixtures';
import { ApiError } from '../api/client';
import { I18nProvider } from '../i18n/I18nProvider';
import { SessionProvider } from '../session/SessionProvider';
import { stubBackend, untranslated, visibleTexts } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import type { WorkflowsClient } from './client';
import { formatDefinition } from './definition';
import {
  fakeWorkflowsClient,
  LOOKUPS,
  S,
  STATUSES,
  SUPPORT_DEFINITION,
  SUPPORT_WORKFLOW,
} from './fixtures';
import { WorkflowEditorPage } from './WorkflowEditorPage';

function renderEditor(client: WorkflowsClient = fakeWorkflowsClient(), workflowId = 2) {
  render(
    <I18nProvider locale="en">
      <SessionProvider session={ADMIN}>
        <main>
          <WorkflowEditorPage workflowId={workflowId} client={client} />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return client;
}

/** Support with a draft that drops Draft, where two tickets wait, and adds Closed. */
const withDraft = () =>
  fakeWorkflowsClient({
    workflows: [
      {
        ...SUPPORT_WORKFLOW,
        draft: {
          version: 3,
          definition: {
            ...SUPPORT_DEFINITION,
            statuses: [
              ...SUPPORT_DEFINITION.statuses.filter((s) => s.statusId !== S.Draft),
              { statusId: S.Closed as number },
            ],
          },
          createdAt: '2026-10-27T15:00:00.000Z',
          publishedAt: null,
        },
      },
    ],
    ticketsIn: { [S.Draft as number]: 2 },
  });

const checks = () => screen.getByRole('region', { name: 'Checks before publishing' });
const statusList = () => screen.getByRole('list', { name: 'Statuses in this workflow' });
const transitionList = () => screen.getByRole('list', { name: 'Transitions' });

describe('workflow editor (M1-030)', () => {
  it('[WF-002] [WF-012] shows the draft as a diagram with lists, and warns about an unreachable status', async () => {
    renderEditor();
    expect(await screen.findByRole('heading', { level: 1, name: 'Support' })).toBeVisible();
    expect(screen.getByText('Published version 2')).toBeVisible();
    expect(screen.getByText('Used by 1 track: HELP')).toBeVisible();
    // The diagram is a picture; the lists are what assistive technology reads.
    const diagram = screen.getByRole('region', { name: 'Diagram' });
    expect(diagram).toHaveAttribute('tabindex', '0');
    expect(within(diagram).queryAllByRole('button')).toHaveLength(0);
    expect(
      within(statusList())
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Open', 'Active', 'Under review', 'Approved', 'Rejected', 'Draft']);
    expect(within(transitionList()).getByText('From any status to Rejected')).toBeVisible();
    expect(within(transitionList()).getByText('3 guards, no checks, 1 effect')).toBeVisible();
    expect(
      within(checks()).getByText('No transition leads to Draft: tickets can never get there.'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Save draft' })).toBeDisabled();
  });

  it('[WF-001] [WF-003] [WF-004] [WF-005] adds a transition with a guard, a check and an effect, and saves them in the draft', async () => {
    const user = userEvent.setup();
    const client = fakeWorkflowsClient();
    const save = vi.spyOn(client, 'saveDraft');
    renderEditor(client);
    await user.click(await screen.findByRole('button', { name: 'Add a transition' }));
    const name = screen.getByLabelText('Name');
    expect(name).toHaveFocus();
    await user.clear(name);
    await user.keyboard('Park');
    const panel = screen.getByRole('region', { name: 'Transition: Park' });
    await user.selectOptions(within(panel).getByLabelText('Goes to'), String(S.Draft));
    // The warning goes as soon as a transition leads to Draft.
    expect(within(checks()).getByText('No problems found.')).toBeVisible();

    await user.selectOptions(within(panel).getByLabelText('New guard'), 'user-in-role');
    await user.click(within(panel).getByRole('button', { name: 'Add guard' }));
    const guard = within(panel).getByRole('group', { name: 'Guard 1: Holds a track role' });
    await user.selectOptions(within(guard).getByLabelText('Track role'), '2');

    await user.selectOptions(within(panel).getByLabelText('New check'), 'field-required');
    await user.click(within(panel).getByRole('button', { name: 'Add check' }));
    const check = within(panel).getByRole('group', { name: 'Check 1: A field is filled in' });
    await user.selectOptions(within(check).getByLabelText('Field'), 'assignee');
    await user.type(within(check).getByLabelText('Message when it blocks'), 'Name someone first.');

    await user.selectOptions(within(panel).getByLabelText('New effect'), 'assign-to-requester');
    await user.click(within(panel).getByRole('button', { name: 'Add effect' }));
    expect(
      within(panel).getByRole('group', { name: 'Effect 1: Assign to the requester' }),
    ).toBeVisible();
    expect(screen.getByText('Unsaved changes')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByText('Saved draft version 3.')).toBeVisible();
    const saved = save.mock.calls[0]?.[1];
    expect(saved?.transitions.at(-1)).toEqual({
      id: 6,
      name: 'Park',
      from: [S.Open],
      to: S.Draft,
      guards: { all: [{ type: 'user-in-role', role: '2' }] },
      checks: [{ type: 'field-required', field: 'assignee', message: 'Name someone first.' }],
      effects: [{ type: 'assign-to-requester' }],
    });
    expect(screen.getByText('Draft version 3')).toBeVisible();
    expect(screen.queryByText('Unsaved changes')).toBeNull();
  });

  it('[WF-002] works from the keyboard: an entry opens with Enter and focus moves to its details', async () => {
    const user = userEvent.setup();
    renderEditor();
    const take = await within(await screen.findByRole('list', { name: 'Transitions' })).findByRole(
      'button',
      { name: 'Take' },
    );
    take.focus();
    await user.keyboard('{Enter}');
    expect(take).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: 'Transition: Take' })).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText('Name')).toHaveFocus();
    await user.keyboard('{End} now');
    expect(within(transitionList()).getByRole('button', { name: 'Take now' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Transition: Take now' })).toBeVisible();
  });

  it('[WF-002] renames the workflow', async () => {
    const user = userEvent.setup();
    const client = fakeWorkflowsClient();
    const update = vi.spyOn(client, 'update');
    renderEditor(client);
    await user.click(await screen.findByText('Name and description'));
    const form = screen.getByRole('form', { name: 'Name and description' });
    await user.clear(within(form).getByLabelText('Name'));
    await user.type(within(form).getByLabelText('Name'), 'Help desk');
    await user.click(within(form).getByRole('button', { name: 'Save name and description' }));
    expect(await within(form).findByText('Saved the name and description.')).toBeVisible();
    expect(update).toHaveBeenCalledWith(2, {
      name: 'Help desk',
      description: 'Requests with a review step',
    });
    expect(screen.getByRole('heading', { level: 1, name: 'Help desk' })).toBeVisible();
  });

  it('[WF-003] nests guards in all and any groups', async () => {
    const user = userEvent.setup();
    const client = fakeWorkflowsClient();
    const save = vi.spyOn(client, 'saveDraft');
    renderEditor(client);
    await user.click(
      await within(await screen.findByRole('list', { name: 'Transitions' })).findByRole('button', {
        name: 'Rework',
      }),
    );
    const panel = screen.getByRole('region', { name: 'Transition: Rework' });
    expect(screen.getByRole('heading', { name: 'Transition: Rework' })).toHaveFocus();
    await user.click(within(panel).getByRole('button', { name: 'Add guard' }));
    await user.click(within(panel).getByRole('button', { name: 'Add a group' }));
    const group = within(panel).getByRole('group', { name: 'Group 2: one must pass' });
    await user.selectOptions(within(group).getByLabelText('New guard'), 'only-requester');
    await user.click(within(group).getByRole('button', { name: 'Add guard' }));
    await user.selectOptions(within(group).getByLabelText('New guard'), 'user-in-any-group');
    await user.click(within(group).getByRole('button', { name: 'Add guard' }));
    await user.click(within(group).getByRole('checkbox', { name: 'Change board' }));
    await user.click(within(panel).getByRole('button', { name: 'Move guard 1 down' }));
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await screen.findByText('Saved draft version 3.');
    expect(save.mock.calls[0]?.[1].transitions.find((x) => x.id === 5)?.guards).toEqual({
      all: [
        { any: [{ type: 'only-requester' }, { type: 'user-in-any-group', groups: ['2'] }] },
        { type: 'only-assignee' },
      ],
    });
  });

  it('[WF-002] switches to text and back without losing anything, and refuses text that does not read', async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(await screen.findByRole('button', { name: 'Text' }));
    const text = screen.getByLabelText('Definition (JSON)') as HTMLTextAreaElement;
    expect(text.value).toBe(formatDefinition(SUPPORT_DEFINITION));
    expect(screen.getByText(`${S.Draft}: Draft`)).toBeVisible();

    await user.type(text, 'x');
    expect(
      within(checks()).getByText(/^The text is not valid JSON near line \d+, column \d+\.$/),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Diagram' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Fix the text first');
    expect(screen.getByRole('button', { name: 'Text' })).toHaveAttribute('aria-pressed', 'true');

    const renamed = formatDefinition({
      ...SUPPORT_DEFINITION,
      transitions: SUPPORT_DEFINITION.transitions.map((x) =>
        x.id === 5 ? { ...x, name: 'Send back', from: 'any' } : x,
      ),
    });
    await user.clear(text);
    await user.click(text);
    await user.paste(renamed);
    expect(within(checks()).queryByText(/not valid JSON/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Diagram' }));
    expect(within(transitionList()).getByRole('button', { name: 'Send back' })).toBeVisible();
    expect(within(transitionList()).getByText('From any status to Active')).toBeVisible();
    // And back to text: the same definition, byte for byte.
    await user.click(screen.getByRole('button', { name: 'Text' }));
    expect((screen.getByLabelText('Definition (JSON)') as HTMLTextAreaElement).value).toBe(renamed);
  });

  it('[WF-002] names the shape problem in text mode by its path', async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(await screen.findByRole('button', { name: 'Text' }));
    const text = screen.getByLabelText('Definition (JSON)');
    await user.clear(text);
    await user.click(text);
    await user.paste(
      JSON.stringify({
        ...SUPPORT_DEFINITION,
        transitions: [{ ...SUPPORT_DEFINITION.transitions[0], guards: { type: 'teleport' } }],
      }),
    );
    expect(
      within(checks()).getByText(
        'At definition.transitions[0].guards.type: unknown type teleport.',
      ),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Fix the errors under Checks');
  });

  it('[WF-002] shows the problem the server found in a definition', async () => {
    const user = userEvent.setup();
    const client = fakeWorkflowsClient();
    client.saveDraft = async () => {
      throw new ApiError(400, {
        error: 'invalid_request',
        detail: { problem: 'invalid_value', transitionId: 3, field: 'close-reason' },
      });
    };
    renderEditor(client);
    await user.click(
      await within(await screen.findByRole('list', { name: 'Transitions' })).findByRole('button', {
        name: 'Reject',
      }),
    );
    await user.click(screen.getByRole('radio', { name: 'These statuses' }));
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Approve: the value for close-reason is not valid.',
    );
  });

  it('[WF-002] removes a status with the transitions that need it, after saying which', async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.click(
      await within(
        await screen.findByRole('list', { name: 'Statuses in this workflow' }),
      ).findByRole('button', { name: 'Under review' }),
    );
    const panel = screen.getByRole('region', { name: 'Status: Under review' });
    expect(within(panel).getByText('1 transition leads here: Ask for review.')).toBeVisible();
    await user.click(
      within(panel).getByRole('button', { name: 'Remove Under review from the workflow' }),
    );
    expect(
      within(panel).getByText(
        'It also removes 3 transitions: Ask for review, Approve, and Rework.',
      ),
    ).toBeVisible();
    expect(
      within(panel).getByText(
        'Tickets in Under review move to a status you choose when you publish.',
      ),
    ).toBeVisible();
    await user.click(within(panel).getByRole('button', { name: 'Remove status' }));
    expect(screen.getByRole('heading', { name: 'Statuses in this workflow' })).toHaveFocus();
    expect(within(statusList()).queryByRole('button', { name: 'Under review' })).toBeNull();
    expect(
      within(transitionList())
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['Take', 'Reject']);
    // Approved is now out of reach.
    expect(within(checks()).getByText(/No transition leads to Approved/)).toBeVisible();
  });

  it('[WF-002] publishes after asking where the tickets of a dropped status go', async () => {
    const user = userEvent.setup();
    const client = withDraft();
    const publish = vi.spyOn(client, 'publish');
    renderEditor(client);
    await user.click(await screen.findByRole('button', { name: 'Publish' }));
    const panel = await screen.findByRole('region', { name: 'Publish version 3' });
    expect(screen.getByRole('heading', { name: 'Publish version 3' })).toHaveFocus();
    expect(within(panel).getByText('It applies at once to 1 track: HELP.')).toBeVisible();
    await user.click(within(panel).getByRole('button', { name: 'Publish now' }));
    expect(within(panel).getByRole('alert')).toHaveTextContent(
      'Choose where the tickets of each dropped status go.',
    );
    await user.selectOptions(
      within(panel).getByLabelText('Move the 2 tickets in Draft to'),
      String(S.Open),
    );
    await user.click(within(panel).getByRole('button', { name: 'Publish now' }));
    expect(
      await screen.findByText(
        'Version 3 is published. The next transition of every ticket uses it.',
      ),
    ).toBeVisible();
    expect(publish).toHaveBeenCalledWith(2, { [String(S.Draft)]: S.Open });
    expect(screen.getByText('Published version 3')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Publish version 3' })).toBeNull();
  });

  it('[WF-002] discards the draft after asking', async () => {
    const user = userEvent.setup();
    const client = withDraft();
    const discard = vi.spyOn(client, 'discardDraft');
    renderEditor(client);
    await user.click(await screen.findByRole('button', { name: 'Discard draft' }));
    const confirm = screen.getAllByRole('button', { name: 'Discard draft' })[1] as HTMLElement;
    expect(confirm).toHaveFocus();
    await user.click(confirm);
    expect(await screen.findByText(/The draft is gone/)).toBeVisible();
    expect(discard).toHaveBeenCalledWith(2);
    expect(screen.getByText('No draft: the first saved change starts one.')).toBeVisible();
    expect(within(statusList()).getByRole('button', { name: 'Draft' })).toBeVisible();
  });

  it('[WF-002] restores an earlier version as the draft', async () => {
    const user = userEvent.setup();
    const client = withDraft();
    const restore = vi.spyOn(client, 'restore');
    renderEditor(client);
    await user.click(await screen.findByRole('button', { name: 'Version history' }));
    const history = await screen.findByRole('region', { name: 'Version history' });
    expect(await within(history).findAllByRole('listitem')).toHaveLength(3);
    await user.click(
      await within(history).findByRole('button', { name: 'Restore version 1 as the draft' }),
    );
    // A draft exists, so restoring asks first.
    await user.click(within(history).getByRole('button', { name: 'Restore version 1' }));
    expect(
      await screen.findByText('Version 1 is the draft now. Publish it to use it again.'),
    ).toBeVisible();
    expect(restore).toHaveBeenCalledWith(2, 1);
    expect(within(statusList()).getByRole('button', { name: 'Draft' })).toBeVisible();
  });

  it('[WF-002] on a phone the diagram waits behind a button and the lists come first', async () => {
    const user = userEvent.setup();
    act(() => setViewportWidth(390));
    renderEditor();
    const toggle = await screen.findByRole('button', { name: 'Show the diagram' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: 'Diagram' })).toBeNull();
    expect(statusList()).toBeVisible();
    await user.click(toggle);
    expect(screen.getByRole('region', { name: 'Diagram' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Hide the diagram' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    act(() => setViewportWidth(1440));
    expect(screen.queryByRole('button', { name: 'Hide the diagram' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Diagram' })).toBeVisible();
  });

  it('[WF-002] tells people who may not manage workflows', async () => {
    const client = fakeWorkflowsClient();
    client.get = async () => {
      throw new ApiError(403, { error: 'forbidden' });
    };
    renderEditor(client);
    expect(
      await screen.findByText('Only site and configuration administrators manage workflows.'),
    ).toBeVisible();
  });

  it('[WF-002] opens from its address and passes the pseudo-locale check', async () => {
    const user = userEvent.setup();
    const errors: Error[] = [];
    stubBackend({
      'GET /workflows/2': () => jsonResponse(200, { workflow: SUPPORT_WORKFLOW }),
      'GET /statuses': () => jsonResponse(200, { statuses: STATUSES }),
      'GET /roles': () => jsonResponse(200, { roles: LOOKUPS.roles }),
      'GET /groups': () => jsonResponse(200, { groups: LOOKUPS.groups }),
      'GET /permissions/catalogue': () =>
        jsonResponse(200, { track: { tickets: LOOKUPS.permissions } }),
    });
    window.location.hash = '#/admin/workflows/2';
    render(<App session={ADMIN} locale="en-XA" onI18nError={(e) => errors.push(e)} />);
    const main = screen.getByRole('main');
    const list = await within(main).findByRole('list', { name: /Ťŕáñšíťíóñš/ });
    // A transition's panel holds most of the editor's words.
    await user.click(within(list).getAllByRole('button')[0] as HTMLElement);
    await waitFor(() => expect(within(main).getAllByRole('group').length).toBeGreaterThan(5));
    const texts = visibleTexts(main);
    expect(texts.length).toBeGreaterThan(80);
    expect(untranslated(texts)).toEqual([]);
    expect(errors).toEqual([]);
  });
});
