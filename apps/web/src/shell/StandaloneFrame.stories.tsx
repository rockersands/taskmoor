import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { onARealTouchScreen } from '../test/touch';
import { PageHeader } from './PageHeader';
import { StandaloneFrame, StandaloneNote } from './StandaloneFrame';

/**
 * The sign-in page's frame, which has no way out, beside a link page's, which has 'Go to sign in'
 * at the top (D24): following the way out must not move the product name or the heading.
 */
function SideBySide() {
  return (
    // Each at the column's full width, whatever the test window's: the row must not wrap.
    <div style={{ display: 'grid', gridTemplateColumns: '640px 640px', alignItems: 'start' }}>
      <div data-testid="sign-in">
        <StandaloneFrame wayOut={false}>
          <main className="setup">
            <PageHeader title="Sign in" />
            <div className="glass-card account-section">
              <p className="form-error" role="alert">
                That email and password do not match.
              </p>
            </div>
          </main>
        </StandaloneFrame>
      </div>
      <div data-testid="link-page">
        <StandaloneFrame>
          <main className="setup">
            <PageHeader title="Choose a password" />
            <StandaloneNote kind="problem">
              This link is invalid, has expired or was already used.
            </StandaloneNote>
          </main>
        </StandaloneFrame>
      </div>
    </div>
  );
}

const meta = {
  title: 'Shell/StandaloneFrame',
  component: SideBySide,
} satisfies Meta<typeof SideBySide>;

export default meta;
type Story = StoryObj<typeof meta>;

const top = (element: Element) => element.getBoundingClientRect().top;

async function sameHeights(canvasElement: HTMLElement) {
  const signIn = within(within(canvasElement).getByTestId('sign-in'));
  const linkPage = within(within(canvasElement).getByTestId('link-page'));
  await expect(linkPage.getByRole('link', { name: 'Go to sign in' })).toBeVisible();
  await expect(signIn.queryByRole('link', { name: 'Go to sign in' })).toBeNull();
  const brand = (page: typeof signIn) => page.getByText('Taskmoor');
  const heading = (page: typeof signIn) => page.getByRole('heading', { level: 1 });
  await expect(Math.abs(top(brand(signIn)) - top(brand(linkPage)))).toBeLessThanOrEqual(0.5);
  await expect(Math.abs(top(heading(signIn)) - top(heading(linkPage)))).toBeLessThanOrEqual(0.5);
}

/** The name and the heading sit at the same heights with and without the way out (D24). */
export const HeaderRowHeights: Story = {
  play: async ({ canvasElement }) => {
    await sameHeights(canvasElement);
  },
};

/** On a touch screen the way out is a finger's height, and the row keeps that height too. */
export const HeaderRowHeightsOnTouch: Story = {
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    await sameHeights(canvasElement);
  },
};

/**
 * A link page's problem is an alert drawn as the sign-in page's errors are (D24): the same colours
 * and the same box, not grey text.
 */
export const ProblemLooksLikeSignInError: Story = {
  play: async ({ canvasElement }) => {
    const signIn = within(within(canvasElement).getByTestId('sign-in')).getByRole('alert');
    const problem = within(within(canvasElement).getByTestId('link-page')).getByRole('alert');
    await expect(problem).toHaveTextContent('This link is invalid');
    const drawn = (element: Element) => {
      const style = getComputedStyle(element);
      return {
        color: style.color,
        background: style.backgroundColor,
        padding: style.padding,
        radius: style.borderRadius,
      };
    };
    await expect(drawn(problem)).toEqual(drawn(signIn));
  },
};
