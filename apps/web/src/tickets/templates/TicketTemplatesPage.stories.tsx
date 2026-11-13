import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import {
  EVERY_TRACK_OPTIONS,
  fakeTemplateClient,
  INCIDENT_TEMPLATE,
  RELEASE_TEMPLATE,
} from './fixtures';
import { TicketTemplatesPage } from './TicketTemplatesPage';

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

const meta = {
  title: 'Tickets/TicketTemplatesPage',
  component: TicketTemplatesPage,
  args: { client: fakeTemplateClient(), trackKey: 'SHOP' },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof TicketTemplatesPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A track's templates, with one for every track alongside. */
export const OfATrack: Story = {};

/** The templates for every track, kept by configuration administrators. */
export const ForEveryTrack: Story = {
  args: {
    trackKey: undefined as never,
    client: fakeTemplateClient([INCIDENT_TEMPLATE], { options: EVERY_TRACK_OPTIONS }),
  },
};

/** Someone who may read the templates and not change them. */
export const ReadOnly: Story = {
  args: {
    client: fakeTemplateClient([{ ...RELEASE_TEMPLATE, mayEdit: false }], { mayCreate: false }),
  },
};

export const Empty: Story = { args: { client: fakeTemplateClient([]) } };

/** The form, open on a template with values, subtickets and a kept value. */
export const Editing: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Edit template Release checklist' }),
    );
    await expect(
      canvas.getByRole('form', { name: 'Edit template Release checklist' }),
    ).toBeVisible();
  },
};

/** A track's templates on a phone: the track's name over the title, the line saying what it covers. */
export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('heading', { level: 1, name: 'Ticket templates' }),
    ).toBeVisible();
    await expect(canvas.getByText(/^Templates offered when .* in this track/)).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};

/** The form on a phone, with its fieldsets. */
export const EditingAtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Edit template Release checklist' }),
    );
    await expect(
      canvas.getByRole('form', { name: 'Edit template Release checklist' }),
    ).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};
