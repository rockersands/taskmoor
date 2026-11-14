import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { onARealTouchScreen, tooSmallForAFinger } from '../../test/touch';
import {
  fakeTemplateClient,
  HOTFIX_TEMPLATE,
  PEOPLE_TEMPLATE,
  RELEASE_TEMPLATE,
  RESTRICTED_RULES,
  TEMPLATE_OPTIONS,
} from './fixtures';
import { TemplateForm } from './TemplateForm';

const meta = {
  title: 'Tickets/TemplateForm',
  component: TemplateForm,
  args: {
    client: fakeTemplateClient(),
    track: 'SHOP',
    options: TEMPLATE_OPTIONS,
    template: null,
    onSaved: () => {},
    onCancel: () => {},
  },
  decorators: [
    (Story) => (
      <main style={{ padding: 24 }}>
        <Story />
      </main>
    ),
  ],
} satisfies Meta<typeof TemplateForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const NewTemplate: Story = {};

export const Editing: Story = { args: { template: RELEASE_TEMPLATE } };

/** Custom release and area values by name, an archived one marked, each with Remove (T-291). */
export const ReleaseAndAreaValues: Story = {
  args: { template: HOTFIX_TEMPLATE, client: fakeTemplateClient([HOTFIX_TEMPLATE]) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const fixedIn = canvas.getByRole('list', { name: 'Fixed in' });
    await expect(within(fixedIn).getByText('0.9 (archived)')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Remove Checkout from Owning area' }));
    await expect(canvas.getByText('None: saving leaves this field empty.')).toHaveFocus();
  },
};

/** A refused save: each reason under its value, the line above the buttons says so (T-291). */
export const Refused: Story = {
  args: {
    template: HOTFIX_TEMPLATE,
    client: fakeTemplateClient([HOTFIX_TEMPLATE], {
      refuse: {
        'defaults.targetReleaseIds.0': 'archived',
        'defaults.fields.12': 'not_in_track',
        'defaults.priorityId': 'not_found',
      },
    }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole('button', { name: 'Save the template' }));
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      'Some values cannot be used. The reason is under each of them.',
    );
    await expect(
      canvas.getByRole('listbox', { name: 'Target releases' }),
    ).toHaveAccessibleDescription('This release or area is archived. Choose another.');
  },
};

