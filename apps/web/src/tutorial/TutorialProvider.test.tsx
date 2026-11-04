import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN, MEMBER } from '../admin/fixtures';
import { announceApiChange } from '../api/changes';
import { I18nProvider } from '../i18n/I18nProvider';
import { type MessageId, messagesEn } from '../i18n/messages.en';
import { navigate, openOverlay } from '../routing/router';
import { type Session, SessionProvider } from '../session/SessionProvider';
import { setViewportWidth } from '../test/viewport';
import type { TutorialClient } from './client';
import { audienceOf, TUTORIAL_SECTIONS, type TutorialSectionId } from './sections';
import { type StepDone, stepsFor, stepTitleId, type TutorialStep } from './steps';
import { TutorialCoach, TutorialProvider, useTutorial } from './TutorialProvider';

const en = (id: MessageId) => messagesEn[id] as string;

const adminSteps = (section: TutorialSectionId) =>
  stepsFor(section, audienceOf(ADMIN.status === 'signed-in' ? ADMIN.user : null));

/** A step's title as the card shows it, by the step's id. */
function titleOf(section: TutorialSectionId, id: string): string {
  const step = adminSteps(section).find((s) => s.id === id);
  if (!step) throw new Error(`no step ${section}.${id}`);
  return en(stepTitleId(section, step));
}

function fakeClient(): TutorialClient & { save: ReturnType<typeof vi.fn> } {
  return {
    progress: vi.fn(async () => ({ offer: null, sections: [] })),
    save: vi.fn(async () => {}),
    answerOffer: vi.fn(async () => {}),
  };
}

function Starters() {
  const { start } = useTutorial();
  return (
    <div>
      {TUTORIAL_SECTIONS.map((s) => (
        <button key={s.id} type="button" onClick={() => start([s.id])}>
          {`Start ${s.id}`}
        </button>
      ))}
      <button type="button" onClick={() => start(['search', 'dashboards'])}>
        Start two
      </button>
      <button type="button" onClick={() => start(['dashboards'], 3)}>
        Resume dashboards
      </button>
      <button
        type="button"
        onClick={() =>
          start(
            ['tracks'],
            adminSteps('tracks').findIndex((s) => s.id === 'openTicket'),
          )
        }
      >
        Resume tracks
      </button>
    </div>
  );
}

function renderRunner(session: Session = ADMIN, client = fakeClient()) {
  const view = render(
    <I18nProvider locale="en">
      <SessionProvider session={session}>
        <TutorialProvider client={client}>
          <Starters />
          <main id="main" tabIndex={-1}>
            <TutorialCoach />
          </main>
        </TutorialProvider>
      </SessionProvider>
    </I18nProvider>,
  );
  return { client, ...view };
}

/** Pages and paths the walk uses to do what a step waits for; the first that fits is taken. */
const ROUTES = [
  '#/tracks',
  '#/tracks/WEB',
  '#/tracks/WEB/board',
  '#/tracks/WEB/backlog',
  '#/tracks/WEB/releases',
  '#/tickets/WEB-1',
  '#/search',
  '#/dashboards',
  '#/dashboards/7',
];
const CHANGES: [string, string][] = [
  ['POST', '/tracks'],
  ['POST', '/tickets'],
  ['POST', '/tickets/WEB-1/comments'],
  ['POST', '/tickets/WEB-1/attachments'],
  ['POST', '/workflows'],
  ['PUT', '/workflows/5/draft'],
  ['POST', '/workflows/5/publish'],
  ['POST', '/workflow-maps'],
  ['PATCH', '/tracks/3'],
  ['POST', '/boards/2/moves'],
  ['POST', '/boards/2/sprints'],
  ['POST', '/sprints/4/tickets'],
  ['POST', '/sprints/4/start'],
  ['POST', '/search'],
  ['POST', '/saved-searches'],
  ['POST', '/dashboards'],
  ['PATCH', '/dashboards/7'],
  ['POST', '/tracks/3/releases'],
  ['POST', '/boards/2/backlog/release'],
  ['POST', '/releases/3/ship'],
  ['POST', '/users'],
  ['POST', '/groups'],
  ['PUT', '/groups/2/members/9'],
  ['PUT', '/tracks/3/roles/1/groups/2'],
  ['POST', '/admin/imports/files'],
  ['POST', '/admin/imports'],
];

const added: HTMLElement[] = [];

