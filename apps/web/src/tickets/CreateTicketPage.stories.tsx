import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { ApiError } from '../api/client';
import { onARealTouchScreen, tooSmallForAFinger } from '../test/touch';
import { type CreateClient, CreateTicketPage } from './CreateTicketPage';
import { BUG_FORM, CHORE_FORM, LOCKED_FORM, PRIORITIES, TRACKS, TYPES } from './fixtures';
import type { TicketForm } from './form';
import { fakePickerClient, RELEASE_TEMPLATE } from './templates/fixtures';

const PEOPLE = [
  { id: 21, name: 'Sam Rivera' },
  { id: 22, name: 'Sasha Lee' },
];

/** The chore form with the fields set by pickers (T-253): the assignee required. */
const PICKER_FORM: TicketForm = {
  ...CHORE_FORM,
  layout: {
    ...CHORE_FORM.layout,
    tabs: [
      {
        name: null,
        sections: [
          {
            kind: 'main',
            hideWhenEmpty: false,
            fields: [
              { key: 'summary', required: true, description: null },
              { key: 'parent', required: false, description: null },
              { key: 'cf[12]', required: false, description: null },
            ],
          },
          {
            kind: 'context',
            hideWhenEmpty: false,
            fields: [
              { key: 'assignee', required: true, description: null },
              { key: 'targetRelease', required: false, description: null },
              { key: 'area', required: false, description: null },
            ],
          },
        ],
      },
    ],
  },
  customFields: [{ id: 12, name: 'Reviewers', description: '', type: 'user', multiple: true }],
};

/**
 * The chore form with the fields T-265 made settable: the requester, a person field that allows
 * only some people, group, team, release and area fields; the team required.
 */
const MORE_PICKERS_FORM: TicketForm = {
  ...CHORE_FORM,
  layout: {
    ...CHORE_FORM.layout,
    tabs: [
      {
        name: null,
        sections: [
          {
            kind: 'main',
            hideWhenEmpty: false,
            fields: [
              { key: 'summary', required: true, description: null },
              { key: 'requester', required: false, description: null },
              { key: 'cf[20]', required: false, description: null },
              { key: 'cf[21]', required: false, description: null },
            ],
          },
          {
            kind: 'context',
            hideWhenEmpty: false,
            fields: [
              { key: 'cf[22]', required: true, description: null },
              { key: 'cf[23]', required: false, description: null },
              { key: 'cf[24]', required: false, description: null },
            ],
          },
        ],
      },
    ],
  },
  customFields: [
    { id: 20, name: 'Approver', description: '', type: 'user', multiple: false, restricted: true },
    { id: 21, name: 'Owning groups', description: '', type: 'group', multiple: true },
    { id: 22, name: 'Team', description: '', type: 'team', multiple: false },
    { id: 23, name: 'Fixed in', description: '', type: 'release', multiple: false },
    { id: 24, name: 'Parts', description: '', type: 'area', multiple: true },
  ],
};

const GROUPS = [
  { id: 41, name: 'Operations' },
  { id: 42, name: 'Ops leads' },
];
const TEAMS = [
  { id: 51, name: 'Payments' },
  { id: 52, name: 'Platform' },
];
const named = (list: { id: number; name: string }[], typed: string) =>
  list.filter((x) => x.name.toLowerCase().includes(typed.toLowerCase()));

/** A backend in memory: Bugs need a due date and a severity, as the form says. */
function fakeClient(overrides: Partial<CreateClient> = {}): CreateClient {
  let number = 0;
  return {
    tracks: async () => TRACKS,
    ticketTypes: async () => ({ defaultTypeId: 3, types: TYPES }),
    form: async (_track, typeId) => (typeId === 3 ? BUG_FORM : CHORE_FORM),
    priorities: async () => PRIORITIES,
    assignable: async () => PEOPLE,
    people: async () => PEOPLE,
    tickets: async () => [{ id: 40, key: 'SHOP-4', summary: 'Payments', status: { name: 'Open' } }],
    releases: async () => [
      { id: 5, name: 'Spring' },
      { id: 6, name: 'Summer' },
    ],
    areas: async () => [{ id: 7, name: 'Checkout' }],
    // Only Sasha may approve (CORE-009 (2)).
    fieldPeople: async () => PEOPLE.filter((p) => p.id === 22),
    groups: async (_field, typed) => named(GROUPS, typed),
    teams: async (typed) => named(TEAMS, typed),
    create: async (body) => {
      const missing: Record<string, string> = {};
      if (body.ticketTypeId === 3 && !body.dueDate) missing.dueDate = 'required';
      if (body.ticketTypeId === 3 && !(body.fields as Record<string, unknown> | undefined)?.[7]) {
        missing['fields.7'] = 'required';
      }
      if (Object.keys(missing).length > 0) {
        throw new ApiError(400, { error: 'invalid_fields', fields: missing });
      }
      number += 1;
      return { key: `SHOP-${number}` };
    },
    ...overrides,
  };
}

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
  title: 'Tickets/CreateTicketPage',
  component: CreateTicketPage,
  args: { client: fakeClient() },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof CreateTicketPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The form on its page: a title, what it is for, and the fields on a slab of glass. */
