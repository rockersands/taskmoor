import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { OAuthSignIn } from './OAuthSignIn';

const client = (failure: string | null = null) => ({
  begin: vi.fn(async () => true),
  failure: () => failure,
});

const show = (ui: React.ReactElement) => render(<I18nProvider locale="en">{ui}</I18nProvider>);

describe('signing in on a backend on another site (M1-107)', () => {
  it('[IAM-024] goes to the backend’s sign-in at once from a page that needs a session', async () => {
    const backend = client();
    show(<OAuthSignIn auto client={backend} host="api.example.net" />);
    expect(await screen.findByText('Taking you to api.example.net to sign in…')).toBeVisible();
    expect(backend.begin).toHaveBeenCalledWith({ auto: true });
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('[IAM-024] waits for the button on the sign-in page and after a sign-in that failed', async () => {
    const user = userEvent.setup();
    const failed = client('state_mismatch');
    show(<OAuthSignIn auto client={failed} host="api.example.net" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Signing in did not finish. Try again.');
    expect(failed.begin).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Sign in on api.example.net' }));
    expect(failed.begin).toHaveBeenCalledWith();
  });
});
