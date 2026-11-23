import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { KALO, SIGNED_IN } from '../account/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import { fakeListClient, fakeListSearch } from '../list/fixtures';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { applyStylesheet } from '../test/stylesheets';
import type { PlanSection } from './address';
import { fakePlanClient } from './fixtures';
import { planSprintName } from './PlanCalendarPage';
import { PlanPage } from './PlanPage';
import { ProgramBoardsPage } from './ProgramBoardsPage';
import { fakeBoardClient } from './programBoardFixtures';
import { fakeScenarioClient } from './scenarioFixtures';

/** The plan pages' faults of the third page sweep (T-316): S3-PL-1 to S3-PL-11. */

function renderPlan(section: PlanSection, hash: string, client = fakePlanClient()) {
  window.location.hash = hash;
  const search = fakeListSearch();
  render(
    <I18nProvider locale="en">
      <PlanPage
        id={12}
        section={section}
        client={client}
        scenarios={fakeScenarioClient(client)}
        search={search}
        list={fakeListClient(search)}
        now={() => new Date('2026-11-04T09:00:00Z')}
      />
    </I18nProvider>,
  );
  return client;
}

afterEach(() => {
  window.location.hash = '';
});

describe('the plan pages after the third sweep (T-316)', () => {
  it('[PLN-001] explains the plan behind a help mark beside its title, on every tab (S3-PL-5)', async () => {
    const user = userEvent.setup();
    renderPlan('timeline', '#/plans/12/timeline');
    await screen.findByRole('heading', { level: 1, name: 'Spring launch' });
    await user.click(screen.getByRole('button', { name: 'What is Spring launch for?' }));
    expect(
      await screen.findByText(/^Each tab shows this plan’s tickets its own way/),
    ).toBeVisible();
  });

  it('[PLN-012] names a sprint on the plan’s calendar by what tells it apart, its track after (S3-PL-4)', async () => {
    const client = fakePlanClient();
    const read = client.calendar;
    client.calendar = async (...args) => ({
      ...(await read(...args)),
      sprints: [
        { id: 1, name: 'Shop Sprint 1', state: 'closed', start: '2026-11-02', end: '2026-11-13' },
        { id: 2, name: 'Shop Sprint 2', state: 'active', start: '2026-11-04', end: '2026-11-17' },
      ],
    });
    renderPlan('calendar', '#/plans/12/calendar', client);
    const chips = await screen.findAllByText(/^Sprint [12] · Shop$/);
    expect(new Set(chips.map((c) => c.textContent))).toEqual(
      new Set(['Sprint 1 · Shop', 'Sprint 2 · Shop']),
    );
    // The whole name is still the chip's tip.
    expect(chips[0]).toHaveAttribute('title', chips[0]?.textContent ?? '');
  });

  it('[PLN-012] takes the longest track name off a sprint’s, and leaves a name no track starts', () => {
    const label = (sprint: string, track: string) => `${sprint} · ${track}`;
    const tracks = [
      { id: 1, key: 'MOB', name: 'Mobile' },
      { id: 2, key: 'MOBA', name: 'Mobile apps' },
      { id: 3, key: 'HID', name: null },
    ];
    expect(planSprintName('Mobile apps Sprint 2', tracks, label)).toBe('Sprint 2 · Mobile apps');
    expect(planSprintName('Mobile: Sprint 7', tracks, label)).toBe('Sprint 7 · Mobile');
    expect(planSprintName('Mobilepad 3', tracks, label)).toBe('Mobilepad 3');
    expect(planSprintName('Winter push', tracks, label)).toBe('Winter push');
  });

  it('[PLN-008] shows someone who may add fields where to add a Team field, not whom to ask (S3-PL-8)', async () => {
    const admin: Session = { status: 'signed-in', user: { ...KALO, isSiteAdmin: true } };
    const page = (session: Session) => (
      <SessionProvider session={session}>
        <I18nProvider locale="en">
          <ProgramBoardsPage
            planId={12}
            client={fakeBoardClient({ list: { teamFields: [], editable: true } })}
            now={() => new Date('2026-11-04T09:00:00Z')}
          />
        </I18nProvider>
      </SessionProvider>
    );
    const { unmount } = render(page(admin));
    const note = (await screen.findByText(/Add a field of the Team type/)).closest('p');
    expect(note).not.toBeNull();
    expect(within(note as HTMLElement).getByRole('link', { name: 'Open Fields' })).toHaveAttribute(
      'href',
      '#/admin/fields',
    );
    expect(screen.queryByText(/Ask a site administrator/)).toBeNull();
    // Anyone else is still sent to a site administrator, with no link they could not use.
    unmount();
    render(page(SIGNED_IN));
    expect(await screen.findByText(/Ask a site administrator to add one/)).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Open Fields' })).toBeNull();
  });

  it('[PLN-002] keeps the scenario bar to one line on a phone, its Live sentence still the select’s description (S3-PL-2)', async () => {
    renderPlan('summary', '#/plans/12');
    const select = await screen.findByRole('combobox', { name: 'Scenario' });
    expect(select).toHaveAccessibleDescription('Changes you make here change tickets now.');
    const sentence = document.getElementById(select.getAttribute('aria-describedby') ?? '');
    const field = select.closest('.form-field') as HTMLElement;
    const phone = applyStylesheet('plans.css', 'max-width: 767px');
    try {
      expect(getComputedStyle(field).gridTemplateColumns).toBe('auto minmax(0, 1fr)');
      expect(sentence && getComputedStyle(sentence).position).toBe('absolute');
      expect(sentence && getComputedStyle(sentence).clipPath).toBe('inset(50%)');
    } finally {
      phone();
    }
  });

  it('[PLN-012] parts a phone’s ticket rows by the border colour, not the light glass edge (S3-PL-3)', () => {
    const gone = applyStylesheet('plans.css');
    const list = document.createElement('div');
    list.className = 'plan-list';
    list.innerHTML = '<ul class="result-rows"><li class="result-row"></li></ul>';
    document.body.append(list);
    try {
      const row = list.querySelector('.result-row') as HTMLElement;
      expect(getComputedStyle(row).borderTopColor).toBe('var(--color-border)');
    } finally {
      list.remove();
      gone();
    }
  });

  it('[PLN-005] stands the settings’ capacity fields level from their labels (S3-PL-10)', () => {
    const gone = applyStylesheet('plans.css');
    const row = document.createElement('div');
    row.className = 'plan-capacity-settings-row';
    document.body.append(row);
    try {
      expect(getComputedStyle(row).alignItems).toBe('start');
    } finally {
      row.remove();
      gone();
    }
  });
});
