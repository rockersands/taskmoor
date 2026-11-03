import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { MEMBER } from '../admin/fixtures';
import type { Board } from '../boards/client';
import { DashboardPage } from '../dashboards/DashboardPage';
import { fakeDashboardClient } from '../dashboards/fixtures';
import { I18nProvider } from '../i18n/I18nProvider';
import { fakeReportClient, SCRUM_REPORT_BOARD } from '../reports/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { fakeSprintClient } from '../sprints/fixtures';
import { fakeTrackClient } from './fixtures';
import { type TrackReport, TrackStatisticsPage } from './TrackStatisticsPage';

/**
 * Fingers and keyboards in the reports (ADR-033, ADR-024): under a coarse pointer every ticket
 * link a report or widget lists is 44px tall, and every table region that can scroll sideways
 * takes focus, so a keyboard can scroll it. The web project turns CSS imports off, so the
 * stylesheets are read from disk, as touchTargets.test.tsx does, and matched against what the
 * reports draw. jsdom has no layout: the e2e spec measures a link on a phone.
 */
const SRC = ['apps/web/src', 'src'].find((d) => existsSync(join(d, 'styles/charts.css'))) ?? 'src';

/** The style rules inside the stylesheets' `(pointer: coarse)` blocks. */
function coarseRules(): CSSStyleRule[] {
  return ['charts.css', 'dashboards.css'].flatMap((file) => {
    const style = document.createElement('style');
    style.textContent = readFileSync(join(SRC, 'styles', file), 'utf8');
    document.head.append(style);
    const sheet = style.sheet as CSSStyleSheet;
    const rules = [...sheet.cssRules]
      .filter(
        (rule): rule is CSSMediaRule =>
          'media' in rule && (rule as CSSMediaRule).media.mediaText.includes('pointer: coarse'),
      )
      .flatMap((rule) => [...rule.cssRules])
      .filter((rule): rule is CSSStyleRule => 'selectorText' in rule);
    style.remove();
    return rules;
  });
}

const isTouchTarget = (element: Element, rules: readonly CSSStyleRule[]) =>
  rules.some(
    (rule) =>
      element.matches(rule.selectorText) &&
      rule.style.getPropertyValue('min-height') === 'var(--hit-target-touch)',
  );

/** The ticket links and table regions a page drew, each checked. */
function check(container: HTMLElement, rules: readonly CSSStyleRule[]) {
  const links = [...container.querySelectorAll('.report-table a, .widget-tickets a')];
  const tables = [...container.querySelectorAll('.report-table')];
  for (const link of links) {
    expect(isTouchTarget(link, rules), `${link.textContent} is a finger's target`).toBe(true);
  }
  for (const table of tables) {
    expect(table.getAttribute('tabindex'), table.getAttribute('aria-label') ?? '').toBe('0');
  }
  return { links: links.length, tables: tables.length };
}

const SCRUM: Board = {
  ...SCRUM_REPORT_BOARD,
  location: { type: 'track', track: { id: 1, key: 'SHOP', name: 'Shop' } },
};

function open(report: TrackReport) {
  return render(
    <I18nProvider locale="en">
      <TrackStatisticsPage
        trackKey="SHOP"
        board={SCRUM}
        report={report}
        reports={fakeReportClient(SCRUM)}
        sprints={fakeSprintClient()}
        client={fakeTrackClient()}
      />
    </I18nProvider>,
  ).container;
}

describe('ticket links and tables in the reports (ADR-033)', () => {
  const rules = coarseRules();

  it('[RPT-002] every ticket a track report lists is a 44px target, and every table takes focus', async () => {
    const seen = { links: 0, tables: 0 };
    for (const [report, ready] of [
      ['time-tracking', 'Time tracking'],
      ['group-by', 'Grouped tickets'],
      ['user-workload', 'Workload by person'],
      ['ticket-statistics', 'Ticket statistics'],
    ] as const) {
      const container = open(report);
      await screen.findAllByRole(report === 'group-by' ? 'list' : 'region', { name: ready });
      const found = check(container, rules);
      seen.links += found.links;
      seen.tables += found.tables;
      container.remove();
    }
    // Something was checked: the time tracking rows and the grouped tickets' keys, four tables.
    expect(seen.links).toBeGreaterThanOrEqual(5);
    expect(seen.tables).toBe(3);
  });

  it('[RPT-001] the outcome report’s tickets are 44px targets in a table that takes focus', async () => {
    const user = userEvent.setup();
    const container = open('outcome-report');
    await user.type(await screen.findByRole('textbox', { name: 'Outcome' }), 'SHOP-7');
    await user.click(screen.getByRole('button', { name: 'Show' }));
    await screen.findByRole('region', { name: 'Tickets under the outcome' });
    expect(check(container, rules)).toEqual({ links: 4, tables: 1 });
  });

  it('[RPT-005] every widget’s ticket links are 44px targets, and every table takes focus', async () => {
    const { container } = render(
      <I18nProvider locale="en">
        <SessionProvider session={MEMBER}>
          <DashboardPage id={5} client={fakeDashboardClient()} wallboard={null} />
        </SessionProvider>
      </I18nProvider>,
    );
    await screen.findByRole('heading', { level: 1, name: 'Checkout team' });
    await waitFor(() => expect(container.querySelector('.report-empty')).toBeNull());
    const found = check(container, rules);
    // Search results, assigned, followed, grouped and time tracking list tickets; four tables.
    expect(found.links).toBeGreaterThanOrEqual(8);
    expect(found.tables).toBe(4);
  });
});
