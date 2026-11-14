import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { PersonPicker, type PickedPerson } from './PersonPicker';

const PEOPLE: PickedPerson[] = [
  { id: 21, name: 'Sam Rivera' },
  { id: 22, name: 'Sasha Lee' },
  { id: 23, name: 'Robin Okafor' },
];
const search = async (typed: string) =>
  PEOPLE.filter((p) => p.name.toLowerCase().includes(typed.toLowerCase()));

const GROUPS: PickedPerson[] = [
  { id: 41, name: 'Operations' },
  { id: 42, name: 'Ops leads' },
];
const searchGroups = async (typed: string) =>
  GROUPS.filter((g) => g.name.toLowerCase().includes(typed.toLowerCase()));

const TEAMS: PickedPerson[] = [
  { id: 51, name: 'Payments' },
  { id: 52, name: 'Platform' },
];
const searchTeams = async (typed: string) =>
  TEAMS.filter((t) => t.name.toLowerCase().includes(typed.toLowerCase()));
const SEARCHES = { people: search, groups: searchGroups, teams: searchTeams };

function Picker({
  multiple = false,
  label,
  kind = 'people',
}: {
  multiple?: boolean;
  label: string;
  kind?: 'people' | 'groups' | 'teams';
}) {
  const [chosen, setChosen] = useState<PickedPerson[]>([]);
  return (
    <div style={{ maxWidth: '28rem' }}>
      <PersonPicker
        label={label}
        search={SEARCHES[kind]}
        chosen={chosen}
        onChange={setChosen}
        multiple={multiple}
        kind={kind}
      />
    </div>
  );
}

const meta = {
  title: 'Tickets/PersonPicker',
  component: Picker,
  args: { label: 'Assignee' },
} satisfies Meta<typeof Picker>;

export default meta;
type Story = StoryObj<typeof meta>;

/** One person: the search field gives way to the choice until it is removed. */
export const OnePerson: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('searchbox', { name: 'Assignee' }), 'sa');
    await expect(await canvas.findByText('2 people found')).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Sam Rivera' }));
    await expect(canvas.queryByRole('searchbox', { name: 'Assignee' })).toBeNull();
    await expect(canvas.getByRole('list', { name: 'Assignee' })).toHaveTextContent('Sam Rivera');
    await userEvent.click(canvas.getByRole('button', { name: 'Remove Sam Rivera' }));
    await expect(canvas.getByRole('searchbox', { name: 'Assignee' })).toBeVisible();
  },
};

/** Several people, for a custom person field that holds several. */
export const SeveralPeople: Story = {
  args: { multiple: true, label: 'Reviewers' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const field = canvas.getByRole('searchbox', { name: 'Reviewers' });
    await userEvent.type(field, 'sa');
    await userEvent.click(await canvas.findByRole('button', { name: 'Sam Rivera' }));
    await userEvent.type(field, 'sa');
    // Those already chosen are not offered again.
    await expect(await canvas.findByText('1 person found')).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Sasha Lee' }));
    await expect(canvas.getByRole('button', { name: 'Remove Sasha Lee' })).toBeVisible();
  },
};

export const NoOneMatches: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('searchbox', { name: 'Assignee' }), 'zz');
    await expect(await canvas.findByText('No one matches.')).toBeInTheDocument();
  },
};

/** Groups, for a custom group field (T-265): the same picker, speaking of groups. */
export const SeveralGroups: Story = {
  args: { multiple: true, label: 'Owning groups', kind: 'groups' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const field = canvas.getByRole('searchbox', { name: 'Owning groups' });
    await expect(field).toHaveAccessibleDescription('Type a name to find a group.');
    await userEvent.type(field, 'op');
    await expect(await canvas.findByText('2 groups found')).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Ops leads' }));
    await userEvent.type(field, 'zz');
    await expect(await canvas.findByText('No group matches.')).toBeInTheDocument();
  },
};

/** A team, for a custom team field (T-276): found by name, as a site can have many. */
export const OneTeam: Story = {
  args: { label: 'Team', kind: 'teams' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const field = canvas.getByRole('searchbox', { name: 'Team' });
    await expect(field).toHaveAccessibleDescription('Type a name to find a team.');
    await userEvent.type(field, 'zz');
    await expect(await canvas.findByText('No team matches.')).toBeInTheDocument();
    await userEvent.clear(field);
    await userEvent.type(field, 'p');
    await expect(await canvas.findByText('2 teams found')).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Payments' }));
    await expect(canvas.getByRole('list', { name: 'Team' })).toHaveTextContent('Payments');
  },
};
