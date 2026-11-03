import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { SessionProvider } from '../session/SessionProvider';
import { setViewportWidth } from '../test/viewport';
import { ADMIN, MEMBER } from './fixtures';
import {
  type UpdateCheck,
  type UpdateCheckClient,
  UpdateCheckSection,
  UpdateNotice,
} from './UpdateNotice';

const AVAILABLE: UpdateCheck = {
  version: '1.2.0',
  enabled: true,
  environmentOff: false,
  developmentBuild: false,
  checkedAt: '2026-11-01T09:30:00.000Z',
  latest: '1.4.0',
  updateAvailable: true,
  command: 'bash update.sh 1.4.0',
  releaseUrl: 'https://github.com/Rockersands/taskmoor/releases/tag/v1.4.0',
};
const CURRENT: UpdateCheck = {
  ...AVAILABLE,
  latest: '1.2.0',
  updateAvailable: false,
  command: null,
  releaseUrl: null,
};

const fake = (answer: UpdateCheck) => {
  const client = {
    load: vi.fn(async () => answer),
    setEnabled: vi.fn(async (enabled: boolean) => ({ ...answer, enabled })),
  } satisfies UpdateCheckClient;
  return client;
};

const asAdmin = (ui: React.ReactNode) =>
  render(
    <I18nProvider locale="en">
      <SessionProvider session={ADMIN}>{ui}</SessionProvider>
    </I18nProvider>,
  );

const notice = () => screen.findByRole('region', { name: 'Taskmoor 1.4.0 is available.' });