export const RefusedOnAPhone: Story = {
  ...Refused,
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

/** A custom release or area value added from the track's open ones, as the create form offers them (T-299). */
export const AddingReleaseAndAreaValues: Story = {
  args: { template: HOTFIX_TEMPLATE, client: fakeTemplateClient([HOTFIX_TEMPLATE]) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.selectOptions(
      canvas.getByRole('combobox', { name: 'Release to add to Fixed in' }),
      '1.1',
    );
    await userEvent.click(canvas.getByRole('button', { name: 'Add to Fixed in' }));
    await expect(canvas.getByRole('button', { name: 'Remove 1.1 from Fixed in' })).toHaveFocus();
    await userEvent.click(canvas.getByRole('button', { name: 'Remove Checkout from Owning area' }));
    await expect(
      canvas.getByRole('combobox', { name: 'Area to add to Owning area' }),
    ).toBeVisible();
  },
};

/** Custom person, group and team values by name, one hidden or gone by its number (T-299). */
export const PeopleGroupsAndTeams: Story = {
  args: { template: PEOPLE_TEMPLATE, client: fakeTemplateClient([PEOPLE_TEMPLATE]) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const owners = await canvas.findByRole('list', { name: 'Owners' });
    await expect(within(owners).getByText('Group 52, hidden from you or gone')).toBeVisible();
    await expect(canvas.getByText('Checkout squad')).toBeVisible();
  },
};

/** Editing a refused value takes its reason away; the others keep theirs (T-299). */
export const RefusedThenEdited: Story = {
  ...Refused,
  play: async (context) => {
    await Refused.play?.(context);
    const canvas = within(context.canvasElement);
    const target = canvas.getByRole('listbox', { name: 'Target releases' });
    await userEvent.deselectOptions(target, '0.9 (archived)');
    await expect(target).not.toHaveAttribute('aria-invalid');
    await expect(canvas.getByRole('combobox', { name: 'Priority' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  },
};

/** A finger reaches each value's Remove and the lists to add from (ADR-033, T-299). */
export const ValuesOnATouchScreen: Story = {
  args: { template: HOTFIX_TEMPLATE, client: fakeTemplateClient([HOTFIX_TEMPLATE]) },
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('combobox', { name: 'Release to add to Fixed in' });
    await expect(
      tooSmallForAFinger(canvasElement, [
        '.ticket-template-values button',
        '.ticket-template-row select',
        '.ticket-template-row button',
      ]),
    ).toEqual([]);
  },
};

/** At a phone's width, the lists to add from and the named values stay inside the form (T-299). */
export const PeopleOnAPhone: Story = {
  ...PeopleGroupsAndTeams,
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async (context) => {
    await PeopleGroupsAndTeams.play?.(context);
    const form = within(context.canvasElement).getByRole('form');
    const edge = form.getBoundingClientRect().right;
    const out = [...form.querySelectorAll('*')]
      .filter((el) => el.getBoundingClientRect().right > edge + 0.5)
      .map((el) => `${el.tagName}.${el.className} ${el.getBoundingClientRect().right - edge}`);
    await expect(out).toEqual([]);
    const page = document.documentElement;
    await expect(page.scrollWidth).toBeLessThanOrEqual(page.clientWidth);
  },
};

/** Nothing in a form reaches past its right edge, and the page does not scroll sideways. */
async function staysInside(canvasElement: HTMLElement) {
  const form = within(canvasElement).getByRole('form');
  const edge = form.getBoundingClientRect().right;
  const out = [...form.querySelectorAll('*')]
    .filter((el) => el.getBoundingClientRect().right > edge + 0.5)
    .map((el) => `${el.tagName}.${el.className} ${el.getBoundingClientRect().right - edge}`);
  await expect(out).toEqual([]);
  const page = document.documentElement;
  await expect(page.scrollWidth).toBeLessThanOrEqual(page.clientWidth);
}

/**
 * A person, group and team found with the create form's searches and added (T-350): a field
 * that holds one offers its search once its value is removed; one that holds several keeps it.
 */
export const AddingPeopleGroupsAndTeams: Story = {
  args: { template: PEOPLE_TEMPLATE, client: fakeTemplateClient([PEOPLE_TEMPLATE]) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Remove Sam Rivera from Reviewer' }),
    );
    await userEvent.type(
      canvas.getByRole('searchbox', { name: 'Person to add to Reviewer' }),
      'an',
    );
    await userEvent.click(await canvas.findByRole('button', { name: 'Ana Ortiz' }));
    await expect(
      canvas.getByRole('button', { name: 'Remove Ana Ortiz from Reviewer' }),
    ).toHaveFocus();
    const groups = canvas.getByRole('searchbox', { name: 'Group to add to Owners' });
    await userEvent.type(groups, 's');
    await expect(await canvas.findByRole('button', { name: 'Design' })).toBeVisible();
    await expect(await canvas.findByRole('button', { name: 'Sales' })).toBeVisible();
  },
};

/** A person field that allows only some people offers those it allows for every type (T-350). */
export const RestrictedPersonField: Story = {
  args: {
    template: { ...PEOPLE_TEMPLATE, ticketTypeIds: [3, 4] },
    client: fakeTemplateClient([PEOPLE_TEMPLATE], { rules: { '14': RESTRICTED_RULES } }),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      await canvas.findByRole('button', { name: 'Remove Sam Rivera from Reviewer' }),
    );
    const search = canvas.getByRole('searchbox', { name: 'Person to add to Reviewer' });
    await expect(search).toHaveAccessibleDescription(
      'Type a name. Only the people this field allows are offered.',
    );
    await userEvent.type(search, 'a');
    await expect(await canvas.findByRole('button', { name: 'Ana Ortiz' })).toBeVisible();
    await expect(canvas.queryByRole('button', { name: 'Lee Park' })).toBeNull();
  },
};

/** At a phone's width, the searches and what they find stay inside the form (T-350). */
export const AddingOnAPhone: Story = {
  ...AddingPeopleGroupsAndTeams,
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  play: async (context) => {
    await AddingPeopleGroupsAndTeams.play?.(context);
    await staysInside(context.canvasElement);
  },
};

/** A finger reaches the search fields and each person, group or team found (ADR-033, T-350). */
export const FindingOnATouchScreen: Story = {
  args: { template: PEOPLE_TEMPLATE, client: fakeTemplateClient([PEOPLE_TEMPLATE]) },
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      await canvas.findByRole('searchbox', { name: 'Group to add to Owners' }),
      's',
    );
    await canvas.findByRole('button', { name: 'Sales' });
    await waitFor(() =>
      expect(
        tooSmallForAFinger(canvasElement, [
          '.ticket-template-find input',
          '.ticket-template-find .person-picker-found button',
          '.ticket-template-values button',
        ]),
      ).toEqual([]),
    );
  },
};
