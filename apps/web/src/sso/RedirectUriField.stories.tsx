import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, within } from 'storybook/test';
import { slashPieces } from '../admin/BreakAtSlashes';
import { onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import { REDIRECT_URI } from './fixtures';
import { RedirectUriField } from './RedirectUriField';

const meta = {
  title: 'Admin/RedirectUriField',
  component: RedirectUriField,
  args: { uri: REDIRECT_URI },
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 720 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof RedirectUriField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Address: Story = {};

export const LongAddress: Story = {
  args: {
    uri: 'https://tasks.a-long-internal-host-name.departments.example.org/api/v1/auth/oidc/callback',
  },
};

/** A phone's window, 375 px, less the page's gutters and the card's own padding. */
const atPhoneWidth = (Story: () => ReactElement) => (
  <div data-testid="phone-width" style={{ width: 343 }}>
    <Story />
  </div>
);

/** The tops of the lines a text node takes. */
const lineTops = (text: Node) => {
  const range = document.createRange();
  range.selectNodeContents(text);
  return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top)));
};

/**
 * On a phone the whole address shows, and each line ends after a '/': 'v1' and the host stay
 * whole (AD-9), and nothing runs past the block's edge.
 */
export const Phone: Story = {
  decorators: [atPhoneWidth],
  args: { uri: 'http://localhost:8090/api/v1/auth/oidc/callback' },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    const block = canvas.getByRole('textbox', { name: 'Redirect URI to register' });
    await expect(block).toHaveAttribute('aria-readonly', 'true');
    await expect(block).toHaveTextContent(args.uri);
    await expect(block.scrollWidth).toBeLessThanOrEqual(block.clientWidth);
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const pieces: Node[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) pieces.push(node);
    await expect(pieces.map((p) => p.textContent)).toEqual(slashPieces(args.uri));
    // Each piece on one line of its own; the address on more than one.
    for (const piece of pieces) await expect(lineTops(piece).size).toBe(1);
    const lines = new Set(pieces.flatMap((piece) => [...lineTops(piece)]));
    await expect(lines.size).toBeGreaterThan(1);
  },
};

/**
 * NFR-007, ADR-033: on a phone's touch screen the address and its Copy button are each a finger's
 * 44 px, and the page does not scroll sideways.
 */
export const OnATouchPhone: Story = {
  tags: ['touch'],
  decorators: [atPhoneWidth],
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    await expect(
      tooSmallForAFinger(canvasElement, ['.redirect-uri-value', '.token-secret-row button']),
    ).toEqual([]);
    const page = canvasElement.ownerDocument.documentElement;
    await expect(page.scrollWidth).toBeLessThanOrEqual(page.clientWidth);
  },
};
