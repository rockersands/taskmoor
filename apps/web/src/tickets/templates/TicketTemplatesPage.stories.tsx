import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import {
  EVERY_TRACK_OPTIONS,
  fakeTemplateClient,
  INCIDENT_TEMPLATE,
  RELEASE_TEMPLATE,
} from './fixtures';
import { TicketTemplatesPage } from './TicketTemplatesPage';

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
