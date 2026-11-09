import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { asOnATouchScreen, tooSmallForAFinger } from '../test/touch';
import type { PlanDuplicated } from './client';
import { DuplicatePlanDialog } from './DuplicatePlanDialog';
import { fakePlanClient } from './fixtures';

const copied = async (hiddenSources: number): Promise<PlanDuplicated> => ({
  ok: true,
  plan: { ...(await fakePlanClient().get(12)), id: 99, name: 'Copy of Spring launch' },
  left: { hiddenSources },
});

/** Copying a plan (PLN-014): a name, and what comes and what does not. */
const meta = {
  title: 'Plans/DuplicatePlanDialog',
  component: DuplicatePlanDialog,
  args: {
    name: 'Spring launch',
    hiddenSources: 0,
    onDuplicate: fn(() => copied(0)),
    onOpen: fn(),
    onClose: fn(),
  },
} satisfies Meta<typeof DuplicatePlanDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Asks: Story = {
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await expect(
      await page.findByRole('dialog', { name: 'Duplicate Spring launch' }),
    ).toBeVisible();
    await expect(page.getByLabelText('Name')).toHaveValue('Copy of Spring launch');
  },
};

/** Sources hidden from the person: how many stay behind, said before and after, never which. */
export const SourcesStayBehind: Story = {
  args: { hiddenSources: 2, onDuplicate: fn(() => copied(2)) },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await expect(await page.findByText('2 sources hidden from you stay behind.')).toBeVisible();
    await userEvent.click(page.getByRole('button', { name: 'Duplicate' }));
    await expect(await page.findByRole('heading', { name: 'Plan copied' })).toBeVisible();
    await expect(page.getByText('2 sources you may not see were left out.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Open the copy' })).toBeVisible();
  },
};

export const Refused: Story = {
  args: {
    onDuplicate: fn(
      async (): Promise<PlanDuplicated> => ({ ok: false, error: 'not_found', fields: {} }),
    ),
  },
  play: async ({ canvasElement }) => {
    const page = within(canvasElement.ownerDocument.body);
    await userEvent.click(await page.findByRole('button', { name: 'Duplicate' }));
    await expect(await page.findByRole('alert')).toHaveTextContent('could not be copied');
  },
};

/** A finger reaches its field and buttons (ADR-033). */
export const OnATouchScreen: Story = {
  beforeEach: asOnATouchScreen,
  play: async ({ canvasElement }) => {
    const body = canvasElement.ownerDocument.body;
    await within(body).findByRole('dialog', { name: 'Duplicate Spring launch' });
    await expect(
      tooSmallForAFinger(body, ['.plan-duplicate-dialog input', '.plan-duplicate-dialog button']),
    ).toEqual([]);
  },
};
