import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, within } from 'storybook/test';
import { HomeSignedOut, PageNotReady } from './HomeSignedOut';

/** The width of a small phone; nothing inside may stick out sideways. */
const atPhoneWidth = (Story: () => ReactElement) => (
  <div data-testid="phone-width" style={{ width: 360 }}>
    <Story />
  </div>
);

/** The accent of the skin in force, as the browser writes a colour. */
function accentColour(): string {
  const probe = document.createElement('span');
  probe.style.color = 'var(--color-accent)';
  document.body.append(probe);
  const colour = getComputedStyle(probe).color;
  probe.remove();
  return colour;
}

const meta = {
  title: 'Home/HomeSignedOut',
  component: HomeSignedOut,
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof HomeSignedOut>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Signed out: the page says what it is and where to sign in. */
export const SignedOut: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
    await expect(canvas.getByText(/^Your work in one place/)).toBeVisible();
    const link = canvas.getByRole('link', { name: 'Sign in' });
    await expect(link).toBeVisible();
    // On glass like the sign-in card it leads to, in the accent of every link (ADR-036).
    await expect(link.closest('.glass-card')).not.toBeNull();
    await expect(getComputedStyle(link).color).toBe(accentColour());
  },
};

export const SignedOutAtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const box = within(canvasElement).getByTestId('phone-width');
    await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
  },
};

/** #/search signed out, or #/home while the session is being checked. */
export const NotReady: Story = {
  render: () => (
    <PageNotReady
      title="Search"
      purpose="Find tickets with filters or the query language, and save the searches you reuse."
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('heading', { level: 1, name: 'Search' })).toBeVisible();
    await expect(canvas.getByText('This area is under construction.')).toBeVisible();
  },
};
