import type { Meta, StoryObj } from '@storybook/react-vite';
import { type ReactElement, useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { BoardPeopleFilter, type BoardPeopleFilterProps } from './BoardPeopleFilter';

const PEOPLE: BoardPeopleFilterProps['people'] = {
  viewerId: 5,
  assignees: [
    { id: 5, name: 'Kalo Smith' },
    { id: 6, name: 'Rin Okafor' },
    { id: 7, name: 'Tomás Herrera' },
  ],
  unassigned: true,
  more: false,
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

/** Holds the choices, as the board does in its address. */
function Live(props: Pick<BoardPeopleFilterProps, 'people' | 'chosen'>) {
  const [chosen, setChosen] = useState<string[]>([...props.chosen]);
  return <BoardPeopleFilter people={props.people} chosen={chosen} onChange={setChosen} />;
}

const meta = {
  title: 'Boards/BoardPeopleFilter',
  component: Live,
  args: { people: PEOPLE, chosen: [] },
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

/** Nothing chosen: every card shows. */
export const Nobody: Story = {};

/** A shared link: Me, a person, and someone with no tickets the viewer can see here. */
export const SharedLink: Story = {
  args: { chosen: ['me', '6', '999'] },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole('button', { name: 'Me', pressed: true })).toBeVisible();
    await expect(canvas.getByRole('button', { name: 'Rin Okafor', pressed: true })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Clear people' }));
    await expect(canvas.getByRole('button', { name: 'Me', pressed: false })).toBeVisible();
  },
};

/** A long list with its menu open: a box finds a name, and the list scrolls inside itself. */
export const ManyPeople: Story = {
  args: {
    people: {
      ...PEOPLE,
      assignees: Array.from({ length: 30 }, (_, i) => ({ id: 100 + i, name: `Person ${i + 1}` })),
      more: true,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText('People'));
    await userEvent.type(canvas.getByRole('searchbox', { name: 'Find a person' }), 'person 2');
    await expect(canvas.getByRole('checkbox', { name: 'Person 20' })).toBeVisible();
  },
};

/** The only person assigned is the viewer: the menu says there is nobody else. */
export const OnlyMe: Story = {
  args: { people: { ...PEOPLE, assignees: [{ id: 5, name: 'Kalo Smith' }] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText('People'));
    await expect(
      canvas.getByText('Nobody else is assigned to tickets on this board.'),
    ).toBeVisible();
  },
};

/** The whole filter with its menu open at the width of a small phone (ADR-033). */
export const PhoneWidth: Story = {
  args: { chosen: ['me', 'none', '6', '7', '999'] },
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByText(/^People/));
    await expect(canvas.getByRole('checkbox', { name: 'Rin Okafor' })).toBeVisible();
    await fitsPhoneWidth(canvas);
  },
};
