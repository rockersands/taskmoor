import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { type ContextLists, ContextsSection } from './ContextsSection';
import type { Field } from './client';
import { fakeFieldsClient, sampleFields } from './fixtures';

const LISTS: ContextLists = {
  tracks: [
    { id: 1, key: 'PAY', name: 'Payments' },
    { id: 4, key: 'OPS', name: 'Operations' },
  ],
  types: [
    { id: 11, name: 'Bug' },
    { id: 12, name: 'Feature' },
    { id: 13, name: 'Subticket' },
  ],
  groups: [
    { id: 21, name: 'Reviewers' },
    { id: 22, name: 'Support' },
  ],
  roles: [{ id: 31, name: 'Administrators' }],
};

const fieldOf = (id: number) => sampleFields().find((f) => f.id === id) as Field;

/** The section as a page keeps it: the field as the server last answered. */
function Live({ start }: { start: Field }) {
  const [field, setField] = useState(start);
  return (
    <ContextsSection
      field={field}
      client={fakeFieldsClient()}
      lists={LISTS}
      onField={setField}
      onChanged={() => {}}
      onProblem={() => {}}
    />
  );
}

const meta = {
  title: 'Admin/Fields/ContextsSection',
  component: Live,
  args: { start: fieldOf(2) },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof Live>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A choice list with a context for all and one for Payments bugs, each with its default. */
export const TwoContexts: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('Tracks: Payments; ticket types: Bug')).toBeVisible();
  },
};

/** Changing a context: chosen tracks and ticket types. */
export const Changing: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Change context Payments bugs' }));
    await expect(canvas.getByRole('form', { name: 'Change context Payments bugs' })).toBeVisible();
  },
};

/** A person field: whom it offers, and a person as its default. */
export const PersonField: Story = {
  args: { start: fieldOf(6) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Change context Everywhere' }));
    await userEvent.selectOptions(canvas.getByLabelText('Offer'), 'role');
    await expect(canvas.getByLabelText('Track role')).toBeVisible();
  },
};

/** A field with no context left applies nowhere, and says so. */
export const Nowhere: Story = {
  args: { start: { ...fieldOf(1), contexts: [] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('This field applies nowhere.')).toBeVisible();
  },
};

/** A formula takes no default. */
export const NoDefault: Story = {
  args: { start: fieldOf(8) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText('A field of type Formula takes no default value.')).toBeVisible();
  },
};

/** Severity with its contexts changed as `change` says, by index. */
const severityWith = (change: (contexts: Field['contexts']) => void): Field => {
  const field = structuredClone(fieldOf(2));
  change(field.contexts);
  return field;
};

/** A context still naming a track in the trash: saving leaves it out, and the form says so. */
export const TrackInTheTrash: Story = {
  args: {
    start: severityWith((contexts) => {
      if (contexts[1]) contexts[1].trackIds = [1, 9];
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Change context Payments bugs' }));
    await expect(canvas.getByText(/^A track it names is in the trash/)).toBeVisible();
  },
};

/** A default naming an option no longer offered: saving leaves it out, and the form says so. */
export const DefaultNoLongerOffered: Story = {
  args: {
    start: severityWith((contexts) => {
      const low = contexts[0]?.options?.find((o) => o.id === 201);
      if (low) low.disabled = true;
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(/^The default still names Low/)).toBeVisible();
  },
};
