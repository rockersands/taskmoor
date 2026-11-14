import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { App } from '../App';
import { MEMBER } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import { type Handler, stubBackend, visibleTexts } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { BUG_FORM, PRIORITIES, TRACKS, TYPES } from '../tickets/fixtures';
import { DRAFTS } from './aiFixtures';
import type { SummaryCitation } from './client';
import { SummaryPanel } from './SummaryPanel';

/**
 * The AI controls in the app (M1-079; AI-013, AI-015, AI-016, NFR-011), against a stubbed
 * backend: none shows without a provider while duplicate suggestions still do; a draft fills the
 * create form and creates nothing; a summary's first words show before it is finished.
 */
const FEATURES = (available: boolean) =>
  jsonResponse(200, {
    features: Object.fromEntries(
      ['summarize', 'query-from-text', 'assisted-creation', 'duplicates'].map((f) => [
        f,
        available ? { available: true } : { available: false, reason: 'not_configured' },
      ]),
    ),
  });

function openCreate(handlers: Record<string, Handler>) {
  const calls = stubBackend({
    'GET /tracks?limit=500': () => jsonResponse(200, { tracks: TRACKS }),
    'GET /priorities': () => jsonResponse(200, { priorities: PRIORITIES }),
    'GET /tracks/SHOP/ticket-types': () =>
      jsonResponse(200, { typeSetId: 1, defaultTypeId: 3, ticketTypes: TYPES }),
    'GET /tracks/SHOP/layout?ticketTypeId=3&operation=create': () => jsonResponse(200, BUG_FORM),
    'POST /tickets/similar': () =>
      jsonResponse(200, {
        model: 'local:all-MiniLM-L6-v2',
        similar: [
          {
            ticket: { id: 4, key: 'SHOP-4', summary: 'Expired card leaves checkout blank' },
            score: 0.81,
            match: 'ticket',
          },
        ],
      }),
    ...handlers,
  });
  window.location.hash = '#/create';
  render(<App session={MEMBER} />);
  return calls;
}

describe('AI controls (M1-079)', () => {
  it('[NFR-011] [AI-016] with no provider no AI control shows, and duplicates still come from embeddings', async () => {
    const user = userEvent.setup();
    const calls = openCreate({ 'GET /ai/features?trackId=1': () => FEATURES(false) });
    await user.type(
      await screen.findByLabelText('Summary (required)'),
      'Checkout is blank with an expired card',
    );
    expect(
      await screen.findByRole('link', { name: 'SHOP-4: Expired card leaves checkout blank' }),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Draft from text' })).toBeNull();
    const asked = calls.filter((c) => c.path === '/tickets/similar');
    expect(asked.at(-1)?.body).toMatchObject({ track: 'SHOP', reasons: false });
    // The AI notice is never asked for: nothing AI happens.
    expect(calls.some((c) => c.path === '/ai/notice')).toBe(false);
  });

  it('[AI-015] a draft from pasted text fills the form, and nothing is created until Create', async () => {
    const user = userEvent.setup();
    const calls = openCreate({
      'GET /ai/features?trackId=1': () => FEATURES(true),
      'GET /ai/notice': () =>
        jsonResponse(200, {
          acknowledgedAt: '2026-10-30T09:00:00Z',
          statement: {
            provider: null,
            region: null,
            features: [],
            retention: null,
            redactedFields: [],
            patterns: [],
          },
        }),
      'POST /ai/drafts': () => jsonResponse(200, { track: { id: 1, key: 'SHOP' }, drafts: DRAFTS }),
    });
    await user.click(await screen.findByRole('button', { name: 'Draft from text' }));
    await user.type(
      screen.getByRole('textbox', { name: 'Paste notes, an email or a bug report' }),
      'Refunds do nothing on Safari.',
    );
    await user.click(screen.getByRole('button', { name: 'Draft' }));
    await user.click(
      await screen.findByRole('button', {
        name: 'Use the draft Refund button does nothing on Safari',
      }),
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Summary (required)')).toHaveValue(
        'Refund button does nothing on Safari',
      ),
    );
    expect(
      screen.getByText('The draft is in the form. Check it, then press Create.'),
    ).toBeVisible();
    expect(calls.filter((c) => c.method === 'POST' && c.path === '/tickets')).toEqual([]);
    expect(calls.find((c) => c.path === '/ai/drafts')?.body).toEqual({
      track: 'SHOP',
      text: 'Refunds do nothing on Safari.',
    });
  });

  it('[AI-013] [AI-007] a summary’s first words show before it is finished', async () => {
    let finish: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const client = {
      summary: async (
        _t: string | number,
        _s: 'ticket' | 'thread',
        onText: (text: string) => void,
      ) => {
        onText('Checkout shows a blank page ');
        await done;
        onText('[c5].');
        return {
          status: 'done' as const,
          text: 'Checkout shows a blank page [c5].',
          citations: [{ commentId: 5, author: 'Ana' }] as SummaryCitation[],
          externalLinks: [],
          omitted: 0,
        };
      },
      query: async () => {
        throw new Error('unused');
      },
      drafts: async () => [],
      breakdown: async () => {
        throw new Error('unused');
      },
      createChild: async () => ({ key: 'X-1' }),
    };
    const user = userEvent.setup();
    render(
      <I18nProvider locale="en">
        <SummaryPanel
          ticket={{ id: 1, key: 'SHOP-1' }}
          client={client}
          notice={{
            notice: async () => ({ acknowledgedAt: 'x', statement: {} as never }),
            acknowledge: async () => {},
          }}
          features={async () => ({ summarize: { available: true } })}
        />
      </I18nProvider>,
    );
    await user.click(await screen.findByRole('button', { name: 'Summarise ticket' }));
    const region = await screen.findByText('Checkout shows a blank page');
    expect(region).toBeVisible();
    expect(screen.queryByRole('link')).toBeNull();
    finish?.();
    const link = await screen.findByRole('link', { name: 'Comment 1, by Ana' });
    expect(link).toHaveAttribute('href', expect.stringContaining('#/tickets/SHOP-1?comment=5'));
    expect(visibleTexts(document.body).join(' ')).toContain('Written by AI');
    expect(within(document.body).queryByRole('alert')).toBeNull();
  });
});
