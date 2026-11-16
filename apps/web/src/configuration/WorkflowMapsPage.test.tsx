import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ADMIN, CONFIG_ADMIN, MEMBER, TRACK_ADMIN } from '../admin/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { type FakeConfigurationClient, fakeConfigurationClient } from './fixtures';
import { WorkflowMapsPage } from './WorkflowMapsPage';

function renderPage(
  options: {
    session?: Session;
    trackId?: number | null;
    client?: FakeConfigurationClient;
    locale?: Locale;
  } = {},
) {
  const client = options.client ?? fakeConfigurationClient();
  render(
    <I18nProvider locale={options.locale ?? 'en'}>
      <SessionProvider session={options.session ?? TRACK_ADMIN}>
        <main>
          <WorkflowMapsPage client={client} trackId={options.trackId ?? null} />
        </main>
      </SessionProvider>
    </I18nProvider>,
  );
  return client;
}

describe('a local-mode track’s own workflow map (T-322, T-163a’s pattern)', () => {
  it('[WF-001] [IAM-030] opens the map OPS owns at once, for the types it offers', async () => {
    renderPage({ trackId: 4 });
    expect(screen.getByRole('heading', { level: 1, name: 'Workflow map' })).toBeVisible();
    const map = await screen.findByRole('form', { name: 'Workflows in OPS workflows' });
    expect(screen.getByText('OPS · Operations')).toBeVisible();
    expect(screen.getByText(/^The workflow map this track owns/)).toBeVisible();
    expect(screen.getByRole('link', { name: 'Back to managing OPS.' })).toHaveAttribute(
      'href',
      '#/manage/tracks/4',
    );
    // Its runbooks follow its own workflow, which says it is the track's own.
    const runbook = within(map).getByRole('combobox', { name: 'Runbook follows' });
    expect(within(runbook).getByRole('option', { selected: true })).toHaveTextContent(
      'Runbook flow (OPS’s own)',
    );
    // Only the types OPS offers can be given a workflow: not Bug or Story.
    const give = within(map).getByRole('combobox', { name: 'Give a type its own workflow' });
    expect(
      within(give)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Choose a ticket type', 'Task']);
    // It is made with the track and goes with it: no other map, no Delete, no New.
    expect(screen.queryByText('Default workflow map')).toBeNull();
    expect(within(map).queryByRole('button', { name: /^Delete map/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New workflow map' })).toBeNull();
    expect(within(map).queryByText(/^Used by/)).toBeNull();
  });

  it('[WF-001] [IAM-030] gives a type the track offers a workflow and saves the map', async () => {
    const user = userEvent.setup();
    const client = renderPage({ trackId: 4 });
    const map = await screen.findByRole('form', { name: 'Workflows in OPS workflows' });
    await user.selectOptions(
      within(map).getByRole('combobox', { name: 'Give a type its own workflow' }),
      'Task',
    );
    await user.click(within(map).getByRole('button', { name: 'Add' }));
    await user.selectOptions(
      within(map).getByRole('combobox', { name: 'Task follows' }),
      'Runbook flow (OPS’s own)',
    );
    await user.click(within(map).getByRole('button', { name: 'Save the map' }));
    expect(await screen.findByText('OPS workflows was saved.')).toBeInTheDocument();
    // The map serves OPS, so the change is previewed first; no ticket needs a new status.
    expect(client.calls.map((c) => c.action)).toEqual(['workflowMapImpact', 'updateWorkflowMap']);
    expect(client.calls.at(-1)?.args).toEqual([
      21,
      {
        defaultWorkflowId: 1,
        entries: [
          { ticketTypeId: 8, workflowId: 3 },
          { ticketTypeId: 6, workflowId: 3 },
        ],
      },
    ]);
  });

  it('[WF-001] [WF-002] asks where OPS’s tickets go before saving a change that leaves them behind', async () => {
    const user = userEvent.setup();
    const client = renderPage({
      trackId: 4,
      client: fakeConfigurationClient({ refuseMapping: true }),
    });
    const map = await screen.findByRole('form', { name: 'Workflows in OPS workflows' });
    await user.click(within(map).getByRole('button', { name: 'Remove Runbook from the map' }));
    await user.click(within(map).getByRole('button', { name: 'Save the map' }));
    const step = await screen.findByRole('heading', { name: 'Save OPS workflows' });
    expect(step).toHaveFocus();
    expect(client.calls.map((c) => c.action)).toEqual(['workflowMapImpact']);
  });

  it('[IAM-030] someone who runs tracks chooses one with its own configuration', async () => {
    renderPage();
    expect(
      await screen.findByRole('link', { name: 'Workflow map of OPS · Operations' }),
    ).toHaveAttribute('href', '#/manage/tracks/4/workflow-map');
    expect(screen.queryByRole('link', { name: /of SHOP/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New workflow map' })).toBeNull();
  });

  it('[IAM-030] a shared-mode track has no map of its own', async () => {
    renderPage({ session: ADMIN, trackId: 3 });
    expect(
      await screen.findByText(
        'SHOP uses shared configuration, so it follows a shared workflow map, which site and configuration administrators choose and change.',
      ),
    ).toBeVisible();
    expect(screen.queryByRole('form')).toBeNull();
  });

  it('[IAM-009] refuses anyone who neither administers nor runs a track', async () => {
    renderPage({ session: MEMBER });
    expect(
      await screen.findByText(
        'Only site and configuration administrators, and the people who run a track with its own configuration, manage workflow maps.',
      ),
    ).toBeVisible();
  });

  it('[WF-001] keeps the shared maps for administrators, without any track’s own', async () => {
    renderPage({ session: CONFIG_ADMIN });
    expect(await screen.findByText('Default workflow map')).toBeVisible();
    expect(screen.queryByText('OPS workflows')).toBeNull();
    expect(screen.getByRole('button', { name: 'New workflow map' })).toBeVisible();
  });

  it('fits a small phone', async () => {
    setViewportWidth(375);
    renderPage({ trackId: 4 });
    expect(await screen.findByRole('form', { name: 'Workflows in OPS workflows' })).toBeVisible();
  });

  it('passes every string of the track’s own page through the pseudo-locale', async () => {
    renderPage({ trackId: 4, locale: 'en-XA' });
    const main = screen.getByRole('main');
    await within(main).findByRole('form');
    const data = new Set([
      'OPS workflows',
      'Default workflow',
      'Bug workflow',
      'Runbook flow',
      'Task',
      'Runbook',
    ]);
    expect(untranslated(visibleTexts(main)).filter((t) => !data.has(t))).toEqual([]);
  });
});
