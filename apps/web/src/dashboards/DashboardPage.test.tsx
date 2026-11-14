import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { ApiError } from '../api/client';
import { I18nProvider } from '../i18n/I18nProvider';
import type { Locale } from '../i18n/locale';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { untranslated, visibleTexts } from '../test/backend';
import { setViewportWidth } from '../test/viewport';
import { DashboardPage, nextInRotation } from './DashboardPage';
import { DashboardsPage } from './DashboardsPage';
import { fakeDashboardClient, TEAM_DASHBOARD } from './fixtures';
import { WidgetSettings } from './WidgetSettings';

function open(
  options: {
    client?: ReturnType<typeof fakeDashboardClient>;
    session?: Session;
    locale?: Locale;
    wallboard?: { rotation: number[]; seconds: number } | null;
  } = {},
) {
  const client = options.client ?? fakeDashboardClient();
  const errors: Error[] = [];
  const view = render(
    <I18nProvider locale={options.locale ?? 'en'} onError={(e) => errors.push(e)}>
      <SessionProvider session={options.session ?? MEMBER}>
        <DashboardPage id={5} client={client} wallboard={options.wallboard ?? null} />
      </SessionProvider>
    </I18nProvider>,
  );
  return { client, errors, container: view.container };
}
const widget = (name: string) => screen.getByRole('article', { name });

describe('a widget that cannot load says what it needs (M1-064)', () => {
  it('[RPT-005] says the query is at fault, not that the widget failed', async () => {
    const client = fakeDashboardClient();
    client.widget = async () => {
      throw new ApiError(400, { error: 'invalid_query', message: 'Expected an operator' });
    };
    open({ client });
    const alerts = await screen.findAllByRole('alert');
    expect(alerts[0]).toHaveTextContent('Taskmoor cannot read the query in this widget');
  });

  it('[RPT-005] refuses to keep a query that cannot be read, and says what one looks like', async () => {
    const user = userEvent.setup();
    const saved: unknown[] = [];
    render(
      <I18nProvider locale="en">
        <WidgetSettings
          widget={{ id: 'w', kind: 'search-results', column: 0, title: '', config: { query: '' } }}
          boards={[]}
          onSave={(title, config) => saved.push({ title, config })}
          onCancel={() => {}}
          checkQuery={async (query) => !query.includes('nope')}
        />
      </I18nProvider>,
    );
    const query = screen.getByRole('textbox', { name: 'Query' });
    await user.type(query, 'nope nope');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A query looks like');
    expect(query).toHaveAttribute('aria-invalid', 'true');
    expect(saved).toEqual([]);
    await user.clear(query);
    await user.type(query, 'track = API');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(saved).toHaveLength(1));
  });

  it('[RPT-005] holds back a sprint widget while there is no Scrum board', () => {
    render(
      <I18nProvider locale="en">
        <WidgetSettings
          widget={{ id: 'w', kind: 'sprint-health', column: 0, title: '', config: {} }}
          boards={[{ id: 8, name: 'Flow', kind: 'kanban' }]}
          onSave={() => {}}
          onCancel={() => {}}
        />
      </I18nProvider>,
    );
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
  });
});

