import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { IconSelect } from './IconSelect';
import { PriorityGlyph, PriorityIcon, TypeGlyph, TypeIcon } from './TicketIcons';

const TYPES: [string, string | null][] = [
  ['Outcome', 'outcome'],
  ['Feature', 'feature'],
  ['Bug', 'bug'],
  ['Chore', 'chore'],
  ['To-do', 'to-do'],
  ['Idea', 'idea'],
  ['Subticket', 'subticket'],
  ['Spike (a custom type)', null],
];

/** The six levels a priority list of any length is stretched over. */
const LEVELS: [string, number][] = [
  ['Urgent', 1],
  ['Level 2', 2],
  ['Level 3', 3],
  ['Level 4', 4],
  ['Level 5', 5],
  ['Very low', 6],
];

function Icons() {
  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <ul
        style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-4)', margin: 0, padding: 0 }}
      >
        {TYPES.map(([name, icon]) => (
          <li key={name} style={{ display: 'flex', gap: 'var(--space-2)', listStyle: 'none' }}>
            <TypeIcon name={name} icon={icon} />
            <span>{name}</span>
          </li>
        ))}
      </ul>
      <ul
        style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-4)', margin: 0, padding: 0 }}
      >
        {LEVELS.map(([name, level]) => (
          <li key={name} style={{ display: 'flex', gap: 'var(--space-2)', listStyle: 'none' }}>
            <PriorityIcon name={name} level={level} />
            <span>{name}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const meta = { title: 'Shell/Ticket icons', component: Icons } satisfies Meta<typeof Icons>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AllOfThem: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('img', { name: 'Bug' })).toHaveAttribute('title', 'Bug');
    await expect(canvas.getAllByRole('img')).toHaveLength(14);
  },
};

function Pickers() {
  const [priority, setPriority] = useState('4');
  const [type, setType] = useState('Bug');
  return (
    <div style={{ display: 'grid', gap: 'var(--space-3)', minHeight: '22rem' }}>
      <div className="form-field">
        <label htmlFor="story-priority" className="form-label">
          Priority
        </label>
        <IconSelect
          id="story-priority"
          value={priority}
          options={LEVELS.map(([label, level]) => ({
            value: String(level),
            label,
            icon: <PriorityGlyph level={level} />,
          }))}
          onChange={setPriority}
        />
      </div>
      <div className="form-field">
        <label htmlFor="story-type" className="form-label">
          Ticket type
        </label>
        <IconSelect
          id="story-type"
          value={type}
          options={TYPES.map(([label, icon]) => ({
            value: label,
            label,
            icon: <TypeGlyph name={label} icon={icon} />,
          }))}
          onChange={setType}
        />
      </div>
    </div>
  );
}

export const Choosing: Story = {
  render: () => <Pickers />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const box = canvas.getByRole('combobox', { name: 'Ticket type' });
    await userEvent.click(box);
    await expect(canvas.getByRole('option', { name: 'Bug' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  },
};
