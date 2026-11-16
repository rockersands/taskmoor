import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { TrackSetsPage } from '../configuration/TrackSetsPage';
import { FieldsAdminPage } from '../fields/FieldsAdminPage';
import { fakeFieldsClient } from '../fields/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import { fakeLayoutsClient } from '../layouts/fixtures';
import { LayoutEditorPage } from '../layouts/LayoutEditorPage';
import { NotificationPoliciesPage } from '../notifications/NotificationPoliciesPage';
import { fakePoliciesClient } from '../notifications/policiesFixtures';
import { PermissionExplainerPage } from '../permissions/PermissionExplainerPage';
import { VisibilityPage } from '../permissions/VisibilityPage';
import { fakePrioritiesClient } from '../priorities/fixtures';
import { PrioritiesPage } from '../priorities/PrioritiesPage';
import { SessionProvider } from '../session/SessionProvider';
import { fakeTicketTypesClient } from '../tickettypes/fixtures';
import { TicketTypesPage } from '../tickettypes/TicketTypesPage';
import { WebhooksPage } from '../webhooks/WebhooksPage';
import { AdminOverviewPage } from './AdminOverviewPage';
import { AiLimitsPage } from './AiLimitsPage';
import { EmailSettingsPage } from './EmailSettingsPage';
import { ADMIN, CONFIG_ADMIN, MEMBER, TRACK_ADMIN } from './fixtures';
import { type McpClient, McpPage } from './McpPage';

/** MCP settings a site administrator would read; `refused` answers as the server does to others. */
const mcp = (refused = false): McpClient => ({
  load: async () => {
    if (refused) throw new ApiError(403, { error: 'forbidden' });
    return { enabled: true, allowedClients: [], profile: 'planner', oauthRegistration: true };
  },
  save: async (settings) => settings,
});

/**
 * Someone who may not use a page is told so, without the rest (docs/manual/admin/administration.md):
 * the page's name and the refusal, with no line on what it is for and no "What is this for?".
 */
function open(page: ReactElement, session = MEMBER) {
  const { container } = render(
    <I18nProvider locale="en">
      <SessionProvider session={session}>
        <main>{page}</main>
      </SessionProvider>
    </I18nProvider>,
  );
  return container;
}

const refusedOnly = async (container: Element, title: string, refusal: RegExp) => {
  expect(await screen.findByText(refusal)).toBeVisible();
  expect(screen.getByRole('heading', { level: 1, name: title })).toBeVisible();
  expect(container.querySelector('.page-purpose')).toBeNull();
  expect(container.querySelector('.help-tip-button')).toBeNull();
};

