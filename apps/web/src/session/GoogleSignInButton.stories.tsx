import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, waitFor, within } from 'storybook/test';
import { I18nProvider } from '../i18n/I18nProvider';
import { onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import { GoogleSignInButton } from './GoogleSignInButton';

/**
 * Google's sign-in button (T-061, T-262, IAM-031): Google's G at the left and "Sign in with
 * Google" in Google Sans Medium, light or dark with the skin, as Google's sign-in branding
 * guidelines and its own button files describe them.
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
    const mark = button.querySelector('img') as HTMLImageElement;
    const label = button.querySelector('span') as HTMLElement;
    // The label in Google Sans Medium, the face the app ships, loaded (T-262).
    await document.fonts.ready;
    await expect(document.fonts.check('500 14px "Google Sans"', label.textContent ?? '')).toBe(
      true,
    );
    await expect(getComputedStyle(label).fontFamily).toMatch(/^"Google Sans", /);
    await expect(getComputedStyle(button).fontWeight).toBe('500');
    await expect(
      Array.from(document.fonts).some(
        (f) => f.family.replace(/"/g, '') === 'Google Sans' && f.status === 'loaded',
      ),
    ).toBe(true);
    // The G drawn: Google's file, loaded, 20 px square at the left of the words.
    await waitFor(() => expect(mark.complete && mark.naturalWidth > 0).toBe(true));
    await expect(mark.getBoundingClientRect().width).toBe(20);
    await expect(mark.getBoundingClientRect().height).toBe(20);
    await expect(mark.getBoundingClientRect().left).toBeLessThan(
      label.getBoundingClientRect().left,
    );
    // 40 px high with a mouse, as Google's files draw it.
    await expect(button.getBoundingClientRect().height).toBe(40);
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

/** On a touch screen it is a finger's height: 44 px, the G still 20 px (T-262). */
export const OnTouch: Story = {
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    await expect(tooSmallForAFinger(canvasElement, ['.google-sign-in'])).toEqual([]);
    const button = canvasElement.querySelector('.google-sign-in') as HTMLElement;
    await expect(button.getBoundingClientRect().height).toBe(44);
    const mark = button.querySelector('img') as HTMLImageElement;
    await expect(mark.getBoundingClientRect().height).toBe(20);
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
