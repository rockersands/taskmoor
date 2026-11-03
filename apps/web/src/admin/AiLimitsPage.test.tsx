import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { type AiLimitsClient, AiLimitsPage, type AiPrice, type StoredLimit } from './AiLimitsPage';
import { fakeAiLimitsClient } from './aiLimitsFixtures';
import { ADMIN, CONFIG_ADMIN } from './fixtures';

function renderPage(
  session: Session = ADMIN,
  locale: Locale = 'en',
  client: AiLimitsClient & { calls: { action: string; args: unknown[] }[] } = fakeAiLimitsClient(),
) {
  render(
    <I18nProvider locale={locale}>
      <SessionProvider session={session}>
        <main>
          <AiLimitsPage client={client} />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return client;
}

describe('AI limits and prices (UI-T19)', () => {
  it('[OPS-020] lists limits with their use, and prices with where they come from', async () => {
    renderPage();
    const limits = await screen.findByRole('region', { name: 'Spend limits' });
    expect(within(limits).getByText('Everyone together, per Month')).toBeVisible();
    expect(within(limits).getByText('1,200 tokens of 200,000 tokens')).toBeVisible();
    expect(within(limits).getByText('200,000 tokens each')).toBeVisible();
    const prices = screen.getByRole('region', { name: 'Price table' });
    const list = within(prices)
      .getByText(/anthropic, claude-example/)
      .closest('li');
    expect(within(list as HTMLElement).getByText('List price: check your bill')).toBeVisible();
    expect(within(list as HTMLElement).getByText(/Above 100,000 tokens/)).toBeVisible();
  });

  it('[OPS-020] adds a daily limit for each person, in tokens', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Add a limit' }));
    const form = screen.getByRole('form', { name: 'Add a limit' });
    await user.selectOptions(within(form).getByLabelText('Who it counts'), 'Each person');
    await user.selectOptions(within(form).getByLabelText('Period'), 'Day');
    await user.type(within(form).getByLabelText('Amount in tokens'), '200000');
    await user.click(within(form).getByRole('button', { name: 'Save the limit' }));
    expect(await screen.findByText('The limit was added.')).toBeInTheDocument();
    expect(client.calls.at(-1)).toEqual({
      action: 'createLimit',
      args: [
        {
          scope: 'user',
          feature: null,
          userId: null,
          period: 'day',
          metric: 'tokens',
          amount: 200000,
          alertPercents: [80, 100],
        },
      ],
    });
  });

  it('[OPS-020] adds a limit for one person and one for a feature, in US dollars', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Add a limit' }));
    const form = screen.getByRole('form', { name: 'Add a limit' });
    await user.selectOptions(within(form).getByLabelText('Who it counts'), 'One person');
    await user.type(within(form).getByLabelText('Find a person'), 'noor');
    await within(form).findByRole('option', { name: 'Noor Haddad' });
    await user.selectOptions(within(form).getByLabelText('Measure'), 'Cost in US dollars');
    await user.type(within(form).getByLabelText('Amount in US dollars'), '25.5');
    await user.click(within(form).getByRole('button', { name: 'Save the limit' }));
    await screen.findByText('The limit was added.');
    expect(client.calls.at(-1)?.args[0]).toMatchObject({
      scope: 'user',
      userId: 8,
      metric: 'cost',
      amount: 25.5,
    });
    await user.click(screen.getByRole('button', { name: 'Add a limit' }));
    const next = screen.getByRole('form', { name: 'Add a limit' });
    await user.selectOptions(within(next).getByLabelText('Who it counts'), 'One feature');
    await user.selectOptions(within(next).getByLabelText('Feature'), 'summarize');
    await user.type(within(next).getByLabelText('Amount in tokens'), '10');
    await user.click(within(next).getByRole('button', { name: 'Save the limit' }));
    await screen.findByText('The limit was added.');
    expect(client.calls.at(-1)?.args[0]).toMatchObject({ scope: 'feature', feature: 'summarize' });
  });

  it('[OPS-020] refuses an amount and alerts it cannot use, before asking the server', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Add a limit' }));
    const form = screen.getByRole('form', { name: 'Add a limit' });
    await user.click(within(form).getByRole('button', { name: 'Save the limit' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('above zero');
    await user.type(within(form).getByLabelText('Amount in tokens'), '10');
    await user.clear(within(form).getByLabelText('Alert at these percentages'));
    await user.type(within(form).getByLabelText('Alert at these percentages'), '150');
    await user.click(within(form).getByRole('button', { name: 'Save the limit' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('1 and 100');
    expect(client.calls).toEqual([]);
  });

  it('[OPS-020] changes and deletes a limit', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(
      await screen.findByRole('button', { name: 'Change the limit: Everyone together, Month' }),
    );
    const form = screen.getByRole('form', { name: 'Change the limit: Everyone together, Month' });
    expect(within(form).getByLabelText('Amount in tokens')).toHaveValue(200000);
    await user.clear(within(form).getByLabelText('Amount in tokens'));
    await user.type(within(form).getByLabelText('Amount in tokens'), '300000');
    await user.click(within(form).getByRole('button', { name: 'Save the limit' }));
    expect(await screen.findByText('The limit was saved.')).toBeInTheDocument();
    expect(client.calls.at(-1)).toMatchObject({
      action: 'updateLimit',
      args: [1, { amount: 300000 }],
    });
    await user.click(screen.getByRole('button', { name: 'Delete the limit: Each person, Day' }));
    await user.click(screen.getByRole('button', { name: 'Yes, delete' }));
    expect(await screen.findByText('The limit was deleted.')).toBeInTheDocument();
  });

  it('[OPS-020] sets a rate, and goes back to the list price', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(
      await screen.findByRole('button', { name: 'Change the rate of anthropic, claude-example' }),
    );
    const form = screen.getByRole('form', {
      name: 'Change the rate of anthropic, claude-example',
    });
    expect(within(form).getByLabelText('Model')).toHaveAttribute('readonly');
    await user.clear(within(form).getAllByLabelText('Input')[0] as HTMLElement);
    await user.type(within(form).getAllByLabelText('Input')[0] as HTMLElement, '4');
    await user.click(within(form).getByRole('button', { name: 'Save the rate' }));
    expect(await screen.findByText('The rate of claude-example was saved.')).toBeInTheDocument();
    expect(client.calls.at(-1)?.args[0]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-example',
      input: 4,
      longContext: { aboveTokens: 100000 },
    });
    await user.click(
      await screen.findByRole('button', {
        name: 'Back to the list price: anthropic, claude-example',
      }),
    );
    expect(
      await screen.findByText('claude-example is back to its list price.'),
    ).toBeInTheDocument();
    expect(client.calls.at(-1)).toEqual({
      action: 'resetPrice',
      args: ['anthropic', 'claude-example'],
    });
  });

  it('[OPS-020] adds a rate for a provider with no list price', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('button', { name: 'Add a rate' }));
    const form = screen.getByRole('form', { name: 'Add a rate' });
    await user.type(within(form).getByLabelText('Provider'), 'bedrock');
    await user.type(within(form).getByLabelText('Model'), 'custom');
    await user.click(within(form).getByRole('button', { name: 'Save the rate' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent('Fill in');
    for (const [i, label] of ['Input', 'Output', 'Cache reads', 'Cache writes'].entries()) {
      await user.type(within(form).getAllByLabelText(label)[0] as HTMLElement, String(i + 1));
    }
    await user.click(within(form).getByRole('button', { name: 'Save the rate' }));
    await screen.findByText('The rate of custom was saved.');
    expect(client.calls.at(-1)?.args[0]).toEqual({
      provider: 'bedrock',
      model: 'custom',
      input: 1,
      output: 2,
      cacheRead: 3,
      cacheWrite: 4,
      longContext: null,
    });
  });

  it('[IAM-009] is for site administrators', () => {
    renderPage(CONFIG_ADMIN);
    expect(screen.getByText(/Only site administrators/)).toBeVisible();
  });

  it('explains having no limits', async () => {
    renderPage(ADMIN, 'en', fakeAiLimitsClient([] as StoredLimit[], [] as AiPrice[]));
    expect(await screen.findByText('No spend limits are set.')).toBeVisible();
  });

  it('fits a small phone', async () => {
    setViewportWidth(375);
    renderPage();
    expect(await screen.findByRole('region', { name: 'Price table' })).toBeVisible();
  });

  it('passes every string through the pseudo-locale', async () => {
    renderPage(ADMIN, 'en-XA');
    const main = screen.getByRole('main');
    await within(main).findAllByRole('listitem');
    const plain = visibleTexts(main).filter((t) => /^[A-Za-z ]+$/.test(t));
    expect(plain).toEqual([]);
  });
});
