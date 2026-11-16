import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import { ScheduleResult } from './ScheduleResult';
import { evenOutRunFixture, scheduleRunFixture } from './scheduleResultFixture';
import { scheduleLookup } from './scheduleWords';

const RUN = scheduleRunFixture();

const atPhoneWidth = (Story: () => ReactElement) => (
  <div data-testid="phone-width" style={{ width: 360 }}>
    <Story />
  </div>
);

/** The result of an auto-schedule run, on top of the scenario's Changes tab (PLN-004). */
const meta = {
  title: 'Plans/ScheduleResult',
  component: ScheduleResult,
  args: {
    run: RUN,
    unit: 'points',
    names: scheduleLookup(RUN.result),
    compareHref: '#/plans/12/scenarios?scenario=2&a=1&b=2',
    compareWith: 'main',
  },
} satisfies Meta<typeof ScheduleResult>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Its counts in words, the tickets not placed first, each with its reason. */
export const Result: Story = {
  args: { run: scheduleRunFixture(), onRunAgain: fn() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Auto-schedule' })).toHaveFocus();
    await expect(
      canvas.getByRole('button', { name: 'Not placed (2)', pressed: true }),
    ).toBeVisible();
    await expect(canvas.getByText('Not placed: no estimate.')).toBeVisible();
  },
};

/** Placed tickets, one pushed by its blocker and due after its release, said after "Note:". */
export const Placed: Story = {
  args: { run: scheduleRunFixture(), onRunAgain: fn() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Placed (2)' }));
    await expect(
      canvas.getByText('Note: due 9 days after its release 2.1 (Nov 25).'),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Its choices' }));
    await expect(
      canvas.getByText('From Nov 9, 3 periods. Tickets in progress kept. Bug left out.'),
    ).toBeVisible();
  },
};

/** For a reader who may not run it, in the main scenario: no Run again, compared with Live. */
export const ReadOnly: Story = {
  args: {
    run: scheduleRunFixture({ scenario: { id: 1, name: 'Main plan', main: true, version: 2 } }),
    compareWith: 'live',
    compareHref: '#/plans/12/scenarios?scenario=1&a=live&b=1',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('link', { name: 'Compare with Live' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Run again…' })).toBeNull();
  },
};

/** On a phone's touch screen: finger-sized filters, links and actions, nothing out sideways. */
export const OnAPhone: Story = {
  tags: ['touch'],
  args: { run: scheduleRunFixture(), onRunAgain: fn() },
  decorators: [atPhoneWidth],
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Placed (2)' }));
    const box = canvas.getByTestId('phone-width');
    await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
    await expect(
      tooSmallForAFinger(canvasElement, [
        '.filter-chip',
        '.scenario-differing li > a',
        '.scenario-item-actions a',
        '.scenario-item-actions button',
      ]),
    ).toEqual([]);
  },
};

/** After evening out load (PLN-011): what moved later and why, and the cells still over. */
export const EvenedOut: Story = {
  args: { run: evenOutRunFixture(), onRunAgain: fn() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { name: 'Even out load' })).toHaveFocus();
    await expect(
      canvas.getByText('Not moved: moving it would make kept OPS-4 late.'),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Moved (2)' }));
    await expect(
      canvas.getByText(
        'Moved 2 weeks later, from Nov 9–Nov 22 to Nov 23–Dec 6: Atlas was 6 points over.',
      ),
    ).toBeVisible();
    const over = canvas.getByRole('region', { name: 'Still over capacity' });
    await expect(within(over).getAllByRole('listitem')).toHaveLength(2);
  },
};

/** Evening out on a phone's touch screen: finger-sized targets, nothing out sideways. */
export const EvenedOutOnAPhone: Story = {
  tags: ['touch'],
  args: { run: evenOutRunFixture(), onRunAgain: fn() },
  decorators: [atPhoneWidth],
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Moved (2)' }));
    const box = canvas.getByTestId('phone-width');
    await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
    await expect(
      tooSmallForAFinger(canvasElement, [
        '.filter-chip',
        '.scenario-differing li > a',
        '.scenario-item-actions a',
        '.scenario-item-actions button',
      ]),
    ).toEqual([]);
  },
};
