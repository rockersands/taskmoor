import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../../i18n/I18nProvider';
import { ChecklistsPanel } from './ChecklistsPanel';
import { fakeToolsClient } from './fixtures';
import { LinksPanel } from './LinksPanel';
import { SubticketsPanel } from './SubticketsPanel';

/**
 * Touch targets in the ticket's tools (ADR-033): under a coarse pointer every field is 44px tall,
 * and so is the label each checklist box sits on. The web project turns CSS imports off, so the
 * stylesheet is read from disk, as motion.test.ts does, and matched against what the panels draw.
 * jsdom has no layout: that the label reaches under its box is for the eye, in the stories.
 */
const SRC =
  ['apps/web/src', 'src'].find((d) => existsSync(join(d, 'styles/ticket-tools.css'))) ?? 'src';

/** The style rules inside the stylesheet's `(pointer: coarse)` blocks. */
function coarseRules(): CSSStyleRule[] {
  const style = document.createElement('style');
  style.textContent = readFileSync(join(SRC, 'styles/ticket-tools.css'), 'utf8');
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
}

const isTouchTarget = (element: Element, rules: readonly CSSStyleRule[]) =>
  rules.some(
    (rule) =>
      element.matches(rule.selectorText) &&
      rule.style.getPropertyValue('min-height') === 'var(--hit-target-touch)',
  );

describe('touch targets in the ticket tools (ADR-033)', () => {
  it('[CORE-031] [CORE-032] [CORE-033] makes every field, and every box’s label, 44px tall on touch', async () => {
    const user = userEvent.setup();
    const client = fakeToolsClient({
      childTypes: [
        { id: 9, name: 'Subticket' },
        { id: 10, name: 'Sub-bug' },
      ],
    });
    const { container } = render(
      <I18nProvider locale="en">
        <LinksPanel
          ticket={{ id: 41, key: 'SHOP-41', track: { key: 'SHOP' } }}
          client={client}
          revision={0}
        />
        <SubticketsPanel
          ticket={{
            id: 41,
            key: 'SHOP-41',
            track: { key: 'SHOP' },
            ticketType: { level: { rank: 0 } },
          }}
          client={client}
          revision={0}
        />
        <ChecklistsPanel ticket={{ id: 41 }} client={client} revision={0} />
      </I18nProvider>,
    );
    // Every kind of field the tools have: the link form, the subticket form, a checklist's.
    await user.click(await screen.findByRole('button', { name: 'Add a link' }));
    await screen.findByRole('combobox', { name: 'How it relates' });
    await screen.findByRole('combobox', { name: 'Ticket type' });
    await user.click(await screen.findByRole('button', { name: 'Add a checklist' }));
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Checklist name' })).toBeInTheDocument(),
    );

    const rules = coarseRules();
    const fields = [...container.querySelectorAll('input:not([type="checkbox"]), select')];
    expect(fields.length).toBeGreaterThanOrEqual(7);
    const small = fields.filter((field) => !isTouchTarget(field, rules));
    expect(small.map((field) => field.outerHTML)).toEqual([]);

    // A subticket's status menu (TT-6).
    const statuses = screen.getAllByRole('button', { name: /^Status of SHOP-/ });
    expect(statuses).toHaveLength(2);
    expect(statuses.filter((button) => !isTouchTarget(button, rules))).toEqual([]);

    // A checklist item's grip (TT-5).
    const grips = [...container.querySelectorAll('.checklist-grip')];
    expect(grips.length).toBeGreaterThan(1);
    expect(grips.filter((grip) => !isTouchTarget(grip, rules)).map((g) => g.outerHTML)).toEqual([]);

    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.length).toBeGreaterThan(0);
    for (const box of boxes) {
      const label = box.labels?.[0];
      expect(label && isTouchTarget(label, rules)).toBe(true);
    }

    // A child's key, however short its words (PL-26).
    const keys = [...container.querySelectorAll('.ticket-child > a')];
    expect(keys.length).toBeGreaterThan(1);
    expect(keys.filter((key) => !isTouchTarget(key, rules)).map((k) => k.textContent)).toEqual([]);
  });
});

describe('the ticket tools after the page review (T-220)', () => {
  it('[CORE-032] keeps a child’s status at the end of its row on a phone too (PL-45)', async () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(join(SRC, 'styles/ticket-tools.css'), 'utf8');
    document.head.append(style);
    const sheet = style.sheet as CSSStyleSheet;
    // No narrow-screen rule moves the status under the summary.
    const narrow = [...sheet.cssRules]
      .filter((rule): rule is CSSMediaRule => 'media' in rule)
      .filter((rule) => /max-width/.test(rule.media.mediaText))
      .flatMap((rule) => [...rule.cssRules] as CSSStyleRule[])
      .filter((rule) => /ticket-child/.test(rule.selectorText ?? ''));
    style.remove();
    expect(narrow.map((rule) => rule.cssText)).toEqual([]);
  });

  it('[CORE-032] [CORE-033] gives a new checklist item and a new subticket the same Add (PL-44)', async () => {
    const client = fakeToolsClient();
    render(
      <I18nProvider locale="en">
        <SubticketsPanel
          ticket={{
            id: 41,
            key: 'SHOP-41',
            track: { key: 'SHOP' },
            ticketType: { level: { rank: 0 } },
          }}
          client={client}
          revision={0}
        />
        <ChecklistsPanel ticket={{ id: 41 }} client={client} revision={0} />
      </I18nProvider>,
    );
    await screen.findAllByRole('checkbox');
    await screen.findByRole('textbox', { name: 'New subticket' });
    const adds = screen.getAllByRole('button', { name: 'Add' });
    expect(adds.length).toBeGreaterThan(1);
    expect(new Set(adds.map((button) => button.className))).toEqual(new Set(['button-primary']));
  });
});