export const BugForm: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('heading', { level: 1 })).toBeVisible();
    await expect(canvasElement.querySelector('.page-purpose')).not.toBeNull();
  },
};

export const AtPhoneWidth: Story = {
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('heading', { level: 1 });
    await fitsPhoneWidth(canvas);
  },
};

/** Submitting without the required fields puts the refusals at each of them. */
export const WithRefusals: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByLabelText('Summary (required)'), 'Checkout fails');
    await userEvent.click(canvas.getByRole('button', { name: 'Create' }));
    await expect(await canvas.findAllByText('This field is required.')).toHaveLength(2);
  },
};

export const ChoreForm: Story = {
  args: { client: fakeClient({ ticketTypes: async () => ({ defaultTypeId: 4, types: TYPES }) }) },
};

/** Fields only some may set (M1-029): shown read-only, each with the reason. */
export const LockedFields: Story = {
  args: {
    client: fakeClient({
      ticketTypes: async () => ({ defaultTypeId: 4, types: TYPES }),
      form: async () => LOCKED_FORM,
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const due = await canvas.findByLabelText('Due date');
    await expect(due).toBeDisabled();
    await expect(due).toHaveAccessibleDescription('Only the Approvers group can set this field.');
    await expect(canvas.getByLabelText('Labels')).toBeDisabled();
    await expect(canvas.getByLabelText('Summary (required)')).toBeEnabled();
  },
};

const pickerClient = () =>
  fakeClient({
    ticketTypes: async () => ({ defaultTypeId: 4, types: TYPES }),
    form: async () => PICKER_FORM,
  });

/** People, the parent, releases and areas chosen with pickers; the assignee is required (T-253). */
export const WithPickers: Story = {
  args: { client: pickerClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByLabelText('Summary (required)'), 'Card declined');
    await userEvent.type(canvas.getByRole('searchbox', { name: 'Assignee (required)' }), 'sa');
    await userEvent.click(await canvas.findByRole('button', { name: 'Sam Rivera' }));
    await userEvent.click(await canvas.findByRole('checkbox', { name: 'Summer' }));
    await userEvent.click(await canvas.findByRole('checkbox', { name: 'Checkout' }));
    await userEvent.type(canvas.getByRole('combobox', { name: 'Parent' }), 'pay');
    await userEvent.click(await canvas.findByRole('option', { name: /SHOP-4/ }));
    await expect(canvas.getByRole('button', { name: 'Remove SHOP-4 as parent' })).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Create' }));
    await expect(await canvas.findByText('SHOP-1 was created.')).toBeVisible();
  },
};

export const WithPickersAtPhoneWidth: Story = {
  args: { client: pickerClient() },
  decorators: [atPhoneWidth],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      await canvas.findByRole('searchbox', { name: 'Assignee (required)' }),
      'sa',
    );
    await canvas.findByRole('button', { name: 'Sasha Lee' });
    await fitsPhoneWidth(canvas);
  },
};

const morePickersClient = () =>
  fakeClient({
    ticketTypes: async () => ({ defaultTypeId: 4, types: TYPES }),
    form: async () => MORE_PICKERS_FORM,
  });

/**
 * The requester, a person field that allows only some, groups, a team, a release and areas, each
 * with its picker (T-265).
 */
