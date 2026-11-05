import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { fakeSignInSso, PARTNERS, STAFF, UMBRELLA } from '../sso/fixtures';
import { SessionProvider } from './SessionProvider';
import { SignInPage } from './SignInPage';

/** Where "Sign in" in the top bar leads, where signing out lands and where SSO errors return. */
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
        <main style={{ padding: 32 }}>
          <Story />
        </main>
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

const GOOGLE = { id: 8, name: 'Google' };
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