/** Goes to a route and waits for the change to arrive, as a hash change does, a moment later. */
async function go(route: string) {
  await act(async () => {
    const arrived = new Promise((resolve) =>
      window.addEventListener('hashchange', resolve, { once: true }),
    );
    navigate(route);
    await arrived;
  });
}

/** Does what the step waits for, the way the person would leave a trace of it. */
function doTheStep(done: StepDone) {
  if ('route' in done) {
    const route = ROUTES.find((r) => done.route.test(r));
    if (!route) throw new Error(`no route for ${done.route}`);
    navigate(route);
  } else if ('appears' in done) {
    const el = document.createElement('div');
    el.dataset.tutorial = done.appears;
    document.body.append(el);
    added.push(el);
  } else {
    const change = CHANGES.find(
      ([method, path]) => done.request.method.test(method) && done.request.path.test(path),
    );
    if (!change) throw new Error(`no change for ${done.request.path}`);
    announceApiChange({ method: change[0], path: change[1] });
  }
}

const card = (step: TutorialStep, section: TutorialSectionId) =>
  screen.findByRole('dialog', { name: en(stepTitleId(section, step)) });

beforeEach(() => {
  window.sessionStorage.clear();
  navigate('#/settings/tutorials');
});

afterEach(() => {
  for (const el of added.splice(0)) el.remove();
});

