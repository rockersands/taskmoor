import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ADMIN, CONFIG_ADMIN, TRACK_ADMIN } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { NotificationPoliciesPage } from './NotificationPoliciesPage';
import type { RuleInput } from './policiesClient';
import { BUILT_IN_EVENTS, type FakePoliciesClient, fakePoliciesClient } from './policiesFixtures';

function renderPage(
  options: {
    session?: Session;
    client?: FakePoliciesClient;
    trackId?: number | null;
    locale?: Locale;
  } = {},
) {
  const client = options.client ?? fakePoliciesClient();
  render(
    <I18nProvider locale={options.locale ?? 'en'}>
      <SessionProvider session={options.session ?? ADMIN}>
        <main>
          <NotificationPoliciesPage client={client} trackId={options.trackId ?? null} />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return client;
}

/** The rules a save sent, the last one first. */
const lastRules = (client: FakePoliciesClient) =>
  (
    client.calls.filter((c) => c.action === 'update').at(-1)?.args[1] as
      | { rules?: RuleInput[] }
      | undefined
  )?.rules;

async function openPolicy(name: string) {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: `Manage ${name}` }));
  return user;
}

describe('notification policies (NTF-001, T-155)', () => {
  it('[NTF-001] lists every shared policy with the tracks that use it, the default first', async () => {
    renderPage();
    const list = await screen.findByRole('region', { name: 'Shared policies' });
    const rows = await within(list).findAllByRole('listitem');
    expect(rows[0]).toHaveTextContent(/^Default notificationsDefault/);
    expect(rows[0]).toHaveTextContent(
      'Tracks that name no other policy use it. Used by SHOP. 45 rules.',
    );
    expect(rows[1]).toHaveTextContent('Payments');
    expect(rows[1]).toHaveTextContent('No track uses it. 6 rules.');
    // A track's own policy belongs on that track's page.
    expect(within(list).queryByText('On-call alerts')).toBeNull();
    expect(within(list).getByRole('link', { name: 'Which sets a track uses' })).toHaveAttribute(
      'href',
      '#/admin/track-sets',
    );
  });

  it('[NTF-001] shows a policy’s rules by event, naming who each reaches', async () => {
    renderPage();
    await openPolicy('Payments');
    expect(screen.getByRole('heading', { name: 'Who hears of what in Payments' })).toBeVisible();
    const created = screen.getByRole('list', { name: 'Ticket created' });
    expect(within(created).getByText('Members of Payments team')).toBeVisible();
    const closed = screen.getByRole('list', { name: 'Ticket closed' });
    expect(within(closed).getByText('People with the role Members')).toBeVisible();
    expect(within(closed).getByText('Ana Ruiz')).toBeVisible();
    const review = screen.getByRole('list', { name: 'Transition event “ready-for-review”' });
    expect(within(review).getByText('People in Reviewer')).toBeVisible();
  });

  it('[NTF-001] (1) adds followers to an event and removes a rule, saving the whole list', async () => {
    const client = renderPage();
    const user = await openPolicy('Payments');
    const form = screen.getByRole('form', { name: 'Add a rule to Payments' });
    await user.selectOptions(within(form).getByLabelText('Event'), 'Ticket updated');
    await user.selectOptions(within(form).getByLabelText('Who hears of it'), 'The followers');
    await user.click(within(form).getByRole('button', { name: 'Add rule' }));
    expect(
      await screen.findByText('Rule added for Ticket updated: The followers.'),
    ).toBeInTheDocument();
    expect(lastRules(client)).toHaveLength(7);
    expect(lastRules(client)?.at(-1)).toEqual({ event: 'ticket_updated', recipient: 'follower' });
    expect(
      within(screen.getByRole('list', { name: 'Ticket updated' })).getByText('The followers'),
    ).toBeVisible();

    await user.click(
      screen.getByRole('button', { name: 'Remove Members of Payments team from Ticket created' }),
    );
    expect(
      await screen.findByText('Rule removed for Ticket created: Members of Payments team.'),
    ).toBeInTheDocument();
    expect(lastRules(client)).not.toContainEqual(
      expect.objectContaining({ event: 'ticket_created' }),
    );
    // Its button is gone: the policy's rules heading has the focus.
    expect(screen.getByRole('heading', { name: 'Who hears of what in Payments' })).toHaveFocus();
    expect(screen.queryByRole('list', { name: 'Ticket created' })).toBeNull();
  });

  it('[NTF-001] (2) names an event a transition fires, from the list or typed', async () => {
    const client = renderPage();
    const user = await openPolicy('Payments');
    const form = screen.getByRole('form', { name: 'Add a rule to Payments' });
    await user.selectOptions(
      within(form).getByLabelText('Event'),
      'Transition event “ready-for-review”',
    );
    await user.selectOptions(within(form).getByLabelText('Who hears of it'), 'The assignee');
    await user.click(within(form).getByRole('button', { name: 'Add rule' }));
    await screen.findByText(/^Rule added for Transition event “ready-for-review”/);
    expect(lastRules(client)?.at(-1)).toEqual({
      event: 'custom:ready-for-review',
      recipient: 'assignee',
    });

    await user.selectOptions(within(form).getByLabelText('Event'), 'Another transition event…');
    const name = within(form).getByLabelText('Transition event name');
    await user.type(name, 'ready/now');
    await user.click(within(form).getByRole('button', { name: 'Add rule' }));
    expect(within(form).getByRole('alert')).toHaveTextContent(/^Give the event’s name/);
    await user.clear(name);
    await user.type(name, 'Ready to ship');
    await user.click(within(form).getByRole('button', { name: 'Add rule' }));
    await screen.findByText('Rule added for Transition event “Ready to ship”: The assignee.');
    expect(lastRules(client)?.at(-1)).toEqual({
      event: 'custom:Ready to ship',
      recipient: 'assignee',
    });
  });

  it('[NTF-001] names a person, a group, a role or a field, and offers only what exists', async () => {
    const client = renderPage();
    const user = await openPolicy('Payments');
    const form = screen.getByRole('form', { name: 'Add a rule to Payments' });
    await user.selectOptions(within(form).getByLabelText('Event'), 'Comment added');
    await user.selectOptions(within(form).getByLabelText('Who hears of it'), 'A person');
    await user.type(within(form).getByRole('searchbox', { name: 'Find a person' }), 'bo');
    await waitFor(() =>
      expect(within(form).getByLabelText('Person')).toHaveDisplayValue('Bo Lindqvist'),
    );
    await user.click(within(form).getByRole('button', { name: 'Add rule' }));
    await screen.findByText('Rule added for Comment added: Bo Lindqvist.');
    expect(lastRules(client)?.at(-1)).toEqual({
      event: 'ticket_commented',
      recipient: 'user',
      userId: 22,
    });

    await user.selectOptions(
      within(form).getByLabelText('Who hears of it'),
      'The members of the groups in a group field',
    );
    expect(within(form).getByLabelText('Group field')).toHaveDisplayValue('Owning team');
    await user.click(within(form).getByRole('button', { name: 'Add rule' }));
    await screen.findByText('Rule added for Comment added: Members of the groups in Owning team.');
    expect(lastRules(client)?.at(-1)).toEqual({
      event: 'ticket_commented',
      recipient: 'group_field',
      fieldKey: 'cf[32]',
    });
    // A shared policy names shared fields only; OPS's own field is not offered.
    await user.selectOptions(
      within(form).getByLabelText('Who hears of it'),
      'The people in a user field',
    );
    expect(
      within(within(form).getByLabelText('User field')).queryByRole('option', { name: 'On call' }),
    ).toBeNull();
  });

  it('[NTF-001] leaves out a recipient type with nothing to choose from', async () => {
    renderPage({ client: fakePoliciesClient({ groups: [] }) });
    await openPolicy('Payments');
    const kinds = within(
      screen.getByRole('form', { name: 'Add a rule to Payments' }),
    ).getByLabelText('Who hears of it');
    expect(within(kinds).queryByRole('option', { name: 'The members of a group' })).toBeNull();
    expect(
      within(kinds).getByRole('option', { name: 'The people with a track role' }),
    ).toBeVisible();
    // The rule already naming a group still says which.
    expect(screen.getByText('Members of Payments team')).toBeVisible();
  });

  it('[NTF-001] refuses a rule the policy has already, sending nothing', async () => {
    const client = renderPage();
    const user = await openPolicy('Payments');
    const form = screen.getByRole('form', { name: 'Add a rule to Payments' });
    await user.selectOptions(within(form).getByLabelText('Event'), 'Comment added');
    await user.selectOptions(within(form).getByLabelText('Who hears of it'), 'The followers');
    await user.click(within(form).getByRole('button', { name: 'Add rule' }));
    expect(within(form).getByRole('alert')).toHaveTextContent('That rule is there already.');
    expect(client.calls.filter((c) => c.action === 'update')).toEqual([]);
  });

  it('[NTF-001] never names a person the choice no longer shows', async () => {
    const client = renderPage();
    const user = await openPolicy('Payments');
    const form = screen.getByRole('form', { name: 'Add a rule to Payments' });
    const person = () => within(form).getByLabelText('Person');
    await user.selectOptions(within(form).getByLabelText('Event'), 'Comment added');
    await user.selectOptions(within(form).getByLabelText('Who hears of it'), 'A person');
    const find = within(form).getByRole('searchbox', { name: 'Find a person' });
    // A search emptied again lists no one, and so leaves no one chosen.
    await user.type(find, 'ana');
    await waitFor(() => expect(person()).toHaveDisplayValue('Ana Ruiz'));
    await user.clear(find);
    await waitFor(() => expect(person()).toHaveDisplayValue('Type a name above to find someone'));
    await user.click(within(form).getByRole('button', { name: 'Add rule' }));
    expect(within(form).getByRole('alert')).toHaveTextContent('Choose who the rule names first.');
    expect(client.calls.filter((c) => c.action === 'update')).toEqual([]);

    // After a person is added, another event does not silently take the same person.
    await user.type(find, 'bo');
    await waitFor(() => expect(person()).toHaveDisplayValue('Bo Lindqvist'));
    await user.click(within(form).getByRole('button', { name: 'Add rule' }));
    await screen.findByText('Rule added for Comment added: Bo Lindqvist.');
    expect(person()).toHaveDisplayValue('Type a name above to find someone');
    await user.selectOptions(within(form).getByLabelText('Event'), 'Ticket updated');
    await user.click(within(form).getByRole('button', { name: 'Add rule' }));
    expect(within(form).getByRole('alert')).toHaveTextContent('Choose who the rule names first.');
    expect(client.calls.filter((c) => c.action === 'update')).toHaveLength(1);
  });

  it('[NTF-001] a rule naming a field since deleted goes with the next change, and is said', async () => {
    const client = renderPage({ client: fakePoliciesClient({ goneField: true }) });
    const user = await openPolicy('Payments');
    const note =
      'A rule names a field since deleted, so it reaches nobody. The next change to these rules removes it.';
    expect(screen.getByText(note)).toBeVisible();
    const created = screen.getByRole('list', { name: 'Ticket created' });
    expect(within(created).getByText('People in something since deleted')).toBeVisible();

    // Adding a rule is not refused for the one naming the deleted field: that one goes.
    const form = screen.getByRole('form', { name: 'Add a rule to Payments' });
    await user.selectOptions(within(form).getByLabelText('Event'), 'Ticket updated');
    await user.selectOptions(within(form).getByLabelText('Who hears of it'), 'The followers');
    await user.click(within(form).getByRole('button', { name: 'Add rule' }));
    expect(
      await screen.findByText(
        'Rule added for Ticket updated: The followers. The rule naming a field since deleted was removed too.',
      ),
    ).toBeInTheDocument();
    expect(lastRules(client)).toHaveLength(7);
    expect(lastRules(client)).not.toContainEqual(expect.objectContaining({ fieldKey: 'cf[39]' }));
    expect(screen.queryByText(note)).toBeNull();
    expect(screen.queryByText('People in something since deleted')).toBeNull();
  });

  it('[NTF-001] removes a rule naming a field since deleted, or another rule beside it', async () => {
    const client = renderPage({ client: fakePoliciesClient({ goneField: true }) });
    const user = await openPolicy('Payments');
    await user.click(
      screen.getByRole('button', { name: 'Remove The followers from Comment added' }),
    );
    expect(
      await screen.findByText(
        'Rule removed for Comment added: The followers. The rule naming a field since deleted was removed too.',
      ),
    ).toBeInTheDocument();
    expect(lastRules(client)).toHaveLength(5);
    expect(screen.queryByText('People in something since deleted')).toBeNull();
  });

  it('[NTF-001] removing the rule naming a field since deleted says only that', async () => {
    renderPage({ client: fakePoliciesClient({ goneField: true }) });
    const user = await openPolicy('Payments');
    await user.click(
      screen.getByRole('button', {
        name: 'Remove People in something since deleted from Ticket created',
      }),
    );
    expect(
      await screen.findByText(
        'Rule removed for Ticket created: People in something since deleted.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/was removed too/)).toBeNull();
  });

  it('[NTF-001] a copy of a policy leaves out a rule naming a field since deleted', async () => {
    const user = userEvent.setup();
    const client = renderPage({ client: fakePoliciesClient({ goneField: true }) });
    await user.click(await screen.findByRole('button', { name: 'New policy' }));
    const form = screen.getByRole('form', { name: 'Add policy' });
    await user.selectOptions(within(form).getByLabelText('Start with'), 'The rules of Payments');
    await user.type(within(form).getByLabelText('Policy name'), 'Payments copy');
    await user.click(within(form).getByRole('button', { name: 'Add policy' }));
    expect(await screen.findByText('Policy Payments copy was added.')).toBeInTheDocument();
    const made = client.calls.find((c) => c.action === 'create')?.args[0] as {
      rules: RuleInput[];
    };
    expect(made.rules).toHaveLength(6);
  });

  it('[NTF-001] adds a policy that starts with the default’s rules, and opens it', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    const opener = await screen.findByRole('button', { name: 'New policy' });
    await user.click(opener);
    const form = screen.getByRole('form', { name: 'Add policy' });
    expect(within(form).getByLabelText('Start with')).toHaveDisplayValue(
      'The rules of Default notifications',
    );
    await user.type(within(form).getByLabelText('Policy name'), 'Support');
    await user.type(within(form).getByLabelText('Description'), 'For the help desk.');
    await user.click(within(form).getByRole('button', { name: 'Add policy' }));
    expect(await screen.findByText('Policy Support was added.')).toBeInTheDocument();
    const made = client.calls.find((c) => c.action === 'create')?.args[0] as {
      name: string;
      description: string;
      rules: RuleInput[];
    };
    expect(made).toMatchObject({ name: 'Support', description: 'For the help desk.' });
    expect(made.rules).toHaveLength(BUILT_IN_EVENTS.length * 3);
    expect(screen.getByRole('heading', { name: 'Who hears of what in Support' })).toBeVisible();
    expect(opener).toHaveFocus();
  });

  it('[NTF-001] says so when a name is taken', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'New policy' }));
    const form = screen.getByRole('form', { name: 'Add policy' });
    await user.type(within(form).getByLabelText('Policy name'), 'payments');
    await user.click(within(form).getByRole('button', { name: 'Add policy' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A policy with that name exists already. Choose another name.',
    );
  });

  it('[NTF-001] changes a policy’s name and description', async () => {
    const client = renderPage();
    const user = await openPolicy('Payments');
    const form = screen.getByRole('form', { name: 'Name and description of Payments' });
    const name = within(form).getByLabelText('Policy name');
    await user.clear(name);
    await user.type(name, 'Payments team');
    await user.click(within(form).getByRole('button', { name: 'Save name and description' }));
    expect(await screen.findByText('Payments team was saved.')).toBeInTheDocument();
    expect(client.calls.at(-1)).toEqual({
      action: 'update',
      args: [
        2,
        {
          name: 'Payments team',
          description: 'The team hears of new tickets; followers of comments.',
        },
      ],
    });
  });

  it('[NTF-001] deletes an unused policy after asking; the default and one in use stay', async () => {
    const client = renderPage();
    const user = await openPolicy('Default notifications');
    expect(
      screen.getByText(
        'The default policy cannot be deleted: tracks that name no other policy use it.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Delete Default notifications' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Manage Payments' }));
    const trigger = screen.getByRole('button', { name: 'Delete Payments' });
    expect(trigger).toHaveClass('button-danger-quiet');
    await user.click(trigger);
    // Asks first, saying what will happen (D13).
    const question = screen.getByRole('group', {
      name: 'Payments and its rules are deleted for good. No track uses it, so nobody hears less.',
    });
    await user.click(within(question).getByRole('button', { name: 'Delete Payments' }));
    expect(await screen.findByText('Policy Payments was deleted.')).toBeInTheDocument();
    expect(client.calls.at(-1)).toEqual({ action: 'remove', args: [2] });
    expect(screen.getByRole('heading', { name: 'Shared policies' })).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Manage Payments' })).toBeNull();
  });

  it('[IAM-009] a configuration administrator manages the shared policies', async () => {
    renderPage({ session: CONFIG_ADMIN });
    expect(await screen.findByRole('button', { name: 'Manage Payments' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'New policy' })).toBeVisible();
  });

  it('[NFR-005] the server’s refusal leaves only the refusal', async () => {
    const { container } = render(
      <I18nProvider locale="en">
        <SessionProvider session={ADMIN}>
          <main>
            <NotificationPoliciesPage client={fakePoliciesClient({ fail: 'forbidden' })} />
          </main>
        </SessionProvider>
      </I18nProvider>,
    );
    expect(await screen.findByText(/^Only site and configuration administrators/)).toBeVisible();
    expect(container.querySelector('.page-purpose')).toBeNull();
    expect(screen.queryByRole('button', { name: 'New policy' })).toBeNull();
  });

  it('[NTF-001] says when the policies cannot be read, under the page’s header', async () => {
    renderPage({ client: fakePoliciesClient({ fail: 'load' }) });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The notification policies could not be read. Try again in a moment.',
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Notification policies' })).toBeVisible();
  });

  it('[NTF-001] fits a small phone', async () => {
    setViewportWidth(375);
    renderPage();
    expect(await screen.findByRole('button', { name: 'Manage Payments' })).toBeVisible();
  });

  it('[NFR-006] passes every string through the pseudo-locale', async () => {
    renderPage({ locale: 'en-XA' });
    const main = screen.getByRole('main');
    await within(main).findAllByRole('listitem');
    // New policy, then each policy's Manage: Payments is the third, with names in its rules.
    const manage = within(main).getAllByRole('button', { expanded: false })[2] as HTMLElement;
    await userEvent.setup().click(manage);
    const data = new Set([
      'Default notifications',
      'Payments',
      'The team hears of new tickets; followers of comments.',
      'SHOP',
      'Payments team',
      'Release managers',
      'Members',
      'Administrators',
      'Viewers',
      'Ana Ruiz',
      'Reviewer',
      'Owning team',
    ]);
    expect(untranslated(visibleTexts(main)).filter((t) => !data.has(t))).toEqual([]);
  });
});

describe('a local-mode track’s own notification policies (T-155, T-163a’s pattern)', () => {
  it('[NTF-001] shows the policies OPS owns, and the one it uses', async () => {
    renderPage({ session: TRACK_ADMIN, trackId: 4 });
    const list = await screen.findByRole('region', { name: 'Policies of OPS' });
    expect(within(list).getByText('OPS uses On-call alerts.')).toBeVisible();
    expect(within(list).queryByText('Default notifications')).toBeNull();
    expect(screen.getByText(/^The notification policies this track owns/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to managing OPS.' })).toHaveAttribute(
      'href',
      '#/manage/tracks/4',
    );
  });

  it('[NTF-001] adds a policy of its own with its own field and event, and uses it for the track', async () => {
    const user = userEvent.setup();
    const client = renderPage({ session: TRACK_ADMIN, trackId: 4 });
    await user.click(await screen.findByRole('button', { name: 'New policy' }));
    const form = screen.getByRole('form', { name: 'Add policy' });
    await user.type(within(form).getByLabelText('Policy name'), 'Night shift');
    await user.selectOptions(within(form).getByLabelText('Start with'), 'No rules');
    await user.click(within(form).getByRole('button', { name: 'Add policy' }));
    expect(await screen.findByText('Policy Night shift was added.')).toBeInTheDocument();
    expect(client.calls.find((c) => c.action === 'create')?.args[0]).toEqual({
      name: 'Night shift',
      trackId: 4,
      rules: [],
    });
    expect(screen.getByText('No rules yet')).toBeVisible();

    const rule = screen.getByRole('form', { name: 'Add a rule to Night shift' });
    await user.selectOptions(
      within(rule).getByLabelText('Event'),
      'Transition event “handed-to-night”',
    );
    await user.selectOptions(
      within(rule).getByLabelText('Who hears of it'),
      'The people in a user field',
    );
    await user.selectOptions(within(rule).getByLabelText('User field'), 'On call');
    await user.click(within(rule).getByRole('button', { name: 'Add rule' }));
    await screen.findByText(
      'Rule added for Transition event “handed-to-night”: People in On call.',
    );
    expect(lastRules(client)).toEqual([
      { event: 'custom:handed-to-night', recipient: 'user_field', fieldKey: 'cf[41]' },
    ]);

    await user.click(screen.getByRole('button', { name: 'Use this policy for OPS' }));
    expect(await screen.findByText('OPS now uses Night shift.')).toBeInTheDocument();
    expect(client.calls.at(-1)).toEqual({ action: 'chooseFor', args: [4, 50] });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Use this policy for OPS' })).toBeNull(),
    );
    expect(screen.getByText('OPS uses Night shift.')).toBeVisible();
  });

  it('[NTF-001] someone who runs tracks chooses one with its own configuration', async () => {
    renderPage({ session: TRACK_ADMIN });
    expect(
      await screen.findByRole('link', { name: 'Notification policies of OPS · Operations' }),
    ).toHaveAttribute('href', '#/manage/tracks/4/notification-policies');
    expect(screen.queryByRole('link', { name: /of SHOP/ })).toBeNull();
  });

  it('[NTF-001] a shared-mode track has no policies of its own', async () => {
    renderPage({ trackId: 3 });
    expect(
      await screen.findByText(
        'SHOP uses shared configuration, so it uses a shared notification policy, which site and configuration administrators change.',
      ),
    ).toBeVisible();
  });
});
