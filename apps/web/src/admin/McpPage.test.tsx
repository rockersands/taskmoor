import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { setViewportWidth } from '../test/viewport';
import { type McpClient, McpPage, type McpSettings } from './McpPage';

function fakeMcp(start: McpSettings = { enabled: true, allowedClients: [], profile: 'planner' }) {
  let saved = structuredClone(start);
  const client: McpClient & { saved: () => McpSettings } = {
    saved: () => saved,
    load: async () => structuredClone(saved),
    save: async (s) => {
      saved = structuredClone(s);
      return structuredClone(saved);
    },
  };
  return client;
}

function renderPage(client = fakeMcp()) {
  render(
    <I18nProvider locale="en">
      <McpPage client={client} origin="https://tracker.example.com" />
    </I18nProvider>,
  );
  return client;
}

describe('the MCP settings page (M1-072)', () => {
  it('[API-012] chooses the tool profile and the allowed clients', async () => {
    const user = userEvent.setup();
    const client = renderPage();
    await user.click(await screen.findByRole('radio', { name: /Read-only/ }));
    await user.type(
      screen.getByRole('textbox', { name: 'Allowed clients' }),
      'claude-code{Enter}cursor',
    );
    await user.click(screen.getByRole('button', { name: 'Save MCP settings' }));
    await waitFor(() =>
      expect(client.saved()).toEqual({
        enabled: true,
        allowedClients: ['claude-code', 'cursor'],
        profile: 'read-only',
      }),
    );
    expect(screen.getByRole('status')).toHaveTextContent('The MCP settings were saved.');
    await user.click(screen.getByRole('checkbox', { name: 'Let agents connect' }));
    await user.click(screen.getByRole('button', { name: 'Save MCP settings' }));
    await waitFor(() => expect(client.saved().enabled).toBe(false));
  });

  it('[API-012] shows how to connect, over HTTP and stdio', async () => {
    renderPage();
    expect(await screen.findByText(/https:\/\/tracker\.example\.com\/api\/v1\/mcp/)).toBeVisible();
    expect(screen.getByText(/node cli\.mjs mcp/)).toBeVisible();
  });

  it('[API-012] fits a phone', async () => {
    setViewportWidth(375);
    renderPage();
    await screen.findByRole('radio', { name: /Planner/ });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
  });
});