describe('the guided tutorial walks every section (ADR-115)', () => {
  for (const section of TUTORIAL_SECTIONS) {
    it(`[AGL-025] walks ${section.id}: each step shows, waits for its action and is saved`, async () => {
      const user = userEvent.setup();
      const { client } = renderRunner(ADMIN);
      const steps = stepsFor(
        section.id,
        audienceOf(ADMIN.status === 'signed-in' ? ADMIN.user : null),
      );
      expect(steps[0]?.id).toBe('intro');
      expect(steps.at(-1)?.id).toBe('finish');
      await user.click(screen.getByRole('button', { name: `Start ${section.id}` }));
      for (const [index, step] of steps.entries()) {
        const shown = await card(step, section.id);
        expect(shown).toHaveAttribute('aria-modal', 'false');
        expect(
          within(shown).getByText(`${en(section.titleId)} · Step ${index + 1} of ${steps.length}`),
        ).toBeVisible();
        expect(client.save).toHaveBeenLastCalledWith(section.id, 'active', index);
        const done = step.done?.[0];
        if (!done) {
          const label = index === steps.length - 1 ? 'Finish' : 'Next';
          expect(within(shown).queryByText(/moves on by itself/)).toBeNull();
          await user.click(within(shown).getByRole('button', { name: label }));
        } else {
          // It waits: nothing else moves it on.
          expect(within(shown).getByText(/moves on by itself/)).toBeVisible();
          await act(async () => announceApiChange({ method: 'POST', path: '/unrelated' }));
          expect(screen.getByRole('dialog')).toBe(shown);
          await act(async () => doTheStep(done));
        }
      }
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(client.save).toHaveBeenLastCalledWith(section.id, 'done', steps.length - 1);
    });
  }

  it('[AGL-025] someone who cannot make a track opens one of theirs instead', async () => {
    const user = userEvent.setup();
    renderRunner(MEMBER);
    const steps = stepsFor(
      'tracks',
      audienceOf(MEMBER.status === 'signed-in' ? MEMBER.user : null),
    );
    expect(steps.map((s) => s.id)).not.toContain('newTrack');
    await user.click(screen.getByRole('button', { name: 'Start tracks' }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    const open = await screen.findByRole('dialog', { name: 'Open a track' });
    // Away from the Tracks page, the card offers the way there.
    expect(within(open).getByRole('link', { name: 'Take me there' })).toHaveAttribute(
      'href',
      '#/tracks',
    );
    await go('#/tracks');
    expect(within(open).queryByRole('link', { name: 'Take me there' })).toBeNull();
    await go('#/tracks/WEB');
    expect(await screen.findByRole('dialog', { name: 'Open the create dialog' })).toBeVisible();
  });

  it('[AGL-025] offers administration and import only to those who may do them', async () => {
    const user = userEvent.setup();
    const { client } = renderRunner(MEMBER);
    await user.click(screen.getByRole('button', { name: 'Start admin' }));
    await user.click(screen.getByRole('button', { name: 'Start import' }));
    await user.click(screen.getByRole('button', { name: 'Start workflows' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(client.save).not.toHaveBeenCalled();
  });
});

describe('the coach card (ADR-115)', () => {
  it('[AGL-025] [NFR-005] takes focus, pauses on Escape, gives focus back and resumes in place', async () => {
    const user = userEvent.setup();
    const { client } = renderRunner();
    const opener = screen.getByRole('button', { name: 'Start dashboards' });
    await user.click(opener);
    const intro = await screen.findByRole('dialog', { name: 'Dashboards' });
    expect(intro).toHaveFocus();
    // Docked on a phone: the page and any dialog over it keep room for it (surfaces.css).
    expect(document.documentElement.dataset.coach).toBe('open');
    expect(within(intro).getByRole('status')).toHaveTextContent(
      'Dashboards · Step 1 of 6: Dashboards',
    );
    await user.click(within(intro).getByRole('button', { name: 'Next' }));
    const open = await screen.findByRole('dialog', { name: 'Open Dashboards' });
    expect(open).toHaveFocus();
    expect(within(open).getByRole('button', { name: 'Back' })).toBeEnabled();

    // Nothing traps the person: Tab leaves the card for the page.
    for (let i = 0; i < 10 && open.contains(document.activeElement); i++) await user.tab();
    expect(open).not.toContainElement(document.activeElement as HTMLElement);

    open.focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(opener).toHaveFocus();
    const paused = screen.getByRole('region', {
      name: 'Tutorial paused: Dashboards, step 2 of 6',
    });
    expect(document.documentElement.dataset.coach).toBe('paused');
    await user.click(within(paused).getByRole('button', { name: 'Resume' }));
    expect(await screen.findByRole('dialog', { name: 'Open Dashboards' })).toHaveFocus();

    // Closed for now: it stays in progress at this step, to resume from Settings.
    await user.click(screen.getByRole('button', { name: 'Pause' }));
    await user.click(screen.getByRole('button', { name: 'Close for now' }));
    expect(screen.queryByRole('region', { name: /Tutorial paused/ })).toBeNull();
    expect(document.documentElement.dataset.coach).toBeUndefined();
    expect(client.save).toHaveBeenLastCalledWith('dashboards', 'active', 1);
  });

  it('[AGL-025] Escape pauses from a link or button on the page, and stays with a field', async () => {
    const user = userEvent.setup();
    renderRunner();
    await user.click(screen.getByRole('button', { name: 'Start dashboards' }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    const open = await screen.findByRole('dialog', { name: 'Open Dashboards' });
    expect(within(open).getByText(/Escape pauses/)).toBeVisible();

    // In a field, Escape is the field's own.
    const field = document.createElement('input');
    field.setAttribute('aria-label', 'Notes');
    document.body.append(field);
    added.push(field);
    field.focus();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('dialog', { name: 'Open Dashboards' })).toBe(open);

    // On a button of the page, as after clicking one, Escape means nothing else: it pauses.
    screen.getByRole('button', { name: 'Start search' }).focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      screen.getByRole('region', { name: 'Tutorial paused: Dashboards, step 2 of 6' }),
    ).toBeVisible();
  });

  it('[AGL-025] Back shows the step again without moving on by itself; Next skips a waiting step', async () => {
    const user = userEvent.setup();
    renderRunner();
    await user.click(screen.getByRole('button', { name: 'Start dashboards' }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await go('#/dashboards');
    const make = await screen.findByRole('dialog', { name: 'Make a dashboard' });
    await user.click(within(make).getByRole('button', { name: 'Back' }));
    // Already on Dashboards, but entered with Back: it waits for Next, and does not say otherwise.
    const again = await screen.findByRole('dialog', { name: 'Open Dashboards' });
    expect(within(again).queryByText(/moves on by itself/)).toBeNull();
    await user.click(within(again).getByRole('button', { name: 'Next' }));
    const skipped = await screen.findByRole('dialog', { name: 'Make a dashboard' });
    expect(within(skipped).getByText(/moves on by itself/)).toBeVisible();
    await user.click(within(skipped).getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('dialog', { name: 'Edit it' })).toBeVisible();
  });

  it('[AGL-025] leads back to what was made and offers the page at the end', async () => {
    const user = userEvent.setup();
    renderRunner();
    await user.click(screen.getByRole('button', { name: 'Resume dashboards' }));
    // Resumed at the fourth step, away from any dashboard: the way back is offered.
    const edit = await screen.findByRole('dialog', { name: 'Edit it' });
    expect(within(edit).getByText('Dashboards · Step 4 of 6')).toBeVisible();
    expect(within(edit).getByRole('link', { name: 'Take me there' })).toHaveAttribute(
      'href',
      '#/dashboards',
    );
    await go('#/dashboards/7');
    await act(async () => doTheStep({ appears: 'dashboard-editor' }));
    await screen.findByRole('dialog', { name: 'Add a widget and save' });
    await act(async () => doTheStep({ request: { method: /PATCH/, path: /^\/dashboards\/\d+$/ } }));
    const finish = await screen.findByRole('dialog', { name: 'Your dashboard is ready' });
    expect(within(finish).getByRole('link', { name: 'Open what you made' })).toHaveAttribute(
      'href',
      '#/dashboards/7',
    );
  });

  it('[AGL-025] remembers the ticket opened over the page by the route that finishes the step', async () => {
    const user = userEvent.setup();
    renderRunner();
    await user.click(screen.getByRole('button', { name: 'Resume tracks' }));
    await screen.findByRole('dialog', { name: titleOf('tracks', 'openTicket') });
    try {
      // The ringed link to the new ticket opens it over the page: one change of route, which
      // both finishes the step and tells the tutorial which ticket is the person's.
      await act(async () => openOverlay('#/tickets/WEB-5'));
      await screen.findByRole('dialog', { name: titleOf('tracks', 'comment') });
      await act(async () => announceApiChange({ method: 'POST', path: '/tickets/WEB-5/comments' }));
      await screen.findByRole('dialog', { name: titleOf('tracks', 'attach') });
      await act(async () =>
        announceApiChange({ method: 'POST', path: '/tickets/WEB-5/attachments' }),
      );
      const finish = await screen.findByRole('dialog', { name: titleOf('tracks', 'finish') });
      expect(within(finish).getByRole('link', { name: 'Open what you made' })).toHaveAttribute(
        'href',
        '#/tickets/WEB-5',
      );
    } finally {
      window.history.replaceState(null, '', window.location.pathname);
    }
  });

  it('[AGL-025] skipping a section saves it as skipped and starts the next one picked', async () => {
    const user = userEvent.setup();
    const { client } = renderRunner();
    await user.click(screen.getByRole('button', { name: 'Start two' }));
    const search = await screen.findByRole('dialog', { name: 'Search and saved searches' });
    await user.click(within(search).getByRole('button', { name: 'Skip section' }));
    expect(client.save).toHaveBeenCalledWith('search', 'skipped', 0);
    const next = await screen.findByRole('dialog', { name: 'Dashboards' });
    expect(next).toHaveFocus();
    expect(client.save).toHaveBeenLastCalledWith('dashboards', 'active', 0);
  });

  it('[AGL-025] keeps its place in this tab across a reload, without taking focus', async () => {
    const user = userEvent.setup();
    const { unmount } = renderRunner();
    await user.click(screen.getByRole('button', { name: 'Start search' }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await screen.findByRole('dialog', { name: 'Open Search' });
    unmount();
    const again = renderRunner();
    const back = await screen.findByRole('dialog', { name: 'Open Search' });
    expect(back).not.toHaveFocus();
    again.unmount();

    // Someone else signing in on this tab is not led through it.
    renderRunner(MEMBER);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('[AGL-025] moves the card off the control it rings, and docks it on a phone', async () => {
    const user = userEvent.setup();
    renderRunner();
    const target = document.createElement('button');
    target.dataset.tutorial = 'dashboard-new';
    document.body.append(target);
    added.push(target);
    // The control sits in the bottom end corner of a desktop window, where the card would go.
    target.getBoundingClientRect = () => new DOMRect(1300, 600, 120, 40);
    await user.click(screen.getByRole('button', { name: 'Start dashboards' }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await go('#/dashboards');
    const make = await screen.findByRole('dialog', { name: 'Make a dashboard' });
    make.getBoundingClientRect = () => new DOMRect(1016, 616, 400, 260);
    await act(async () => window.dispatchEvent(new Event('resize')));
    expect(make).toHaveAttribute('data-place', 'start');
    expect(document.querySelector('.coach-ring')).toHaveStyle({ top: '594px', left: '1294px' });

    await act(async () => setViewportWidth(375));
    await act(async () => window.dispatchEvent(new Event('resize')));
    expect(make).not.toHaveAttribute('data-place');
    expect(document.documentElement.style.getPropertyValue('--coach-space')).toBe('260px');
  });
});