describe('a dashboard (M1-064)', () => {
  it('[RPT-005] draws every kind of widget from its data', async () => {
    open();
    await screen.findByRole('heading', { level: 1, name: 'Checkout team' });
    expect(await within(widget('Introduction')).findByText('Ask in #checkout.')).toBeVisible();
    expect(within(widget('Quick links')).getByRole('link', { name: 'Runbook' })).toHaveAttribute(
      'rel',
      'noopener noreferrer',
    );
    expect(await within(widget('Newest in SHOP')).findByText('3 tickets of 41')).toBeVisible();
    expect(within(widget('Assigned to me')).getByRole('link', { name: 'SHOP-12' })).toHaveAttribute(
      'href',
      '#/tickets/SHOP-12',
    );
    expect(
      within(await screen.findByRole('figure', { name: 'Created vs closed' }))
        .getByRole('img')
        .getAttribute('aria-label'),
    ).toBe('Created vs closed: 21 created and 13 closed in the period.');
    // The pie: values and shares beside each swatch, most tickets first. Untitled, it names what
    // it counts rather than its shape (PL-35).
    const pie = await screen.findByRole('figure', { name: 'Tickets by Priority' });
    expect(
      within(pie)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Medium17 · 41%', 'High11 · 27%', 'Low8 · 20%', 'None3 · 7%', 'Urgent2 · 5%']);
    const stats = within(widget('Ticket statistics')).getByRole('table');
    expect(
      within(stats)
        .getAllByRole('rowheader')
        .map((r) => r.textContent),
    ).toEqual(['checkout', 'payments', 'ux', 'None', 'Total']);
    const grid = within(widget('Two-dimensional statistics')).getByRole('table');
    expect(within(grid).getAllByRole('row')[1]?.textContent).toBe('High45211');
    expect(
      await screen.findByRole('figure', { name: 'Burndown of Checkout Sprint 10' }),
    ).toBeVisible();
    expect(within(widget('Sprint health')).getByText('55%')).toBeVisible();
    expect(within(widget('Sprint health')).getByText('+8%')).toBeVisible();
    expect(
      within(widget('Days remaining in the sprint')).getByText('days left in Checkout Sprint 10'),
    ).toBeVisible();
    expect(await screen.findByRole('figure', { name: 'Average age' })).toBeVisible();
    expect(screen.getByRole('figure', { name: 'Time to close' })).toBeVisible();
    expect(screen.getByRole('figure', { name: 'Average time in status' })).toBeVisible();
    expect(screen.getByRole('figure', { name: 'Recently created' })).toBeVisible();
    expect(screen.getByRole('figure', { name: 'Tickets by date' })).toBeVisible();
    const grouped = within(widget('Grouped tickets'));
    expect(grouped.getByText('1 of 3 done')).toBeVisible();
    expect(grouped.getByText('2 tickets of 3')).toBeVisible();
    const work = within(widget('Workload')).getByRole('table');
    expect(within(work).getAllByRole('row')[1]?.textContent).toBe('Ada Lovelace414h1');
    const time = within(widget('Time tracking'));
    // 40h estimated, 31h spent and 12h left: 3h over the estimate.
    expect(time.getByText('3h over the estimate')).toBeVisible();
    expect(time.getByRole('link', { name: 'SHOP-12' })).toHaveAttribute(
      'href',
      '#/tickets/SHOP-12',
    );
  });

  it('[RPT-005] says why a widget shows nothing', async () => {
    const client = fakeDashboardClient(undefined, {
      ...(await import('./fixtures')).WIDGET_DATA,
      burndown: { unavailable: 'no_active_sprint' },
      health: { unavailable: 'board_not_found' },
    });
    client.widget = async (_d, id) => {
      if (id === 'stats') throw new Error('network');
      return id === 'burndown'
        ? { unavailable: 'no_active_sprint' }
        : id === 'health'
          ? { unavailable: 'board_not_found' }
          : null;
    };
    open({ client });
    expect(
      await within(await screen.findByRole('article', { name: 'Sprint burndown' })).findByText(
        'The board has no active sprint.',
      ),
    ).toBeVisible();
    expect(
      await within(widget('Sprint health')).findByText('The board is not one you can see.'),
    ).toBeVisible();
    expect(await within(widget('Ticket statistics')).findByRole('alert')).toHaveTextContent(
      'This widget could not be loaded.',
    );
  });

  it('[RPT-004] its owner adds, sets up, moves and removes widgets, saved with the version', async () => {
    const user = userEvent.setup();
    const { client } = open();
    await user.click(await screen.findByRole('button', { name: 'Edit dashboard' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Layout' }), 'Two columns');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Widget to add' }), 'Pie chart');
    await user.click(screen.getByRole('button', { name: 'Add widget' }));
    const settings = await screen.findByRole('form', { name: 'Settings of Pie chart' });
    await user.type(within(settings).getByLabelText('Title (optional)'), 'By type');
    await user.clear(within(settings).getByLabelText('Field'));
    await user.type(within(settings).getByLabelText('Field'), 'type');
    await user.click(within(settings).getByRole('button', { name: 'Apply' }));
    expect(screen.getByRole('article', { name: 'By type' })).toHaveTextContent(
      'Save the dashboard to see this widget.',
    );
    await user.click(
      screen.getByRole('button', { name: 'Move Days remaining in the sprint left' }),
    );
    await user.click(screen.getByRole('button', { name: 'Remove Quick links' }));
    await user.click(screen.getByRole('button', { name: 'Save dashboard' }));
    await waitFor(() => expect(client.patches).toHaveLength(1));
    const patch = client.patches[0]?.patch;
    expect(patch?.version).toBe(3);
    expect(patch?.layout).toBe('two');
    expect(patch?.widgets?.[0]).toEqual({
      kind: 'pie',
      column: 0,
      title: 'By type',
      config: { query: '', field: 'type' },
    });
    expect(patch?.widgets?.find((w) => w.id === 'links')).toBeUndefined();
    // The third column of three became the second of two, then moved left.
    expect(patch?.widgets?.find((w) => w.id === 'days')?.column).toBe(0);
    expect(await screen.findByRole('status')).toHaveTextContent('Saved.');
  });

  it('[RPT-004] its owner deletes it only after saying what goes (D13)', async () => {
    const user = userEvent.setup();
    const client = fakeDashboardClient();
    let refuse = true;
    const remove = client.remove;
    client.remove = async (id) => {
      if (refuse) throw new ApiError(500, {});
      return remove(id);
    };
    open({ client });
    await user.click(await screen.findByRole('button', { name: 'Edit dashboard' }));
    const trigger = screen.getByRole('button', { name: 'Delete dashboard' });
    expect(trigger).toHaveClass('button-danger-quiet');
    await user.click(trigger);
    const question = screen.getByRole('group', {
      name: 'Delete the dashboard Checkout team? Whoever it is shared with loses it too, and this cannot be undone.',
    });
    expect(within(question).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(within(question).getByRole('button', { name: 'Delete Checkout team' }));
    // Refused: the reason shows and the question stays, to try again.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The dashboard could not be deleted.',
    );
    refuse = false;
    await user.click(within(question).getByRole('button', { name: 'Delete Checkout team' }));
    await waitFor(() => expect(window.location.hash).toBe('#/dashboards'));
    expect(client.dashboards.some((d) => d.id === 5)).toBe(false);
  });

  it('[RPT-004] offers no Delete on everyone’s home dashboard, and says what to do instead', async () => {
    const user = userEvent.setup();
    open({ client: fakeDashboardClient([{ ...TEAM_DASHBOARD, isDefault: true }]) });
    await user.click(await screen.findByRole('button', { name: 'Edit dashboard' }));
    expect(screen.queryByRole('button', { name: 'Delete dashboard' })).toBeNull();
    expect(
      screen.getByText(
        'Everyone’s home dashboard cannot be deleted. Make another dashboard everyone’s home first.',
      ),
    ).toBeVisible();
  });

  it('[RPT-004] says why the server keeps a dashboard that became everyone’s home meanwhile', async () => {
    const user = userEvent.setup();
    const client = fakeDashboardClient();
    open({ client });
    await user.click(await screen.findByRole('button', { name: 'Edit dashboard' }));
    await user.click(screen.getByRole('button', { name: 'Delete dashboard' }));
    // An administrator made it everyone's home after the page loaded.
    for (const d of client.dashboards) d.isDefault = d.id === 5;
    await user.click(screen.getByRole('button', { name: 'Delete Checkout team' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'Everyone’s home dashboard cannot be deleted. Make another dashboard everyone’s home first.',
    );
    expect(alert).not.toHaveTextContent('Try again');
    expect(window.location.hash).not.toBe('#/dashboards');
  });

  it('[RPT-004] says when someone else saved first', async () => {
    const user = userEvent.setup();
    const client = fakeDashboardClient();
    open({ client });
    await user.click(await screen.findByRole('button', { name: 'Edit dashboard' }));
    const stored = client.dashboards[0];
    if (stored) stored.version = 9;
    await user.click(screen.getByRole('button', { name: 'Save dashboard' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Someone changed this dashboard meanwhile.',
    );
  });

  it('[RPT-004] its owner chooses who sees it; anyone who sees it copies it', async () => {
    const user = userEvent.setup();
    const { client } = open();
    const who = await screen.findByRole('combobox', { name: 'Who sees it' });
    expect(who).toHaveDisplayValue('Everyone signed in');
    await user.selectOptions(who, 'Only me');
    expect(await screen.findByRole('status')).toHaveTextContent('Only you see it now.');
    expect(client.patches.at(-1)?.patch).toEqual({ shares: [], version: 3 });
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(window.location.hash).toBe('#/dashboards/101'));
    // Not the owner's: no editing, no sharing; and no default without being an administrator.
    const other = fakeDashboardClient([{ ...TEAM_DASHBOARD, editable: false }]);
    open({ client: other });
    await screen.findAllByRole('heading', { level: 1, name: 'Checkout team' });
    expect(screen.getAllByRole('button', { name: 'Edit dashboard' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Make it everyone’s home' })).toBeNull();
  });

  it('[RPT-004] site administrators make it everyone’s home', async () => {
    const user = userEvent.setup();
    const { client } = open({ session: ADMIN });
    await user.click(await screen.findByRole('button', { name: 'Make it everyone’s home' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'It is everyone’s home dashboard now.',
    );
    expect(client.defaultId).toBe(5);
  });

  it('[RPT-004] a wallboard has no controls and turns to the next dashboard', async () => {
    expect(nextInRotation([5, 6, 7], 5)).toBe(6);
    expect(nextInRotation([5, 6, 7], 7)).toBe(5);
    expect(nextInRotation([], 5)).toBeNull();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      open({ wallboard: { rotation: [5, 6], seconds: 30 } });
      await screen.findByRole('heading', { level: 1, name: 'Checkout team' });
      expect(screen.queryByRole('button', { name: 'Edit dashboard' })).toBeNull();
      // Its own layout, no controls in sight: the way out waits for a pointer or a key (D31).
      expect(
        screen.getByRole('button', { name: 'Full screen' }).closest('.wallboard-exits'),
      ).not.toBeNull();
      expect(document.querySelector('.is-wallboard')).not.toBeNull();
      vi.advanceTimersByTime(30_000);
      expect(window.location.hash).toBe('#/dashboards/6/wallboard?rotate=5,6&seconds=30');
    } finally {
      vi.useRealTimers();
    }
  });

  it('[RPT-004] fits a phone without sideways scrolling', async () => {
    setViewportWidth(375);
    open();
    await screen.findByRole('figure', { name: 'Tickets by Priority' });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
  });

  it('[RPT-004] every text goes through the catalogue (en-XA)', async () => {
    const { container, errors } = open({ locale: 'en-XA' });
    await screen.findAllByRole('figure');
    await screen.findAllByRole('table');
    const data = new Set([
      TEAM_DASHBOARD.name,
      'Ada Lovelace',
      'Newest in SHOP',
      'Ask in #checkout.',
      'Our tickets, sprints and releases.',
      'Board',
      'Runbook',
      'Accept card payments',
      'Refund a payment',
      'Show the order total',
      'Send the receipt',
      'Save the address',
      'Save the card',
      'Active',
      'New',
      'Closed',
      'In Review',
      'High',
      'Low',
      'Medium',
      'Urgent',
      'checkout',
      'payments',
      'ux',
      'Checkout Sprint 10',
    ]);
    const texts = visibleTexts(container).filter((t) => !/\d/.test(t) && !data.has(t));
    expect(untranslated(texts)).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe('the dashboards list (M1-064)', () => {
  function list(session: Session = MEMBER) {
    const client = fakeDashboardClient([
      TEAM_DASHBOARD,
      {
        ...TEAM_DASHBOARD,
        id: 6,
        name: 'Support',
        owner: { id: 9, name: 'Grace Hopper' },
        editable: false,
        isDefault: true,
      },
    ]);
    render(
      <I18nProvider locale="en">
        <SessionProvider session={session}>
          <DashboardsPage client={client} />
        </SessionProvider>
      </I18nProvider>,
    );
    return client;
  }

  it('[RPT-004] lists the person’s own and shared dashboards, and makes a new one', async () => {
    const user = userEvent.setup();
    const client = list();
    const mine = await screen.findByRole('region', { name: 'Yours' });
    expect(within(mine).getByRole('link', { name: 'Checkout team' })).toHaveAttribute(
      'href',
      '#/dashboards/5',
    );
    const shared = screen.getByRole('region', { name: 'Shared with you' });
    expect(shared).toHaveTextContent('Support');
    expect(shared).toHaveTextContent('Everyone’s home dashboard.');
    await user.type(screen.getByLabelText('New dashboard'), 'Release week');
    await user.click(screen.getByRole('button', { name: 'Create dashboard' }));
    await waitFor(() => expect(window.location.hash).toBe('#/dashboards/101'));
    expect(client.dashboards.at(-1)?.name).toBe('Release week');
  });

  it('[RPT-004] labels each box in words and shows the start once one is ticked (PL-14)', async () => {
    const user = userEvent.setup();
    list();
    const box = await screen.findByRole('checkbox', {
      name: 'Show Checkout team on the wallboard',
    });
    expect(box.closest('label')).toHaveTextContent('On the wallboard');
    const wallboard = screen.getByRole('region', { name: 'Wallboard' });
    expect(within(wallboard).getByText(/^Choose dashboards to show them/)).toBeVisible();
    expect(within(wallboard).queryByRole('link')).toBeNull();
    await user.click(box);
    expect(
      within(wallboard).getByRole('link', { name: 'Start the wallboard with 1 dashboard' }),
    ).toBeVisible();
  });

  it('[RPT-005] says a dashboard that is not there is not found, with a way on (D4)', async () => {
    const client = fakeDashboardClient();
    client.get = async () => {
      throw new ApiError(404, { error: 'not_found' });
    };
    open({ client });
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Dashboard not found' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Go to Home' })).toBeVisible();
  });

  it('[RPT-005] keeps its header when it cannot be read for another reason, with the alert under it (UI-T22)', async () => {
    const client = fakeDashboardClient();
    client.get = async () => {
      throw new ApiError(500, { error: 'internal' });
    };
    open({ client });
    const heading = await screen.findByRole('heading', { level: 1, name: 'Dashboard' });
    expect(screen.getByRole('alert')).toHaveTextContent('This dashboard could not be loaded.');
    expect(heading.closest('section')).toContainElement(screen.getByRole('alert'));
    expect(screen.queryByRole('heading', { name: 'Dashboard not found' })).toBeNull();
  });

  it('[RPT-004] starts a wallboard with the chosen dashboards', async () => {
    const user = userEvent.setup();
    list();
    await user.click(
      await screen.findByRole('checkbox', { name: 'Show Checkout team on the wallboard' }),
    );
    await user.click(screen.getByRole('checkbox', { name: 'Show Support on the wallboard' }));
    await user.clear(screen.getByLabelText('Seconds per dashboard'));
    await user.type(screen.getByLabelText('Seconds per dashboard'), '30');
    expect(
      screen.getByRole('link', { name: 'Start the wallboard with 2 dashboards' }),
    ).toHaveAttribute('href', '#/dashboards/5/wallboard?rotate=5,6&seconds=30');
  });
});