export const WithMorePickers: Story = {
  args: { client: morePickersClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByLabelText('Summary (required)'), 'Refund');
    await userEvent.type(canvas.getByRole('searchbox', { name: 'Requester' }), 'sa');
    await userEvent.click(await canvas.findByRole('button', { name: 'Sam Rivera' }));
    await userEvent.type(canvas.getByRole('searchbox', { name: 'Approver' }), 'sa');
    await expect(await canvas.findByText('1 person found')).toBeInTheDocument();
    await userEvent.click(canvas.getByRole('button', { name: 'Sasha Lee' }));
    await userEvent.type(canvas.getByRole('searchbox', { name: 'Owning groups' }), 'op');
    await userEvent.click(await canvas.findByRole('button', { name: 'Ops leads' }));
    // Teams are found by name (T-276).
    await userEvent.type(canvas.getByRole('searchbox', { name: 'Team (required)' }), 'pay');
    await userEvent.click(await canvas.findByRole('button', { name: 'Payments' }));
    await canvas.findByRole('option', { name: 'Spring' });
    await userEvent.selectOptions(canvas.getByRole('combobox', { name: 'Fixed in' }), 'Spring');
    await userEvent.click(await canvas.findByRole('checkbox', { name: 'Checkout' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Create' }));
    await expect(await canvas.findByText('SHOP-1 was created.')).toBeVisible();
  },
};

/** The same on a phone's touch screen: every picker a finger's size, nothing sideways. */
export const WithMorePickersOnAPhone: Story = {
  args: { client: morePickersClient() },
  decorators: [atPhoneWidth],
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(await canvas.findByRole('searchbox', { name: 'Owning groups' }), 'op');
    await canvas.findByRole('button', { name: 'Operations' });
    await userEvent.type(canvas.getByRole('searchbox', { name: 'Team (required)' }), 'p');
    await canvas.findByRole('button', { name: 'Platform' });
    await canvas.findByRole('option', { name: 'Spring' });
    await canvas.findByRole('checkbox', { name: 'Checkout' });
    await expect(
      tooSmallForAFinger(canvasElement, [
        '.person-picker input[type="search"]',
        '.person-picker-found button',
        '.create-field select',
        '.create-choice',
      ]),
    ).toEqual([]);
    await fitsPhoneWidth(canvas);
  },
};

/**
 * A ticket template's custom person, group, team, release and area values, in the pickers
 * (T-276): a value chosen there wins. The second approver is no one this person may see, so the
 * template start gave no name: that field stays under 'Also from this template'.
 */
const templateClient = () =>
  fakeClient({
    ticketTypes: async () => ({ defaultTypeId: 4, types: TYPES }),
    form: async () => ({
      ...MORE_PICKERS_FORM,
      customFields: MORE_PICKERS_FORM.customFields.map((f) =>
        f.id === 20 ? { ...f, restricted: false, multiple: true } : f,
      ),
    }),
    ticketTemplates: fakePickerClient(
      [{ ...RELEASE_TEMPLATE, ticketTypeIds: [], subtickets: [] }],
      {
        summary: 'Release SHOP 2026-11-03',
        fields: { 20: [21, 99], 21: [41], 22: 51, 23: 5, 24: [7] },
      },
      {},
      {
        'fields.20': [{ id: 21, name: 'Sam Rivera' }],
        'fields.21': [{ id: 41, name: 'Operations' }],
        'fields.22': [{ id: 51, name: 'Payments' }],
      },
    ),
  });

export const FromATemplate: Story = {
  args: { client: templateClient() },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('option', { name: 'Spring' });
    await userEvent.selectOptions(
      await canvas.findByRole('combobox', { name: 'Start from a template' }),
      'Release checklist',
    );
    await expect(await canvas.findByRole('list', { name: 'Owning groups' })).toHaveTextContent(
      'Operations',
    );
    await expect(canvas.getByRole('list', { name: 'Team (required)' })).toHaveTextContent(
      'Payments',
    );
    await expect(canvas.getByRole('combobox', { name: 'Fixed in' })).toHaveValue('5');
    await expect(canvas.getByRole('checkbox', { name: 'Checkout' })).toBeChecked();
    const also = canvas.getByRole('group', { name: 'Also from this template' });
    await expect(within(also).getByRole('checkbox', { name: 'Approver' })).toBeChecked();
    await userEvent.click(canvas.getByRole('button', { name: 'Remove Payments' }));
    await userEvent.type(canvas.getByRole('searchbox', { name: 'Team (required)' }), 'plat');
    await userEvent.click(await canvas.findByRole('button', { name: 'Platform' }));
    await userEvent.click(canvas.getByRole('button', { name: 'Create' }));
    await expect(await canvas.findByText('SHOP-9 was created.')).toBeVisible();
  },
};

/** The same on a phone's touch screen: the filled pickers a finger's size, nothing sideways. */
export const FromATemplateOnAPhone: Story = {
  args: { client: templateClient() },
  decorators: [atPhoneWidth],
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('option', { name: 'Spring' });
    await userEvent.selectOptions(
      await canvas.findByRole('combobox', { name: 'Start from a template' }),
      'Release checklist',
    );
    await canvas.findByRole('list', { name: 'Team (required)' });
    await expect(
      tooSmallForAFinger(canvasElement, [
        '.person-picker-chosen button',
        '.create-field select',
        '.create-choice',
        '.ticket-template-picker select',
      ]),
    ).toEqual([]);
    await fitsPhoneWidth(canvas);
  },
};

/** What the person may not set at create (IAM-010): left out, or kept with the reason if required. */
export const Withheld: Story = {
  args: {
    client: fakeClient({
      ticketTypes: async () => ({ defaultTypeId: 4, types: TYPES }),
      form: async () => ({ ...PICKER_FORM, withheld: ['assignee'] }),
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const assignee = await canvas.findByRole('group', { name: 'Assignee (required)' });
    await expect(assignee).toHaveAccessibleDescription(
      /^You may not set this field on a new ticket\./,
    );
  },
};

export const NoTracks: Story = {
  args: { client: fakeClient({ tracks: async () => [] }) },
};
