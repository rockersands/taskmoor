import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ADMIN, CONFIG_ADMIN, MEMBER, TRACK_ADMIN } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { PermissionExplainerPage } from './PermissionExplainerPage';
import { VisibilityPage } from './VisibilityPage';
import { fakeExplainClient, fakeVisibilityClient, REFUSED } from './visibilityFixtures';

function renderPage(
  session: Session = ADMIN,
  locale: Locale = 'en',
  trackId: number | null = null,
) {
  const client = fakeVisibilityClient();
  render(
    <I18nProvider locale={locale}>
      <SessionProvider session={session}>
        <main>
          <VisibilityPage client={client} trackId={trackId} />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return client;
}

function renderExplainer(client = fakeExplainClient(), session: Session = ADMIN) {
  render(
    <I18nProvider locale="en">
      <SessionProvider session={session}>
        <main>
          <PermissionExplainerPage client={client} />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return client;
}

describe('visibility policies (UI-T17)', () => {
  it('[IAM-011] lists policies with what uses them, their levels and members', async () => {
    renderPage();
    const policy = await screen.findByRole('region', { name: 'Company levels' });
    expect(within(policy).getByText('Used by SHOP')).toBeVisible();
    expect(within(policy).getByText('Internal', { selector: 'p' })).toBeVisible();
    expect(within(policy).getByText('Group Security team')).toBeVisible();
    expect(within(policy).getByLabelText('New tickets take')).toHaveValue('11');
    const spare = screen.getByRole('region', { name: 'Spare' });
    expect(within(spare).getByText('No track uses this policy.')).toBeVisible();
  });

  it('[IAM-011] adds a policy, then a level, and refuses a name in use', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    // The policies come first; "New visibility policy" opens the form (D11, AD-18).
    await screen.findByRole('region', { name: 'Spare' });
    expect(screen.queryByRole('form', { name: 'Add a visibility policy' })).toBeNull();
    const opener = screen.getByRole('button', { name: 'New visibility policy' });
    expect(opener).toHaveClass('button-primary');
    await user.click(opener);
    const add = screen.getByRole('form', { name: 'Add a visibility policy' });
    await user.type(within(add).getByLabelText('Policy name'), 'Spare');
    await user.click(within(add).getByRole('button', { name: 'Add a visibility policy' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Another policy or level');
    await user.clear(within(add).getByLabelText('Policy name'));
    await user.type(within(add).getByLabelText('Policy name'), 'Legal');
    await user.click(within(add).getByRole('button', { name: 'Add a visibility policy' }));
    const legal = await screen.findByRole('region', { name: 'Legal' });
    // Added, the form closes and the focus goes back to the New button.
    expect(screen.queryByRole('form', { name: 'Add a visibility policy' })).toBeNull();
    expect(opener).toHaveFocus();
    const level = within(legal).getByRole('form', { name: 'Add a level to Legal' });
    await user.type(within(level).getByLabelText('Level name'), 'Counsel');
    await user.click(within(level).getByRole('button', { name: 'Add a level' }));
    expect(await within(legal).findByText('Counsel', { selector: 'p' })).toBeVisible();
    // A new level has no members yet, and says so as an empty state (T-289).
    expect(within(legal).getByText(/^No members yet/)).toHaveClass('empty-state-title');
    expect(client.calls.map((c) => c.action)).toEqual(['createPolicy', 'createPolicy', 'addLevel']);
  });

  it('[IAM-011] adds a member by name and removes one', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    const form = await screen.findByRole('form', { name: 'Add a member to Security' });
    await user.selectOptions(within(form).getByLabelText('Who'), 'A person');
    await user.type(within(form).getByLabelText('Find a person'), 'noor');
    expect(await within(form).findByRole('option', { name: 'Noor Haddad' })).toBeVisible();
    await user.click(within(form).getByRole('button', { name: 'Add' }));
    const members = await screen.findByRole('list', { name: 'Members of Security' });
    expect(await within(members).findByText('Noor Haddad')).toBeVisible();
    await user.click(
      within(members).getByRole('button', {
        name: 'Remove Group Security team from Security',
      }),
    );
    expect(await screen.findByText('Group Security team left Security.')).toBeInTheDocument();
    expect(client.calls.at(0)).toEqual({
      action: 'addMember',
      args: [1, 12, { grantee: 'user', userId: 8 }],
    });
  });

  it('[IAM-011] asks where tickets go before deleting a level they use', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    const trigger = await screen.findByRole('button', { name: 'Delete level Internal' });
    expect(trigger).toHaveClass('button-danger-quiet');
    await user.click(trigger);
    // Asks first, saying what will happen (D13).
    const question = screen.getByRole('group', { name: /^Delete level Internal\?/ });
    await user.click(within(question).getByRole('button', { name: 'Delete level Internal' }));
    const form = await screen.findByRole('form', { name: 'Where tickets at Internal go' });
    expect(within(form).getByText(/4 tickets are at Internal/)).toBeVisible();
    expect(within(form).getByLabelText('Move them to')).toHaveFocus();
    // Cancel goes back to the level's Delete level.
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Delete level Internal' })).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Delete level Internal' }));
    await user.click(
      within(screen.getByRole('group')).getByRole('button', { name: 'Delete level Internal' }),
    );
    const again = await screen.findByRole('form', { name: 'Where tickets at Internal go' });
    await user.selectOptions(within(again).getByLabelText('Move them to'), 'Security');
    await user.click(within(again).getByRole('button', { name: 'Delete level' }));
    expect(await screen.findByText('Level Internal was deleted.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Company levels' })).toHaveFocus();
    expect(client.calls.map((c) => c.args)).toEqual([
      [1, 11, undefined],
      [1, 11, undefined],
      [1, 11, 12],
    ]);
  });

  it('[IAM-011] refuses to delete a policy a track uses, and moves a level', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Move Security up' }));
    expect(await screen.findByText('Security was moved.')).toBeInTheDocument();
    expect(client.calls.at(0)).toEqual({
      action: 'updateLevel',
      args: [1, 12, { position: 0 }],
    });
    await user.click(screen.getByRole('button', { name: 'Delete policy Company levels' }));
    const question = screen.getByRole('group', { name: /^Delete Company levels/ });
    await user.click(
      within(question).getByRole('button', { name: 'Delete policy Company levels' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('Tracks still use');
    // Refused: the question stays open, to cancel (D13).
    expect(screen.getByRole('group', { name: /^Delete Company levels/ })).toBeVisible();
  });

  it('[IAM-009] [IAM-011] lets a configuration administrator manage the shared policies, as the server does (T-322)', async () => {
    const user = userEvent.setup();
    const client = renderPage(CONFIG_ADMIN);
    const spare = await screen.findByRole('region', { name: 'Spare' });
    expect(screen.queryByText(/^Only site/)).toBeNull();
    // A track's own policy belongs on that track's page.
    expect(screen.queryByRole('region', { name: 'Night desk' })).toBeNull();
    const add = within(spare).getByRole('form', { name: 'Add a level to Spare' });
    await user.type(within(add).getByLabelText('Level name'), 'Counsel');
    await user.click(within(add).getByRole('button', { name: 'Add a level' }));
    expect(await screen.findByText('Level Counsel was added.')).toBeInTheDocument();
    expect(client.calls.at(-1)).toEqual({ action: 'addLevel', args: [2, { name: 'Counsel' }] });
  });

  it('[IAM-009] refuses anyone who neither administers nor runs a track (T-322)', async () => {
    renderPage(MEMBER);
    expect(
      await screen.findByText(
        'Only site and configuration administrators, and the people who run a track with its own configuration, manage visibility policies.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'New visibility policy' })).toBeNull();
  });

  it('fits a small phone', async () => {
    setViewportWidth(375);
    renderPage();
    expect(await screen.findByRole('region', { name: 'Company levels' })).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    renderPage(ADMIN, 'en-XA');
    const main = screen.getByRole('main');
    await within(main).findByText('Internal', { selector: 'p' });
    const fixed = [
      'Company levels',
      'Spare',
      'Internal',
      'Security',
      'Staff only.',
      'Administrators',
      'Members',
      'Security team',
    ];
    const texts = visibleTexts(main).filter(
      (t) => /^[A-Za-z .,]+$/.test(t) && !fixed.includes(t) && !t.startsWith('What stays'),
    );
    expect(texts).toEqual([]);
  });
});

describe('the permission explainer (UI-T17)', () => {
  it('[IAM-012] names the grants that allow it, and what may allow it per ticket', async () => {
    const user = userEvent.setup();
    const client = renderExplainer();
    const form = await screen.findByRole('form', { name: 'Ask why' });
    await user.type(within(form).getByLabelText('Find a person'), 'sam');
    await within(form).findByRole('option', { name: 'Sam Rivera' });
    await user.selectOptions(within(form).getByLabelText('Permission'), 'edit_tickets');
    await user.selectOptions(within(form).getByLabelText('Track'), 'OPS: Operations');
    await user.click(within(form).getByRole('button', { name: 'Explain' }));
    const answer = await screen.findByRole('region', { name: /Sam Rivera can/ });
    expect(within(answer).getByText('Through the role Members.')).toBeVisible();
    expect(within(answer).getByText('Through the group Security team.')).toBeVisible();
    expect(within(answer).getByText('The assignee')).toBeVisible();
    expect(client.asked).toEqual([{ permission: 'edit_tickets', userId: 7, trackId: 4 }]);
  });

  it('[IAM-012] says when no grant allows it, also for someone not signed in', async () => {
    const user = userEvent.setup();
    renderExplainer(fakeExplainClient(() => REFUSED));
    const form = await screen.findByRole('form', { name: 'Ask why' });
    await user.click(within(form).getByRole('button', { name: 'Explain' }));
    expect(
      await screen.findByRole('region', { name: /A visitor not signed in cannot/ }),
    ).toBeVisible();
    expect(screen.getByText(/No grant in the track.s access policy/)).toBeVisible();
  });

  it('[IAM-012] names the visibility level that hides a ticket', async () => {
    const user = userEvent.setup();
    const client = renderExplainer();
    const form = await screen.findByRole('form', { name: 'Ask why' });
    await user.type(within(form).getByLabelText('Ticket key (optional)'), 'SHOP-9');
    await user.click(within(form).getByRole('button', { name: 'Explain' }));
    expect(await screen.findByText(/SHOP-9 is at the level Security/)).toBeVisible();
    expect(client.asked).toEqual([{ permission: 'edit_tickets', ticket: 'SHOP-9' }]);
  });

  it('[IAM-012] says when the ticket does not exist', async () => {
    const user = userEvent.setup();
    renderExplainer();
    const form = await screen.findByRole('form', { name: 'Ask why' });
    await user.type(within(form).getByLabelText('Ticket key (optional)'), 'NOPE-1');
    await user.click(within(form).getByRole('button', { name: 'Explain' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be found');
  });

  it('[IAM-009] is for site administrators', () => {
    renderExplainer(fakeExplainClient(), CONFIG_ADMIN);
    expect(screen.getByText(/Only site administrators/)).toBeVisible();
  });
});

describe('a local-mode track’s own visibility policies (T-322, T-163a’s pattern)', () => {
  it('[IAM-011] [IAM-030] shows only the policies OPS owns, and says it uses none yet', async () => {
    renderPage(TRACK_ADMIN, 'en', 4);
    const own = await screen.findByRole('region', { name: 'Night desk' });
    expect(screen.getByText('OPS · Operations')).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Company levels' })).toBeNull();
    expect(screen.getByText(/^The visibility policies this track owns/)).toBeVisible();
    expect(
      screen.getByText(
        'OPS uses no visibility policy now, so everyone who sees it sees all its tickets. Use one of its own to give its tickets levels.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to managing OPS.' })).toHaveAttribute(
      'href',
      '#/manage/tracks/4',
    );
    expect(within(own).getByText('Responders', { selector: 'p' })).toBeVisible();
  });

  it('[IAM-011] [IAM-030] adds a policy of its own, names its own field and people, and uses it for OPS', async () => {
    const user = userEvent.setup();
    const client = renderPage(TRACK_ADMIN, 'en', 4);
    await user.click(await screen.findByRole('button', { name: 'New visibility policy' }));
    const add = screen.getByRole('form', { name: 'Add a visibility policy' });
    await user.type(within(add).getByLabelText('Policy name'), 'Incidents');
    await user.click(within(add).getByRole('button', { name: 'Add a visibility policy' }));
    const policy = await screen.findByRole('region', { name: 'Incidents' });
    expect(client.calls.at(-1)).toEqual({
      action: 'createPolicy',
      args: [{ name: 'Incidents', trackId: 4 }],
    });
    const level = within(policy).getByRole('form', { name: 'Add a level to Incidents' });
    await user.type(within(level).getByLabelText('Level name'), 'Major');
    await user.click(within(level).getByRole('button', { name: 'Add a level' }));
    const member = await within(policy).findByRole('form', { name: 'Add a member to Major' });

    // The track's own user field is offered beside the shared one; another track's is not.
    await user.selectOptions(within(member).getByLabelText('Who'), 'People in a user field');
    const fields = within(member).getByLabelText('User field');
    expect(
      within(fields)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Reviewer', 'On call']);
    await user.selectOptions(fields, 'On call');
    await user.click(within(member).getByRole('button', { name: 'Add' }));
    expect(await screen.findByText('People in field On call joined Major.')).toBeInTheDocument();

    // People are found among those who may be named in OPS.
    const again = within(policy).getByRole('form', { name: 'Add a member to Major' });
    await user.selectOptions(within(again).getByLabelText('Who'), 'A person');
    await user.type(within(again).getByLabelText('Find a person'), 'ola');
    expect(await within(again).findByRole('option', { name: 'Ola Night' })).toBeVisible();

    const use = within(policy).getByRole('button', { name: 'Use this policy for OPS' });
    expect(use).toHaveAccessibleDescription(/^Tickets at a level this policy lacks take/);
    await user.click(use);
    expect(await screen.findByText('OPS now uses Incidents.')).toBeInTheDocument();
    expect(client.calls.at(-1)).toEqual({ action: 'chooseFor', args: [4, 200] });
    await waitFor(() =>
      expect(within(policy).queryByRole('button', { name: 'Use this policy for OPS' })).toBeNull(),
    );
    expect(screen.getByText('OPS uses Incidents.')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Incidents' })).toHaveFocus();
    expect(within(policy).getByText('Used by OPS')).toBeVisible();
  });

  it('[IAM-011] offers no group to someone who may not read the groups', async () => {
    const client = { ...fakeVisibilityClient(), groups: async () => [] };
    render(
      <I18nProvider locale="en">
        <SessionProvider session={TRACK_ADMIN}>
          <main>
            <VisibilityPage client={client} trackId={4} />
          </main>
        </SessionProvider>
      </I18nProvider>,
    );
    const form = await screen.findByRole('form', { name: 'Add a member to Responders' });
    const kinds = within(within(form).getByLabelText('Who')).getAllByRole('option');
    expect(kinds.map((o) => o.textContent)).not.toContain('A group');
    expect(kinds[0]).toHaveTextContent('A role');
  });

  it('[IAM-030] someone who runs tracks chooses one with its own configuration', async () => {
    renderPage(TRACK_ADMIN);
    expect(
      await screen.findByRole('link', { name: 'Visibility policies of OPS · Operations' }),
    ).toHaveAttribute('href', '#/manage/tracks/4/visibility-policies');
    expect(screen.queryByRole('link', { name: /of SHOP/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New visibility policy' })).toBeNull();
  });

  it('[IAM-030] a shared-mode track has no policies of its own', async () => {
    renderPage(ADMIN, 'en', 3);
    expect(
      await screen.findByText(
        'SHOP uses shared configuration, so it uses a shared visibility policy, or none, which site and configuration administrators choose.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'New visibility policy' })).toBeNull();
  });

  it('passes the track’s own page through the pseudo-locale', async () => {
    renderPage(TRACK_ADMIN, 'en-XA', 4);
    const main = screen.getByRole('main');
    await within(main).findByText('Responders', { selector: 'p' });
    const fixed = ['Night desk', 'Responders', 'Administrators', 'Members', 'OPS · Operations'];
    const texts = visibleTexts(main).filter((t) => /^[A-Za-z .,·]+$/.test(t) && !fixed.includes(t));
    expect(texts).toEqual([]);
  });
});
