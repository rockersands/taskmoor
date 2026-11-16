import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ADMIN, CONFIG_ADMIN } from '../admin/fixtures';
import { ApiError } from '../api/client';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import type { ConfigurationClient } from './client';
import { fakeConfigurationClient } from './fixtures';
import { TracksAdminPage } from './TracksAdminPage';

function renderPage(
  props: { session?: Session; locale?: Locale; client?: ConfigurationClient } = {},
) {
  const client = fakeConfigurationClient();
  render(
    <I18nProvider locale={props.locale ?? 'en'}>
      <SessionProvider session={props.session ?? ADMIN}>
        <main>
          <TracksAdminPage client={props.client ?? client} />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return client;
}

const OUTCOME =
  'SHOP goes to the trash with its tickets, releases and areas. Nobody sees it there, and its key stays taken. It can be restored from Trash until its time there is up; then it is deleted for good.';

describe('deleting a track (T-322)', () => {
  it('[CORE-025] says first what goes to the trash, then deletes the track and leads to Trash', async () => {
    const user = userEvent.setup();
    const client = renderPage({ session: CONFIG_ADMIN });
    await user.click(await screen.findByRole('button', { name: 'Manage track SHOP' }));
    await user.click(screen.getByRole('button', { name: 'Delete track SHOP' }));
    const question = screen.getByRole('group', { name: OUTCOME });
    expect(within(question).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(client.calls.map((c) => c.action)).toEqual([]);
    await user.click(within(question).getByRole('button', { name: 'Delete track SHOP' }));
    expect(await screen.findByText('Track SHOP is in the trash.')).toBeInTheDocument();
    expect(screen.queryByText('SHOP · Shop')).toBeNull();
    expect(screen.getByRole('link', { name: 'Restore SHOP from Trash' })).toHaveAttribute(
      'href',
      '#/admin/trash',
    );
    // The track's row went: the page's heading has the focus.
    expect(screen.getByRole('heading', { level: 1, name: 'Tracks' })).toHaveFocus();
    expect(client.calls).toEqual([{ action: 'deleteTrack', args: [3] }]);
  });

  it('[CORE-025] Cancel keeps the track and puts the focus back on Delete', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Manage track SHOP' }));
    await user.click(screen.getByRole('button', { name: 'Delete track SHOP' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Delete track SHOP' })).toHaveFocus();
    expect(screen.getByText('SHOP · Shop')).toBeVisible();
    expect(client.calls).toEqual([]);
  });

  it('[CORE-025] deletes an archived track too', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Manage track OLD' }));
    await user.click(screen.getByRole('button', { name: 'Delete track OLD' }));
    await user.click(
      within(screen.getByRole('group', { name: /^OLD goes to the trash/ })).getByRole('button', {
        name: 'Delete track OLD',
      }),
    );
    expect(await screen.findByText('Track OLD is in the trash.')).toBeInTheDocument();
    expect(client.calls).toEqual([{ action: 'deleteTrack', args: [9] }]);
  });

  it('[CORE-025] says why when the track is in the trash already, and keeps the question open', async () => {
    const user = userEvent.setup();
    renderPage({
      client: {
        ...fakeConfigurationClient(),
        deleteTrack: async () => {
          throw new ApiError(409, { error: 'in_trash' });
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Manage track SHOP' }));
    await user.click(screen.getByRole('button', { name: 'Delete track SHOP' }));
    const question = screen.getByRole('group', { name: OUTCOME });
    await user.click(within(question).getByRole('button', { name: 'Delete track SHOP' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Track SHOP is in the trash already.',
    );
    expect(question).toBeVisible();
  });

  it('[CORE-025] says when the track is gone, or the server refuses', async () => {
    const user = userEvent.setup();
    let answer = new ApiError(404, { error: 'not_found' });
    renderPage({
      client: {
        ...fakeConfigurationClient(),
        deleteTrack: async () => {
          throw answer;
        },
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Manage track SHOP' }));
    await user.click(screen.getByRole('button', { name: 'Delete track SHOP' }));
    const confirm = within(screen.getByRole('group', { name: OUTCOME })).getByRole('button', {
      name: 'Delete track SHOP',
    });
    await user.click(confirm);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Track SHOP is gone, or you may no longer see it.',
    );
    answer = new ApiError(403, { error: 'forbidden' });
    await user.click(confirm);
    expect(await screen.findByRole('alert')).toHaveTextContent('You may not change this track.');
  });

  it('[CORE-025] asks on a small phone', async () => {
    setViewportWidth(375);
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Manage track SHOP' }));
    await user.click(screen.getByRole('button', { name: 'Delete track SHOP' }));
    expect(screen.getByRole('group', { name: OUTCOME })).toBeVisible();
  });

  it('passes the question and its answer through the pseudo-locale', async () => {
    const user = userEvent.setup();
    renderPage({ locale: 'en-XA' });
    const main = screen.getByRole('main');
    await within(main).findAllByRole('listitem');
    await user.click(main.querySelector('.people-item .people-action') as HTMLButtonElement);
    // Archive track, a danger action too since T-267, comes first; Delete track ends the panel.
    const trigger = [...main.querySelectorAll<HTMLButtonElement>('.button-danger-quiet')].at(-1);
    if (!trigger) throw new Error('no Delete track button');
    expect(
      untranslated([trigger.textContent ?? '', trigger.getAttribute('aria-label') ?? '']),
    ).toEqual([]);
    await user.click(trigger);
    const question = within(main).getByRole('group');
    expect(untranslated(visibleTexts(question))).toEqual([]);
    await user.click(question.querySelector('.button-danger') as HTMLButtonElement);
    const status = within(main).getByRole('status');
    await waitFor(() => expect(status).not.toBeEmptyDOMElement());
    const link = main.querySelector('a[href="#/admin/trash"]');
    expect(untranslated([link?.textContent ?? '', status.textContent ?? ''])).toEqual([]);
  });
});
