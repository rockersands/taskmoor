import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { DomainListField } from './DomainListField';

/** The field keeps no list of its own; the story holds it like the provider form does. */
function Field({ initial = [], invalid = false }: { initial?: string[]; invalid?: boolean }) {
  const [domains, setDomains] = useState(initial);
  return (
    <form className="form" aria-label="Domains">
      <DomainListField domains={domains} onChange={setDomains} invalid={invalid} />
    </form>
  );
}

const meta = {
  title: 'Admin/DomainListField',
  component: Field,
  decorators: [
    (Story) => (
      <main style={{ padding: 24, maxWidth: 720 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof Field>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const WithDomains: Story = {
  args: { initial: ['corp.example', 'corp.example.org', 'a-much-longer-subsidiary-name.example'] },
};

export const AddingSeveral: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Domain'), 'corp.example, @Agency.Example{Enter}');
    await expect(canvas.getByRole('list', { name: 'Domains this provider serves' })).toBeVisible();
  },
};

export const NotADomain: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByLabelText('Domain'), 'corp_example{Enter}');
    await expect(await canvas.findByRole('alert')).toHaveTextContent('corp_example');
  },
};

export const Phone: Story = {
  args: { initial: ['corp.example', 'corp.example.org'] },
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};
