import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ADMIN, CONFIG_ADMIN, MEMBER } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { TrackSetsPage } from './TrackSetsPage';
import { fakeTrackSetsClient } from './trackSetsFixtures';

function renderPage(
  session: Session = CONFIG_ADMIN,
  props: {
    initialTrackId?: number;
    locale?: Locale;
    client?: ReturnType<typeof fakeTrackSetsClient>;
  } = {},
) {
  const client = props.client ?? fakeTrackSetsClient();
  render(
    <I18nProvider locale={props.locale ?? 'en'}>
      <SessionProvider session={session}>
        <main>
          <TrackSetsPage
            client={client}
            {...(props.initialTrackId ? { initialTrackId: props.initialTrackId } : {})}
          />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return client;
}

describe('which sets a track uses (UI-T20)', () => {
  it('[CORE-013] shows what the first track uses, a default as the default', async () => {
    renderPage();
    const form = await screen.findByRole('form', { name: 'Sets of SHOP' });
    expect(within(form).getByLabelText('Layouts')).toHaveValue('');
    expect(within(form).getByRole('option', { name: 'The site’s default layouts' })).toBeVisible();
    expect(within(form).getByLabelText('Priorities')).toHaveValue('21');
    expect(within(form).getByLabelText('Visibility policy')).toHaveValue('');
    expect(within(form).getByRole('option', { name: 'None: tickets have no level' })).toBeVisible();
    expect(within(form).getByLabelText('Notifications')).toHaveValue('');
  });

  it('[IAM-009] lets a configuration administrator choose, sending only what changed', async () => {
    const user = userEvent.setup();
    const client = renderPage(CONFIG_ADMIN);
    const form = await screen.findByRole('form', { name: 'Sets of SHOP' });
    await user.selectOptions(within(form).getByLabelText('Priorities'), 'Default priority set');
    await user.selectOptions(within(form).getByLabelText('Visibility policy'), 'Company levels');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText('SHOP was saved.')).toBeInTheDocument();
    expect(client.saved).toEqual([
      { trackId: 3, change: { prioritySetId: 20, visibilityPolicyId: 30 } },
    ]);
  });

  it('[CORE-014] a default clears the choice, and an unchanged form sends nothing', async () => {
    const user = userEvent.setup();
    const client = renderPage(ADMIN);
    const form = await screen.findByRole('form', { name: 'Sets of SHOP' });
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText('Nothing changed.')).toBeInTheDocument();
    expect(client.saved).toEqual([]);
    await user.selectOptions(
      within(form).getByLabelText('Priorities'),
      'The site’s default priorities',
    );
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await within(form).findByText('SHOP was saved.');
    expect(client.saved).toEqual([{ trackId: 3, change: { prioritySetId: null } }]);
  });

  it('[CORE-014] links the priority picker to the page that makes priority sets', async () => {
    renderPage();
    const form = await screen.findByRole('form', { name: 'Sets of SHOP' });
    expect(
      within(form).getByRole('link', { name: 'Make and change priority sets on Priorities.' }),
    ).toHaveAttribute('href', '#/admin/priorities');
  });

  it('[NTF-001] links the notification picker to the page that makes notification policies', async () => {
    renderPage();
    const form = await screen.findByRole('form', { name: 'Sets of SHOP' });
    expect(
      within(form).getByRole('link', {
        name: 'Make and change notification policies on Notification policies.',
      }),
    ).toHaveAttribute('href', '#/admin/notification-policies');
  });

  it('[NTF-001] offers a local-mode track its own sets, opens on the named track', async () => {
    renderPage(CONFIG_ADMIN, { initialTrackId: 4 });
    const form = await screen.findByRole('form', { name: 'Sets of OPS' });
    expect(within(form).getByLabelText('Notifications')).toHaveValue('41');
    expect(within(form).getByRole('option', { name: 'Ops notices (its own)' })).toBeVisible();
    expect(within(form).getByLabelText('Layouts')).toHaveValue('12');
  });

  it('[IAM-011] says when the server refuses, and changes track without losing it', async () => {
    const user = userEvent.setup();
    renderPage(CONFIG_ADMIN, { initialTrackId: 4 });
    const form = await screen.findByRole('form', { name: 'Sets of OPS' });
    await user.selectOptions(within(form).getByLabelText('Visibility policy'), 'Company levels');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('may not choose');
    await user.selectOptions(screen.getByLabelText('Track'), 'SHOP: Shop');
    expect(await screen.findByRole('form', { name: 'Sets of SHOP' })).toBeVisible();
  });

  it('[IAM-009] refuses someone who is neither kind of administrator', () => {
    renderPage(MEMBER);
    expect(screen.getByText(/Only site and configuration administrators/)).toBeVisible();
  });

  it('explains having no tracks', async () => {
    renderPage(ADMIN, { client: fakeTrackSetsClient([]) });
    expect(await screen.findByText('No tracks yet')).toBeVisible();
  });

  it('fits a small phone', async () => {
    setViewportWidth(375);
    renderPage();
    expect(await screen.findByRole('form', { name: 'Sets of SHOP' })).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    renderPage(ADMIN, { locale: 'en-XA' });
    const main = screen.getByRole('main');
    await within(main).findByRole('form');
    const plain = visibleTexts(main).filter((t) => /^[A-Za-z ]+$/.test(t) && !NAMES.includes(t));
    expect(plain).toEqual([]);
  });
});

