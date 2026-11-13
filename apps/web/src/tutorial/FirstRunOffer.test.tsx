import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { stubBackend, untranslated, visibleTexts } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import { readProgress, type TutorialClient, type TutorialProgress, tutorialClient } from './client';
import { FirstRunOffer } from './FirstRunOffer';
import { TutorialCoach, TutorialProvider } from './TutorialProvider';

function fakeClient(progress: TutorialProgress | Error = { offer: null, sections: [] }) {
  return {
    progress: vi.fn(async () => {
      if (progress instanceof Error) throw progress;
      return progress;
    }),
    save: vi.fn(async () => {}),
    answerOffer: vi.fn(async () => {}),
  } satisfies TutorialClient;
}

function renderOffer(client: TutorialClient, session: Session = MEMBER, locale: Locale = 'en') {
  return render(
    <I18nProvider locale={locale}>
      <SessionProvider session={session}>
        <TutorialProvider client={client}>
          <main id="main" tabIndex={-1}>
            <FirstRunOffer client={client} />
            <TutorialCoach />
          </main>
        </TutorialProvider>
      </SessionProvider>
    </I18nProvider>,
  );
}

const offer = () => screen.findByRole('region', { name: 'Welcome to Taskmoor, Bo' });

beforeEach(() => window.sessionStorage.clear());

describe('the first-run offer (ADR-115)', () => {
  it('[AGL-025] offers the sections to tick, the suggested ones ticked, until answered', async () => {
    renderOffer(fakeClient());
    const shown = await offer();
    const boxes = within(shown).getAllByRole('checkbox');
    expect(boxes).toHaveLength(5);
    expect(
      within(shown)
        .getAllByRole('checkbox', { checked: true })
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual([
      'Learn Tracks and tickets',
      'Learn Boards and sprints',
      'Learn Search and saved searches',
    ]);
    expect(within(shown).getByRole('button', { name: 'Start 3 sections' })).toBeEnabled();
    expect(within(shown).getByRole('button', { name: 'Not now' })).toBeEnabled();
    expect(within(shown).getByRole('button', { name: 'Don’t offer again' })).toBeEnabled();
  });

  it('[AGL-025] offers administrators the sections they may do as well', async () => {
    renderOffer(fakeClient(), ADMIN);
    const shown = await screen.findByRole('region', { name: 'Welcome to Taskmoor, Ada' });
    expect(within(shown).getAllByRole('checkbox')).toHaveLength(8);
  });

  it('[AGL-025] Start saves the answer and starts the ticked sections in the coach card', async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    renderOffer(client);
    const shown = await offer();
    await user.click(within(shown).getByRole('checkbox', { name: 'Learn Tracks and tickets' }));
    await user.click(within(shown).getByRole('checkbox', { name: 'Learn Boards and sprints' }));
    await user.click(within(shown).getByRole('button', { name: 'Start 1 section' }));
    expect(client.answerOffer).toHaveBeenCalledWith('shown');
    const card = await screen.findByRole('dialog', { name: 'Search and saved searches' });
    expect(card).toHaveFocus();
    expect(screen.queryByRole('region', { name: /Welcome/ })).toBeNull();
    expect(client.save).toHaveBeenCalledWith('search', 'active', 0);
  });

  it('[AGL-025] Not now closes it for good and points to Settings, Tutorials', async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    const { unmount } = renderOffer(client);
    await user.click(within(await offer()).getByRole('button', { name: 'Not now' }));
    expect(client.answerOffer).toHaveBeenCalledWith('shown');
    const note = await screen.findByRole('status');
    expect(note).toHaveFocus();
    expect(within(note).getByRole('link', { name: 'Open Tutorials' })).toHaveAttribute(
      'href',
      '#/settings/tutorials',
    );
    expect(screen.queryByRole('region', { name: /Welcome/ })).toBeNull();
    unmount();

    // The next visit: answered, so only the small link shows (D10).
    const answered = fakeClient({ offer: 'shown', sections: [] });
    renderOffer(answered);
    expect(await screen.findByRole('link', { name: 'Getting started' })).toHaveAttribute(
      'href',
      '#/settings/tutorials',
    );
    expect(screen.queryByRole('region', { name: /Welcome/ })).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('[AGL-025] counts as seen once shown, and the next visit puts own work first (PL-9, D10)', async () => {
    const first = fakeClient();
    const { unmount } = renderOffer(first);
    await offer();
    // Seen: saved at once, with no answer from the person.
    await waitFor(() => expect(first.answerOffer).toHaveBeenCalledWith('shown'));
    unmount();

    const next = fakeClient({ offer: 'shown', sections: [] });
    renderOffer(next);
    expect(await screen.findByRole('link', { name: 'Getting started' })).toBeVisible();
    expect(screen.queryByRole('region', { name: /Welcome/ })).toBeNull();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(next.answerOffer).not.toHaveBeenCalled();
  });

  it('[AGL-025] Don’t offer again records that, and every section stays in Settings', async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    renderOffer(client);
    await user.click(within(await offer()).getByRole('button', { name: 'Don’t offer again' }));
    expect(client.answerOffer).toHaveBeenCalledWith('dismissed');
    expect(await screen.findByRole('status')).toHaveTextContent(
      'We won’t offer the tutorial again. Every section stays in Settings, Tutorials if you change your mind. Open Tutorials',
    );
  });

  it('[AGL-025] says when the answer could not be saved, and lets the person try again', async () => {
    const user = userEvent.setup();
    const client = fakeClient();
    // The first save is the quiet "seen"; the person's own answer is the one that fails.
    client.answerOffer.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('offline'));
    renderOffer(client);
    const shown = await offer();
    await user.click(within(shown).getByRole('button', { name: 'Not now' }));
    expect(await within(shown).findByRole('alert')).toHaveTextContent(
      'Your answer could not be saved. Try again.',
    );
    await user.click(within(shown).getByRole('button', { name: 'Not now' }));
    expect(await screen.findByRole('status')).toBeVisible();
  });

  it('[AGL-025] is only the small link once a section was started, and nothing when progress cannot be read', async () => {
    const started = fakeClient({
      offer: null,
      sections: [{ section: 'boards', state: 'active', step: 2 }],
    });
    const { unmount } = renderOffer(started);
    expect(await screen.findByRole('link', { name: 'Getting started' })).toBeVisible();
    expect(screen.queryByRole('region', { name: /Welcome/ })).toBeNull();
    unmount();
    const failing = fakeClient(new Error('offline'));
    renderOffer(failing);
    await waitFor(() => expect(failing.progress).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: /Welcome/ })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Getting started' })).toBeNull();
  });

  it('[AGL-025] [NFR-005] works on a phone', async () => {
    setViewportWidth(375);
    const user = userEvent.setup();
    renderOffer(fakeClient());
    const shown = await offer();
    await user.click(within(shown).getByRole('button', { name: 'Start 3 sections' }));
    expect(await screen.findByRole('dialog', { name: 'Tracks and tickets' })).toHaveFocus();
  });
});

