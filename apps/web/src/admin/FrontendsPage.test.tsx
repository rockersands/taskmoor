import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { FrontendsPage } from './FrontendsPage';
import { ADMIN, MEMBER } from './fixtures';
import { fakeFrontendsClient } from './frontendsFixtures';

function renderPage(
  client = fakeFrontendsClient(),
  locale: 'en' | 'en-XA' = 'en',
  session = ADMIN,
) {
  const errors: Error[] = [];
  const view = render(
    <I18nProvider locale={locale} onError={(e) => errors.push(e)}>
      <SessionProvider session={session}>
        <FrontendsPage client={client} />
      </SessionProvider>
    </I18nProvider>,
  );
  return Object.assign(client, { errors, container: view.container });
}

describe('the frontends page (M1-108)', () => {
  it('[OPS-017] lists the frontends with the versions they report against the server’s', async () => {
    renderPage();
    const board = (await screen.findByRole('heading', { name: 'https://board.example.org' }))
      .parentElement as HTMLElement;
    expect(within(board).getByText(/Runs version 1\.3\.1/)).toBeVisible();
    expect(within(board).getByText('An update is available.')).toBeVisible();
    expect(within(board).getByText(/returns to https:\/\/board\.example\.org\//)).toBeVisible();
    expect(within(board).getByText(/Added by Ada Admin/)).toBeVisible();
    const intranet = screen.getByRole('heading', { name: 'https://intranet.example.org' })
      .parentElement as HTMLElement;
    expect(within(intranet).getByText('Has not reported its version yet.')).toBeVisible();
    expect(within(intranet).getByText(/cookie only/)).toBeVisible();
    expect(within(intranet).getByText('May not open live updates.')).toBeVisible();
    // This server, serving the app itself, and the environment's list.
    // The same version for the app and the server is said once (AD-36).
    expect(
      screen.getByText('Serves the app itself, at the server’s version, 1.4.2.'),
    ).toBeVisible();
    expect(screen.queryByText('Server version 1.4.2.')).toBeNull();
    expect(screen.getByRole('heading', { name: 'https://tracker.example.com' })).toBeVisible();
  });

  it('[OPS-017] (1) adds a frontend, and says what was wrong with a bad origin', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    const origin = await screen.findByRole('textbox', { name: 'Origin' });
    await user.type(origin, 'https://*.example.net');
    await user.click(screen.getByRole('button', { name: 'Add frontend' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/no path and no wildcard/);

    await user.clear(origin);
    await user.type(origin, 'https://second.example.net');
    await user.type(screen.getByRole('textbox', { name: 'Label' }), 'Second kit');
    await user.type(
      screen.getByRole('textbox', { name: 'OAuth return addresses' }),
      'https://second.example.net/app/',
    );
    await user.click(screen.getByRole('checkbox', { name: /live updates/ }));
    await user.click(screen.getByRole('button', { name: 'Add frontend' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'https://second.example.net was added.',
    );
    expect(client.added.at(-1)).toEqual({
      origin: 'https://second.example.net',
      label: 'Second kit',
      redirectUris: ['https://second.example.net/app/'],
      websocket: false,
    });
    expect(
      await screen.findByRole('heading', { name: 'https://second.example.net' }),
    ).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();

    // The same origin again: already there.
    await user.type(origin, 'https://second.example.net');
    await user.click(screen.getByRole('button', { name: 'Add frontend' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('registered already');
  });

  it('[OPS-017] removes a frontend after a confirmation', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(
      await screen.findByRole('button', { name: 'Remove https://board.example.org' }),
    );
    const confirm = screen.getByRole('group', { name: /Remove https:\/\/board\.example\.org\?/ });
    await user.click(within(confirm).getByRole('button', { name: 'Remove it' }));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'https://board.example.org' })).toBeNull(),
    );
    expect(screen.getByRole('status')).toHaveTextContent('https://board.example.org was removed.');
  });

  it('[OPS-017] tells other people it is for site administrators', async () => {
    renderPage(fakeFrontendsClient(), 'en', MEMBER);
    expect(await screen.findByText(/Only site administrators/)).toBeVisible();
  });

  it('[NFR-006] passes every string through the pseudo-locale', async () => {
    const { container, errors } = renderPage(fakeFrontendsClient(), 'en-XA');
    await screen.findAllByRole('heading', { level: 3 });
    // Origins, labels and names are data, as typed.
    const texts = visibleTexts(container).filter(
      (t) => !/^https:\/\/[a-z.]+$/.test(t) && !['Wall boards'].includes(t),
    );
    expect(untranslated(texts)).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('[OPS-017] fits a phone', async () => {
    setViewportWidth(360);
    renderPage();
    await screen.findByRole('heading', { name: 'https://board.example.org' });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(360);
  });
});
