import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { I18nProvider } from '../i18n/I18nProvider';
import { SessionProvider } from '../session/SessionProvider';
import { fakeInvitationClient } from './fixtures';
import { InvitationPage } from './InvitationPage';

function renderPage(client = fakeInvitationClient()) {
  render(
    <I18nProvider locale="en">
      <SessionProvider session={{ status: 'anonymous' }}>
        <InvitationPage client={client} />
      </SessionProvider>
    </I18nProvider>,
  );
}

describe('the invitation page’s problems (D24)', () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it('[IAM-027] says a link with no invitation in it as an alert in the error style', () => {
    window.location.hash = '#/invite';
    renderPage();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/This address has no invitation in it/);
    expect(alert).toHaveClass('page-note');
  });

  it('[IAM-027] says a used, withdrawn or expired link as an alert in the error style', async () => {
    window.location.hash = '#/invite?token=invitation-token-0123456789';
    const client = fakeInvitationClient();
    client.inspect = async () => {
      throw new ApiError(404, { error: 'invalid_link' });
    };
    renderPage(client);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/This invitation can no longer be used/);
    expect(alert).toHaveClass('page-note');
  });

  it('[IAM-027] announces the check politely, not as an alert', () => {
    window.location.hash = '#/invite?token=invitation-token-0123456789';
    const client = fakeInvitationClient();
    client.inspect = () => new Promise(() => {});
    renderPage(client);
    expect(screen.getByRole('status')).toHaveTextContent('Checking the link…');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
