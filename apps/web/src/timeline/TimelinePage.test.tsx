import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { setViewportWidth } from '../test/viewport';
import { fakeTimelineClient } from './fixtures';
import { TimelinePage } from './TimelinePage';

function renderTimeline(client = fakeTimelineClient()) {
  render(
    <I18nProvider locale="en">
      <TimelinePage trackKey="LCH" client={client} now={() => new Date('2026-11-04T09:00:00Z')} />
    </I18nProvider>,
  );
  return client;
}
const rowOf = (key: string) => screen.getByRole('link', { name: key }).closest('li') as HTMLElement;
const item = (client: ReturnType<typeof fakeTimelineClient>, key: string) =>
  client.data().items.find((i) => i.key === key);

describe('the timeline (M1-048)', () => {
  it('[AGL-015] nests children under parents and rolls a parent up from its children', async () => {
    renderTimeline();
    expect(await screen.findByRole('heading', { name: 'Timeline of Launch' })).toBeVisible();
    expect(
      screen
        .getAllByRole('link')
        .map((a) => a.textContent)
        .filter((k) => k?.startsWith('LCH-')),
    ).toEqual(['LCH-1', 'LCH-2', 'LCH-3', 'LCH-4', 'LCH-5', 'LCH-6']);
    expect(
      within(rowOf('LCH-1')).getByRole('img', {
        name: 'LCH-1: Oct 28, 2026 to Nov 20, 2026, rolled up from its children',
      }),
    ).toBeVisible();
    expect(within(rowOf('LCH-1')).getByText('1 of 3 closed')).toBeVisible();
    expect(
      within(rowOf('LCH-2')).getByRole('button', { name: 'LCH-2: Nov 2, 2026 to Nov 10, 2026' }),
    ).toBeVisible();
    // Hiding the outcome's children hides the grandchild too.
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Hide the children of LCH-1' }));
    expect(screen.queryByRole('link', { name: 'LCH-3' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Show the children of LCH-1' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('[AGL-015] moves a bar by dragging it, and the parent rolls up again', async () => {
    const client = renderTimeline();
    const bar = await screen.findByRole('button', { name: 'LCH-4: Nov 12, 2026 to Nov 20, 2026' });
    // jsdom gives no layout: the bar's box is empty, so a press at x 0 is its middle's "move".
    Object.defineProperty(bar, 'getBoundingClientRect', {
      value: () => ({ left: 0, width: 252, top: 0, height: 24, right: 252, bottom: 24 }),
    });
    fireEvent.pointerDown(bar, { button: 0, clientX: 100, pointerId: 1 });
    // Three days to the right at 28px a day (the weeks zoom).
    fireEvent.pointerMove(bar, { clientX: 100 + 3 * 28, pointerId: 1 });
    fireEvent.pointerUp(bar, { clientX: 100 + 3 * 28, pointerId: 1 });
    await waitFor(() =>
      expect(item(client, 'LCH-4')).toMatchObject({ start: '2026-11-15', due: '2026-11-23' }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'LCH-4 now runs from Nov 15, 2026 to Nov 23, 2026.',
    );
    expect(item(client, 'LCH-1')?.rollup?.due).toBe('2026-11-23');
    // A drag does not open the side panel.
    expect(screen.queryByRole('complementary', { name: 'Days of LCH-4' })).toBeNull();
  });

  it('[AGL-015] stretches a bar from its end, and moves a focused bar with Alt and an arrow', async () => {
    const user = userEvent.setup();
    const client = renderTimeline();
    const bar = await screen.findByRole('button', { name: 'LCH-2: Nov 2, 2026 to Nov 10, 2026' });
    Object.defineProperty(bar, 'getBoundingClientRect', {
      value: () => ({ left: 0, width: 252, top: 0, height: 24, right: 252, bottom: 24 }),
    });
    // At its right end: the due day moves, the start stays.
    fireEvent.pointerDown(bar, { button: 0, clientX: 250, pointerId: 1 });
    fireEvent.pointerMove(bar, { clientX: 250 + 2 * 28, pointerId: 1 });
    fireEvent.pointerUp(bar, { clientX: 250 + 2 * 28, pointerId: 1 });
    await waitFor(() =>
      expect(item(client, 'LCH-2')).toMatchObject({ start: '2026-11-02', due: '2026-11-12' }),
    );
    const moved = await screen.findByRole('button', { name: 'LCH-2: Nov 2, 2026 to Nov 12, 2026' });
    moved.focus();
    await user.keyboard('{Alt>}{Shift>}{ArrowLeft}{/Shift}{/Alt}');
    await waitFor(() =>
      expect(item(client, 'LCH-2')).toMatchObject({ start: '2026-10-26', due: '2026-11-05' }),
    );
  });

  it('[AGL-015] edits days in the side panel, a sprint’s days included', async () => {
    const user = userEvent.setup();
    const client = renderTimeline();
    await user.click(
      await screen.findByRole('button', { name: 'LCH-5: Nov 9, 2026 to Nov 20, 2026' }),
    );
    const panel = within(screen.getByRole('complementary', { name: 'Days of LCH-5' }));
    expect(panel.getByText(/come from its sprint/)).toBeVisible();
    await user.clear(panel.getByLabelText('Due date'));
    await user.type(panel.getByLabelText('Due date'), '2026-11-01');
    expect(panel.getByText('The start date must not be after the due date.')).toBeVisible();
    expect(panel.getByRole('button', { name: 'Save dates' })).toBeDisabled();
    await user.clear(panel.getByLabelText('Due date'));
    await user.type(panel.getByLabelText('Due date'), '2026-11-27');
    await user.click(panel.getByRole('button', { name: 'Save dates' }));
    await waitFor(() =>
      expect(item(client, 'LCH-5')).toMatchObject({
        start: '2026-11-09',
        due: '2026-11-27',
        dated: 'own',
      }),
    );
    // An unscheduled ticket gets days from its panel too.
    await user.click(screen.getByRole('button', { name: 'Schedule LCH-6' }));
    const venue = within(screen.getByRole('complementary', { name: 'Days of LCH-6' }));
    await user.type(venue.getByLabelText('Start date'), '2026-11-16');
    await user.click(venue.getByRole('button', { name: 'Save dates' }));
    await waitFor(() => expect(item(client, 'LCH-6')?.start).toBe('2026-11-16'));
  });

  it('[AGL-015] lists dependencies in the panel and says when a change is refused', async () => {
    const user = userEvent.setup();
    renderTimeline(fakeTimelineClient({ refuse: true }));
    await user.click(
      await screen.findByRole('button', { name: 'LCH-4: Nov 12, 2026 to Nov 20, 2026' }),
    );
    const panel = within(screen.getByRole('complementary', { name: 'Days of LCH-4' }));
    expect(panel.getByText('Blocked by LCH-2')).toBeVisible();
    await user.click(panel.getByRole('button', { name: 'Save dates' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('LCH-4 could not be rescheduled');
  });

  it('[AGL-015] zooms by months and quarters', async () => {
    const user = userEvent.setup();
    renderTimeline();
    await screen.findByRole('heading', { name: 'Timeline of Launch' });
    const months = screen.getByRole('button', { name: 'Months' });
    await user.click(months);
    expect(months).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: 'Quarters' }));
    expect(screen.getByText('Q4 2026')).toBeInTheDocument();
  });

  it('[AGL-015] fits a phone: the timeline scrolls inside itself, never the page', async () => {
    setViewportWidth(375);
    renderTimeline();
    await screen.findByRole('heading', { name: 'Timeline of Launch' });
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375);
  });
});
