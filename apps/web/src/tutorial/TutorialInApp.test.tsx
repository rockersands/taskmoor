import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { MEMBER } from '../admin/fixtures';
import { stubBackend } from '../test/backend';
import { jsonResponse } from '../test/setup';

beforeEach(() => window.sessionStorage.clear());

describe('the tutorial in the app (ADR-115)', () => {
  it('[AGL-025] offers the sections on Home under its header, and starts them in the coach card', async () => {
    const user = userEvent.setup();
    const calls = stubBackend({
      'GET /account/tutorial': () => jsonResponse(200, { offer: null, sections: [] }),
      'PUT /account/tutorial/*': () => jsonResponse(200, {}),
      'GET /*': () => jsonResponse(403, { error: 'forbidden' }),
    });
    window.location.hash = '#/home';
    render(<App session={MEMBER} />);
    const offer = await screen.findByRole('region', { name: 'Welcome to Taskmoor, Bo' });
    const heading = screen.getByRole('heading', { level: 1, name: 'Home' });
    const tracks = screen.getByRole('region', { name: 'Your tracks' });
    expect(heading.compareDocumentPosition(offer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(offer.compareDocumentPosition(tracks) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await user.click(within(offer).getByRole('button', { name: 'Start 3 sections' }));
    const card = await screen.findByRole('dialog', { name: 'Tracks and tickets' });
    expect(card).toHaveFocus();
    expect(calls.filter((c) => c.method === 'PUT').map((c) => [c.path, c.body])).toEqual([
      ['/account/tutorial/offer', { state: 'shown' }],
      ['/account/tutorial/tracks', { state: 'active', step: 0 }],
    ]);

    // The card leaves the page usable: C still opens the create dialog over it.
    await user.click(within(card).getByRole('button', { name: 'Next' }));
    await screen.findByRole('dialog', { name: 'Open a track' });
    await user.keyboard('c');
    expect(await screen.findByRole('dialog', { name: 'Create ticket' })).toBeVisible();
  });
});
