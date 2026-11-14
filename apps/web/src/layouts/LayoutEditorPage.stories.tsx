import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { CONFIG_ADMIN, MEMBER, TRACK_ADMIN } from '../admin/fixtures';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { gripsTooSmall, onARealTouchScreen } from '../test/touch';
import { fakeLayoutsClient, layoutSetsFixture } from './fixtures';
import { LayoutEditorPage } from './LayoutEditorPage';

const meta = {
  title: 'Admin/LayoutEditor',
  component: LayoutEditorPage,
  args: { client: fakeLayoutsClient(), previewDelay: 0 },
  decorators: [
    (Story, context) => (
      <SessionProvider session={(context.parameters.session as Session) ?? CONFIG_ADMIN}>
        <main style={{ padding: 24 }}>
          <Story />
        </main>
      </SessionProvider>
    ),
  ],
} satisfies Meta<typeof LayoutEditorPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The default set: the create form for every ticket type, its fields in a main and a side
 * column, the fields not placed, and the preview with the field rules applied. A grip's menu is
 * open, so its moves are checked too.
 */
export const DefaultSet: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Preview of the create form for Feature')).toBeVisible();
    await userEvent.click(canvas.getByRole('button', { name: 'Move Priority' }));
    await expect(
      canvas.getByRole('menuitem', { name: 'Move to Details, section 2: side column' }),
    ).toBeVisible();
  },
};

/**
 * At a desktop's page width the preview's two selects stand side by side at one height (AD-37):
 * 'Fields and rules of' once sat lower, under the hint that now follows the row.
 */
export const PreviewChoicesInARow: Story = {
  decorators: [
    (Story) => (
      <div style={{ width: 640 }}>
        <Story />
      </div>
    ),
  ],
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('Preview of the create form for Feature')).toBeVisible();
    const type = canvas.getByRole('combobox', { name: 'Preview as' });
    const track = canvas.getByRole('combobox', { name: 'Fields and rules of' });
    await expect(Math.round(track.getBoundingClientRect().top)).toBe(
      Math.round(type.getBoundingClientRect().top),
    );
    await expect(track).toHaveDisplayValue('No particular track');
  },
};

/** The keyboard path: Alt and an arrow move a field one place, and the move is announced. */
export const MovedWithTheKeyboard: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const grip = await canvas.findByRole('button', { name: 'Move Summary' });
    grip.focus();
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    await expect(
      await canvas.findByText('Summary: place 2 of 3 in Details, section 1: main column.'),
    ).toBeInTheDocument();
    await expect(canvas.getByText('Unsaved changes')).toBeVisible();
  },
};

/** A set with no layouts yet: every form shows every field, and offers to make a layout. */
export const EmptySet: Story = { args: { initialSetId: 2 } };

/** No ticket type to preview: the preview says so as an empty state (T-289). */
export const NoTicketTypes: Story = {
  args: { client: { ...fakeLayoutsClient(), ticketTypes: async () => [] } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByText('There are no ticket types to preview.')).toHaveClass(
      'empty-state-title',
    );
  },
};

/** A local-mode track's own set: its own ticket type and field, previewed in that track. */
export const TrackOwnSet: Story = { args: { initialSetId: 5 } };

/** The preview could not be made: the layout can still be edited and saved. */
export const PreviewFails: Story = {
  args: { client: fakeLayoutsClient(undefined, { failPreview: true }) },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText('The preview could not be made. Try again in a moment.'),
    ).toBeVisible();
  },
};

/** A saved layout the server would now refuse: the preview says why, in the catalogue's words. */
export const PreviewRefuses: Story = {
  args: {
    client: fakeLayoutsClient(
      (() => {
        const sets = structuredClone(layoutSetsFixture());
        sets[0]?.layouts[0]?.definition.tabs[0]?.sections[1]?.fields.push('cf[99]');
        return sets;
      })(),
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByText('cf[99] no longer exists. Take it off the layout.'),
    ).toBeVisible();
  },
};

/** On a phone: everything in one column, nothing sideways. */
export const OnAPhone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

/** Someone who is neither a site nor a configuration administrator, and runs no track. */
export const NotAnAdministrator: Story = { parameters: { session: MEMBER } };

/**
 * Someone who runs OPS, a track with its own configuration, on its own page (T-163a): its own
 * sets only, previewed with its fields, rules and ticket types, and no choice of track.
 */
export const TrackAdministrator: Story = {
  args: { trackId: 4 },
  parameters: { session: TRACK_ADMIN },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByRole('form', { name: 'Layouts of Ops layouts' });
    const options = within(canvas.getByLabelText('Layout set')).getAllByRole('option');
    await expect(options.map((option) => option.textContent)).toEqual(['Ops layouts']);
    await expect(
      await canvas.findByText(
        'With the fields and rules of OPS · Operations, the track this set belongs to.',
      ),
    ).toBeVisible();
  },
};

/** The same on a phone: one column, nothing sideways. */
export const TrackAdministratorOnAPhone: Story = {
  ...TrackAdministrator,
  globals: { viewport: { value: 'mobile1', isRotated: false } },
};

/**
 * NFR-007, ADR-033: on a phone's touch screen the links inside the page's notes, 'Back to managing
 * OPS.' and the field rules of OPS, keep their line's height and reach a finger's 44 px above and
 * below it, as on Track people (T-226).
 */
export const TrackLinksOnATouchPhone: Story = {
  ...TrackAdministrator,
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const links = [
      await canvas.findByRole('link', { name: 'Back to managing OPS.' }),
      await canvas.findByRole('link', {
        name: 'The field rules of OPS are on its configuration sets.',
      }),
    ];
    for (const link of links) {
      const press = getComputedStyle(link, '::after');
      await expect(press.position).toBe('absolute');
      await expect(Number.parseFloat(press.height)).toBeGreaterThanOrEqual(44 - 0.5);
    }
    const page = canvasElement.ownerDocument.documentElement;
    await expect(page.scrollWidth).toBeLessThanOrEqual(page.clientWidth);
  },
};

/**
 * NFR-007, ADR-033: on a real touch screen at a desktop's width, every field's, section's and
 * tab's grip is a finger's size (T-231).
 */
export const GripsOnATouchScreen: Story = {
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    await expect(window.innerWidth).toBeGreaterThanOrEqual(768);
    await expect(await gripsTooSmall(canvasElement, ['.layout-grip-handle'])).toEqual([]);
  },
};

/** The same on a phone. */
export const GripsOnATouchPhone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  beforeEach: onARealTouchScreen,
  play: async ({ canvasElement }) => {
    await expect(window.innerWidth).toBeLessThan(768);
    await expect(await gripsTooSmall(canvasElement, ['.layout-grip-handle'])).toEqual([]);
  },
};

/** A set of the track's own that the track does not use yet: the page offers to use it. */
export const TrackSetNotUsedYet: Story = {
  args: {
    trackId: 4,
    client: fakeLayoutsClient(
      layoutSetsFixture().map((set) => (set.id === 5 ? { ...set, usedBy: [] } : set)),
    ),
  },
  parameters: { session: TRACK_ADMIN },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(await canvas.findByRole('button', { name: 'Use this set for OPS' })).toBeVisible();
  },
};

/** On the shared page, someone who runs tracks chooses one with its own configuration. */
export const TracksToChoose: Story = {
  parameters: { session: TRACK_ADMIN },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole('link', { name: 'Layout sets of OPS · Operations' }),
    ).toBeVisible();
  },
};

/** The page of a track the person does not run. */
export const NotTheirTrack: Story = {
  args: { trackId: 6 },
  parameters: { session: TRACK_ADMIN },
};
