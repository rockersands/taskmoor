import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ADMIN, CONFIG_ADMIN } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { PermissionExplainerPage } from './PermissionExplainerPage';
import { VisibilityPage } from './VisibilityPage';
import { fakeExplainClient, fakeVisibilityClient, REFUSED } from './visibilityFixtures';

function renderPage(session: Session = ADMIN, locale: Locale = 'en') {
  const client = fakeVisibilityClient();
  render(
    <I18nProvider locale={locale}>
      <SessionProvider session={session}>
        <main>
          <VisibilityPage client={client} />
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
    await user.click(await screen.findByRole('button', { name: 'Delete level Internal' }));
    await user.click(screen.getByRole('button', { name: 'Yes, delete' }));
    const form = await screen.findByRole('form', { name: 'Where tickets at Internal go' });
    expect(within(form).getByText(/4 tickets are at Internal/)).toBeVisible();
    await user.selectOptions(within(form).getByLabelText('Move them to'), 'Security');
    await user.click(within(form).getByRole('button', { name: 'Delete level' }));
    expect(await screen.findByText('Level Internal was deleted.')).toBeInTheDocument();
    expect(client.calls.map((c) => c.args)).toEqual([
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
    await user.click(screen.getByRole('button', { name: 'Yes, delete' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Tracks still use');
  });

  it('[IAM-009] is for site administrators', () => {
    renderPage(CONFIG_ADMIN);
    expect(screen.getByText(/Only site administrators/)).toBeVisible();
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
