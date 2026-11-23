import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import { ESTIMATES, fakeGridClient } from './grid/clientFixtures';
import { DEFAULT_STRUCTURE, GRID_LIMITS } from './grid/types';
import { StructureDialog } from './StructureDialog';

const client = fakeGridClient();
const FIELDS = [
  { id: 40, name: 'Customer', type: 'text' },
  { id: 41, name: 'Points', type: 'number' },
  { id: 42, name: 'Team', type: 'select' },
];
const LIST = {
  plan: { id: 12, name: 'Spring launch' },
  structures: [],
  editable: true,
  default: DEFAULT_STRUCTURE,
  limits: GRID_LIMITS,
};

/**
 * Making or changing a structure of a plan's Grid (PLN-010; ADR-122 stage 10): its steps in the
 * order they apply, then its columns, each with its check in words.
 */
const meta = {
  title: 'Plans/StructureDialog',
  component: StructureDialog,
  args: {
    planId: 12,
    client,
    list: LIST,
    fields: FIELDS,
    structure: null,
    initial: DEFAULT_STRUCTURE,
    refusal: () => 'Refused',
    onDone: fn(),
    onClose: fn(),
  },
} satisfies Meta<typeof StructureDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

const dialogOf = async (canvas: HTMLElement) =>
  within(canvas.ownerDocument.body).findByRole('dialog');

/** A new structure from the default: Add tickets, Add children, its columns and totals. */
export const New: Story = {
  play: async ({ canvasElement }) => {
    const dialog = await dialogOf(canvasElement);
    await expect(within(dialog).getByRole('heading', { name: 'New structure' })).toBeVisible();
    await expect(within(dialog).getByLabelText('Add children, down every level')).toBeChecked();
    await expect(
      within(dialog).getByText('Counts the ticket rows below each row, at every depth.'),
    ).toBeVisible();
  },
};

/** Changing a saved one, with a formula that does not check said in the server's words. */
export const Edit: Story = {
  args: {
    structure: {
      id: 3,
      name: 'Estimates',
      spec: ESTIMATES,
      updatedAt: '2026-11-12T10:00:00Z',
      version: 1,
      broken: false,
    },
  },
  play: async ({ canvasElement }) => {
    const dialog = await dialogOf(canvasElement);
    const expression = within(dialog).getByLabelText('Formula of column 9');
    await userEvent.clear(expression);
    await userEvent.type(expression, 'sum(children.{{nope})');
    await userEvent.tab();
    await expect(
      await within(dialog).findByText('The formula does not check: No field is called nope'),
    ).toBeVisible();
  },
};

/** On a phone's touch screen: a sheet whose every control is a finger's size. */
export const OnAPhone: Story = {
  tags: ['touch'],
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const dialog = await dialogOf(canvasElement);
    await expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.clientWidth);
    await expect(
      tooSmallForAFinger(dialog, [
        '.form-actions button',
        'select',
        'input:not([type="checkbox"], [type="radio"])',
        '.form-field-inline label',
      ]),
    ).toEqual([]);
  },
};
