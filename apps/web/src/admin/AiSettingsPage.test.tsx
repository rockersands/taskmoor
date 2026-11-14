import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { setViewportWidth } from '../test/viewport';
import { AiSettingsPage } from './AiSettingsPage';
import { aiView, fakeAiClient } from './aiFixtures';

/** A key typed at run time: never one that looks like a real provider key. */
const typedKey = () => `fake-ai-key-${Math.random().toString(36).slice(2)}${Date.now()}`;

function renderPage(client = fakeAiClient()) {
  render(
    <I18nProvider locale="en">
      <AiSettingsPage client={client} />
    </I18nProvider>,
  );
  return client;
}

describe('the AI settings page (M1-076)', () => {
  it('[AI-006] offers each feature on claude-opus-5-5 by default, and saves a change of model and effort', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    const summaries = await screen.findByRole('group', {
      name: 'Summaries of tickets and threads',
    });
    const model = within(summaries).getByRole('combobox', { name: 'Model' });
    expect(model).toHaveValue('claude-opus-5-5');
    expect(within(model).getByRole('option', { selected: true })).toHaveTextContent(
      'claude-opus-5-5 (default)',
    );
    expect(within(summaries).getByRole('combobox', { name: 'Effort' })).toHaveValue('low');
    await user.selectOptions(model, 'claude-haiku-5-5');
    await user.selectOptions(within(summaries).getByRole('combobox', { name: 'Effort' }), 'medium');
    const creation = screen.getByRole('group', { name: 'Drafting tickets from a description' });
    await user.click(within(creation).getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: 'Save AI settings' }));
    await waitFor(() => expect(client.sent.saved).toHaveLength(1));
    expect(client.sent.saved[0]?.features).toEqual({
      summarize: { enabled: true, model: 'claude-haiku-5-5', effort: 'medium' },
      'assisted-creation': { enabled: false },
    });
  });

  it('[IAM-020] takes a key write-only and shows only its last four characters', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    const field = await screen.findByLabelText('API key');
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveValue('');
    expect(field).toHaveAccessibleDescription(
      'Stored, ending in k9Qe. It came from the server’s environment file.',
    );
    const key = typedKey();
    await user.type(field, key);
    await user.click(screen.getByRole('button', { name: 'Save API key' }));
    await waitFor(() => expect(client.sent.keys).toEqual([['apiKey', key]]));
    expect(screen.getByLabelText('API key')).toHaveValue('');
    expect(screen.getByLabelText('API key')).toHaveAccessibleDescription(
      `Stored, ending in ${key.slice(-4)}.`,
    );
    expect(document.body.textContent).not.toContain(key);
    const trigger = screen.getByRole('button', { name: 'Remove API key' });
    expect(trigger).toHaveClass('button-danger-quiet');
    await user.click(trigger);
    // Asks first, saying what will happen (D13); nothing is sent yet.
    const question = screen.getByRole('group', {
      name: 'API key: remove the stored value? AI features that need it stop until another one is saved.',
    });
    expect(client.sent.removed).toEqual([]);
    await user.click(within(question).getByRole('button', { name: 'Remove API key' }));
    await waitFor(() => expect(client.sent.removed).toEqual(['apiKey']));
    expect(screen.getByLabelText('API key')).toHaveAccessibleDescription('Not set.');
    expect(screen.getByLabelText('API key')).toHaveFocus();
  });

  it('[AI-001] tests the connection with the typed key and lists the models the provider offers', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    const key = typedKey();
    await user.type(await screen.findByLabelText('API key'), key);
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    const models = await screen.findByRole('list', { name: 'Available models' });
    expect(
      within(models)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['claude-opus-5-5 Claude Opus 5.5', 'claude-haiku-5-5 Claude Haiku 5.5']);
    expect(client.sent.tests).toEqual([
      { provider: { provider: 'anthropic' }, credentials: { apiKey: key } },
    ]);
  });

  it('[AI-001] (1) shows the provider’s refusal', async () => {
    const user = userEvent.setup();
    renderPage(
      fakeAiClient(aiView(), {
        ok: false,
        error: { kind: 'authentication', message: 'anthropic: invalid x-api-key [redacted]' },
      }),
    );
    await user.click(await screen.findByRole('button', { name: 'Test connection' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The connection test failed: anthropic: invalid x-api-key [redacted]',
    );
  });

  it('[AI-001] asks each provider for its own settings and keys', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Provider' }), 'vertex');
    expect(screen.getByRole('textbox', { name: 'Region' })).toBeRequired();
    expect(screen.getByRole('textbox', { name: 'Project ID' })).toBeRequired();
    expect(screen.getByLabelText('Access token')).toHaveAttribute('type', 'password');
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Provider' }),
      'openai-compatible',
    );
    expect(screen.getByRole('textbox', { name: 'Model' })).toBeRequired();
    // A local model's server picks the model itself: no Claude model choice per feature.
    const summaries = screen.getByRole('group', { name: 'Summaries of tickets and threads' });
    expect(within(summaries).queryByRole('combobox', { name: 'Model' })).toBeNull();
  });

  it('[AI-002] offers OpenAI and Gemini by name and saves them as OpenAI-compatible servers at their addresses', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    const provider = await screen.findByRole('combobox', { name: 'Provider' });
    await user.selectOptions(provider, 'openai');
    // The address comes with the choice; the model is typed, with an example.
    expect(screen.queryByRole('textbox', { name: 'Server address' })).toBeNull();
    const model = screen.getByRole('textbox', { name: 'Model' });
    expect(model).toHaveAccessibleDescription(/gpt-5/);
    await user.type(model, 'gpt-5');
    await user.click(screen.getByRole('button', { name: 'Save AI settings' }));
    await waitFor(() => expect(client.sent.saved.at(-1)?.provider).toBeDefined());
    expect(client.sent.saved.at(-1)?.provider).toEqual({
      provider: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5',
    });
    await user.selectOptions(provider, 'gemini');
    expect(screen.getByRole('textbox', { name: 'Model' })).toHaveAccessibleDescription(
      /gemini-2\.5-pro/,
    );
    await user.selectOptions(provider, 'openai-compatible');
    expect(screen.getByRole('textbox', { name: 'Server address' })).toBeRequired();
  });

  it('[AI-002] shows a saved provider at Gemini’s address as Gemini', async () => {
    renderPage(
      fakeAiClient(
        aiView({
          provider: {
            provider: 'openai-compatible',
            baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
            model: 'gemini-2.5-pro',
          },
        }),
      ),
    );
    expect(await screen.findByRole('combobox', { name: 'Provider' })).toHaveValue('gemini');
  });

  it('[AI-001] hides the per-feature and per-track controls while AI is off for the workspace', async () => {
    const user = userEvent.setup();
    renderPage(fakeAiClient(aiView({ enabled: false })));
    await screen.findByRole('checkbox', { name: 'Use AI on this site' });
    expect(screen.queryByRole('group', { name: 'Summaries of tickets and threads' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Tracks' })).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: 'Use AI on this site' }));
    expect(screen.getByRole('group', { name: 'Summaries of tickets and threads' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Save AI settings' }));
    expect(await screen.findByRole('heading', { name: 'Tracks' })).toBeVisible();
  });

  it('[AI-001] a track switch leaves an unsaved change alone', async () => {
    const user = userEvent.setup();
    renderPage();
    const track = await screen.findByRole('checkbox', { name: /WEB Website/ });
    const strict = screen.getByRole('checkbox', { name: 'Strict mode' });
    await user.click(track);
    await user.click(strict);
    expect(await screen.findByText('The track’s AI switch was saved.')).toBeVisible();
    expect(strict).toBeChecked();
  });

  it('[IAM-019] in strict mode, AI runs only in the tracks turned on', async () => {
    const user = userEvent.setup();
    renderPage(fakeAiClient(aiView({ strict: true })));
    const web = await screen.findByRole('checkbox', { name: 'WEB Website' });
    expect(
      screen.getByText('Strict mode is on: AI runs only in the tracks turned on here.'),
    ).toBeVisible();
    expect(web).not.toBeChecked();
    await user.click(web);
    await waitFor(() =>
      expect(screen.getByRole('checkbox', { name: 'WEB Website' })).toBeChecked(),
    );
    expect(screen.getByRole('checkbox', { name: 'OPS Operations' })).not.toBeChecked();
  });

  it('[NFR-005] fits a phone', async () => {
    setViewportWidth(375);
    renderPage();
    await screen.findByRole('combobox', { name: 'Provider' });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
  });
});