describe('a page someone may not use says only so (T-144)', () => {
  it.each([
    ['Webhooks', <WebhooksPage key="w" />, /^Only site administrators/],
    ['AI limits and prices', <AiLimitsPage key="a" />, /^Only site administrators manage AI/],
    ['MCP server', <McpPage key="m" client={mcp()} />, /^Only site administrators change the MCP/],
    ['Visibility policies', <VisibilityPage key="v" />, /^Only site administrators use this page/],
    [
      'Permission explainer',
      <PermissionExplainerPage key="e" />,
      /^Only site administrators use the permission explainer/,
    ],
    [
      'Ticket types',
      <TicketTypesPage key="t" client={fakeTicketTypesClient()} />,
      /^Only site and configuration administrators manage ticket types/,
    ],
  ])('[NFR-005] %s', async (title, page, refusal) => {
    await refusedOnly(open(page), title, refusal);
  });

  it('[NFR-005] Administration', async () => {
    await refusedOnly(
      open(<AdminOverviewPage />),
      'Administration',
      /^Only site and configuration/,
    );
  });

  it('[NFR-005] the sets a track uses', async () => {
    const container = open(<TrackSetsPage />);
    expect(container.querySelector('.page-purpose')).toBeNull();
    expect(container.querySelector('.help-tip-button')).toBeNull();
  });

  it.each([
    ['a member', MEMBER],
    ['someone who only runs tracks', TRACK_ADMIN],
  ])('[NFR-005] Priorities, for %s', async (_, session) => {
    await refusedOnly(
      open(<PrioritiesPage />, session),
      'Priorities',
      /^Only site and configuration administrators change priorities/,
    );
  });

  it.each([
    ['a member', MEMBER],
    ['someone who only runs tracks', TRACK_ADMIN],
  ])('[NFR-005] Fields, for %s (T-320)', async (_, session) => {
    // The list is readable to them, so the session decides: the page would otherwise offer
    // changes to shared fields that the server refuses.
    const container = open(<FieldsAdminPage client={fakeFieldsClient()} />, session);
    await refusedOnly(
      container,
      'Fields',
      /^Only site and configuration administrators manage fields/,
    );
    expect(screen.queryByRole('button', { name: 'New field' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Manage field/ })).toBeNull();
  });

  it('[NFR-005] a configuration administrator still manages fields (T-320)', async () => {
    open(<FieldsAdminPage client={fakeFieldsClient()} />, CONFIG_ADMIN);
    expect(await screen.findByRole('button', { name: 'Manage field Severity' })).toBeVisible();
  });

  it('[NFR-005] a configuration administrator still sees what Priorities is for', async () => {
    const container = open(<PrioritiesPage client={fakePrioritiesClient()} />, CONFIG_ADMIN);
    expect(await screen.findByText('Urgent')).toBeVisible();
    expect(container.querySelector('.page-purpose')).not.toBeNull();
  });

  it('[NFR-005] notification policies, for someone who runs no track (T-155)', async () => {
    await refusedOnly(
      open(<NotificationPoliciesPage client={fakePoliciesClient()} />),
      'Notification policies',
      /^Only site and configuration administrators, and the people who run a track/,
    );
  });

  it('[NFR-005] email, for anyone but a site administrator (T-155)', async () => {
    for (const session of [MEMBER, CONFIG_ADMIN]) {
      const container = open(<EmailSettingsPage />, session);
      await refusedOnly(container, 'Email', /^Only site administrators change the email/);
      cleanup();
    }
  });

  it('[NFR-005] layouts, for someone who runs no track', async () => {
    const container = open(<LayoutEditorPage client={fakeLayoutsClient()} previewDelay={0} />);
    await screen.findByText(/^Only/);
    expect(container.querySelector('.page-purpose')).toBeNull();
  });

  it('[NFR-005] layouts, when the server refuses the list', async () => {
    const client = fakeLayoutsClient();
    client.layoutSets = async () => {
      throw new ApiError(403, { error: 'forbidden' });
    };
    const container = open(<LayoutEditorPage client={client} previewDelay={0} />, CONFIG_ADMIN);
    await screen.findByText(/^Only/);
    // The refusal reaches the page's header one render after the words, so a loaded machine can
    // catch the moment between them.
    await waitFor(() => expect(container.querySelector('.page-purpose')).toBeNull());
  });

  it('[NFR-005] the MCP server, when the server refuses its settings', async () => {
    // A session read before the right was taken away: the server's answer decides.
    await refusedOnly(
      open(<McpPage client={mcp(true)} />, ADMIN),
      'MCP server',
      /^Only site administrators change the MCP/,
    );
  });

  it('[NFR-005] an administrator still sees what the MCP server is for', async () => {
    const container = open(<McpPage client={mcp()} />, ADMIN);
    expect(await screen.findByRole('radio', { name: /Planner/ })).toBeChecked();
    expect(container.querySelector('.page-purpose')).not.toBeNull();
  });

  it('[NFR-005] an administrator still sees what each is for', async () => {
    const container = open(<AiLimitsPage />, ADMIN);
    expect(container.querySelector('.page-purpose')).not.toBeNull();
  });
});
