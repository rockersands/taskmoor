import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { StandaloneFrame } from '../shell/StandaloneFrame';
import { fakeSignInSso, PARTNERS, STAFF, UMBRELLA } from '../sso/fixtures';
import { SessionProvider } from './SessionProvider';
import { SignInPage } from './SignInPage';

/**
 * Where signing out lands and where SSO errors return, in the reduced frame (D8): the product
 * name and the sign-in page, nothing else.
 */
const meta = {
  title: 'Session/SignInPage',
  component: SignInPage,
  // No providers unless a story names them; the page never calls a backend here.
  args: { onSignedIn: () => {}, ssoClient: fakeSignInSso() },
  decorators: [
    (Story, { parameters }) => {
      // The form reads `sso_error` and `method` from the address when it opens.
      window.history.replaceState(null, '', `#${parameters.hash ?? '/sign-in'}`);
      return (
        <StandaloneFrame wayOut={false}>
          <Story />
        </StandaloneFrame>
      );
    },
  ],
} satisfies Meta<typeof SignInPage>;

export default meta;
type Story = StoryObj<typeof meta>;

const anonymous: Story['decorators'] = [
  (Story) => (
    <SessionProvider session={{ status: 'anonymous' }}>
      <Story />
    </SessionProvider>
  ),
];

export const Form: Story = { decorators: anonymous };

export const PasswordShown: Story = {
  decorators: anonymous,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Password'), 'correct horse battery');
    await userEvent.click(canvas.getByRole('button', { name: 'Show password' }));
    await expect(canvas.getByLabelText('Password')).toHaveAttribute('type', 'text');
  },
};

export const CheckingTheSession: Story = {
  decorators: [
    (Story) => (
      <SessionProvider session={{ status: 'loading' }}>
        <Story />
      </SessionProvider>
    ),
  ],
};

export const Phone: Story = {
  decorators: anonymous,
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

const providers = fakeSignInSso([STAFF, PARTNERS, UMBRELLA], {
  'corp.example': { provider: STAFF, password: true },
  'umbrella.example': { provider: UMBRELLA, password: false },
});

export const WithProviders: Story = {
  args: { ssoClient: providers },
  decorators: anonymous,
};

export const OrganisationProvider: Story = {
  args: { ssoClient: providers },
  decorators: anonymous,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Email'), 'sam@corp.example');
    await userEvent.tab();
    await expect(
      await canvas.findByText('This address signs in with Staff accounts.'),
    ).toBeVisible();
  },
};

const GOOGLE = { id: 8, name: 'Google', brand: 'google' as const };
const withGoogle = fakeSignInSso([GOOGLE], { 'gmail.com': { provider: GOOGLE, password: true } });

/** A site with Google set up (IAM-032): on offer for anyone, first for a Gmail address. */
export const GoogleOnOffer: Story = {
  args: { ssoClient: withGoogle },
  decorators: anonymous,
};

export const GoogleForAGmailAddress: Story = {
  args: { ssoClient: withGoogle },
  decorators: anonymous,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Email'), 'sam@gmail.com');
    await userEvent.tab();
    await expect(await canvas.findByText('This address signs in with Google.')).toBeVisible();
    await expect(canvas.getByLabelText('Password')).toBeVisible();
    // Google's own button, with its G (T-061, T-262): Google's file as an image, drawn.
    const google = canvas.getByRole('button', { name: 'Sign in with Google' });
    await expect(google).toHaveClass('google-sign-in');
    const mark = google.querySelector('img.google-sign-in-mark') as HTMLImageElement;
    await expect(mark).not.toBeNull();
    await waitFor(() => expect(mark.complete && mark.naturalWidth > 0).toBe(true));
  },
};

export const GooglePhone: Story = {
  args: { ssoClient: withGoogle },
  decorators: anonymous,
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

export const SingleSignOnEnforced: Story = {
  args: { ssoClient: providers },
  decorators: anonymous,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Email'), 'ana@umbrella.example');
    await userEvent.tab();
    await expect(
      await canvas.findByRole('button', { name: 'Sign in with Umbrella' }),
    ).toBeVisible();
    await expect(canvas.queryByLabelText('Password')).toBeNull();
  },
};

