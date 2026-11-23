import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import {
  AskFirst,
  NewScenarioDialog,
  type NewScenarioDialogProps,
  RenameScenarioDialog,
} from './ScenarioDialogs';
import type { ScenarioRow } from './scenarioClient';

const FASTER: ScenarioRow = {
  id: 2,
  name: 'Faster',
  main: false,
  drafts: 8,
  notShown: 0,
  applying: false,
  createdBy: { id: 7, name: 'Ana Ruiz' },
  createdAt: '2026-11-01T09:00:00Z',
  updatedAt: '2026-11-01T09:00:00Z',
  version: 1,
};

/** A new scenario (ADR-122 stage 6): a name, and empty or a copy of another's drafts. */
const meta = {
  title: 'Plans/ScenarioDialogs',
  component: NewScenarioDialog,
  args: {
    scenarios: [{ ...FASTER, id: 1, name: 'Main plan', main: true, drafts: 12 }, FASTER],
    onCreate: fn<NewScenarioDialogProps['onCreate']>(async (name) => ({
      ok: true as const,
      value: { scenario: { ...FASTER, id: 4, name }, left: { notShown: 0 } },
    })),
    onMade: fn(),
    onClose: fn(),
  },
} satisfies Meta<typeof NewScenarioDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NewScenario: Story = {
  play: async ({ canvasElement, args }) => {
    const page = within(canvasElement.ownerDocument.body);
    const dialog = await page.findByRole('dialog', { name: 'New scenario' });
    await userEvent.type(within(dialog).getByLabelText('Name'), 'Slower');
    await userEvent.selectOptions(
      within(dialog).getByLabelText('Start from'),
      'A copy of Faster (8 changes)',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Make scenario' }));
    await expect(args.onCreate).toHaveBeenCalledWith('Slower', 2);
  },
};

/** A refusal said in words: the plan already has its 20 scenarios. */
export const TooMany: Story = {
  args: {
    onCreate: fn<NewScenarioDialogProps['onCreate']>(async () => ({
      ok: false,
      code: 'too_many_scenarios',
      fields: {},
    })),
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const dialog = await page.findByRole('dialog', { name: 'New scenario' });
    await userEvent.type(within(dialog).getByLabelText('Name'), 'One more');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Make scenario' }));
    await expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'as many scenarios as it may',
    );
  },
};

/** Renaming a scenario. */
export const Rename: Story = {
  render: () => (
    <RenameScenarioDialog
      scenario={FASTER}
      onRename={async (name) => ({ ok: true, value: { ...FASTER, name } })}
      onDone={() => {}}
      onClose={() => {}}
    />
  ),
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    const dialog = await page.findByRole('dialog', { name: 'Rename Faster' });
    await expect(within(dialog).getByLabelText('Name')).toHaveValue('Faster');
  },
};

/** Make main asks first, in its own place, focus on Cancel. */
export const MakeMainAsks: Story = {
  render: () => (
    <AskFirst
      label="Make Faster main"
      question="Faster’s 8 changes become the plan’s drafts to apply. Main plan keeps its 12 changes as a scenario."
      confirmLabel="Make Faster main"
      onConfirm={() => {}}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Make Faster main' }));
    const ask = canvas.getByRole('group', { name: /^Faster’s 8 changes become/ });
    await expect(within(ask).getByRole('button', { name: 'Cancel' })).toHaveFocus();
  },
};

/** On a touch screen the dialog's field and buttons take a finger (ADR-033). */
export const OnATouchScreen: Story = {
  tags: ['touch'],
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const body = canvasElement.ownerDocument.body;
    await within(body).findByRole('dialog', { name: 'New scenario' });
    await expect(
      tooSmallForAFinger(body, [
        '.scenario-dialog input',
        '.scenario-dialog select',
        '.scenario-dialog button',
      ]),
    ).toEqual([]);
  },
};
