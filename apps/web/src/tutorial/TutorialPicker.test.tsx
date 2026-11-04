import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { audienceOf, sectionsFor } from './sections';
import { TutorialPicker } from './TutorialPicker';

describe('the tutorial picker (ADR-115)', () => {
  it('[NFR-005] lists the sections a person may take, with their state, to tick or start', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onStart = vi.fn();
    render(
      <I18nProvider locale="en">
        <TutorialPicker
          sections={sectionsFor(audienceOf({ isSiteAdmin: false }))}
          status={{ boards: 'active', tracks: 'done' }}
          selected={['search']}
          onSelect={onSelect}
          onStart={onStart}
        />
      </I18nProvider>,
    );
    expect(screen.queryByRole('checkbox', { name: 'Learn Workflows' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Learn Administration' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Learn Import' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Learn Search and saved searches' })).toBeChecked();

    await user.click(screen.getByRole('checkbox', { name: 'Learn Dashboards' }));
    expect(onSelect).toHaveBeenCalledWith(['search', 'dashboards']);

    await user.click(screen.getByRole('button', { name: 'Resume: Boards and sprints' }));
    expect(onStart).toHaveBeenCalledWith('boards');
    expect(screen.getByRole('button', { name: 'Do it again: Tracks and tickets' })).toBeVisible();
  });

  it('[NFR-005] offers Workflows to configuration administrators and the rest to site administrators', () => {
    const { rerender } = render(
      <I18nProvider locale="en">
        <TutorialPicker
          sections={sectionsFor(audienceOf({ isSiteAdmin: false, isConfigAdmin: true }))}
          status={{}}
          selected={[]}
          onSelect={() => {}}
        />
      </I18nProvider>,
    );
    expect(screen.getByRole('checkbox', { name: 'Learn Workflows' })).toBeVisible();
    expect(screen.getByText('For administrators')).toBeVisible();
    expect(screen.queryByRole('checkbox', { name: 'Learn Import' })).toBeNull();
    // Without a way to start one, as in the first-run offer: no button on each card.
    expect(screen.queryByRole('button')).toBeNull();

    rerender(
      <I18nProvider locale="en">
        <TutorialPicker
          sections={sectionsFor(audienceOf({ isSiteAdmin: true }))}
          status={{}}
          selected={[]}
          onSelect={() => {}}
        />
      </I18nProvider>,
    );
    expect(screen.getAllByRole('checkbox')).toHaveLength(8);
    expect(screen.getAllByText('For site administrators')).toHaveLength(2);
  });
});