/** A Google Workspace domain that signs in only through Google: the form's one button is Google's (T-061). */
const STAFF_GOOGLE = { id: 9, name: 'Staff Google', brand: 'google' as const };
export const GoogleRequired: Story = {
  args: {
    ssoClient: fakeSignInSso([STAFF_GOOGLE], {
      'example.com': { provider: STAFF_GOOGLE, password: false },
    }),
  },
  decorators: anonymous,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Email'), 'ann@example.com');
    await userEvent.tab();
    const form = canvas.getByRole('form', { name: 'Sign in' });
    const google = await within(form).findByRole('button', { name: 'Sign in with Google' });
    await expect(google).toHaveAttribute('type', 'submit');
    await expect(google).toHaveClass('google-sign-in');
    await expect(canvas.queryByLabelText('Password')).toBeNull();
  },
};

export const BreakGlass: Story = {
  args: { ssoClient: providers },
  decorators: anonymous,
  parameters: { hash: '/sign-in?method=password' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Email'), 'ana@umbrella.example');
    await userEvent.tab();
    await canvas.findByText('This address signs in with Umbrella.');
    await expect(canvas.getByLabelText('Password')).toBeVisible();
  },
};

export const SingleSignOnFailed: Story = {
  args: { ssoClient: providers },
  decorators: anonymous,
  parameters: { hash: '/sign-in?sso_error=email_unverified' },
};

export const PhoneWithProviders: Story = {
  args: { ssoClient: providers },
  decorators: anonymous,
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

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

export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth, ...(anonymous as [])],
  args: { ssoClient: providers },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/** A desktop's column, whatever the test window's width: the stand-alone column's 40 rem fits. */
const atDesktopWidth = (Story: () => ReactElement) => (
  <div style={{ width: 1000 }}>
    <Story />
  </div>
);

/** The inside width of an element: its box less its padding and borders. */
const insideWidth = (element: Element) => {
  const style = getComputedStyle(element);
  const sides = [
    style.paddingLeft,
    style.paddingRight,
    style.borderLeftWidth,
    style.borderRightWidth,
  ].reduce((sum, value) => sum + Number.parseFloat(value), 0);
  return element.getBoundingClientRect().width - sides;
};

/**
 * The form fills its card (AC-16, D24): the fields and the button span the card's inside, as on
 * the password link page, rather than Account's narrower reading width.
 */
export const FillsItsCard: Story = {
  decorators: [atDesktopWidth, ...(anonymous as [])],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const email = await canvas.findByLabelText('Email');
    const card = email.closest('.sign-in-card') as HTMLElement;
    const inside = insideWidth(card);
    await expect(inside).toBeGreaterThan(560);
    await expect(Math.abs(email.getBoundingClientRect().width - inside)).toBeLessThanOrEqual(1);
    const button = canvas.getByRole('button', { name: 'Sign in' });
    await expect(Math.abs(button.getBoundingClientRect().width - inside)).toBeLessThanOrEqual(1);
  },
};

/** A failed single sign-on's alert and the fields below it are one width (AC-16). */
export const SingleSignOnFailedFillsItsCard: Story = {
  args: { ssoClient: providers },
  decorators: [atDesktopWidth, ...(anonymous as [])],
  parameters: { hash: '/sign-in?sso_error=no_account' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const alert = await canvas.findByRole('alert');
    // The same person to ask as the line under the form (D12, D15).
    await expect(alert).toHaveTextContent('Ask a site administrator to create one.');
    const field = canvas.getByLabelText('Email').getBoundingClientRect();
    const box = alert.getBoundingClientRect();
    await expect(Math.abs(field.left - box.left)).toBeLessThanOrEqual(1);
    await expect(Math.abs(field.right - box.right)).toBeLessThanOrEqual(1);
  },
};
