import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { setViewportWidth } from '../test/viewport';
import { ConsentPage } from './ConsentPage';
import { failingLoad, fakeConsentClient, SAMPLE_REQUEST } from './fixtures';

function renderPage(client = fakeConsentClient()) {
  render(
    <I18nProvider locale="en">
      <ConsentPage client={client} />
    </I18nProvider>,
  );
  return client;
}

describe('the OAuth consent page (M1-072)', () => {
  beforeEach(() => {
    window.location.hash = '#/oauth/consent?request=test-request-0123456789abcdef';
  });

  it('[API-002] (3) names the app, what it may do and where it goes back, then sends the answer', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    expect(
      await screen.findByRole('heading', { name: 'Allow Desktop assistant to use Taskmoor?' }),
    ).toBeVisible();
    expect(screen.getByText(/It sees what you can see/)).toBeVisible();
    expect(screen.getByText(/It can create and change tickets/)).toBeVisible();
    expect(screen.getByText('You go back to an app on this computer.')).toBeVisible();
    expect(client.answers).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Allow' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Sending you back to the app');
    expect(client.answers).toEqual([{ approve: true, scope: 'read write' }]);
    expect(client.visited[0]).toContain('code=sample-code');
  });

  it('[API-002] (3) lets the person allow reading only, or refuse', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('checkbox', { name: 'Also let it make changes' }));
    expect(screen.queryByText(/It can create and change tickets/)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Allow' }));
    expect(client.answers).toEqual([{ approve: true, scope: 'read' }]);

    const refusing = fakeConsentClient();
    document.body.innerHTML = '';
    renderPage(refusing);
    await user.click(await screen.findByRole('button', { name: 'Don’t allow' }));
    expect(refusing.answers).toEqual([{ approve: false, scope: 'read write' }]);
    expect(refusing.visited[0]).toContain('error=access_denied');
  });

  it('[API-002] (3) offers no changes to an app that asked only to read, and names a site', async () => {
    renderPage(
      fakeConsentClient(
        {},
        { ...SAMPLE_REQUEST, scope: 'read', redirectUri: 'https://assistant.example.com/cb' },
      ),
    );
    expect(await screen.findByText('You go back to assistant.example.com.')).toBeVisible();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText(/It can create and change tickets/)).toBeNull();
  });

  it('[API-002] says when the request is gone, also signed out (D35), with no intro above it', async () => {
    renderPage(fakeConsentClient({ load: failingLoad(404) }));
    expect(await screen.findByText(/This request has expired/)).toBeVisible();
    // The intro would ask to read and answer a request that is not there (AC-7).
    expect(screen.queryByText(/Read what it wants/)).toBeNull();
    expect(screen.getByRole('link', { name: 'Go to sign in' })).toHaveAttribute(
      'href',
      '#/sign-in',
    );
  });

  it('[API-002] leads someone signed out to sign in and back to the request (D24)', async () => {
    renderPage(fakeConsentClient({ load: failingLoad(401) }));
    expect(await screen.findByText('Sign in to answer this request.')).toBeVisible();
    // One way out, at the top: it comes back to the request.
    const links = screen.getAllByRole('link');
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveTextContent('Go to sign in');
    expect(links[0]?.getAttribute('href')).toContain(
      encodeURIComponent('/api/v1/oauth/authorize?request=test-request-0123456789abcdef'),
    );
  });

  it('[API-002] says an address with no request names none', () => {
    window.location.hash = '#/oauth/consent';
    renderPage();
    expect(screen.getByText(/This address names no request from an app/)).toBeVisible();
    expect(screen.queryByText(/expired or was already answered/)).toBeNull();
  });

  it('fits a phone', async () => {
    setViewportWidth(360);
    renderPage();
    expect(await screen.findByRole('button', { name: 'Allow' })).toBeVisible();
  });
});
