import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { I18nProvider } from '../i18n/I18nProvider';
import { onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import { GoogleSignInButton } from './GoogleSignInButton';

/**
 * Google's sign-in button (T-061, IAM-031): the four-colour G at the left and "Sign in with
 * Google", light or dark with the skin, as Google's sign-in branding guidelines describe them.
 */
const meta = {
  title: 'Session/GoogleSignInButton',
  component: GoogleSignInButton,
  args: { onClick: () => {} },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: '20rem' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof GoogleSignInButton>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The colours Google gives its light and dark buttons, as the browser computes them. */
const LOOKS = {
  light: { fill: 'rgb(255, 255, 255)', edge: 'rgb(116, 119, 117)', text: 'rgb(31, 31, 31)' },
  dark: { fill: 'rgb(19, 19, 20)', edge: 'rgb(142, 145, 143)', text: 'rgb(227, 227, 227)' },
} as const;

export const Button: Story = {
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole('button', { name: 'Sign in with Google' });
    const mark = button.querySelector('svg') as SVGElement;
    const { height } = button.getBoundingClientRect();
    // At least the 40px Google sets, and the mark at 20px at the left of the words.
    await expect(height).toBeGreaterThanOrEqual(40);
    await expect(mark.getBoundingClientRect().width).toBe(20);
    await expect(mark.getBoundingClientRect().left).toBeLessThan(
      (button.querySelector('span') as HTMLElement).getBoundingClientRect().left,
    );
  },
};

/** Both looks side by side, each in its own skin. */
export const BothSkins: Story = {
  render: (args) => (
    <div style={{ display: 'grid', gap: '1rem' }}>
      {(['light', 'dark'] as const).map((skin) => (
        <div
          key={skin}
          data-skin={skin}
          data-testid={skin}
          style={{ padding: '1rem', background: 'var(--color-surface)' }}
        >
          <GoogleSignInButton {...args} />
        </div>
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    for (const skin of ['light', 'dark'] as const) {
      const button = within(canvas.getByTestId(skin)).getByRole('button', {
        name: 'Sign in with Google',
      });
      const style = getComputedStyle(button);
      await expect(style.backgroundColor).toBe(LOOKS[skin].fill);
      await expect(style.borderTopColor).toBe(LOOKS[skin].edge);
      await expect(style.color).toBe(LOOKS[skin].text);
    }
  },
};

/** On a touch screen it is a finger's height. */
export const OnTouch: Story = {
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    await expect(tooSmallForAFinger(canvasElement, ['.google-sign-in'])).toEqual([]);
  },
};

/** In Spanish, as Google words it. */
export const Spanish: Story = {
  decorators: [
    (Story) => (
      <I18nProvider locale="es">
        <Story />
      </I18nProvider>
    ),
  ],
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole('button', { name: 'Iniciar sesión con Google' }),
    ).toBeVisible();
  },
};

/** At a small phone's width the words wrap inside the button, never past it. */
export const Phone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  decorators: [
    (Story) => (
      <div data-testid="narrow" style={{ width: 200 }}>
        <I18nProvider locale="es">
          <Story />
        </I18nProvider>
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const box = within(canvasElement).getByTestId('narrow');
    await expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth);
  },
};
