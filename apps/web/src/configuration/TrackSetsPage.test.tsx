import { render, screen, within } from '@testing-library/react';
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
    const names = [
      'Default layouts',
      'Default priority set',
      'Support priorities',
      'Company levels',
      'Default notifications',
    ];
    const plain = visibleTexts(main).filter((t) => /^[A-Za-z ]+$/.test(t) && !names.includes(t));
    expect(plain).toEqual([]);
  });
});
