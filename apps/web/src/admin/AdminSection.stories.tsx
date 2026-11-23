import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { AdminGroupPage } from './AdminGroupPage';
import { AdminLayout } from './AdminLayout';
import { AdminOverviewPage, type OverviewClient } from './AdminOverviewPage';
import { RECENT_ALERTS } from './alertsFixtures';
import { ADMIN, CONFIG_ADMIN, HEALTHY } from './fixtures';
import { ADMIN_GROUPS } from './sections';

const never = () => new Promise<never>(() => {});
const CLIENT: OverviewClient = {
  system: async () => HEALTHY,
  alerts: async () => RECENT_ALERTS,
  people: async () => ({
    users: [
      {
        id: 2,
        name: 'Noor Haddad',
        email: 'noor@example.com',
        isSiteAdmin: false,
        active: true,
        hasPassword: false,
        createdAt: '2026-10-01T00:00:00.000Z',
        deactivatedAt: null,
        lastSignInAt: null,
      },
    ],
    total: 1,
  }),
};

const meta = {
  title: 'Admin/Administration',
  component: AdminOverviewPage,
  args: { client: CLIENT },
  // One frame per story: a story that wraps the page in a second AdminLayout draws the list of
  // pages twice, two navigation landmarks of one name (axe landmark-unique, T-327).
  decorators: [
    (Story, context) => (
      <SessionProvider session={(context.parameters.session as Session) ?? ADMIN}>
        <main style={{ padding: 24 }}>
          <AdminLayout hash="#/admin">
            <Story />
          </AdminLayout>
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof AdminOverviewPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * A small laptop's window height (1280 by 720). The story's own window is taller, so a list that
 * fits there may still run past the card on a laptop: the stories measure against this instead.
 */
const LAPTOP_HEIGHT = 720;

/** How tall the side list's card may grow in a window this high (admin.css, .admin-nav-side). */
const cardLimitAt = (windowHeight: number) => {
  const tokens = getComputedStyle(document.documentElement);
  const token = (name: string) => Number.parseFloat(tokens.getPropertyValue(name));
  return windowHeight - token('--topbar-height') - 3 * token('--shell-gap');
};

/** The card's whole height with all of its list showing, scrolled part and borders included. */
const listHeight = (card: HTMLElement) => card.scrollHeight + card.offsetHeight - card.clientHeight;

/** What a site administrator opens on: every group, health, people and alerts. */
export const Overview: Story = {};

/**
 * Beside the overview the list shows every group's heading, closed, so the last one is in view
 * inside the card and nothing hides in its own scroller (S3-AD-2); the pages are on the overview.
 */
export const EveryGroupInView: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const nav = canvas.getByRole('navigation', { name: 'Administration pages' });
    const card = nav.closest('.admin-nav-side') as HTMLElement;
    const last = within(nav).getByRole('button', { name: 'System' });
    await expect(last).toHaveAttribute('aria-expanded', 'false');
    // Within a pixel: the heights are rounded.
    await expect(card.scrollHeight - card.clientHeight).toBeLessThanOrEqual(1);
    await expect(last.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      card.getBoundingClientRect().bottom,
    );
    // And on a laptop, whose window is shorter than the story's.
    await expect(listHeight(card)).toBeLessThanOrEqual(cardLimitAt(LAPTOP_HEIGHT));
    const every = canvas.getByRole('region', { name: 'Every page' });
    await expect(within(every).getByRole('link', { name: 'Guardrails' })).toBeVisible();
  },
};

/** Nothing back yet. */
export const Reading: Story = {
  args: { client: { system: never, alerts: never, people: never } },
};

/** Nobody waiting and no alert raised. */
export const NothingWaiting: Story = {
  args: {
    client: { ...CLIENT, alerts: async () => [], people: async () => ({ users: [], total: 0 }) },
  },
};

/**
 * A configuration administrator sees only the setup pages: their single-page groups open beside
 * the overview and the twelve pages of Tracks and setup stay closed, so the whole list fits the
 * card on a laptop and nothing hides in its own scroller (S3-AD-2).
 */
export const ConfigurationAdministrator: Story = {
  parameters: { session: CONFIG_ADMIN },
  play: async ({ canvasElement }) => {
    const nav = within(canvasElement).getByRole('navigation', { name: 'Administration pages' });
    const card = nav.closest('.admin-nav-side') as HTMLElement;
    for (const name of ['Your tracks', 'People and access']) {
      await expect(within(nav).getByRole('button', { name })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
    }
    await expect(within(nav).getByRole('button', { name: 'Tracks and setup' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    await expect(within(nav).getByRole('link', { name: 'Visibility policies' })).toBeVisible();
    await expect(listHeight(card)).toBeLessThanOrEqual(cardLimitAt(LAPTOP_HEIGHT));
  },
};

/** A group's own page, where a breadcrumb leads back to. */
export const GroupPage: Story = {
  render: () => {
    const group = ADMIN_GROUPS.find((g) => g.id === 'setup') ?? ADMIN_GROUPS[0];
    return group ? <AdminGroupPage group={group} /> : <div />;
  },
};
