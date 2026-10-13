import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { I18nProvider } from '../i18n/I18nProvider';
import { SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { AppearanceSection } from './AppearanceSection';
import { fakeAccountClient, KALO, SIGNED_IN } from './fixtures';

function renderSection(client = fakeAccountClient(), user = { ...KALO, appearance: 'system' }) {
  render(
    <I18nProvider locale="en">
      <SessionProvider session={{ status: 'signed-in', user }}>
        <AppearanceSection user={user} client={client} />
      </SessionProvider>
    </I18nProvider>,
  );
  return within(screen.getByRole('region', { name: 'Appearance' }));
}

describe('appearance (M1-122)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete document.documentElement.dataset.skin;
  });

  it('[IAM-008] offers System, Light and Dark, with the saved choice selected', () => {
    const section = renderSection(fakeAccountClient(), { ...KALO, appearance: 'dark' });
    expect(section.getByRole('group', { name: 'Appearance' })).toBeVisible();
    expect(section.getByRole('radio', { name: 'System' })).not.toBeChecked();
    expect(section.getByRole('radio', { name: 'Light' })).not.toBeChecked();
    expect(section.getByRole('radio', { name: 'Dark' })).toBeChecked();
    expect(section.getByRole('radio', { name: 'Dark' })).toHaveAccessibleDescription(
      /deep plum canvas/,
    );
  });

  it('[IAM-008] applies a choice at once and saves it with the account', async () => {
    const user = userEvent.setup();
    const saved: unknown[] = [];
    const client = fakeAccountClient({
      updateProfile: async (changes) => {
        saved.push(changes);
        return { ...KALO, ...changes };
      },
    });
    const section = renderSection(client);
    await user.click(section.getByRole('radio', { name: 'Dark' }));
    expect(document.documentElement.dataset.skin).toBe('dark');
    expect(await section.findByText('Appearance saved to your account.')).toBeVisible();
    expect(saved).toEqual([{ appearance: 'dark' }]);
    await user.click(section.getByRole('radio', { name: 'Light' }));
    expect(document.documentElement.dataset.skin).toBe('light');
    expect(window.localStorage.getItem('taskmoor.appearance')).toBe('light');
  });

  it('keeps the choice in this browser when the account cannot be updated', async () => {
    const user = userEvent.setup();
    const client = fakeAccountClient({
      updateProfile: async () => {
        throw new ApiError(500, { error: 'internal' });
      },
    });
    const section = renderSection(client);
    await user.click(section.getByRole('radio', { name: 'Dark' }));
    expect(await section.findByRole('alert')).toHaveTextContent(
      'Shown in this browser, but your account could not be updated.',
    );
    expect(document.documentElement.dataset.skin).toBe('dark');
  });

  it('offers every choice on a phone', () => {
    setViewportWidth(375);
    const section = renderSection();
    expect(section.getAllByRole('radio')).toHaveLength(3);
  });

  it('passes every string through the pseudo-locale', () => {
    const errors: Error[] = [];
    const { container } = render(
      <I18nProvider locale="en-XA" onError={(e) => errors.push(e)}>
        <SessionProvider session={SIGNED_IN}>
          <AppearanceSection user={KALO} client={fakeAccountClient()} />
        </SessionProvider>
      </I18nProvider>,
    );
    const texts = visibleTexts(container);
    expect(texts.length).toBeGreaterThan(6);
    expect(untranslated(texts)).toEqual([]);
    expect(errors).toEqual([]);
  });
});