/** The names of the sets and types the fake backend holds: data, not the page's words. */
const NAMES = [
  'Default layouts',
  'Default priority set',
  'Support priorities',
  'Company levels',
  'Default notifications',
  'Default access policy',
  'Contractors',
  'Software types',
  'Support types',
  'Product types',
  'Bug',
  'Task',
  'Story',
  'Epic',
  'Request',
  'Initiative',
];

describe('a shared-mode track’s access policy and type set (T-322)', () => {
  it('[IAM-010] switches a shared-mode track’s access policy, sending only that', async () => {
    const user = userEvent.setup();
    const client = renderPage(CONFIG_ADMIN);
    const form = await screen.findByRole('form', { name: 'Sets of SHOP' });
    const policy = within(form).getByRole('combobox', { name: 'Access policy' });
    expect(policy).toHaveValue('60');
    expect(
      within(policy)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Default access policy', 'Contractors']);
    await user.selectOptions(policy, 'Contractors');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText('SHOP was saved.')).toBeInTheDocument();
    expect(client.saved).toEqual([{ trackId: 3, change: { accessPolicyId: 62 } }]);
  });

  it('[CORE-005] asks which type the tickets of each type the new set lacks take, then saves with the mapping', async () => {
    const user = userEvent.setup();
    const client = renderPage(CONFIG_ADMIN);
    const form = await screen.findByRole('form', { name: 'Sets of SHOP' });
    const typeSet = within(form).getByRole('combobox', { name: 'Type set' });
    expect(typeSet).toHaveValue('50');
    await user.selectOptions(typeSet, 'Product types');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'Tickets in SHOP have a type Product types lacks: choose the type they take, then save again.',
    );
    const question = within(form).getByRole('group', {
      name: 'Tickets of the types Product types lacks',
    });
    expect(question).toHaveAccessibleDescription(
      '4 tickets in SHOP have a type Product types lacks. Choose the type they take, at the same level, then save again.',
    );
    // The first choice takes the keyboard, and offers only kept types of its level.
    const bug = within(question).getByRole('combobox', { name: 'Tickets of Bug become' });
    expect(bug).toHaveFocus();
    expect(
      within(bug)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Choose a type', 'Task', 'Story']);
    await user.selectOptions(bug, 'Task');
    await user.selectOptions(
      within(question).getByRole('combobox', { name: 'Tickets of Epic become' }),
      'Initiative',
    );
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(
      await within(form).findByText('SHOP was saved; 4 tickets took another type.'),
    ).toBeInTheDocument();
    expect(within(form).queryByRole('group')).toBeNull();
    expect(client.saved.at(-1)).toEqual({
      trackId: 3,
      change: { typeSetId: 52, ticketTypeMapping: { '5': 6, '8': 10 } },
    });
  });

  it('[CORE-005] says when the new set has no type at a level the tickets have', async () => {
    const user = userEvent.setup();
    renderPage(CONFIG_ADMIN);
    const form = await screen.findByRole('form', { name: 'Sets of SHOP' });
    await user.selectOptions(within(form).getByLabelText('Type set'), 'Support types');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    const question = await within(form).findByRole('group', {
      name: 'Tickets of the types Support types lacks',
    });
    expect(
      within(question).getByText(
        'Support types has no type at the Outcome level, so tickets of Epic have nowhere to go: choose another type set, or add a type of that level to Support types.',
      ),
    ).toBeVisible();
    expect(within(question).getByRole('combobox', { name: 'Tickets of Bug become' })).toHaveFocus();
  });

  it('[CORE-005] keeps a type the server named before when it asks again for another', async () => {
    const user = userEvent.setup();
    const client = renderPage(ADMIN);
    const form = await screen.findByRole('form', { name: 'Sets of SHOP' });
    await user.selectOptions(within(form).getByLabelText('Type set'), 'Product types');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    const question = await within(form).findByRole('group');
    await user.selectOptions(
      within(question).getByRole('combobox', { name: 'Tickets of Bug become' }),
      'Story',
    );
    // Epic left out: refused again for it alone, and Bug keeps its choice.
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(client.saved).toHaveLength(2));
    expect(client.saved[1]?.change).toEqual({ typeSetId: 52, ticketTypeMapping: { '5': 7 } });
    expect(within(question).getByRole('combobox', { name: 'Tickets of Bug become' })).toHaveValue(
      '7',
    );
    await user.selectOptions(
      within(question).getByRole('combobox', { name: 'Tickets of Epic become' }),
      'Initiative',
    );
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    // The counts of both refusals tell how many tickets moved: three bugs and an epic.
    expect(
      await within(form).findByText('SHOP was saved; 4 tickets took another type.'),
    ).toBeInTheDocument();
  });

  it('[CORE-005] choosing another type set drops the question that was for the one before', async () => {
    const user = userEvent.setup();
    const client = renderPage(CONFIG_ADMIN);
    const form = await screen.findByRole('form', { name: 'Sets of SHOP' });
    const typeSet = within(form).getByLabelText('Type set');
    await user.selectOptions(typeSet, 'Product types');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    await within(form).findByRole('group');
    await user.selectOptions(typeSet, 'Software types');
    expect(within(form).queryByRole('group')).toBeNull();
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByText('Nothing changed.')).toBeInTheDocument();
    expect(client.saved).toHaveLength(1);
  });

  it('[CORE-005] links the type set picker to the page that makes type sets', async () => {
    renderPage(CONFIG_ADMIN);
    const form = await screen.findByRole('form', { name: 'Sets of SHOP' });
    expect(
      within(form).getByRole('link', { name: 'Make and change type sets on Configuration sets.' }),
    ).toHaveAttribute('href', '#/admin/configuration-sets');
  });

  it('[IAM-010] links the access policy picker to Permissions for a site administrator only', async () => {
    renderPage(ADMIN);
    const name = 'Make and change access policies on Permissions.';
    const form = await screen.findByRole('form', { name: 'Sets of SHOP' });
    expect(within(form).getByRole('link', { name })).toHaveAttribute('href', '#/admin/permissions');
    cleanup();
    renderPage(CONFIG_ADMIN);
    const other = await screen.findByRole('form', { name: 'Sets of SHOP' });
    expect(within(other).getByRole('combobox', { name: 'Access policy' })).toBeVisible();
    expect(within(other).queryByRole('link', { name })).toBeNull();
  });

  it('[IAM-010] says a local-mode track keeps its own access policy and type set, with the way to its page', async () => {
    renderPage(CONFIG_ADMIN, { initialTrackId: 4 });
    const form = await screen.findByRole('form', { name: 'Sets of OPS' });
    expect(within(form).queryByRole('combobox', { name: 'Access policy' })).toBeNull();
    expect(within(form).queryByRole('combobox', { name: 'Type set' })).toBeNull();
    expect(
      within(form).getByText(
        'OPS has its own access policy and type set, which its administrators change on its own pages.',
      ),
    ).toBeVisible();
    expect(within(form).getByRole('link', { name: 'Open the page of OPS' })).toHaveAttribute(
      'href',
      '#/manage/tracks/4',
    );
  });

  it('[CORE-005] asks on a small phone', async () => {
    setViewportWidth(375);
    const user = userEvent.setup();
    renderPage(CONFIG_ADMIN);
    const form = await screen.findByRole('form', { name: 'Sets of SHOP' });
    await user.selectOptions(within(form).getByLabelText('Type set'), 'Product types');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByRole('group')).toBeVisible();
  });

  it('passes the mapping step through the pseudo-locale', async () => {
    const user = userEvent.setup();
    renderPage(ADMIN, { locale: 'en-XA' });
    const main = screen.getByRole('main');
    const form = await within(main).findByRole('form');
    await user.selectOptions(within(form).getAllByRole('combobox')[1] as HTMLElement, '51');
    await user.click(within(form).getByRole('button'));
    await within(form).findByRole('group');
    const plain = visibleTexts(main).filter((t) => /^[A-Za-z ]+$/.test(t) && !NAMES.includes(t));
    expect(plain).toEqual([]);
  });
});
