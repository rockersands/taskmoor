import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { setViewportWidth } from '../test/viewport';
import type { TutorialClient, TutorialProgress } from './client';
import { TutorialCoach, TutorialProvider } from './TutorialProvider';
import { TutorialsPage } from './TutorialsPage';

function fakeClient(progress: TutorialProgress | Error) {
  return {
    progress: vi.fn(async () => {
      if (progress instanceof Error) throw progress;
      return progress;
    }),
    save: vi.fn(async () => {}),
    answerOffer: vi.fn(async () => {}),
  } satisfies TutorialClient;
}

const PROGRESS: TutorialProgress = {
  offer: 'dismissed',
  sections: [
    { section: 'tracks', state: 'done', step: 9 },
    { section: 'dashboards', state: 'active', step: 3 },
    { section: 'search', state: 'skipped', step: 1 },
  ],
};

function renderPage(client: TutorialClient, session: Session = MEMBER) {
  return render(
    <I18nProvider locale="en">
      <SessionProvider session={session}>
        <TutorialProvider client={client}>
          <main id="main" tabIndex={-1}>
            <TutorialsPage client={client} />
            <TutorialCoach />
          </main>
        </TutorialProvider>
      </SessionProvider>
    </I18nProvider>,
  );
}

beforeEach(() => window.sessionStorage.clear());

describe('Settings, Tutorials (ADR-115)', () => {
  it('[AGL-025] shows where the person is in each section, after skipping the offer too', async () => {
    renderPage(fakeClient(PROGRESS));
    expect(
      await screen.findByRole('button', { name: 'Do it again: Tracks and tickets' }),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'Resume: Dashboards' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start: Search and saved searches' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start: Boards and sprints' })).toBeVisible();
    expect(screen.getAllByRole('checkbox')).toHaveLength(5);
    // Ticked to start with: every section not done yet.
    expect(screen.getByRole('checkbox', { name: 'Learn Tracks and tickets' })).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Start 4 sections' })).toBeEnabled();
  });

  it('[AGL-025] resumes a section where the person left it', async () => {
    const user = userEvent.setup();
    const client = fakeClient(PROGRESS);
    renderPage(client);
    await user.click(await screen.findByRole('button', { name: 'Resume: Dashboards' }));
    const step = await screen.findByRole('dialog', { name: 'Edit it' });
    expect(within(step).getByText('Dashboards · Step 4 of 6')).toBeVisible();
    expect(step).toHaveFocus();
    expect(client.save).toHaveBeenLastCalledWith('dashboards', 'active', 3);
    expect(screen.getByText(/^A tutorial is open in its card\./)).toBeVisible();
  });

  it('[AGL-025] replays a finished section from its first step', async () => {
    const user = userEvent.setup();
    const client = fakeClient(PROGRESS);
    renderPage(client);
    await user.click(
      await screen.findByRole('button', { name: 'Do it again: Tracks and tickets' }),
    );
    const step = await screen.findByRole('dialog', { name: 'Tracks and tickets' });
    expect(within(step).getByText('Tracks and tickets · Step 1 of 8')).toBeVisible();
    expect(client.save).toHaveBeenLastCalledWith('tracks', 'active', 0);
    // Saved here, so the page shows it at once.
    expect(screen.getByRole('button', { name: 'Resume: Tracks and tickets' })).toBeVisible();
  });

  it('[AGL-025] starts the ticked sections one after another', async () => {
    const user = userEvent.setup();
    const client = fakeClient({ offer: null, sections: [] });
    renderPage(client, ADMIN);
    await screen.findByRole('button', { name: 'Start 8 sections' });
    for (const name of [
      'Tracks and tickets',
      'Workflows',
      'Boards and sprints',
      'Search and saved searches',
      'Releases',
      'Administration',
    ]) {
      await user.click(screen.getByRole('checkbox', { name: `Learn ${name}` }));
    }
    await user.click(screen.getByRole('button', { name: 'Start 2 sections' }));
    const first = await screen.findByRole('dialog', { name: 'Dashboards' });
    await user.click(within(first).getByRole('button', { name: 'Skip section' }));
    expect(await screen.findByRole('dialog', { name: 'Import' })).toHaveFocus();
    expect(client.save).toHaveBeenCalledWith('dashboards', 'skipped', 0);
    expect(screen.getByRole('button', { name: 'Start: Dashboards' })).toBeVisible();
  });

  it('[AGL-025] lets every section start when progress cannot be read', async () => {
    renderPage(fakeClient(new Error('offline')));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your progress could not be read.');
    expect(screen.getAllByRole('button', { name: /^Start: / })).toHaveLength(5);
  });

  it('[AGL-025] [NFR-005] works on a phone', async () => {
    setViewportWidth(375);
    const user = userEvent.setup();
    renderPage(fakeClient(PROGRESS));
    await user.click(await screen.findByRole('button', { name: 'Start: Boards and sprints' }));
    expect(await screen.findByRole('dialog', { name: 'Boards and sprints' })).toHaveFocus();
  });
});
