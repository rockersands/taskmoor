import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { CONFIG_ADMIN, MEMBER, TRACK_ADMIN } from '../admin/fixtures';
import { type Session, SessionProvider } from '../session/SessionProvider';
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
