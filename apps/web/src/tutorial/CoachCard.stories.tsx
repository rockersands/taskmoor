import type { Meta, StoryObj } from '@storybook/react-vite';
import { useId, useRef } from 'react';
import { expect, fn, waitFor, within } from 'storybook/test';
import { ModalDialog } from '../shell/ModalDialog';
import { CoachCard, PausedCoach, Spotlight } from './CoachCard';

const meta = {
  title: 'Tutorial/CoachCard',
  component: CoachCard,
  args: {
    sectionTitle: 'Dashboards',
    title: 'Make a dashboard',
    body: 'Type a name and choose Create dashboard. Only you see it until you share it.',
    index: 2,
    count: 6,
    waiting: true,
    goThere: null,
    made: null,
    focusKey: 0,
    onBack: fn(),
    onNext: fn(),
    onPause: fn(),
    onSkip: fn(),
  },
} satisfies Meta<typeof CoachCard>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A step that waits for the person: it moves on by itself once they have done it (ADR-115). */
export const Waiting: Story = {};

/** Away from the step's page: the card offers the way there. */
export const Away: Story = { args: { goThere: '#/dashboards' } };

/** The first step: what the section makes, and that it is real. */
export const First: Story = {
  args: {
    title: 'Dashboards',
    body: 'A dashboard puts the lists and numbers you check often on one page. You will make one and add a widget. It is real and stays on this site.',
    index: 0,
    waiting: false,
  },
};

/** The last step: Finish, and the page of what was made, to keep it or delete it. */
export const Last: Story = {
  args: {
    title: 'Your dashboard is ready',
    body: 'It stays on this site. On its page you can share it, show it as a wallboard or delete it.',
    index: 5,
    waiting: false,
    made: '#/dashboards/7',
  },
};

/** Over a page: the ring around the control to use, the rest dimmed but usable. */
export const OverAPage: Story = {
  render: (args) => {
    const card = useRef<HTMLDivElement | null>(null);
    return (
      <main style={{ padding: 32 }}>
        <h1>Dashboards</h1>
        <form data-tutorial="dashboard-new" style={{ display: 'flex', gap: 8, maxWidth: 420 }}>
          <label>
            Name <input />
          </label>
          <button type="button" className="button-primary">
            Create dashboard
          </button>
        </form>
        <Spotlight target="dashboard-new" card={card} />
        <CoachCard {...args} cardRef={card} />
      </main>
    );
  },
};

/** Paused: the place kept, one press from going on. */
export const Paused: Story = {
  render: () => (
    <PausedCoach sectionTitle="Dashboards" index={2} count={6} onResume={fn()} onClose={fn()} />
  ),
};

const FIELDS = ['Track', 'Type', 'Summary', 'Description', 'Labels', 'Priority', 'Assignee', 'Due'];

/**
 * A dialog over the page that scrolls inside itself, ending in its button: the create dialog's
 * sheet, or with `popup` the ticket pop-up's.
 */
function Sheet({
  popup = false,
  title,
  button,
}: {
  popup?: boolean;
  title: string;
  button: string;
}) {
  const id = useId();
  const form = (
    <form className="form" data-tutorial="create-ticket-form" onSubmit={(e) => e.preventDefault()}>
      {FIELDS.map((label) => (
        <div key={label} className="form-field">
          <label>
            {label} <input />
          </label>
        </div>
      ))}
      <button type="submit" className="button-primary">
        {button}
      </button>
    </form>
  );
  if (popup) {
    return (
      <ModalDialog onClose={() => {}} labelledBy={id} closeLabel="Close" className="ticket-popup">
        <div className="ticket-popup-body">
          <h2 id={id}>{title}</h2>
          {form}
        </div>
      </ModalDialog>
    );
  }
  return (
    <ModalDialog onClose={() => {}} labelledBy={id} closeLabel="Close">
      <h2 id={id}>{title}</h2>
      {form}
    </ModalDialog>
  );
}

/** What TutorialCoach marks while the card or the paused panel is docked; cleared afterwards. */
const docked = (state: 'open' | 'paused') => () => {
  document.documentElement.dataset.coach = state;
  return () => {
    delete document.documentElement.dataset.coach;
    document.documentElement.style.removeProperty('--coach-space');
  };
};

/** Scrolled to its end, the sheet's last button sits above what is docked at the bottom. */
async function lastButtonClears(
  canvasElement: HTMLElement,
  sheetName: string,
  buttonName: string,
  dock: () => HTMLElement,
) {
  const body = within(canvasElement.ownerDocument.body);
  const sheet = await body.findByRole('dialog', { name: sheetName });
  const last = within(sheet).getByRole('button', { name: buttonName });
  await waitFor(() => {
    expect(document.documentElement.style.getPropertyValue('--coach-space')).not.toBe('');
    sheet.scrollTop = sheet.scrollHeight;
    expect(last.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      dock().getBoundingClientRect().top,
    );
  });
}

/**
 * A phone, the card docked over the create dialog's full-screen sheet: the sheet keeps room at its
 * end, so its last control scrolls above the card (AGL-025).
 */
export const OverASheetOnAPhone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  args: {
    title: 'Fill in the ticket',
    body: 'Give it a summary and choose Create. It goes in the track you picked.',
    index: 4,
    count: 9,
    sectionTitle: 'Tracks and tickets',
  },
  beforeEach: docked('open'),
  render: (args) => {
    const card = useRef<HTMLDivElement | null>(null);
    return (
      <>
        <Sheet title="Create ticket" button="Create" />
        <Spotlight target="create-ticket-form" card={card} />
        <CoachCard {...args} cardRef={card} />
      </>
    );
  },
  play: async ({ canvasElement }) => {
    const doc = within(canvasElement.ownerDocument.body);
    await lastButtonClears(canvasElement, 'Create ticket', 'Create', () =>
      doc.getByRole('dialog', { name: 'Fill in the ticket' }),
    );
  },
};

/** Paused over the ticket pop-up on a phone: its end scrolls above the panel too (AGL-025). */
export const PausedOverATicketOnAPhone: Story = {
  globals: { viewport: { value: 'mobile1', isRotated: false } },
  beforeEach: docked('paused'),
  render: () => (
    <>
      <Sheet popup title="WEB-5 Try the tutorial" button="Add comment" />
      <PausedCoach
        sectionTitle="Tracks and tickets"
        index={6}
        count={9}
        onResume={fn()}
        onClose={fn()}
      />
    </>
  ),
  play: async ({ canvasElement }) => {
    const doc = within(canvasElement.ownerDocument.body);
    const panel = doc.getByRole('region', {
      name: 'Tutorial paused: Tracks and tickets, step 7 of 9',
    });
    // Docked over the window, not placed in the page's flow like other glass cards.
    await expect(getComputedStyle(panel).position).toBe('fixed');
    await lastButtonClears(canvasElement, 'WEB-5 Try the tutorial', 'Add comment', () => panel);
  },
};
