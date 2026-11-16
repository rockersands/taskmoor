import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { MEMBER } from '../admin/fixtures';
import { SessionProvider } from '../session/SessionProvider';
import { onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import { fakeSavedSearchClient, fakeSearchClient } from './fixtures';
import { SearchPage } from './SearchPage';

const meta = {
  title: 'Search/SearchPage',
  component: SearchPage,
  args: { client: fakeSearchClient(), savedClient: fakeSavedSearchClient() },
  decorators: [
    (Story) => (
      <SessionProvider session={MEMBER}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof SearchPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The width of a small phone; nothing inside may stick out sideways. */
const atPhoneWidth = (Story: () => ReactElement) => (
  <div data-testid="phone-width" style={{ width: 360 }}>
    <Story />
  </div>
);
const fitsPhoneWidth = async (canvas: ReturnType<typeof within>) => {
  const box = canvas.getByTestId('phone-width');
  await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
};

/** The basic mode, before a search. */
export const Basic: Story = {};

/** Every kind of filter on the basic form, from a query in the address (QRY-014, QRY-006). */
export const BasicWithFilters: Story = {
  args: {
    initialQuery:
      'type IN (Bug, Story) AND priority = High AND labels = refunds AND requester = currentUser() AND targetRelease = "1.0" AND created >= 2026-10-01 AND created < 2026-11-01 AND due < 2026-12-01 ORDER BY updated DESC',
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('group', { name: 'Date created' })).toBeVisible();
    await expect(canvas.getByRole('group', { name: 'Due date' })).toBeVisible();
    await expect(await canvas.findByRole('checkbox', { name: 'Bug' })).toBeChecked();
    await expect(canvas.getByRole('button', { name: 'Remove refunds from Labels' })).toBeVisible();
  },
};

/** Adding a date filter with "Add a filter", between two days. */
export const AddADateFilter: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'Add a filter' }), 'closed');
    await userEvent.click(canvas.getByRole('button', { name: 'Add filter' }));
    const group = within(canvas.getByRole('group', { name: 'Date closed' }));
    await expect(group.getByRole('combobox', { name: 'When' })).toHaveFocus();
    await userEvent.selectOptions(group.getByRole('combobox', { name: 'When' }), 'between');
    await expect(group.getByLabelText('To')).toBeVisible();
  },
};

/** A query from the address, run, with suggestions open at the caret. */
export const Advanced: Story = {
  args: { initialQuery: 'status = Active' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const query = await canvas.findByRole('textbox', { name: 'Query' });
    await userEvent.clear(query);
    await userEvent.type(query, 'track = ');
    await expect(await canvas.findByRole('option', { name: 'SHOP' })).toBeVisible();
  },
};

/** A query the backend refuses, with the place it is wrong. */
export const WrongQuery: Story = {
  args: { initialQuery: 'nope = 1' },
};

/** Results in the person's columns, with export links. */
export const Results: Story = {
  args: { initialQuery: 'track = SHOP' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('table')).toBeVisible();
    await expect(canvas.getByRole('link', { name: 'Export CSV' })).toBeVisible();
  },
};

/** A search that finds nothing says so, and what to try. */
export const NoResults: Story = {
  args: {
    initialQuery: 'track = SHOP',
    client: {
      ...fakeSearchClient(),
      search: async () => ({
        tickets: [],
        next: null,
        total: { count: 0, exact: true },
      }),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('No tickets match this search')).toBeVisible();
    await expect(canvas.queryByRole('table')).toBeNull();
    await expect(canvas.getByRole('button', { name: 'Basic', pressed: true })).toBeVisible();
  },
};

/** A saved search opened from the address: its query, its columns and its results (M1-063). */
export const SavedSearchOpened: Story = {
  args: { initialSavedSearch: 2 },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { name: 'Saved search: Shop releases' }),
    ).toBeVisible();
    await expect(await canvas.findByRole('table')).toBeVisible();
  },
};

/** The page with filters at the width of a small phone: only the results table scrolls sideways. */
export const FiltersAtPhoneWidth: Story = {
  args: {
    initialQuery:
      'type = Bug AND labels = refunds AND created >= 2026-10-01 AND created < 2026-11-01 AND due = 2026-12-01 ORDER BY updated DESC',
  },
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('table');
    await fitsPhoneWidth(canvas);
  },
};

/**
 * Five tracks on a phone (QRY-014): every track's box and label shows in full, the last one
 * ('WEB Web app') too, with no part of the group cut off at its lower edge.
 */
export const EveryTrackOnAPhone: Story = {
  tags: ['touch'],
  args: {
    client: {
      ...fakeSearchClient(),
      tracks: async () => [
        { key: 'API', name: 'API Platform' },
        { key: 'MOB', name: 'Mobile apps' },
        { key: 'OPS', name: 'Operations' },
        { key: 'SWEEPL', name: 'Sweep local track' },
        { key: 'WEB', name: 'Web app' },
      ],
    },
  },
  beforeEach: onARealTouchScreen,
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const group = canvas.getByRole('group', { name: 'Tracks' });
    const last = await within(group).findByRole('checkbox', { name: 'WEB Web app' });
    const label = canvasElement.querySelector(`label[for="${last.id}"]`);
    if (!label) throw new Error('No label');
    const box = group.getBoundingClientRect();
    for (const shown of [last, label]) {
      await expect(shown.getBoundingClientRect().bottom).toBeLessThanOrEqual(box.bottom + 0.5);
    }
    await expect(group.scrollHeight).toBeLessThanOrEqual(group.clientHeight + 1);
    await fitsPhoneWidth(canvas);
  },
};

/** On a touch screen each stage's label is a finger's target, "New" too (PL-13). */
export const StagesOnATouchScreen: Story = {
  tags: ['touch'],
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('group', { name: 'Stage' });
    await expect(
      tooSmallForAFinger(canvasElement, ['.search-choices .form-field-inline label']),
    ).toEqual([]);
  },
};