describe('the tutorial in the pseudo-locale', () => {
  it('[NFR-006] takes every string of the offer and the coach card from the catalogue', async () => {
    const user = userEvent.setup();
    renderOffer(fakeClient(), MEMBER, 'en-XA');
    const main = screen.getByRole('main');
    await within(main).findByRole('region');
    expect(untranslated(visibleTexts(main))).toEqual([]);
    const [start] = within(main).getAllByRole('button');
    if (start) await user.click(start);
    await within(main).findByRole('dialog');
    expect(untranslated(visibleTexts(main))).toEqual([]);
  });
});

describe('the tutorial client (ADR-115)', () => {
  it('[AGL-025] reads the progress the server keeps and saves a section and the offer', async () => {
    const calls = stubBackend({
      'GET /account/tutorial': () =>
        jsonResponse(200, {
          offer: 'dismissed',
          sections: [
            { section: 'boards', state: 'active', step: 3, updatedAt: '2026-11-03T10:00:00Z' },
            { section: 'gone', state: 'done', step: 1, updatedAt: '2026-11-03T10:00:00Z' },
          ],
        }),
      'PUT /account/tutorial/boards': () => jsonResponse(200, {}),
      'PUT /account/tutorial/offer': () => jsonResponse(200, {}),
    });
    expect(await tutorialClient.progress()).toEqual({
      offer: 'dismissed',
      sections: [{ section: 'boards', state: 'active', step: 3 }],
    });
    await tutorialClient.save('boards', 'done', 7);
    await tutorialClient.answerOffer('shown');
    expect(calls.map((c) => [c.method, c.path, c.body])).toEqual([
      ['GET', '/account/tutorial', undefined],
      ['PUT', '/account/tutorial/boards', { state: 'done', step: 7 }],
      ['PUT', '/account/tutorial/offer', { state: 'shown' }],
    ]);
  });

  it('[AGL-025] offers nothing on an answer of another shape', () => {
    expect(() => readProgress({})).toThrow();
    expect(() => readProgress({ offer: 'maybe', sections: [] })).toThrow();
    expect(() => readProgress(null)).toThrow();
  });
});
