import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { setViewportWidth } from '../test/viewport';
import { fakeReleaseClient } from './fixtures';
import { ReleasesPage } from './ReleasesPage';

function renderHub(client = fakeReleaseClient(), trackKey = 'CHK') {
  render(
    <I18nProvider locale="en">
      <ReleasesPage trackKey={trackKey} client={client} />
    </I18nProvider>,
  );
  return client;
}
const group = (name: string) => within(screen.getByRole('region', { name }));
const names = (name: string) =>
  group(name)
    .queryAllByRole('link')
    .map((a) => a.textContent);

describe('the releases hub (M1-050)', () => {
  it('[PLN-007] labels a release in a release across tracks and links to their list', async () => {
    renderHub(fakeReleaseClient({ linked: true }));
    const label = await screen.findByRole('link', { name: 'In Spring launch' });
    expect(label.getAttribute('href')).toContain('#/cross-track-releases/5');
    expect(
      screen.getByRole('link', { name: 'Releases across tracks' }).getAttribute('href'),
    ).toContain('#/cross-track-releases');
  });

  it('[CORE-016] lists upcoming releases in order, then shipped, with state and progress', async () => {
    renderHub();
    expect(await screen.findByRole('heading', { name: 'Releases of Checkout' })).toBeVisible();
    expect(names('Upcoming')).toEqual(['2.0', '2.1']);
    expect(names('Shipped')).toEqual(['1.9']);
    const first = screen.getByRole('link', { name: '2.0' }).closest('li') as HTMLElement;
    expect(within(first).getByText('Overdue')).toBeVisible();
    expect(within(first).getByText('Due on 2026-10-15')).toBeVisible();
    expect(within(first).getByText('1 of 4 tickets closed')).toBeVisible();
    expect(screen.getByRole('link', { name: '2.0' })).toHaveAttribute('href', '#/releases/2');
    expect(screen.getByText('1 archived release')).toBeInTheDocument();
    expect(screen.getByText('Shipped on 2026-10-01')).toBeVisible();
  });

  it('[CORE-016] adds a release, and says when the name is taken', async () => {
    const user = userEvent.setup();
    const client = renderHub();
    const form = within(await screen.findByRole('form', { name: 'New release' }));
    await user.type(form.getByRole('textbox', { name: 'Name' }), '2.2');
    await user.type(form.getByLabelText('Release date'), '2027-01-15');
    await user.click(form.getByRole('button', { name: 'Add release' }));
    await waitFor(() => expect(names('Upcoming')).toEqual(['2.0', '2.1', '2.2']));
    expect(client.releases().at(-1)).toMatchObject({ name: '2.2', releaseDate: '2027-01-15' });
    await user.type(form.getByRole('textbox', { name: 'Name' }), '2.1');
    await user.click(form.getByRole('button', { name: 'Add release' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already has a release');
  });

  it('[CORE-016] shows no way to add releases to someone who may not manage them', async () => {
    renderHub(fakeReleaseClient({ mayManage: false }));
    await screen.findByRole('heading', { name: 'Releases of Checkout' });
    expect(screen.queryByRole('form', { name: 'New release' })).toBeNull();
  });

  it('[CORE-016] says so for a track that does not exist', async () => {
    renderHub(fakeReleaseClient(), 'NOPE');
    expect(await screen.findByRole('alert')).toHaveTextContent('does not exist');
  });

  it('[CORE-016] fits a phone: nothing scrolls sideways', async () => {
    setViewportWidth(375);
    renderHub();
    await screen.findByRole('heading', { name: 'Releases of Checkout' });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
  });
});
