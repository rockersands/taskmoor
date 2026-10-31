import type { Meta, StoryObj } from '@storybook/react-vite';
import { utf8 } from '@taskmoor/builder-core';
import { expect, userEvent, within } from 'storybook/test';
import { BuilderPage } from './BuilderPage';
import { EMPTY_FORM } from './form';
import { MissingBuild } from './MissingBuild';

/** A web build in miniature: the page makes real kits from it in the story's browser. */
const WEB = {
  'index.html': utf8(
    '<!doctype html><html><head><meta charset="UTF-8" /><script id="taskmoor-config" type="application/json">{}</script><script type="module" crossorigin src="./assets/app.js"></script></head><body></body></html>',
  ),
  'assets/app.js': utf8('console.log(1);'),
};

const FILLED = {
  ...EMPTY_FORM,
  backendUrl: 'https://api.example.com',
  frontendUrl: 'https://tracker.example.com/',
  instanceName: 'Acme tracker',
  withSmtp: true,
  smtpHost: 'mail.example.com',
  smtpUser: 'tracker',
  smtpFrom: 'tracker@example.com',
  aiProvider: 'anthropic' as const,
};

const meta = {
  title: 'Builder/BuilderPage',
  component: BuilderPage,
  args: { web: WEB, version: '1.4.2' },
} satisfies Meta<typeof BuilderPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const Filled: Story = { args: { initialForm: FILLED } };

export const WithProblems: Story = {
  args: {
    initialForm: {
      ...EMPTY_FORM,
      backendUrl: 'http://api.example.com',
      frontendUrl: 'https://tracker.example.com/app',
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Make the kits' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent('Some settings need a change');
  },
};

export const Generated: Story = {
  args: { initialForm: FILLED },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Make the kits' }));
    await expect(
      await canvas.findByRole('link', { name: 'Download the backend kit' }, { timeout: 10_000 }),
    ).toHaveAttribute('download', 'taskmoor-backend-kit.zip');
  },
};

export const WithoutBuild: StoryObj<typeof MissingBuild> = {
  render: () => <MissingBuild />,
};
