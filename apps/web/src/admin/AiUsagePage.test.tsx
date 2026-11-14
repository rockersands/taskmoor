import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { AiNotice, aiRefusalMessage } from '../ai/AiNotice';
import { I18nProvider, useT } from '../i18n/I18nProvider';
import { SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { setViewportWidth } from '../test/viewport';
import { AiUsagePage, periodDays } from './AiUsagePage';
import { fakeAiNoticeClient, fakeAiUsageClient, QUIET_MONTH } from './aiUsageFixtures';
import { ADMIN, MEMBER } from './fixtures';

const NOW = () => new Date('2026-10-31T15:00:00Z');

function renderPage(client = fakeAiUsageClient(), locale: 'en' | 'en-XA' = 'en') {
  const errors: Error[] = [];
  const view = render(
    <I18nProvider locale={locale} onError={(e) => errors.push(e)}>
      <SessionProvider session={ADMIN}>
        <AiUsagePage client={client} now={NOW} />
      </SessionProvider>
    </I18nProvider>,
  );
  return { errors, container: view.container, client };
}

const rows = (table: HTMLElement) =>
  within(table)
    .getAllByRole('row')
    .slice(1)
    .map((r) => r.textContent);

describe('AI usage page (M1-077)', () => {
  it('[OPS-020] shows the totals and the usage by day, feature, person and model', async () => {
    renderPage();
    const people = await screen.findByRole('table', { name: 'By person' });
    expect(rows(people)).toEqual([
      'Ada Lovelace25100,000$0.72',
      'Grace Hopper517,000$0.18',
      'The system1233,000$0.18',
    ]);
    expect(rows(screen.getByRole('table', { name: 'By feature' }))).toEqual([
      'Duplicate suggestions1233,000$0.18',
      'Summaries30117,000$0.90',
    ]);
    expect(rows(screen.getByRole('table', { name: 'By model' }))).toEqual([
      'claude-opus-5-5 (anthropic)42150,000$1.08',
    ]);
    expect(screen.getByRole('table', { name: 'By day (UTC)' })).toBeVisible();
    expect(screen.getByText('Refused by a limit', { selector: 'dt' })).toBeVisible();
  });

  it('[OPS-020] asks for the last 7 days, the last 30 days or this month, in UTC', async () => {
    const { client } = renderPage();
    await screen.findByRole('table', { name: 'By person' });
    await userEvent.click(screen.getByRole('button', { name: 'Last 7 days' }));
    await screen.findByRole('table', { name: 'By person' });
    await userEvent.click(screen.getByRole('button', { name: 'This month' }));
    await screen.findByRole('table', { name: 'By person' });
    expect(client.asked).toEqual([
      { from: '2026-10-02', to: '2026-10-31' },
      { from: '2026-10-25', to: '2026-10-31' },
      { from: '2026-10-01', to: '2026-10-31' },
    ]);
    expect(periodDays('week', new Date('2026-03-01T01:00:00Z'))).toEqual({
      from: '2026-02-23',
      to: '2026-03-01',
    });
  });

  it('[OPS-020] lists the spend limits with their use, and the latest calls of the AI audit log', async () => {
    renderPage();
    const limits = await screen.findByRole('table', { name: 'Spend limits' });
    expect(rows(limits)).toEqual([
      'Everyone togetherMonth$1.08 of $50.00Nov 1, 2026, 12:00 AM',
      'Each personDay100,000 tokens eachNov 1, 2026, 12:00 AM',
      'SummariesWeek117,000 tokens of 117,000 tokensNov 2, 2026, 12:00 AM',
    ]);
    const calls = await screen.findByRole('table', { name: 'Latest AI calls' });
    expect(within(calls).getAllByRole('row')[1]).toHaveTextContent('Refused by a limit');
  });

  it('[IAM-022] (2) shows administrators what leaves the site', async () => {
    renderPage();
    const statement = await screen.findByRole('region', { name: 'What leaves this site' });
    expect(statement).toHaveTextContent(
      'AI features send data to Amazon Bedrock, region eu-central-1.',
    );
    expect(statement).toHaveTextContent(
      'Summaries on claude-opus-5-5: the ticket’s fields, its comments.',
    );
    // A feature that is off sends nothing and is not listed.
    expect(statement).not.toHaveTextContent('Drafting tickets');
    expect(statement).toHaveTextContent(
      'Replaced by a placeholder before sending: card numbers, IBANs, US social security numbers; 1 field marked sensitive; 2 listed terms.',
    );
  });

  it('says when nothing used AI', async () => {
    renderPage(fakeAiUsageClient(QUIET_MONTH, { limits: [] }));
    expect(await screen.findAllByText('No AI calls in this period.')).not.toHaveLength(0);
    expect(screen.getByText('No spend limits are set.')).toBeVisible();
  });

  it('[OPS-020] is for site administrators only', async () => {
    window.location.hash = '#/admin/ai-usage';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(403, { error: 'forbidden' })),
    );
    render(<App session={MEMBER} />);
    expect(await screen.findByText('Only site administrators see AI usage.')).toBeVisible();
  });

  it('fits a phone without sideways scrolling', async () => {
    setViewportWidth(360);
    const { container } = renderPage();
    await screen.findByRole('table', { name: 'By person' });
    for (const wrap of container.querySelectorAll('.api-usage-table-wrap')) {
      expect(wrap.querySelector('table')).not.toBeNull();
      // Each sideways scroller is reachable by keyboard and named (AD-3).
      expect(wrap).toHaveAttribute('tabindex', '0');
      expect(wrap).toHaveAccessibleName();
    }
  });

  it('passes every string through the pseudo-locale', async () => {
    const { container, errors } = renderPage(fakeAiUsageClient(), 'en-XA');
    await screen.findAllByRole('table');
    await screen.findAllByRole('region');
    const data = ['Ada Lovelace', 'Grace Hopper', 'claude-', 'eu-central-1', 'anthropic'];
    const texts = visibleTexts(container).filter(
      (t) =>
        !/^[\d,.$:\s/APM]+$/.test(t) &&
        // Dates and times are formatted by the locale, not taken from the catalogue.
        !/^(Oct|Nov) \d+, 2026/.test(t) &&
        !data.some((d) => t.includes(d)),
    );
    expect(untranslated(texts)).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe('AI first-use notice (M1-077)', () => {
  const renderNotice = (client = fakeAiNoticeClient()) =>
    render(
      <I18nProvider locale="en">
        <AiNotice client={client}>
          <p>The AI feature</p>
        </AiNotice>
      </I18nProvider>,
    );

  it('[IAM-022] shows what is sent before the first use, then the feature once read', async () => {
    const client = fakeAiNoticeClient();
    renderNotice(client);
    const notice = await screen.findByRole('region', { name: 'Before you use AI' });
    expect(notice).toHaveTextContent('AI features send data to Amazon Bedrock');
    expect(notice).toHaveTextContent(
      'Never sent: tickets you cannot see, fields the field rules hide, fields marked sensitive, attachments, passwords, tokens and keys.',
    );
    expect(screen.queryByText('The AI feature')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'I understand' }));
    expect(await screen.findByText('The AI feature')).toBeVisible();
    expect(client.acknowledged).toBe(1);
  });

  it('[IAM-022] stays out of the way once read', async () => {
    renderNotice(fakeAiNoticeClient('2026-10-30T09:00:00Z'));
    expect(await screen.findByText('The AI feature')).toBeVisible();
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('[OPS-020] (1) words a refused call: the limit and when AI is back', () => {
    let said: string[] = [];
    function Probe() {
      const t = useT();
      const date = (iso: string) => iso.slice(0, 10);
      said = [
        aiRefusalMessage(
          { error: 'ai_limit_reached', limit: { resetsAt: '2026-11-01T00:00:00Z' } },
          t,
          date,
        ),
        aiRefusalMessage({ error: 'ai_disabled' }, t, date),
        aiRefusalMessage({ error: 'ai_provider_error' }, t, date),
      ];
      return null;
    }
    render(
      <I18nProvider locale="en">
        <Probe />
      </I18nProvider>,
    );
    expect(said).toEqual([
      'The AI limit is reached. AI is available again from 2026-11-01.',
      'This AI feature is turned off.',
      'AI could not help with this request.',
    ]);
  });
});