describe('the new-version notice', () => {
  beforeEach(() => window.localStorage.clear());

  it('[OPS-026] shows a site administrator the new version and the exact command', async () => {
    asAdmin(<UpdateNotice client={fake(AVAILABLE)} />);
    const region = within(await notice());
    expect(region.getByText(/This server runs 1\.2\.0/)).toBeTruthy();
    expect(region.getByText('bash update.sh 1.4.0')).toBeTruthy();
    expect(region.getByRole('link', { name: 'What is new' }).getAttribute('href')).toBe(
      AVAILABLE.releaseUrl,
    );
  });

  it('[OPS-026] has no button that would update from the app', async () => {
    asAdmin(<UpdateNotice client={fake(AVAILABLE)} />);
    const region = within(await notice());
    const names = region.getAllByRole('button').map((b) => b.textContent);
    expect(names).toEqual(['Copy command', 'Not now']);
  });

  it('[OPS-026] normal people see nothing, and the backend is not even asked', async () => {
    const client = fake(AVAILABLE);
    render(
      <I18nProvider locale="en">
        <SessionProvider session={MEMBER}>
          <UpdateNotice client={client} />
        </SessionProvider>
      </I18nProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.load).not.toHaveBeenCalled();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('[OPS-026] says nothing when nothing is newer, or when the backend cannot answer', async () => {
    const current = fake(CURRENT);
    const { unmount } = asAdmin(<UpdateNotice client={current} />);
    await waitFor(() => expect(current.load).toHaveBeenCalled());
    expect(screen.queryByRole('region')).toBeNull();
    unmount();
    const failing = fake(AVAILABLE);
    failing.load.mockRejectedValue(new Error('down'));
    asAdmin(<UpdateNotice client={failing} />);
    await waitFor(() => expect(failing.load).toHaveBeenCalled());
    expect(screen.queryByRole('region')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('[OPS-026] "Not now" puts off this version; a newer one shows again', async () => {
    const user = userEvent.setup();
    const { unmount } = asAdmin(<UpdateNotice client={fake(AVAILABLE)} />);
    await user.click(within(await notice()).getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('region')).toBeNull();
    unmount();
    const again = fake(AVAILABLE);
    const second = asAdmin(<UpdateNotice client={again} />);
    await waitFor(() => expect(again.load).toHaveBeenCalled());
    expect(screen.queryByRole('region')).toBeNull();
    second.unmount();
    asAdmin(
      <UpdateNotice
        client={fake({ ...AVAILABLE, latest: '1.5.0', command: 'bash update.sh 1.5.0' })}
      />,
    );
    expect(
      await screen.findByRole('region', { name: 'Taskmoor 1.5.0 is available.' }),
    ).toBeTruthy();
  });

  it('[OPS-026] copies the command', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    asAdmin(<UpdateNotice client={fake(AVAILABLE)} />);
    await user.click(within(await notice()).getByRole('button', { name: 'Copy command' }));
    expect(writeText).toHaveBeenCalledWith('bash update.sh 1.4.0');
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy();
  });

  it('[OPS-026] on a phone it keeps every action and the whole command', async () => {
    setViewportWidth(360);
    asAdmin(<UpdateNotice client={fake(AVAILABLE)} />);
    const region = within(await notice());
    expect(region.getByText('bash update.sh 1.4.0')).toBeTruthy();
    expect(region.getByRole('button', { name: 'Not now' })).toBeTruthy();
    expect(region.getByRole('button', { name: 'Copy command' })).toBeTruthy();
  });

  it('[OPS-026] speaks Spanish', async () => {
    render(
      <I18nProvider locale="es">
        <SessionProvider session={ADMIN}>
          <UpdateNotice client={fake(AVAILABLE)} />
        </SessionProvider>
      </I18nProvider>,
    );
    expect(
      await screen.findByRole('region', { name: 'Taskmoor 1.4.0 está disponible.' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copiar el comando' })).toBeTruthy();
  });
});

describe('the updates card on the status page', () => {
  const card = () => screen.findByRole('region', { name: 'Updates' });
  const toggle = () =>
    screen.getByRole<HTMLInputElement>('checkbox', { name: 'Look for new versions once a day' });

  it('[OPS-026] shows what the last look found, with the command', async () => {
    asAdmin(<UpdateCheckSection client={fake(AVAILABLE)} />);
    const region = within(await card());
    expect(region.getByText('1.4.0')).toBeTruthy();
    expect(region.getByText('bash update.sh 1.4.0')).toBeTruthy();
    expect(toggle().checked).toBe(true);
  });

  it('[OPS-026] the setting turns the look off', async () => {
    const user = userEvent.setup();
    const client = fake(CURRENT);
    asAdmin(<UpdateCheckSection client={client} />);
    await card();
    await user.click(toggle());
    expect(client.setEnabled).toHaveBeenCalledWith(false);
    await waitFor(() => expect(toggle().checked).toBe(false));
    expect(screen.queryByText('Newest version')).toBeNull();
  });

  it('[OPS-026] says when the server turned it off, and leaves it locked', async () => {
    asAdmin(<UpdateCheckSection client={fake({ ...CURRENT, environmentOff: true })} />);
    await card();
    expect(toggle().disabled).toBe(true);
    expect(toggle().checked).toBe(false);
    expect(screen.getByText(/TASKMOOR_UPDATE_CHECK=off/)).toBeTruthy();
  });

  it('[OPS-026] says why a development build does not look', async () => {
    asAdmin(<UpdateCheckSection client={fake({ ...CURRENT, developmentBuild: true })} />);
    await card();
    expect(screen.getByText(/development build/)).toBeTruthy();
  });

  it('[OPS-026] says so when the setting could not be saved', async () => {
    const user = userEvent.setup();
    const client = fake(CURRENT);
    client.setEnabled.mockRejectedValue(new Error('down'));
    asAdmin(<UpdateCheckSection client={client} />);
    await card();
    await user.click(toggle());
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(toggle().checked).toBe(true);
  });

  it('[OPS-026] stays away when the backend cannot answer', async () => {
    const client = fake(CURRENT);
    client.load.mockRejectedValue(new Error('down'));
    asAdmin(<UpdateCheckSection client={client} />);
    await waitFor(() => expect(client.load).toHaveBeenCalled());
    expect(screen.queryByRole('region')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
